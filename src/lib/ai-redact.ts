/**
 * Masks secrets in text before it leaves this device for a model: terminal
 * output, captured command results, host facts and the conversation.
 *
 * It is best effort and errs toward masking: a masked value the model needed
 * costs a follow-up question, a leaked one cannot be taken back. The names
 * around a value (the variable, the flag, the header) are kept so the model
 * still understands the line.
 */

export const REDACTED = '[redacted]'

/** Words that make an assignment, flag, header or JSON field a secret. */
const SECRET_NAME = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth(?:orization)?)`
/** Names that contain a secret word but hold no secret. */
const NOT_SECRET = /^(?:old)?pwd$|^passwd$|^pass$|^token_?type$|^auth_?type$|^auth_?method$/i

const rules: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  // PEM and OpenSSH private keys: keep the armour lines, drop the body.
  {
    pattern: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: (_m, begin: string, end: string) => `${begin}\n${REDACTED}\n${end}`,
  },
  // Credentials inside a URL: scheme://user:password@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi,
    replace: (_m, prefix: string) => `${prefix}:${REDACTED}@`,
  },
  // Authorization headers and bare bearer/basic tokens.
  {
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme: string) => `${scheme} ${REDACTED}`,
  },
  // Well-known token formats, wherever they appear.
  {
    pattern: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    replace: () => REDACTED,
  },
  // Flags: --password=x, --token x, sshpass -p x
  {
    pattern: new RegExp(String.raw`(--[a-z0-9-]*${SECRET_NAME}[a-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)`, 'gi'),
    replace: (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`,
  },
  {
    pattern: /(\bsshpass\s+-p\s*)("[^"]*"|'[^']*'|\S+)/g,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  // Assignments and fields: DB_PASSWORD=x, "api_key": "x", token: x
  {
    pattern: new RegExp(String.raw`(["']?)([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}"']+)`, 'gi'),
    replace: (match: string, quote: string, name: string, sep: string, value: string) => {
      // A header whose scheme is followed by an already masked token: `Authorization: Bearer [redacted]`.
      if (NOT_SECRET.test(name) || /^\[redacted\]/.test(value) || /^(?:Bearer|Basic|Token)$/i.test(value)) return match
      const wrapped = /^["']/.test(value) ? `${value[0]}${REDACTED}${value[0]}` : REDACTED
      return `${quote}${name}${quote}${sep}${wrapped}`
    },
  },
]

export function redactSecrets(text: string): string {
  if (!text) return text
  let result = text
  for (const rule of rules) result = result.replace(rule.pattern, rule.replace as (substring: string, ...args: string[]) => string)
  return result
}
