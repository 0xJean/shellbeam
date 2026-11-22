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

function sanitizeBackupSlug(filePath: string): string {
  const normalized = filePath.replace(/^~\/+/, 'home_').replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return (normalized || 'file').slice(-80)
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

/**
 * Conservative extraction of concrete file paths that a state-changing shell
 * command will modify, move, or overwrite. Fails closed (returns `[]`) when:
 * - any target uses unresolvable shell expansion (`~user`, globs, `$VAR`),
 * - `mv` / `cp` / `install` targets a directory or uses `-t`/`--target-directory` or >2 operands,
 * - the total number of detected targets exceeds `MAX_BACKUP_TARGETS` (never advertises partial coverage).
 */
export function detectModifiedFileTargets(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed || classifyCommandRisk(trimmed) === 'read-only') return []

  const found = new Set<string>()
  let unsupported = false

  const addChecked = (raw?: string): boolean => {
    if (!raw) return false
    const cleaned = stripOuterQuotes(raw.trim())
    if (!cleaned || cleaned === '/dev/null') return true
    if (!isCandidateFilePath(cleaned)) return false
    found.add(cleaned)
    return true
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
        let sawTarget = false
        for (let i = args.length - 1; i >= 0; i -= 1) {
          const arg = stripOuterQuotes(args[i])
          if (arg.startsWith('-')) break
          if (isCandidateFilePath(arg)) {
            found.add(arg)
            sawTarget = true
          } else if (sawTarget) {
            break
          } else {
            break
          }
        }
      }
    } else if (bin === 'mv') {
      const hasTargetDirFlag = args.some((a) => a === '-t' || a.startsWith('--target-directory'))
      const positionals = args.filter((a) => !a.startsWith('-')).map(stripOuterQuotes)
      if (hasTargetDirFlag || positionals.length !== 2) {
        unsupported = true
      } else {
        // Track BOTH source and destination so rollback restores the moved source and old destination.
        const [src, dst] = positionals
        if (!isCandidateFilePath(src) || !isCandidateFilePath(dst)) {
          unsupported = true
        } else {
          found.add(src)
          found.add(dst)
        }
      }
    } else if (bin === 'cp' || bin === 'install') {
      const hasTargetDirFlag = args.some((a) => a === '-t' || a.startsWith('--target-directory'))
      const positionals = args.filter((a) => !a.startsWith('-')).map(stripOuterQuotes)
      if (hasTargetDirFlag || positionals.length !== 2) {
        unsupported = true
      } else {
        const dest = positionals[1]
        if (!isCandidateFilePath(dest)) {
          unsupported = true
        } else {
          found.add(dest)
        }
      }
    } else if (bin === 'rm' || bin === 'truncate') {
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
 * - Resolves `~/...` via `"$HOME"/'...'` so home-relative edits back up the real file.
 * - Records `.absent` markers for files that did not exist prior to mutation.
 * - Uses privilege-aware restore (`sudo`) when the command itself uses `sudo`, and verifies
 *   non-elevated writability before running unprivileged mutations.
 * - Uses a newline-delimited subshell so heredoc writes (`<<EOF ... EOF`) remain intact.
 * - Rollback processes every target independently (reporting any individual failure via exit code)
 *   so a newly created file never skips restoring later targets.
 */
export function buildFileBackupPlan(command: string, now = Date.now()): FileBackupPlan | null {
  const targets = detectModifiedFileTargets(command)
  if (targets.length === 0) return null

  const trimmed = command.trim()
  const usesSudo = commandUsesSudo(trimmed)
  const stamp = formatUtcStamp(now)
  const backupSteps: string[] = [`mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"`]
  const rollbackSteps: string[] = ['rc=0']
  const priv = usesSudo ? 'sudo ' : ''

  for (const target of targets) {
    const slug = sanitizeBackupSlug(target)
    const targetExpr = shellPathExpr(target)
    const backupFile = `"${BACKUP_DIR}/${stamp}_${slug}"`
    const absentMarker = `"${BACKUP_DIR}/${stamp}_${slug}.absent"`

    // Refuse if target is an existing directory (cannot safely roll back directory overwrite as file).
    // For non-sudo commands, verify target (or parent dir if new) is writable so rollback can succeed.
    const guard = usesSudo
      ? `if [ -d ${targetExpr} ]; then printf '%s\\n' ${shellQuote(`Refusing backup (directory): ${target}`)} >&2; exit 1; fi`
      : `if [ -d ${targetExpr} ]; then printf '%s\\n' ${shellQuote(`Refusing backup (directory): ${target}`)} >&2; exit 1; fi; if [ -e ${targetExpr} ] && [ ! -w ${targetExpr} ]; then printf '%s\\n' ${shellQuote(`Refusing backup (not writable): ${target}`)} >&2; exit 1; fi; if [ ! -e ${targetExpr} ] && [ ! -w "$(dirname -- ${targetExpr})" ]; then printf '%s\\n' ${shellQuote(`Refusing backup (parent not writable): ${target}`)} >&2; exit 1; fi`

    const snapshot = `if [ -f ${targetExpr} ]; then ${priv}cp -p ${targetExpr} ${backupFile} && ${usesSudo ? `sudo chown "$(id -u):$(id -g)" ${backupFile} && ` : ''}ls -1t "${BACKUP_DIR}/"*_${slug} 2>/dev/null | tail -n +${MAX_BACKUPS_PER_FILE + 1} | xargs -r rm -f; elif [ ! -e ${targetExpr} ]; then : > ${absentMarker}; fi`

    backupSteps.push(`{ ${guard} && ${snapshot}; }`)

    rollbackSteps.push(
      `if [ -f ${backupFile} ]; then ${priv}cp -p ${backupFile} ${targetExpr} || { printf '%s\\n' ${shellQuote(`Rollback failed: ${target}`)} >&2; rc=1; }; elif [ -f ${absentMarker} ]; then ${priv}rm -f ${targetExpr} || { printf '%s\\n' ${shellQuote(`Rollback cleanup failed: ${target}`)} >&2; rc=1; }; else printf '%s\\n' ${shellQuote(`Rollback skipped (no snapshot): ${target}`)} >&2; rc=1; fi`,
    )
  }

  rollbackSteps.push('exit $rc')

  const wrappedCommand = `${backupSteps.join(' && ')} && (\n${trimmed}\n)`
  const rollbackCommand = `( ${rollbackSteps.join('; ')} )`
  return { targets, stamp, usesSudo, wrappedCommand, rollbackCommand }
}
