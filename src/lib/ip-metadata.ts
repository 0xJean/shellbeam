import { invoke } from '@tauri-apps/api/core'
import { t } from './i18n'

export type HostAddressType = 'ipv4' | 'ipv6' | 'domain' | 'unknown'
export type HostAddressScope = 'public' | 'private' | 'loopback' | 'linkLocal' | 'carrierNat' | 'reserved' | 'multicast' | 'domain' | 'unknown'

export interface HostAddressMetadata {
  address: string
  addressType: HostAddressType
  scope: HostAddressScope
  versionLabel: string
  scopeLabel: string
  locationLabel: string
  publicIp: string | null
  canLookupLocation: boolean
}

export interface PublicIpLocation {
  ip: string
  locationLabel: string
  countryCode?: string
  countryName?: string
  provider: string
  updatedAt: number
}

const IP_GEO_CACHE_KEY = 'shellbeam.ipGeoCache.v1'
const IP_GEO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function normalizeAddress(address: string) {
  const trimmed = address.trim()
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketedIpv6) return bracketedIpv6[1]

  const hostWithPort = trimmed.match(/^([^:]+):\d+$/)
  if (hostWithPort) return hostWithPort[1]

  return trimmed
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : Number.NaN
  })

  return octets.every(Number.isFinite) ? octets : null
}

function isHostname(address: string) {
  return /^[a-z0-9.-]+$/i.test(address) && /[a-z]/i.test(address)
}

function classifyIpv4(octets: number[]): HostAddressScope {
  const [a, b] = octets
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'linkLocal'
  if (a === 100 && b >= 64 && b <= 127) return 'carrierNat'
  if (a >= 224 && a <= 239) return 'multicast'
  const c = octets[2]
  if (
    a === 0
    || a >= 240
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  ) {
    return 'reserved'
  }
  return 'public'
}

function classifyIpv6(address: string): HostAddressScope {
  const normalized = address.toLowerCase().split('%')[0]
  const first = normalized.split(':').find(Boolean) ?? ''
  if (normalized === '::' || normalized.startsWith('2001:db8:')) return 'reserved'
  if (normalized === '::1') return 'loopback'
  if (/^f[cd]/.test(first)) return 'private'
  if (/^fe[89ab]/.test(first)) return 'linkLocal'
  if (/^ff/.test(first)) return 'multicast'
  return 'public'
}

function scopeLabel(scope: HostAddressScope) {
  if (scope === 'public') return t('hosts.networkPublic')
  if (scope === 'private') return t('hosts.networkPrivate')
  if (scope === 'loopback') return t('hosts.networkLocal')
  if (scope === 'linkLocal') return t('hosts.networkLinkLocal')
  if (scope === 'carrierNat') return t('hosts.networkCarrierNat')
  if (scope === 'reserved') return t('hosts.networkReserved')
  if (scope === 'multicast') return t('hosts.networkMulticast')
  if (scope === 'domain') return t('hosts.networkDomain')
  return t('hosts.networkUnknown')
}

function defaultLocationLabel(scope: HostAddressScope) {
  if (scope === 'public') return t('hosts.locationPending')
  if (scope === 'domain') return t('hosts.locationDomain')
  if (scope === 'private') return t('hosts.locationPrivate')
  if (scope === 'loopback') return t('hosts.locationLocal')
  if (scope === 'linkLocal') return t('hosts.locationLinkLocal')
  if (scope === 'carrierNat') return t('hosts.locationCarrierNat')
  if (scope === 'reserved' || scope === 'multicast') return t('hosts.locationNotLocatable')
  return t('hosts.locationUnknown')
}

export function classifyHostAddress(rawAddress: string): HostAddressMetadata {
  const address = normalizeAddress(rawAddress)
  const ipv4 = parseIpv4(address)

  if (ipv4) {
    const scope = classifyIpv4(ipv4)
    return {
      address,
      addressType: 'ipv4',
      scope,
      versionLabel: 'IPv4',
      scopeLabel: scopeLabel(scope),
      locationLabel: defaultLocationLabel(scope),
      publicIp: scope === 'public' ? address : null,
      canLookupLocation: scope === 'public',
    }
  }

  if (address.includes(':') && /^[0-9a-f:.%]+$/i.test(address)) {
    const scope = classifyIpv6(address)
    return {
      address,
      addressType: 'ipv6',
      scope,
      versionLabel: 'IPv6',
      scopeLabel: scopeLabel(scope),
      locationLabel: defaultLocationLabel(scope),
      publicIp: scope === 'public' ? address : null,
      canLookupLocation: scope === 'public',
    }
  }

  if (isHostname(address)) {
    return {
      address,
      addressType: 'domain',
      scope: 'domain',
      versionLabel: t('hosts.networkDomain'),
      scopeLabel: scopeLabel('domain'),
      locationLabel: defaultLocationLabel('domain'),
      publicIp: null,
      canLookupLocation: false,
    }
  }

  return {
    address,
    addressType: 'unknown',
    scope: 'unknown',
    versionLabel: t('workspace.asset.unknown'),
    scopeLabel: scopeLabel('unknown'),
    locationLabel: defaultLocationLabel('unknown'),
    publicIp: null,
    canLookupLocation: false,
  }
}

function readLocationCache(): Record<string, PublicIpLocation> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(IP_GEO_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isPublicIpLocation(value: unknown): value is PublicIpLocation {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<PublicIpLocation>
  return typeof record.ip === 'string'
    && typeof record.locationLabel === 'string'
    && typeof record.provider === 'string'
    && typeof record.updatedAt === 'number'
}

function writeLocationCache(cache: Record<string, PublicIpLocation>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(IP_GEO_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Location cache is best effort only.
  }
}

async function invokeIpLocationCommand<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args)
  } catch {
    return null
  }
}

function isFreshPublicIpLocation(location: PublicIpLocation) {
  return Date.now() - location.updatedAt <= IP_GEO_CACHE_TTL_MS
}

export function getCachedPublicIpLocation(ip: string): PublicIpLocation | null {
  const cached = readLocationCache()[ip]
  if (!isPublicIpLocation(cached) || !isFreshPublicIpLocation(cached)) return null
  return cached
}

export async function loadPublicIpLocationPersistedCache(ips: string[]): Promise<Record<string, PublicIpLocation>> {
  const uniqueIps = Array.from(new Set(ips.map((ip) => ip.trim()).filter(Boolean)))
  const localCache = readLocationCache()
  const cache = uniqueIps.reduce<Record<string, PublicIpLocation>>((next, ip) => {
    const local = localCache[ip]
    if (isPublicIpLocation(local) && isFreshPublicIpLocation(local)) next[ip] = local
    return next
  }, {})

  const snapshots = await invokeIpLocationCommand<unknown[]>('list_public_ip_locations', { ips: uniqueIps })
  if (!snapshots) return cache

  snapshots.forEach((snapshot) => {
    if (!isPublicIpLocation(snapshot) || !isFreshPublicIpLocation(snapshot)) return
    cache[snapshot.ip] = snapshot
    localCache[snapshot.ip] = snapshot
  })
  writeLocationCache(localCache)

  return cache
}

export async function savePublicIpLocationCacheEntry(location: PublicIpLocation) {
  const localCache = readLocationCache()
  localCache[location.ip] = location
  writeLocationCache(localCache)

  await invokeIpLocationCommand<void>('upsert_public_ip_location', { payload: location })
  return location
}

function compactLocation(parts: Array<string | null | undefined>) {
  const seen = new Set<string>()
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .filter((part) => {
      const key = part.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(' · ')
}

function normalizeCountryCode(value: unknown) {
  return typeof value === 'string' && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : undefined
}

export async function lookupPublicIpLocation(ip: string): Promise<PublicIpLocation> {
  const cached = getCachedPublicIpLocation(ip)
  if (cached) return cached
  if (typeof fetch === 'undefined') throw new Error('fetch unavailable')

  const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`)
  if (!response.ok) throw new Error(`IP location lookup failed: ${response.status}`)

  const data = await response.json() as Record<string, unknown>
  if (data.error) throw new Error(String(data.reason ?? data.error))

  const locationLabel = compactLocation([
    typeof data.country_name === 'string' ? data.country_name : undefined,
    typeof data.region === 'string' ? data.region : undefined,
    typeof data.city === 'string' ? data.city : undefined,
  ]) || (typeof data.timezone === 'string' ? data.timezone : undefined) || t('hosts.locationUnknown')
  const countryCode = normalizeCountryCode(data.country_code)
  const countryName = typeof data.country_name === 'string' ? data.country_name : undefined

  const location: PublicIpLocation = {
    ip,
    locationLabel,
    countryCode,
    countryName,
    provider: 'ipapi.co',
    updatedAt: Date.now(),
  }
  return savePublicIpLocationCacheEntry(location)
}
