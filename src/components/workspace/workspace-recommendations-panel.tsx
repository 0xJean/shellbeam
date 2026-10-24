import { useEffect, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { useT } from '@/lib/i18n'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { useWorkspaceProviderState } from '@/lib/workspace-provider-state'
import { loadLocalAlertState, LOCAL_OPS_CHANGED_EVENT } from '@/lib/local-ops-store'
import { getWorkspaceRecommendations, type WorkspaceRecommendation } from '@/lib/workspace-recommendations'
import { COLLECTION_LIMITS } from '@/lib/collection-limits'

export interface WorkspaceRecommendationsPanelProps {
  host: HostProfile | null
  hosts?: HostProfile[]
  vaultId?: string
  onSelectApp: (app: WorkspaceAppId) => void
  recommendations?: WorkspaceRecommendation[]
}
export function WorkspaceRecommendationsPanel({ host, hosts, vaultId, onSelectApp, recommendations }: WorkspaceRecommendationsPanelProps) {
  const { t } = useT()
  const { view, now } = useWorkspaceProviderState({ host, hosts, vaultId })
  const inventories = useWorkspaceInventoryStates()
  const [, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => { setRevision((value) => value + 1) }
    window.addEventListener(LOCAL_OPS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  const scopedHost = host && (!vaultId || !host.vaultId || host.vaultId === vaultId)
    ? host.vaultId || !vaultId ? host : { ...host, vaultId }
    : null
  const selected = scopedHost && view?.host.id === scopedHost.id
    && (!scopedHost.vaultId || view.host.vaultId === scopedHost.vaultId) ? view : null
  const inventory = scopedHost ? inventories[getWorkspaceInventoryHostKey(scopedHost)] : undefined
  const freshness = selected?.health.freshness
  // Resource recommendations must describe the same observation as the main
  // cards. Asset refreshes and other providers' samples cannot renew its TTL.
  const sampledAt = freshness?.sampledAt
  const expiresAt = freshness?.expiresAt
  const ttlMs = freshness?.ttlMs
  const metrics = selected?.health.state === 'online' && selected.metrics && freshness && !freshness.stale
    && typeof sampledAt === 'number' && Number.isFinite(sampledAt) && sampledAt > 0 && sampledAt <= now
    && selected.metrics.sampledAt === sampledAt
    && typeof expiresAt === 'number' && Number.isFinite(expiresAt)
    && typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0
    && now <= Math.min(expiresAt, sampledAt + ttlMs) ? selected.metrics : null
  const assetAge = inventory?.inventory ? now - inventory.inventory.scannedAt : Number.NaN
  const assets = inventory?.status === 'ready' && assetAge >= 0 && assetAge <= COLLECTION_LIMITS.cadence.inventoryTtlMs ? inventory.inventory : null
  const alerts = scopedHost ? loadLocalAlertState(scopedHost.vaultId, scopedHost.id).alerts.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged') : []
  const items = recommendations ?? getWorkspaceRecommendations({
    diskUsagePercent: metrics?.diskPercent ?? undefined, cpuUsagePercent: metrics?.cpuPercent ?? undefined,
    memoryUsagePercent: metrics?.memoryPercent ?? undefined,
    failedServiceCount: assets?.services.filter((service) => service.active === 'failed').length,
    hasNginx: assets?.services.some((service) => service.name.startsWith('nginx')),
    hasDocker: assets?.tools.some((tool) => tool.binary === 'docker'), openAlertCount: alerts.length, offline: selected?.health.state === 'offline',
  })
  function label(app: WorkspaceAppId) {
    if (app === 'fileSystem') return t('workspace.diagnostics.openFileSystem')
    if (app === 'fileTransfer') return t('workspace.action.openFiles')
    if (app === 'logs') return t('workspace.diagnostics.openLogs')
    if (app === 'processes') return t('workspace.diagnostics.openProcesses')
    if (app === 'services') return t('workspace.action.openServices')
    return t('workspace.action.openTerminal')
  }
  if (items.length === 0) return null
  return <section data-testid="workspace-recommendations" className="space-y-3 rounded-xl border border-border/60 bg-card/90 p-4">
    <h2 className="text-sm font-semibold">{t('workspace.section.recommendations')}</h2>
    {items.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"><span className="text-xs font-medium">{item.title}</span><button type="button" onClick={() => onSelectApp(item.targetApp)} className="shrink-0 rounded border px-2 py-1 text-xs">{label(item.targetApp)}</button></div>)}
  </section>
}
