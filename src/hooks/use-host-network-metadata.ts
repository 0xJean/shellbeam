import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  classifyHostAddress,
  getCachedPublicIpLocation,
  loadPublicIpLocationPersistedCache,
  lookupPublicIpLocation,
  type HostAddressMetadata,
  type PublicIpLocation,
} from '@/lib/ip-metadata'

export interface HostNetworkDisplay extends HostAddressMetadata {
  resolvedLocationLabel: string
  locationStatus: 'local' | 'pending' | 'loading' | 'ready' | 'error'
  countryCode?: string
  countryName?: string
}

type LocationEntry = {
  label: string
  status: HostNetworkDisplay['locationStatus']
  countryCode?: string
  countryName?: string
}

type LocationListener = () => void

let sharedLocations: Record<string, LocationEntry> = {}
const locationListeners = new Set<LocationListener>()
const inFlightLocationLookups = new Map<string, Promise<PublicIpLocation>>()
const inFlightPersistedLocationLoads = new Map<string, Promise<PublicIpLocation | null>>()

function emitLocationChange() {
  locationListeners.forEach((listener) => listener())
}

function subscribeLocationStore(listener: LocationListener) {
  locationListeners.add(listener)
  return () => locationListeners.delete(listener)
}

function getLocationSnapshot() {
  return sharedLocations
}

function setSharedLocation(address: string, entry: LocationEntry) {
  const current = sharedLocations[address]
  if (
    current?.label === entry.label
    && current.status === entry.status
    && current.countryCode === entry.countryCode
    && current.countryName === entry.countryName
  ) {
    return
  }

  sharedLocations = { ...sharedLocations, [address]: entry }
  emitLocationChange()
}

function startSharedLocationLookup(ip: string) {
  const existing = inFlightLocationLookups.get(ip)
  if (existing) return existing

  const promise = lookupPublicIpLocation(ip)
    .finally(() => {
      inFlightLocationLookups.delete(ip)
    })
  inFlightLocationLookups.set(ip, promise)
  return promise
}

function loadSharedPersistedLocation(ip: string) {
  const cached = getCachedPublicIpLocation(ip)
  if (cached) return Promise.resolve(cached)

  const existing = inFlightPersistedLocationLoads.get(ip)
  if (existing) return existing

  const promise = loadPublicIpLocationPersistedCache([ip])
    .then((cache) => cache[ip] ?? null)
    .finally(() => {
      inFlightPersistedLocationLoads.delete(ip)
    })
  inFlightPersistedLocationLoads.set(ip, promise)
  return promise
}

export function clearHostNetworkMetadataMemoryCache() {
  sharedLocations = {}
  inFlightLocationLookups.clear()
  inFlightPersistedLocationLoads.clear()
  emitLocationChange()
}

function createDisplay(
  metadata: HostAddressMetadata,
  location?: { label?: string; countryCode?: string; countryName?: string },
  status?: HostNetworkDisplay['locationStatus'],
): HostNetworkDisplay {
  return {
    ...metadata,
    resolvedLocationLabel: location?.label ?? metadata.locationLabel,
    countryCode: location?.countryCode,
    countryName: location?.countryName,
    locationStatus: status ?? (metadata.canLookupLocation ? 'pending' : 'local'),
  }
}

export function useHostNetworkMetadata(addresses: string[]) {
  const addressKey = addresses.map((address) => address.trim()).filter(Boolean).sort().join('\0')
  const uniqueAddresses = useMemo(() => (
    Array.from(new Set(addressKey.split('\0').filter(Boolean)))
  ), [addressKey])
  const locations = useSyncExternalStore(subscribeLocationStore, getLocationSnapshot, getLocationSnapshot)

  const metadataByAddress = useMemo(() => {
    return uniqueAddresses.reduce<Record<string, HostNetworkDisplay>>((next, address) => {
      const metadata = classifyHostAddress(address)
      const cached = metadata.publicIp ? getCachedPublicIpLocation(metadata.publicIp) : null
      const known = locations[address]
      next[address] = createDisplay(
        metadata,
        {
          label: known?.label ?? cached?.locationLabel,
          countryCode: known?.countryCode ?? cached?.countryCode,
          countryName: known?.countryName ?? cached?.countryName,
        },
        known?.status ?? (cached ? 'ready' : undefined),
      )
      return next
    }, {})
  }, [locations, uniqueAddresses])

  useEffect(() => {
    uniqueAddresses.forEach((address) => {
      const metadata = classifyHostAddress(address)
      if (!metadata.publicIp || !metadata.canLookupLocation) return
      if (sharedLocations[address]?.status === 'ready' || sharedLocations[address]?.status === 'loading') return

      const ip = metadata.publicIp
      setSharedLocation(address, { label: '地区查询中', status: 'loading' })

      void loadSharedPersistedLocation(ip)
        .then((persisted) => {
          if (persisted) {
            setSharedLocation(address, {
              label: persisted.locationLabel,
              status: 'ready',
              countryCode: persisted.countryCode,
              countryName: persisted.countryName,
            })
            return null
          }
          return startSharedLocationLookup(ip)
        })
        .then((location) => {
          if (!location) return
          setSharedLocation(address, {
            label: location.locationLabel,
            status: 'ready',
            countryCode: location.countryCode,
            countryName: location.countryName,
          })
        })
        .catch(() => {
          setSharedLocation(address, { label: '地区未知', status: 'error' })
        })
    })

    return undefined
  }, [uniqueAddresses])

  return metadataByAddress
}
