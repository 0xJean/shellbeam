import type { ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import type { HostOpsHealthState } from '@/lib/host-ops-view'
import { healthDotClass, shortOsLabel } from '@/lib/workspace-overview-display'
import { cn } from '@/lib/utils'
import { HostRegionMeta } from '../host-display-meta'

interface WorkspaceHostCardProps {
  hostName: string
  hostAddress: string
  host: HostProfile | null
  network?: HostNetworkDisplay
  resource?: WorkspaceInventoryResource
  health?: HostOpsHealthState
  children?: ReactNode
}

/** v3 list-layout host card: status, address and region, tags, then the layout toggle. */
export function WorkspaceHostCard({ hostName, hostAddress, host, network, resource, health, children }: WorkspaceHostCardProps) {
  const os = shortOsLabel(resource?.os)
  const tag = host?.tags.find((value) => value.trim())
  return (
    <div data-testid="workspace-host-card" className="sb-card p-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span data-testid="workspace-host-card-status" data-health={health ?? 'unknown'} className={cn('h-2 w-2 shrink-0 rounded-full', healthDotClass(health))} aria-hidden="true" />
        <b className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{hostName}</b>
      </div>
      <div className="mb-2 mt-1 flex min-w-0 flex-wrap items-center gap-x-1 font-mono text-[11px] text-[var(--workspace-text-muted)]">
        <span className="min-w-0 truncate">{host?.username ? `${host.username}@${hostAddress}` : hostAddress}</span>
        {network && <HostRegionMeta network={network} className="min-w-0 shrink" iconClassName="h-3 w-3" />}
      </div>
      {(tag || os) && <div className="mb-2.5 flex min-w-0 flex-wrap gap-1">
        {tag && <span className="max-w-full truncate rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-text)]">{tag}</span>}
        {os && <span className="max-w-full truncate rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-text)]">{os}</span>}
      </div>}
      {children}
    </div>
  )
}
