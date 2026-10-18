import { useEffect, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import type { WorkspaceAppId } from '@/lib/workspace'
import { useT } from '@/lib/i18n'
import { useServerMonitorStates } from '@/lib/server-monitor-state'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getServerMonitorHostKey } from '@/lib/server-monitor'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { loadLocalAlertState, LOCAL_OPS_CHANGED_EVENT } from '@/lib/local-ops-store'
import { getWorkspaceRecommendations, type WorkspaceRecommendation } from '@/lib/workspace-recommendations'

export interface WorkspaceRecommendationsPanelProps {
  host: HostProfile | null
  vaultId?: string
  onSelectApp: (app: WorkspaceAppId) => void
  recommendations?: WorkspaceRecommendation[]
}
export function WorkspaceRecommendationsPanel({ host, vaultId, onSelectApp, recommendations }: WorkspaceRecommendationsPanelProps) {
  const { t } = useT()
  const monitors = useServerMonitorStates()
  const inventories = useWorkspaceInventoryStates()
  const [, setRevision] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const refresh = () => { setRevision((value) => value + 1); setNow(Date.now()) }
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    window.addEventListener(LOCAL_OPS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { clearInterval(timer); window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  const monitor = host ? monitors[getServerMonitorHostKey(host)]?.latest : undefined
  const inventory = host ? inventories[getWorkspaceInventoryHostKey(host)] : undefined
  const metrics = monitor?.status === 'online' && monitor.snapshot && now - monitor.snapshot.sampledAt <= 5 * 60_000 ? monitor.snapshot : null
  const assets = inventory?.status === 'ready' && inventory.updatedAt && now - inventory.updatedAt <= 5 * 60_000 ? inventory.inventory : null
  const alerts = host ? loadLocalAlertState(vaultId ?? host.vaultId, host.id).alerts.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged') : []
  const items = recommendations ?? getWorkspaceRecommendations({
    diskUsagePercent: metrics?.diskPercent ?? undefined, cpuUsagePercent: metrics?.cpuPercent ?? undefined,
    memoryUsagePercent: metrics?.memoryPercent ?? undefined,
    failedServiceCount: assets?.services.filter((service) => service.active === 'failed').length,
    hasNginx: assets?.services.some((service) => service.name.startsWith('nginx')),
    hasDocker: assets?.tools.some((tool) => tool.binary === 'docker'), openAlertCount: alerts.length, offline: monitor?.status === 'offline',
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
