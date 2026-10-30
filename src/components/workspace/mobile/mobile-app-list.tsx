import { useT } from '@/lib/i18n'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import { formatBytesRate } from '@/lib/metric-series'
import type { WorkspaceAppId } from '@/lib/workspace'
import { SpringboardApp } from './mobile-home-screen'
import type { MobileHomeData } from './use-mobile-home-data'

const GROUPS: Array<{ key: 'session' | 'observe' | 'manage'; apps: WorkspaceAppId[] }> = [
  { key: 'session', apps: ['terminal', 'browser', 'overview', 'assetInventory'] },
  { key: 'observe', apps: ['processes', 'services', 'network', 'logs', 'charts'] },
  { key: 'manage', apps: ['fileTransfer', 'fileSystem', 'docker', 'scheduledTasks', 'sitesSsl', 'toolManager'] },
]

/** v3 `m:apps`: the same apps grouped in sections, with the live metric strip on top. */
export function MobileAppList({ data, onOpen, onQuickActions }: { data: MobileHomeData; onOpen: (app: WorkspaceAppId) => void; onQuickActions: (app: WorkspaceAppId) => void }) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const metrics = data.metrics
  const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`
  const cells = metrics ? [
    { key: 'cpu', label: copy.cpu, value: percent(metrics.cpuPercent) },
    { key: 'memory', label: copy.memory, value: percent(metrics.memoryPercent) },
    { key: 'disk', label: copy.disk, value: percent(metrics.diskPercent) },
    { key: 'network', label: `${copy.net} ↓`, value: metrics.networkRxBytesPerSec == null ? '—' : formatBytesRate(metrics.networkRxBytesPerSec).replace(/\/s$/, '') },
  ] : []
  return <div data-testid="mobile-app-list" className="space-y-4 px-4">
    {cells.length > 0 && <div data-testid="mobile-app-list-metrics" className="grid grid-cols-4 gap-2">
      {cells.map((cell) => <div key={cell.key} className="min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-2">
        <div className="truncate text-[11px] text-[var(--workspace-text-muted)]">{cell.label}</div>
        <div className="truncate text-[17px] font-semibold text-[var(--workspace-text-strong)]">{cell.value}</div>
      </div>)}
    </div>}
    {GROUPS.map((group) => <section key={group.key} aria-label={copy.groups[group.key]}>
      <h3 className="px-3 pb-1.5 text-[13px] font-medium text-[var(--workspace-text-muted)]">{copy.groups[group.key]}</h3>
      <div className="grid grid-cols-4 gap-y-3 rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-1 py-3">
        {group.apps.map((app) => <SpringboardApp key={app} app={app} data={data} onOpen={onOpen} onQuickActions={onQuickActions} compact />)}
      </div>
    </section>)}
  </div>
}
