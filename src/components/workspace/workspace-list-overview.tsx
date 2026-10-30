import type { HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import { useWorkspaceProviderState } from '@/lib/workspace-provider-state'
import { FolderOpen, RotateCw, SquareTerminal } from 'lucide-react'
import { Button } from '../ui/button'
import { HostMetadataLine } from '../host-display-meta'
import { healthDotClass, serviceRows, type ServiceTone } from '@/lib/workspace-overview-display'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { WorkspaceDataSourcesCard } from './workspace-provider-summary'
import { ProviderHistoryPanel } from './provider-history-panel'
import { ShellbeamAgentPanel } from './shellbeam-agent-panel'
import { WorkspaceRecommendationsPanel } from './workspace-recommendations-panel'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'

const TONE_DOT: Record<ServiceTone, string> = {
  ok: 'bg-[var(--workspace-status-good)]',
  warn: 'bg-[var(--workspace-status-warn)]',
  bad: 'bg-[var(--workspace-status-bad)]',
}

function ServicesCard({ inventory, onOpenServices, className }: { inventory?: WorkspaceInventory; onOpenServices: () => void; className?: string }) {
  const { locale } = useT()
  const copy = workspaceOverviewCopy[locale]
  const rows = serviceRows(inventory)
  const bad = rows.filter((row) => row.tone !== 'ok').length
  return (
    <section data-testid="workspace-services-card" className={cn('sb-card flex min-w-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
        <h3 className="flex min-w-0 items-baseline gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
          <span className="truncate">{copy.servicesContainers}</span>
          {rows.length > 0 && <small className="shrink-0 text-[11.5px] font-normal text-[var(--workspace-text-muted)]">{copy.servicesCount.replace('{count}', String(rows.length)).replace('{bad}', String(bad))}</small>}
        </h3>
        <button type="button" onClick={onOpenServices} className="shrink-0 font-mono text-[11.5px] text-[var(--workspace-accent-text)] hover:underline">{copy.viewAll}</button>
      </div>
      {rows.length === 0
        ? <p className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{copy.noInventory}</p>
        : <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row) => (
            <div key={`${row.kind}:${row.name}`} data-testid="workspace-service-row" data-tone={row.tone} className="flex items-center gap-2.5 border-t border-[color:var(--workspace-border-soft)] px-4 py-[7px] text-[12.5px] first:border-t-0">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[row.tone])} aria-hidden="true" />
              <b className="min-w-0 flex-1 truncate font-medium text-[var(--workspace-text-strong)]">{row.name}</b>
              <span className="shrink-0 rounded bg-[var(--workspace-surface-800)] px-1.5 text-[10.5px] leading-[18px] text-[var(--workspace-text-muted)]">{copy[row.kind]}</span>
              <span className="w-24 shrink-0 truncate text-right font-mono text-[11px] text-[var(--workspace-text-muted)]" title={row.state}>{row.state}</span>
            </div>
          ))}
        </div>}
    </section>
  )
}

interface WorkspaceListOverviewProps {
  activeVaultId?: string
  hostName: string
  hostAddress: string
  host: HostProfile | null
  hosts: HostProfile[]
  network?: HostNetworkDisplay
  inventory?: WorkspaceInventory
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
  onSelectApp: (app: WorkspaceAppId) => void
}

/** v3 workspace overview: header, live metrics, history and sources, then services, probe and suggestions. */
export function WorkspaceListOverview({ activeVaultId, hostName, hostAddress, host, hosts, network, inventory, resolveAuthSecret, onSelectApp }: WorkspaceListOverviewProps) {
  const { t, locale } = useT()
  const copy = workspaceOverviewCopy[locale]
  const provider = useWorkspaceProviderState({ host, hosts, vaultId: activeVaultId })
  const tag = host?.tags.find((value) => value.trim())
  return (
    <div data-testid="workspace-list-overview" className="mx-auto flex max-w-[1400px] flex-col gap-3.5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-2.5 text-xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', healthDotClass(provider.view?.health.state))} aria-hidden="true" />
            <span className="truncate">{hostName}</span>
            {tag && <span className="shrink-0 rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--workspace-text)]">{tag}</span>}
          </h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 text-[12.5px] text-[var(--workspace-text-muted)]">
            <span className="font-mono">{host?.username ? `${host.username}@${hostAddress}` : hostAddress}</span>
            <HostMetadataLine network={network} resource={inventory?.resource} className="text-[12.5px] text-[var(--workspace-text-muted)]" itemClassName="max-w-[14rem]" iconClassName="h-3.5 w-3.5" />
            {inventory?.resource.uptime && <span>{inventory.resource.uptime}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="ghost" className="gap-1.5" disabled={provider.loading} onClick={() => void provider.refresh()}><RotateCw className={cn('h-3.5 w-3.5', provider.loading && 'animate-spin')} />{copy.refresh}</Button>
          <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => onSelectApp('fileTransfer')}><FolderOpen className="h-3.5 w-3.5" />{copy.sftp}</Button>
          <Button type="button" size="sm" className="gap-1.5" onClick={() => onSelectApp('terminal')}><SquareTerminal className="h-3.5 w-3.5" />{t('workspace.action.openTerminal')}</Button>
        </div>
      </div>

      {host && <WorkspaceOperationRecoveryNotice host={host} vaultId={activeVaultId} />}

      <WorkspaceStatusCards activeVaultId={activeVaultId} hostAddress={hostAddress} selectedHostId={host?.id ?? null} hosts={hosts} resolveAuthSecret={resolveAuthSecret} showProviderSummary={false} showAgent={false} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-3.5">
        {activeVaultId && host ? <ProviderHistoryPanel vaultId={activeVaultId} hostId={host.id} className="min-h-[300px]" /> : null}
        <WorkspaceDataSourcesCard state={provider} className="min-h-[300px]" />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16.5rem),1fr))] gap-3.5">
        <ServicesCard inventory={inventory} onOpenServices={() => onSelectApp('services')} className="max-h-[300px] min-h-[220px]" />
        <ShellbeamAgentPanel variant="card" host={host} vaultId={activeVaultId} resolveAuthSecret={resolveAuthSecret} className="min-h-[220px]" />
        <WorkspaceRecommendationsPanel host={host} hosts={hosts} vaultId={activeVaultId} onSelectApp={onSelectApp} className="flex max-h-[300px] min-h-[220px] flex-col" />
      </div>
    </div>
  )
}
