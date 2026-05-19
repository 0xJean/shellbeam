import type { HostProfile } from './hosts'

interface ProviderConsoleLink {
  label: string
  url: string
  aliases: string[]
}

export interface ServerConsoleLink {
  label: string
  url: string
  source: 'tag' | 'provider'
}

const EXPLICIT_CONSOLE_PREFIXES = [
  'console:',
  'console=',
  'control-panel:',
  'control-panel=',
  'panel:',
  'panel=',
]

const PROVIDER_CONSOLE_LINKS: ProviderConsoleLink[] = [
  {
    label: 'Contabo',
    url: 'https://my.contabo.com/account/login',
    aliases: ['contabo'],
  },
]

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

function findExplicitConsoleUrl(values: string[]) {
  for (const value of values) {
    const trimmed = value.trim()
    const lower = trimmed.toLowerCase()
    for (const prefix of EXPLICIT_CONSOLE_PREFIXES) {
      if (lower.startsWith(prefix)) {
        const parsed = parseHttpUrl(trimmed.slice(prefix.length))
        if (parsed) return parsed
      }
    }
  }
  return null
}

export function getServerConsoleLink(host: HostProfile): ServerConsoleLink | null {
  const explicitUrl = findExplicitConsoleUrl(host.tags ?? [])
  if (explicitUrl) {
    return {
      label: '服务器',
      url: explicitUrl,
      source: 'tag',
    }
  }

  const hostHints = [host.group, ...(host.tags ?? [])].map(normalize).filter(Boolean)
  const provider = PROVIDER_CONSOLE_LINKS.find((candidate) => {
    const aliases = [candidate.label, ...candidate.aliases].map(normalize)
    return aliases.some((alias) => hostHints.includes(alias))
  })

  if (!provider) return null

  return {
    label: provider.label,
    url: provider.url,
    source: 'provider',
  }
}
