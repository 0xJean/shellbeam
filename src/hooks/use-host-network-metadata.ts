import { useEffect, useMemo, useState } from 'react'
import {
  classifyHostAddress,
  getCachedPublicIpLocation,
  lookupPublicIpLocation,
  type HostAddressMetadata,
} from '@/lib/ip-metadata'

export interface HostNetworkDisplay extends HostAddressMetadata {
  resolvedLocationLabel: string
  locationStatus: 'local' | 'pending' | 'loading' | 'ready' | 'error'
  countryCode?: string
  countryName?: string
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
  const [locations, setLocations] = useState<Record<string, { label: string; status: HostNetworkDisplay['locationStatus']; countryCode?: string; countryName?: string }>>({})

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
    let cancelled = false
    const lookups: Array<{ address: string; ip: string }> = []

    setLocations((prev) => {
      const next = { ...prev }
      uniqueAddresses.forEach((address) => {
        const metadata = classifyHostAddress(address)
        if (!metadata.publicIp || !metadata.canLookupLocation) return
        if (next[address]?.status === 'ready' || next[address]?.status === 'loading') return
        const cached = getCachedPublicIpLocation(metadata.publicIp)
        if (cached) {
          next[address] = {
            label: cached.locationLabel,
            status: 'ready',
            countryCode: cached.countryCode,
            countryName: cached.countryName,
          }
          return
        }

        next[address] = { label: '地区查询中', status: 'loading' }
        lookups.push({ address, ip: metadata.publicIp })
      })
      return next
    })

    lookups.forEach(({ address, ip }) => {
      const metadata = classifyHostAddress(address)
      if (!metadata.publicIp || metadata.publicIp !== ip) return
      void lookupPublicIpLocation(ip)
        .then((location) => {
          if (!cancelled) {
            setLocations((prev) => ({
              ...prev,
              [address]: {
                label: location.locationLabel,
                status: 'ready',
                countryCode: location.countryCode,
                countryName: location.countryName,
              },
            }))
          }
        })
        .catch(() => {
          if (!cancelled) setLocations((prev) => ({ ...prev, [address]: { label: '地区未知', status: 'error' } }))
        })
    })

    return () => {
      cancelled = true
    }
  }, [uniqueAddresses])

  return metadataByAddress
}
