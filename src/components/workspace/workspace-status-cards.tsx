import type { HostProfile } from '@/lib/hosts'
import { resolveWorkspaceMetricsHost } from '@/lib/workspace-metrics'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import { useT } from '@/lib/i18n'
import type { HostOpsHealthState } from '@/lib/host-ops-view'
import { useWorkspaceProviderState } from '@/lib/workspace-provider-state'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import { Sparkline } from '@/components/charts/chart-primitives'
import { formatBytes } from '@/lib/metric-series'
import { useHostMetricHistory } from '@/hooks/use-host-metric-history'
import { ShellbeamAgentPanel } from './shellbeam-agent-panel'
import { WorkspaceProviderSummary } from './workspace-provider-summary'

interface WorkspaceStatusCardsProps {
  activeVaultId?: string
  hostAddress: string
  selectedHostId?: string | null
  hosts?: HostProfile[]
  /** Kept for call-site compatibility. Sampling is owned by the app-level runtime. */
  resolveAuthSecret?: (host: HostProfile) => Promise<string>
}

const STATUS_CARDS = [
  { key: 'cpu', labelKey: 'workspace.status.cpu', accent: 'from-[var(--workspace-metric-cpu-from)] to-[var(--workspace-metric-cpu-to)]', glow: 'bg-[var(--workspace-metric-cpu-glow)]' },
  { key: 'memory', labelKey: 'workspace.status.memory', accent: 'from-[var(--workspace-metric-memory-from)] to-[var(--workspace-metric-memory-to)]', glow: 'bg-[var(--workspace-metric-memory-glow)]' },
  { key: 'disk', labelKey: 'workspace.status.disk', accent: 'from-[var(--workspace-metric-disk-from)] to-[var(--workspace-metric-disk-to)]', glow: 'bg-[var(--workspace-metric-disk-glow)]' },
  { key: 'network', labelKey: 'workspace.status.network', accent: 'from-[var(--workspace-metric-network-from)] to-[var(--workspace-metric-network-to)]', glow: 'bg-[var(--workspace-metric-network-glow)]' },
] as const

function formatBytesPerSecond(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let next = Math.max(0, value)
  let index = 0
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${next >= 10 || index === 0 ? Math.round(next) : next.toFixed(1)} ${units[index]}`
}

function statusTone(status: HostOpsHealthState | undefined) {
  if (status === 'jump-unavailable') return 'offline'
  if (status === 'unknown') return 'idle'
  if (status === 'unsupported') return 'idle'
  if (status === 'online') return 'online'
  if (status === 'stale') return 'stale'
  if (status === 'offline') return 'offline'
  if (status === 'paused') return 'paused'
  return 'checking'
}

const TREND_COLORS = { cpu: 'var(--workspace-primary-400)', memory: '#a78bfa', disk: '#f5a524', network: '#38bdf8' } as const

function cardSide(key: (typeof STATUS_CARDS)[number]['key'], snapshot: ServerMonitorSnapshot, loadLabel: string) {
  if (key === 'cpu') return snapshot.load1 == null ? null : `${loadLabel} ${snapshot.load1.toFixed(2)}`
  if (key === 'network') return snapshot.networkTxBytesPerSec == null ? null : `↑ ${formatBytesPerSecond(snapshot.networkTxBytesPerSec)}`
  if (!cardBytes(key, snapshot)) return null
  const percent = key === 'memory' ? snapshot.memoryPercent : snapshot.diskPercent
  return percent == null ? null : `${Math.round(percent)}%`
}

/** Memory and disk read as "used / total" when sizes are known, with the percent moved to the corner. */
function cardBytes(key: (typeof STATUS_CARDS)[number]['key'], snapshot: ServerMonitorSnapshot) {
  if (key === 'memory' && snapshot.memoryPercent != null && snapshot.memoryUsedBytes != null && snapshot.memoryTotalBytes) return { used: formatBytes(snapshot.memoryUsedBytes), total: formatBytes(snapshot.memoryTotalBytes) }
  if (key === 'disk' && snapshot.diskPercent != null && snapshot.diskUsedBytes != null && snapshot.diskTotalBytes) return { used: formatBytes(snapshot.diskUsedBytes), total: formatBytes(snapshot.diskTotalBytes) }
  return null
}

function getCardValue(key: (typeof STATUS_CARDS)[number]['key'], snapshot: ServerMonitorSnapshot | null) {
  if (!snapshot) return { value: null, percent: null }
  if (key !== 'network') {
    const value = snapshot[key === 'cpu' ? 'cpuPercent' : key === 'memory' ? 'memoryPercent' : 'diskPercent']
    return value == null || !Number.isFinite(value) ? { value: null, percent: null } : { value: `${Math.round(value)}%`, percent: value }
  }
  const rx = formatBytesPerSecond(snapshot.networkRxBytesPerSec)
  const tx = formatBytesPerSecond(snapshot.networkTxBytesPerSec)
  if (!rx && !tx) return { value: null, percent: null }
  return { value: `↓ ${rx ?? '--'} · ↑ ${tx ?? '--'}`, percent: null }
}

export function WorkspaceStatusCards(props: WorkspaceStatusCardsProps) {
  const { t, locale } = useT()
  const { hostAddress, selectedHostId = null, hosts = [] } = props
  const host = resolveWorkspaceMetricsHost(hosts, { selectedHostId, hostAddress, vaultId: props.activeVaultId })
  const provider = useWorkspaceProviderState({ host: host ?? null, hosts, vaultId: props.activeVaultId })
  const snapshot = provider.view?.metrics ?? null
  const status = provider.view?.health.state
  const copy = workspaceOverviewCopy[locale]
  const history = useHostMetricHistory(host?.vaultId ?? props.activeVaultId, host?.id)
  const trend = (key: (typeof STATUS_CARDS)[number]['key']) => history.map((point) => key === 'network'
    ? point.metrics.networkRxBytesPerSec
    : point.metrics[key === 'cpu' ? 'cpuPercent' : key === 'memory' ? 'memoryPercent' : 'diskPercent'])

  return (
    <>
      <WorkspaceProviderSummary state={provider} />
      {snapshot ? <div
        data-testid="workspace-status-grid"
        className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3"
      >
        {STATUS_CARDS.map((card) => {
        const metric = getCardValue(card.key, snapshot)
        const primaryValue = metric.value ?? t('workspace.statusValue.unavailable')
        const tone = statusTone(status)

        return (
          <div
            key={card.labelKey}
            data-testid="workspace-status-card"
            data-status={tone}
            data-provider={provider.source?.kind ?? 'unknown'}
            className={`sb-card min-w-0 overflow-hidden p-4 text-[var(--workspace-text)] ${
              tone === 'offline'
                ? 'border-[color:var(--workspace-status-bad-border)]'
                : tone === 'stale' || tone === 'paused'
                  ? 'border-[color:var(--workspace-status-warn-border)]'
                  : ''
            }`}
          >
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="font-semibold text-[var(--workspace-text-strong)]">{t(card.labelKey)}</span>
              <span className={`truncate text-xs text-[var(--workspace-text-muted)] ${tone === 'checking' ? 'animate-pulse' : ''}`} title={card.key === 'network' ? t('workspace.statusHint.network') : t('workspace.statusHint.percent')}>{cardSide(card.key, snapshot, copy.load)}</span>
            </div>
            <div className="mt-2 flex min-w-0 items-baseline gap-2">
              <div className="truncate text-[28px] font-bold leading-none tracking-tight text-[var(--workspace-text-strong)]">{card.key === 'network' && snapshot.networkRxBytesPerSec != null ? `↓ ${formatBytesPerSecond(snapshot.networkRxBytesPerSec)}` : cardBytes(card.key, snapshot)?.used ?? primaryValue}</div>
              {cardBytes(card.key, snapshot) && <span className="truncate text-xs text-[var(--workspace-text-muted)]">/ {cardBytes(card.key, snapshot)!.total}</span>}
            </div>
            <div className="mt-2 h-8">{trend(card.key).filter((value) => value != null).length > 1 && <Sparkline values={trend(card.key)} color={TREND_COLORS[card.key]} width={220} height={32} />}</div>
            <div
              data-testid="workspace-status-meter"
              className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--workspace-surface-950)]"
            >
              <div
                className={`h-full rounded-full bg-gradient-to-r ${card.accent} transition-[width] duration-500`}
                style={{ width: `${metric.percent === null ? 0 : Math.max(0, Math.min(100, metric.percent))}%` }}
              />
            </div>
          </div>
        )
        })}
      </div> : <section data-testid="workspace-resources-empty" aria-label={copy.resources} className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-4">
        <p className="text-sm text-[var(--workspace-text-muted)]">{copy.noMetrics}</p>
        <p className="mt-1 text-xs text-[var(--workspace-text-subtle)]">{copy.noMetricsHint}</p>
      </section>}
      <div className="mt-4">
        <ShellbeamAgentPanel host={host ?? null} vaultId={props.activeVaultId} resolveAuthSecret={props.resolveAuthSecret} />
      </div>
    </>
  )
}
