import { classifyCommandRisk } from './command-risk'

export const BACKUP_DIR = '$HOME/.shellbeam-backups'
export const MAX_BACKUPS_PER_FILE = 3
export const MAX_BACKUP_TARGETS = 8

export interface FileBackupPlan {
  targets: string[]
  stamp: string
  usesSudo: boolean
  wrappedCommand: string
  rollbackCommand: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Resolves a validated path operand to a safe POSIX shell expression.
 * Home-relative paths (`~/...`) expand `$HOME` with a single-quoted literal suffix
 * so spaces and metacharacters cannot trigger unexpected expansion while matching
 * the real home directory edited by the user's command.
 */
function shellPathExpr(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return `"$HOME"/${shellQuote(filePath.slice(2))}`
  }
  return shellQuote(filePath)
}

/** Deterministic 32-bit FNV-1a hex hash of the exact target path to prevent slug collisions. */
function targetPathHash(filePath: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < filePath.length; i += 1) {
    hash ^= filePath.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function sanitizeBackupSlug(filePath: string): string {
  const normalized = filePath.replace(/^~\/+/, 'home_').replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return (normalized || 'file').slice(-64)
}

function isCandidateFilePath(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  if (token === '/dev/null' || token.startsWith('/dev/') || token.startsWith('/proc/') || token.startsWith('/sys/')) return false
  // Decline `~otheruser/...` or bare `~` because shell expansion cannot be safely reproduced.
  if (token === '~' || (token.startsWith('~') && !token.startsWith('~/'))) return false
  if (token.endsWith('/')) return false
  if (/^https?:\/\//i.test(token)) return false
  if (/[*?[\]$`();|&<>]/.test(token)) return false
  return token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || /\.[A-Za-z0-9]{1,8}$/.test(token)
}

function stripOuterQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1)
  }
  return token
}

function commandUsesSudo(command: string): boolean {
  return /(?:^|[;&|\n(]\s*)sudo\b/.test(command)
}

interface OptionParseSpec {
  /** Single-letter short flags that take a separate argument (e.g. `-m 0644`). */
  shortValue: string
  /** Long flag names (without `--`) that take a separate argument (e.g. `--mode 0644`). */
  longValue: readonly string[]
  /** Flags that make target resolution ambiguous (e.g. `-t`, `-d`, `--target-directory`). */
  rejectShort: string
  rejectLong: readonly string[]
}

const OPTION_SPECS: Record<'mv' | 'cp' | 'install' | 'truncate', OptionParseSpec> = {
  mv: { shortValue: 'S', longValue: ['suffix'], rejectShort: 't', rejectLong: ['target-directory'] },
  cp: { shortValue: 'S', longValue: ['suffix'], rejectShort: 't', rejectLong: ['target-directory'] },
  install: {
    shortValue: 'mgoS',
    longValue: ['mode', 'group', 'owner', 'suffix'],
    rejectShort: 'td',
    rejectLong: ['target-directory', 'directory'],
  },
  truncate: {
    shortValue: 'sr',
    longValue: ['size', 'reference'],
    rejectShort: '',
    rejectLong: [],
  },
}

function parseCommandPositionals(bin: 'mv' | 'cp' | 'install' | 'truncate', args: string[]): string[] | null {
  const spec = OPTION_SPECS[bin]
  const positionals: string[] = []
  let endOfFlags = false
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]
    if (endOfFlags || raw === '-' || !raw.startsWith('-')) {
      positionals.push(stripOuterQuotes(raw))
      continue
    }
    if (raw === '--') {
      endOfFlags = true
      continue
    }
    if (raw.startsWith('--')) {
      const [flagPart] = raw.slice(2).split('=')
      if (spec.rejectLong.includes(flagPart)) return null
      if (spec.longValue.includes(flagPart) && !raw.includes('=')) {
        if (i + 1 >= args.length) return null
        i += 1
      }
      continue
    }
    // Short option cluster (e.g. `-m`, `-m0644`, `-rf`)
    for (let j = 1; j < raw.length; j += 1) {
      const ch = raw[j]
      if (spec.rejectShort.includes(ch)) return null
      if (spec.shortValue.includes(ch)) {
        if (j === raw.length - 1) {
          if (i + 1 >= args.length) return null
          i += 1
        }
        break
      }
    }
  }
  return positionals
}

/**
 * Conservative extraction of concrete file paths that a state-changing shell
 * command will modify, move, or overwrite. Fails closed (returns `[]`) when:
 * - any target uses unresolvable shell expansion (`~user`, globs, `$VAR`),
 * - `mv` / `cp` / `install` targets a directory or uses `-t`/`--target-directory`/`-d` or >2 operands,
 * - the total number of detected targets exceeds `MAX_BACKUP_TARGETS` (never advertises partial coverage).
 */
export function detectModifiedFileTargets(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed || classifyCommandRisk(trimmed) === 'read-only') return []

  const found = new Set<string>()
  let unsupported = false

  const addParsed = (operand: string): boolean => {
    if (!operand || operand === '/dev/null') return true
    if (!isCandidateFilePath(operand)) return false
    found.add(operand)
    return true
  }

  const addChecked = (raw?: string): boolean => {
    if (!raw) return false
    const trimmedRaw = raw.trim()
    const cleaned = (trimmedRaw.startsWith('"') && trimmedRaw.endsWith('"')) || (trimmedRaw.startsWith("'") && trimmedRaw.endsWith("'"))
      ? stripOuterQuotes(trimmedRaw)
      : trimmedRaw
    return addParsed(cleaned)
  }

  // 1. Output redirections: > /path, >> /path, 1> /path (exclude 2>&1 / &>)
  const redirectRe = /(?:^|[\s;])(?:\d?>>?)\s*("(?:[^"\\]|\\.)+"|'(?:[^'])+'|[^\s;&|><]+)/g
  let match: RegExpExecArray | null
  while ((match = redirectRe.exec(trimmed)) !== null) {
    if (!addChecked(match[1])) unsupported = true
  }

  // 2. tee [-a] <file>
  const teeRe = /\b(?:sudo\s+)?tee\b((?:\s+-[a-zA-Z]+)*)\s+("(?:[^"\\]|\\.)+"|'(?:[^'])+'|[^\s;&|><]+)/g
  while ((match = teeRe.exec(trimmed)) !== null) {
    if (!addChecked(match[2])) unsupported = true
  }

  // 3. Segment-level analysis for sed -i, cp, mv, install, rm, truncate
  const segments = trimmed.split(/(?:&&|\|\||;|\||\n)/)
  for (const segment of segments) {
    const tokens = segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []
    if (tokens.length === 0) continue
    let idx = 0
    while (idx < tokens.length && (tokens[idx] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]))) {
      idx += 1
    }
    const bin = tokens[idx]
    const args = tokens.slice(idx + 1)

    if (bin === 'sed') {
      const hasInPlace = args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place='))
      if (hasInPlace) {
        for (let i = args.length - 1; i >= 0; i -= 1) {
          const arg = stripOuterQuotes(args[i])
          if (arg.startsWith('-')) break
          if (isCandidateFilePath(arg)) found.add(arg)
          else break
        }
      }
    } else if (bin === 'mv') {
      const positionals = parseCommandPositionals('mv', args)
      if (!positionals || positionals.length !== 2) {
        unsupported = true
      } else {
        const [src, dst] = positionals
        if (!isCandidateFilePath(src) || !isCandidateFilePath(dst)) {
          unsupported = true
        } else {
          found.add(src)
          found.add(dst)
        }
      }
    } else if (bin === 'cp' || bin === 'install') {
      const positionals = parseCommandPositionals(bin, args)
      if (!positionals || positionals.length !== 2) {
        unsupported = true
      } else {
        const dest = positionals[1]
        if (!isCandidateFilePath(dest)) {
          unsupported = true
        } else {
          found.add(dest)
        }
      }
    } else if (bin === 'truncate') {
      const positionals = parseCommandPositionals('truncate', args)
      if (!positionals || positionals.length === 0) {
        unsupported = true
      } else {
        for (const target of positionals) {
          if (!addParsed(target)) unsupported = true
        }
      }
    } else if (bin === 'rm') {
      for (const arg of args) {
        if (!arg.startsWith('-') && !addChecked(arg)) unsupported = true
      }
    }
  }

  if (unsupported || found.size === 0 || found.size > MAX_BACKUP_TARGETS) {
    return []
  }

  return [...found]
}

function formatUtcStamp(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/**
 * Wraps a mutating command with a POSIX-safe pre-backup into `~/.shellbeam-backups/`:
 * - Every backup step executes inside a subshell `( ... )` so a refusal (`exit 1`) never closes an interactive SSH session.
 * - Snapshot names include a deterministic path hash (`${stamp}_${hash}_${slug}.bak`) and separate `.absent` markers to prevent collisions.
 * - Uses the same privilege level (`sudo`) for inspecting, copying, pruning, and restoring elevated targets, preserving original UID/GID ownership.
 * - Refuses directory and symlink targets (including dangling symlinks) as well as untraversable parent directories.
 * - Uses a newline-delimited subshell so heredoc writes (`<<EOF ... EOF`) terminate cleanly.
 * - Rollback processes every target independently and propagates any failure via exit status.
 */
export function buildFileBackupPlan(command: string, now = Date.now()): FileBackupPlan | null {
  const targets = detectModifiedFileTargets(command)
  if (targets.length === 0) return null

  const trimmed = command.trim()
  const usesSudo = commandUsesSudo(trimmed)
  const stamp = formatUtcStamp(now)
  const backupSteps: string[] = [`( mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}" )`]
  const rollbackSteps: string[] = ['rc=0']
  const priv = usesSudo ? 'sudo ' : ''

  for (const target of targets) {
    const hash = targetPathHash(target)
    const slug = sanitizeBackupSlug(target)
    const key = `${hash}_${slug}`
    const targetExpr = shellPathExpr(target)
    const backupFile = `"${BACKUP_DIR}/${stamp}_${key}.bak"`
    const absentMarker = `"${BACKUP_DIR}/${stamp}_${key}.absent"`

    // Inspect target under the exact same effective privileges as the mutation/copy.
    // Refuse symlinks (including dangling links), directories, and untraversable/unwritable parents.
    const guardParts = [
      `if ${priv}test -L ${targetExpr}; then printf '%s\\n' ${shellQuote(`Refusing backup (symlink): ${target}`)} >&2; exit 1; fi`,
      `if ${priv}test -d ${targetExpr}; then printf '%s\\n' ${shellQuote(`Refusing backup (directory): ${target}`)} >&2; exit 1; fi`,
      `if ! ${priv}test -x "$(dirname -- ${targetExpr})"; then printf '%s\\n' ${shellQuote(`Refusing backup (parent not accessible): ${target}`)} >&2; exit 1; fi`,
    ]
    if (!usesSudo) {
      guardParts.push(
        `if test -e ${targetExpr} && ! test -w ${targetExpr}; then printf '%s\\n' ${shellQuote(`Refusing backup (not writable): ${target}`)} >&2; exit 1; fi`,
        `if ! test -e ${targetExpr} && ! test -w "$(dirname -- ${targetExpr})"; then printf '%s\\n' ${shellQuote(`Refusing backup (parent not writable): ${target}`)} >&2; exit 1; fi`,
      )
    }
    const guard = guardParts.join('; ')

    // Preserve original owner/mode on elevated backups (never chown snapshots away from original owner).
    const snapshot = [
      `if ${priv}test -f ${targetExpr}; then`,
      `${priv}cp -p ${targetExpr} ${backupFile} && ls -1t "${BACKUP_DIR}/"*_${key}.bak 2>/dev/null | tail -n +${MAX_BACKUPS_PER_FILE + 1} | xargs -r ${priv}rm -f;`,
      `elif ! ${priv}test -e ${targetExpr}; then`,
      `: > ${absentMarker};`,
      `else printf '%s\\n' ${shellQuote(`Refusing backup (unsupported file type): ${target}`)} >&2; exit 1; fi`,
    ].join(' ')

    backupSteps.push(`( ${guard}; ${snapshot} )`)

    rollbackSteps.push(
      `if ${priv}test -f ${backupFile}; then ${priv}cp -p ${backupFile} ${targetExpr} || { printf '%s\\n' ${shellQuote(`Rollback failed: ${target}`)} >&2; rc=1; }; elif test -f ${absentMarker}; then ${priv}rm -f ${targetExpr} || { printf '%s\\n' ${shellQuote(`Rollback cleanup failed: ${target}`)} >&2; rc=1; }; else printf '%s\\n' ${shellQuote(`Rollback skipped (no snapshot): ${target}`)} >&2; rc=1; fi`,
    )
  }

  rollbackSteps.push('exit $rc')

  const wrappedCommand = `${backupSteps.join(' && ')} && (\n${trimmed}\n)`
  const rollbackCommand = `( ${rollbackSteps.join('; ')} )`
  return { targets, stamp, usesSudo, wrappedCommand, rollbackCommand }
}
