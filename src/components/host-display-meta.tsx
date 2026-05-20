import { CountryFlag, getCountryFlagCode } from '@/components/country-flag'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceInventoryHostKey, type WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import type { WorkspaceInventoryHostState } from '@/lib/workspace-inventory-state'
import { MapPin } from 'lucide-react'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'

type ResourceLike = Pick<WorkspaceInventoryResource, 'os'> | null | undefined

export function resolveHostForDisplay(hosts: HostProfile[], hostId?: string | null, hostAddress?: string | null) {
  if (hostId) {
    const byId = hosts.find((host) => host.id === hostId)
    if (byId) return byId
  }
  if (hostAddress) {
    const byAddress = hosts.find((host) => host.address === hostAddress)
    if (byAddress) return byAddress
  }
  return null
}

export function getHostInventoryResource(
  host: HostProfile | null | undefined,
  states: Record<string, WorkspaceInventoryHostState>,
) {
  return host ? states[getWorkspaceInventoryHostKey(host)]?.inventory?.resource : undefined
}

export function getHostRegionFlagName(network: HostNetworkDisplay | undefined) {
  return network?.countryName ?? network?.resolvedLocationLabel
}

interface HostRegionMetaProps {
  network?: HostNetworkDisplay
  label?: string
  className?: string
  iconClassName?: string
  textClassName?: string
  showText?: boolean
  fallbackKey?: string
}

export function HostRegionMeta({
  network,
  label,
  className,
  iconClassName,
  textClassName,
  showText = true,
  fallbackKey = 'hosts.locationUnknown',
}: HostRegionMetaProps) {
  const { t } = useT()
  const displayLabel = label ?? network?.resolvedLocationLabel ?? t(fallbackKey)
  const countryName = getHostRegionFlagName(network) ?? displayLabel
  const countryCode = getCountryFlagCode(network?.countryCode, countryName)

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {countryCode ? (
        <CountryFlag
          countryCode={network?.countryCode ?? countryCode}
          countryName={countryName}
          className={iconClassName}
        />
      ) : (
        <MapPin className={cn('h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]', iconClassName)} />
      )}
      {showText && <span className={cn('truncate', textClassName)}>{displayLabel}</span>}
    </span>
  )
}

interface HostSystemMetaProps {
  resource?: ResourceLike
  os?: string | null
  className?: string
  iconClassName?: string
  textClassName?: string
  showText?: boolean
  fallbackKey?: string
}

export function HostSystemMeta({
  resource,
  os,
  className,
  iconClassName,
  textClassName,
  showText = true,
  fallbackKey = 'workspace.asset.versionPending',
}: HostSystemMetaProps) {
  const { t } = useT()
  const osLabel = os ?? resource?.os ?? ''

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <WorkspaceOsIcon os={osLabel} className={cn('h-3.5 w-3.5 text-[var(--workspace-text-muted)]', iconClassName)} />
      {showText && <span className={cn('truncate', textClassName)}>{osLabel || t(fallbackKey)}</span>}
    </span>
  )
}

interface HostMetadataLineProps {
  network?: HostNetworkDisplay
  resource?: ResourceLike
  regionLabel?: string
  className?: string
  itemClassName?: string
  iconClassName?: string
  textClassName?: string
  showLocation?: boolean
  showSystem?: boolean
  showLocationText?: boolean
  showSystemText?: boolean
  systemFallbackKey?: string
  locationFallbackKey?: string
}

export function HostMetadataLine({
  network,
  resource,
  regionLabel,
  className,
  itemClassName,
  iconClassName,
  textClassName,
  showLocation = true,
  showSystem = true,
  showLocationText = true,
  showSystemText = true,
  systemFallbackKey,
  locationFallbackKey,
}: HostMetadataLineProps) {
  if (!showLocation && !showSystem) return null

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--workspace-text-subtle)]', className)}>
      {showLocation && (
        <HostRegionMeta
          network={network}
          label={regionLabel}
          className={itemClassName}
          iconClassName={iconClassName}
          textClassName={textClassName}
          showText={showLocationText}
          fallbackKey={locationFallbackKey}
        />
      )}
      {showSystem && (
        <HostSystemMeta
          resource={resource}
          className={itemClassName}
          iconClassName={iconClassName}
          textClassName={textClassName}
          showText={showSystemText}
          fallbackKey={systemFallbackKey}
        />
      )}
    </div>
  )
}
