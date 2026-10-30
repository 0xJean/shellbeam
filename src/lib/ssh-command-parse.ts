export interface SshEndpoint {
  host: string
  username?: string
  port?: number
}

export interface ParsedSshCommand extends SshEndpoint {
  jump?: SshEndpoint
  identityFile?: string
}

// OpenSSH client options that consume the following argument (ssh(1) synopsis).
const OPTIONS_WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))
const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*\.?$/
const IPV6 = /^[0-9A-Fa-f:.]+(?:%[\w.-]+)?$/
const USERNAME = /^[A-Za-z0-9._][A-Za-z0-9._@-]*$/
const MAX_LENGTH = 1000

function tokenize(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

function parsePort(value: string | undefined): number | null | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

function validHost(host: string) {
  return HOSTNAME.test(host) || (host.split(':').length >= 3 && IPV6.test(host))
}

/** Parses `[user@]host[:port]`, `[user@][v6]:port` or `ssh://[user@]host[:port]`; null when malformed. */
export function parseSshEndpoint(raw: string, allowPortSuffix = true): SshEndpoint | null {
  let value = raw.trim()
  if (!value || value.startsWith('-')) return null
  const uri = /^ssh:\/\//i.test(value)
  if (uri) value = value.slice(6).replace(/\/$/, '')
  const at = value.lastIndexOf('@')
  const username = at > 0 ? value.slice(0, at) : undefined
  if (at === 0 || (username !== undefined && !USERNAME.test(username))) return null
  let rest = at > 0 ? value.slice(at + 1) : value
  let port: number | undefined
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0) return null
    const suffix = rest.slice(close + 1)
    if (suffix && !(allowPortSuffix || uri)) return null
    if (suffix && !suffix.startsWith(':')) return null
    const parsed = parsePort(suffix.slice(1))
    if (parsed === null) return null
    port = parsed
    rest = rest.slice(1, close)
  } else if ((allowPortSuffix || uri) && rest.split(':').length === 2) {
    const [host, portText] = rest.split(':')
    const parsed = parsePort(portText)
    if (parsed === null) return null
    port = parsed
    rest = host
  }
  if (!rest || !validHost(rest)) return null
  return { host: rest, ...(username ? { username } : {}), ...(port ? { port } : {}) }
}

/**
 * Recognises a pasted OpenSSH client invocation such as
 * `ssh -p 2222 -J bastion -i ~/.ssh/id_ed25519 root@10.0.0.5`. Only the first
 * line is read; options may follow the destination as OpenSSH allows, and a
 * trailing remote command is ignored. Multi-hop `-J a,b`
 * cannot be expressed as one jump host, so it is rejected rather than truncated.
 */
export function parseSshCommand(text: string): ParsedSshCommand | null {
  if (!text || text.length > MAX_LENGTH) return null
  const line = text.trim().split(/\r?\n/)[0]?.trim().replace(/^[$#>]\s+/, '') ?? ''
  const tokens = tokenize(line)
  if (!tokens || tokens.length < 2) return null
  if (!/^(?:.*[/\\])?ssh(?:\.exe)?$/i.test(tokens[0])) return null

  let port: number | undefined
  let login: string | undefined
  let identityFile: string | undefined
  let jumpSpec: string | undefined
  let destination: string | undefined

  const applyOption = (flag: string, value: string): boolean => {
    if (flag === 'p') {
      const parsed = parsePort(value)
      if (!parsed) return false
      port = parsed
    } else if (flag === 'l') {
      if (!USERNAME.test(value)) return false
      login = value
    } else if (flag === 'i') identityFile = value
    else if (flag === 'J') jumpSpec = value
    else if (flag === 'o') {
      const match = /^(\w+)\s*[= ]\s*(.+)$/.exec(value.trim())
      if (!match) return true
      const key = match[1].toLowerCase()
      if (key === 'port') return applyOption('p', match[2])
      if (key === 'user') return applyOption('l', match[2])
      if (key === 'identityfile') return applyOption('i', match[2])
      if (key === 'proxyjump') return applyOption('J', match[2])
    }
    return true
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') { destination ??= tokens[index + 1]; break }
    if (!token.startsWith('-') || token === '-') {
      // OpenSSH re-reads options after the destination; the next plain word starts the remote command.
      if (destination !== undefined) break
      destination = token
      continue
    }
    for (let position = 1; position < token.length; position += 1) {
      const flag = token[position]
      if (!/[A-Za-z0-9]/.test(flag)) return null
      if (!OPTIONS_WITH_VALUE.has(flag)) continue
      const attached = token.slice(position + 1)
      const value = attached || tokens[++index]
      if (value === undefined || !applyOption(flag, value)) return null
      break
    }
  }
  if (!destination) return null

  const target = parseSshEndpoint(destination, /^ssh:\/\//i.test(destination))
  if (!target) return null
  let jump: SshEndpoint | undefined
  if (jumpSpec !== undefined && jumpSpec.toLowerCase() !== 'none') {
    if (jumpSpec.includes(',')) return null
    const parsed = parseSshEndpoint(jumpSpec)
    if (!parsed) return null
    jump = parsed
  }
  const username = target.username ?? login
  const finalPort = target.port ?? port
  return {
    host: target.host,
    ...(username ? { username } : {}),
    ...(finalPort ? { port: finalPort } : {}),
    ...(jump ? { jump } : {}),
    ...(identityFile ? { identityFile } : {}),
  }
}

/** Compact `ssh user@host -p 22 -J jump` form for confirming what will be filled in. */
export function formatSshCommand(parsed: ParsedSshCommand) {
  const endpoint = (value: SshEndpoint) => {
    const host = value.host.includes(':') ? `[${value.host}]` : value.host
    return `${value.username ? `${value.username}@` : ''}${host}`
  }
  const jump = parsed.jump ? ` -J ${endpoint(parsed.jump)}${parsed.jump.port ? `:${parsed.jump.port}` : ''}` : ''
  return `ssh ${endpoint(parsed)}${parsed.port ? ` -p ${parsed.port}` : ''}${jump}`
}

/** File name of an `-i` identity path, used to match a Vault key of the same name. */
export function identityBaseName(path: string) {
  return path.split(/[/\\]/).pop()?.replace(/\.pem$/i, '') ?? ''
}
