import { classifyCommandRisk } from './command-risk'

export const BACKUP_DIR = '$HOME/.shellbeam-backups'
export const MAX_BACKUPS_PER_FILE = 3

export interface FileBackupPlan {
  targets: string[]
  stamp: string
  wrappedCommand: string
  rollbackCommand: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function sanitizeBackupSlug(filePath: string): string {
  const normalized = filePath.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return (normalized || 'file').slice(-80)
}

function isCandidateFilePath(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  if (token === '/dev/null' || token.startsWith('/dev/') || token.startsWith('/proc/') || token.startsWith('/sys/')) return false
  if (/^https?:\/\//i.test(token)) return false
  if (/[*?[\]$`();|&<>]/.test(token)) return false
  // Must look like an explicit file path (absolute, relative, or home-relative) or config filename.
  return token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/') || /\.[A-Za-z0-9]{1,8}$/.test(token)
}

function stripOuterQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * Best-effort extraction of concrete file paths that a state-changing shell
 * command will modify or overwrite. Only returns static, unambiguous paths so
 * the pre-execution backup wrapper never executes shell expansions unexpectedly.
 */
export function detectModifiedFileTargets(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed || classifyCommandRisk(trimmed) === 'read-only') return []

  const found = new Set<string>()
  const add = (raw?: string) => {
    if (!raw) return
    const cleaned = stripOuterQuotes(raw.trim())
    if (isCandidateFilePath(cleaned)) found.add(cleaned)
  }

  // 1. Output redirections: > /path, >> /path, 1> /path (exclude 2>&1 / &>)
  const redirectRe = /(?:^|[\s;])(?:\d?>>?)\s*("(?:[^"\\]|\\.)+"|'(?:[^'])+'|[^\s;&|><]+)/g
  let match: RegExpExecArray | null
  while ((match = redirectRe.exec(trimmed)) !== null) {
    add(match[1])
  }

  // 2. tee [-a] <file>
  const teeRe = /\b(?:sudo\s+)?tee\b((?:\s+-[a-zA-Z]+)*)\s+("(?:[^"\\]|\\.)+"|'(?:[^'])+'|[^\s;&|><]+)/g
  while ((match = teeRe.exec(trimmed)) !== null) {
    add(match[2])
  }

  // 3. sed -i [suffix] <expr> <file>  OR  sed --in-place <expr> <file>
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
        // The last path-like positional token(s) after the sed expression are the edited files.
        for (let i = args.length - 1; i >= 0; i -= 1) {
          const arg = stripOuterQuotes(args[i])
          if (arg.startsWith('-')) break
          if (isCandidateFilePath(arg)) add(arg)
          else break
        }
      }
    } else if (bin === 'cp' || bin === 'mv' || bin === 'install') {
      const positionals = args.filter((a) => !a.startsWith('-')).map(stripOuterQuotes)
      if (positionals.length >= 2) {
        const dest = positionals[positionals.length - 1]
        if (isCandidateFilePath(dest) && !dest.endsWith('/')) add(dest)
      }
    } else if (bin === 'rm' || bin === 'truncate') {
      for (const arg of args) {
        if (!arg.startsWith('-')) add(arg)
      }
    }
  }

  return [...found].slice(0, 5)
}

function formatUtcStamp(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/**
 * Wraps a mutating command with a POSIX-safe pre-backup into `~/.shellbeam-backups/`,
 * keeping only the latest 3 snapshots per target file and generating a 1-click rollback command.
 */
export function buildFileBackupPlan(command: string, now = Date.now()): FileBackupPlan | null {
  const targets = detectModifiedFileTargets(command)
  if (targets.length === 0) return null

  const stamp = formatUtcStamp(now)
  const backupSteps: string[] = [`mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"`]
  const rollbackSteps: string[] = []

  for (const target of targets) {
    const slug = sanitizeBackupSlug(target)
    const quotedTarget = shellQuote(target)
    const backupFile = `"${BACKUP_DIR}/${stamp}_${slug}"`
    // Copy existing regular file preserving permissions, then prune older backups beyond MAX_BACKUPS_PER_FILE.
    backupSteps.push(
      `if [ -f ${quotedTarget} ]; then cp -p ${quotedTarget} ${backupFile} && ls -1t "${BACKUP_DIR}/"*_${slug} 2>/dev/null | tail -n +${MAX_BACKUPS_PER_FILE + 1} | xargs -r rm -f; fi`,
    )
    rollbackSteps.push(
      `[ -f ${backupFile} ] && cp -p ${backupFile} ${quotedTarget}`,
    )
  }

  const wrappedCommand = `${backupSteps.join(' && ')} && (${command.trim()})`
  const rollbackCommand = rollbackSteps.join(' && ')
  return { targets, stamp, wrappedCommand, rollbackCommand }
}
