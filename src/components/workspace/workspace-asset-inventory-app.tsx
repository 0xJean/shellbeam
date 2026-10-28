import { hasSshConnection } from '@/lib/hosts'
import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { HostRegionMeta, HostSystemMeta } from '@/components/host-display-meta'
import { ProjectDeploymentsPanel, getProjectDeploymentSignals } from '@/components/project-deployments-panel'
import {
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
  type WorkspaceInventoryProject,
} from '@/lib/workspace-inventory'
import { getServerConsoleLink } from '@/lib/server-console'
import { SegmentedMeter } from '@/components/ui/segmented-meter'
import {
  createReadyWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  selectWorkspaceInventoryStatesForHosts,
  useWorkspaceInventoryStates,
} from '@/lib/workspace-inventory-state'
import { scanWorkspaceInventoryHosts } from '@/lib/workspace-inventory-scan'
import {
  getServerMonitorHostKey,
  type ServerMonitorHistoryPoint,
  type ServerMonitorLatest,
  type ServerMonitorSnapshot,
  type ServerMonitorStatus,
} from '@/lib/server-monitor'
import { useServerMonitorStates } from '@/lib/server-monitor-state'
import { listMcpDeploymentRecords, type McpDeploymentRecord } from '@/lib/mcp'
import { cn } from '@/lib/utils'
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  ExternalLink,
  FileDown,
  Gauge,
  GitBranch,
  Loader2,
  Network,
  Settings2,
  Pencil,
  Plus,
  Search,
  SquareTerminal,
  Timer,
  Tags,
  Wifi,
  Wrench,
  ArrowDownWideNarrow,
  Filter,
  ScanSearch,
  Info,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOsIcon } from './workspace-os-icon'
import { Sparkline } from '@/components/charts/chart-primitives'
import { osBrandColor } from '@/lib/os-brand'
import type { WorkspaceResourceHeaderTab } from './workspace-resource-overview-header'
import { WorkspaceServiceIcon } from './workspace-service-icon'
import { WorkspaceServerList, workspaceServerMatchesSearch, type WorkspaceServerSearchData } from './workspace-server-list'
import { WorkspaceToolManagerApp } from './workspace-tool-manager-app'
import { TOOL_CATALOG } from '@/lib/workspace-tools'

interface WorkspaceAssetInventoryAppProps {
  activeVaultId?: string
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  initialView?: 'assets' | 'tools' | 'deployments'
  presentation?: 'panel' | 'mobile'
  onOpenTerminal?: (host: HostProfile) => void
  onOpenProviderConsole?: (url: string, host: HostProfile) => void
  onEditHost?: (host: HostProfile) => void
  onImportSsh?: () => void
  onCreateHost?: () => void
  headerExtraAction?: ReactNode
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error' | 'unsupported'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

const SCAN_CONCURRENCY = 3
type AssetSortMode = 'recent' | 'name' | 'resource' | 'status'
type TFunction = ReturnType<typeof useT>['t']

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

/** v3 asset risk rule, judged on the busiest of CPU / memory / disk. */
const ASSET_RISK_TIGHT = 90
const ASSET_RISK_HIGH = 75

function getRiskBadge(values: Array<number | null | undefined>, t: TFunction): { label: string; tone: 'good' | 'warn' | 'bad' } | undefined {
  const risk = riskOf(values)
  if (!risk) return undefined
  return risk === 'tight' ? { label: t('workspace.asset.riskTight'), tone: 'bad' } : risk === 'high' ? { label: t('workspace.asset.riskHigh'), tone: 'warn' } : { label: t('workspace.asset.riskEnough'), tone: 'good' }
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-lg border px-2 py-1 text-[11px] font-medium',
        tone === 'good' && 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
        tone === 'warn' && 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
        tone === 'bad' && 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
        tone === 'info' && 'border-[color:var(--workspace-status-info-border)] bg-[var(--workspace-status-info-bg)] text-[color:var(--workspace-status-info-text)]',
        tone === 'default' && 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text)]',
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

function AssetDetailSection({
  icon: Icon,
  title,
  meta,
  action,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="sb-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{title}</div>
            {meta && <div className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{meta}</div>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function getServiceTone(active: string): 'good' | 'warn' | 'bad' | 'default' {
  if (active === 'active') return 'good'
  if (active === 'failed') return 'bad'
  if (active === 'inactive' || active === 'activating') return 'warn'
  return 'default'
}

function getInventoryToolServiceName(toolId: string) {
  return TOOL_CATALOG.find((tool) => tool.id === toolId)?.service
}

function projectMatches(project: WorkspaceInventoryProject, query: string, signals: string[] = []) {
  if (!query) return true
  return [project.name, project.kind, project.path, ...signals].join(' ').toLowerCase().includes(query)
}

function agentDeploymentTone(status: string): 'good' | 'warn' | 'bad' | 'info' | 'default' {
  if (status === 'deployed') return 'good'
  if (status === 'failed') return 'bad'
  if (status === 'deploying' || status === 'planned') return 'warn'
  if (status === 'unknown') return 'info'
  return 'default'
}

function agentDeploymentStatusLabel(status: string, t: TFunction) {
  const knownStatus = ['deployed', 'deploying', 'planned', 'failed', 'unknown', 'retired'].includes(status)
    ? status
    : 'unknown'
  return t(`workspace.agentDeployments.status.${knownStatus}`)
}

function isRunningSignal(signal: string) {
  return /up|online|active/i.test(signal)
}

function getInstalledToolSearchValues(inventory: WorkspaceInventory | undefined) {
  return inventory?.tools.flatMap((tool) => [
    tool.name,
    tool.id,
    tool.binary,
    tool.path,
    tool.version,
    tool.category,
  ]) ?? []
}

function getProjectSearchValues(inventory: WorkspaceInventory | undefined) {
  return inventory?.projects.flatMap((project) => [
    project.name,
    project.kind,
    project.path,
  ]) ?? []
}

function HostStatusDot({ state }: { state: HostInventoryState }) {
  if (state.inventory || state.status === 'ready') {
    return (
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
        <WorkspaceOsIcon os={state.inventory?.resource.os} className="h-4 w-4 text-[var(--workspace-text-muted)]" />
        {state.status === 'scanning' ? (
          <Loader2 className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-spin rounded-full bg-[var(--workspace-surface-row)] text-[color:var(--workspace-primary-300)]" />
        ) : (
          <CheckCircle2 className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[var(--workspace-surface-row)] text-[color:var(--workspace-status-good)]" />
        )}
      </span>
    )
  }
  if (state.status === 'scanning') return <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--workspace-primary-300)]" />
  if (state.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--workspace-status-bad)]" />
  return <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />
}

function HostRegionLine({ network }: { network: HostNetworkDisplay }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--workspace-text-subtle)]">
      <HostRegionMeta network={network} />
    </div>
  )
}

function groupLabel(group: string, t: TFunction) {
  const labels: Record<string, string> = {
    Production: t('workspace.asset.group.production'),
    Development: t('workspace.asset.group.development'),
    Staging: t('workspace.asset.group.staging'),
    Custom: t('workspace.asset.group.custom'),
  }
  return labels[group] ?? group
}

function getResourcePressure(state: HostInventoryState | undefined) {
  const resource = state?.inventory?.resource
  return Math.max(
    resource?.cpuPercent ?? 0,
    resource?.memoryPercent ?? 0,
    resource?.diskPercent ?? 0,
  )
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let next = Math.max(0, value)
  let index = 0
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${next >= 10 || index === 0 ? Math.round(next) : next.toFixed(1)} ${units[index]}`
}

function formatBytesPair(used: number | null, total: number | null) {
  const usedText = formatBytes(used)
  const totalText = formatBytes(total)
  if (!usedText && !totalText) return undefined
  return `${usedText ?? '--'} / ${totalText ?? '--'}`
}

function formatBytesPerSecond(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let next = Math.max(0, value)
  let index = 0
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024
    index += 1
  }
  return `${next >= 10 || index === 0 ? Math.round(next) : next.toFixed(1)} ${units[index]}`
}

function formatUptime(seconds: number | null, t: TFunction) {
  if (seconds === null || !Number.isFinite(seconds)) return t('workspace.monitor.notAvailable')
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return t('workspace.monitor.uptime.days', { days, hours })
  if (hours > 0) return t('workspace.monitor.uptime.hours', { hours, minutes })
  return t('workspace.monitor.uptime.minutes', { minutes })
}

function monitorStatusLabel(status: ServerMonitorStatus | undefined, t: TFunction) {
  if (status === 'unsupported') return t('workspace.monitor.status.unsupported')
  if (status === 'online') return t('workspace.monitor.status.online')
  if (status === 'stale') return t('workspace.monitor.status.stale')
  if (status === 'offline') return t('workspace.monitor.status.offline')
  if (status === 'paused') return t('workspace.monitor.status.paused')
  return t('workspace.monitor.status.checking')
}

function monitorStatusTone(status: ServerMonitorStatus | undefined): 'good' | 'warn' | 'bad' | 'info' {
  if (status === 'online') return 'good'
  if (status === 'stale' || status === 'paused') return 'warn'
  if (status === 'offline') return 'bad'
  return 'info'
}

function getMonitorResourcePressure(snapshot: ServerMonitorSnapshot | null | undefined) {
  return Math.max(
    snapshot?.cpuPercent ?? 0,
    snapshot?.memoryPercent ?? 0,
    snapshot?.diskPercent ?? 0,
  )
}

function getDisplayMetric(
  inventory: WorkspaceInventory | undefined,
  snapshot: ServerMonitorSnapshot | null | undefined,
  t: TFunction,
) {
  return {
    cpuPercent: snapshot?.cpuPercent ?? inventory?.resource.cpuPercent ?? null,
    memoryPercent: snapshot?.memoryPercent ?? inventory?.resource.memoryPercent ?? null,
    diskPercent: snapshot?.diskPercent ?? inventory?.resource.diskPercent ?? null,
    cpuDetail: snapshot ? formatUptime(snapshot.uptimeSeconds, t) : inventory?.resource.uptime,
    memoryDetail: snapshot
      ? formatBytesPair(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes)
      : inventory?.resource.memoryText,
    diskDetail: snapshot
      ? formatBytesPair(snapshot.diskUsedBytes, snapshot.diskTotalBytes)
      : inventory?.resource.diskText,
  }
}

function formatTrendValue(value: number | null, unit: string) {
  if (value === null || !Number.isFinite(value)) return '--'
  if (unit === '%') return `${Math.round(value)}%`
  return formatBytesPerSecond(value) ?? '--'
}

function MonitorTrendChart({
  title,
  history,
  series,
  unit,
  emptyText,
}: {
  title: string
  history: ServerMonitorHistoryPoint[]
  series: Array<{ label: string; color: string; getValue: (snapshot: ServerMonitorSnapshot) => number | null }>
  unit: '%' | 'rate'
  emptyText: string
}) {
  const width = 360
  const height = 116
  const paddingX = 10
  const paddingY = 12
  const values = series.flatMap((entry) => history.map((point) => entry.getValue(point.snapshot)).filter((value): value is number => value !== null && Number.isFinite(value)))
  const hasValues = values.length > 0
  const minValue = unit === '%' ? 0 : (hasValues ? Math.min(0, ...values) : 0)
  const maxValue = unit === '%' ? 100 : (hasValues ? Math.max(1, ...values) : 1)
  const xForIndex = (index: number) => history.length <= 1
    ? width / 2
    : paddingX + (index / (history.length - 1)) * (width - paddingX * 2)
  const yForValue = (value: number) => paddingY + (1 - (value - minValue) / Math.max(1, maxValue - minValue)) * (height - paddingY * 2)

  return (
    <div className="min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-[var(--workspace-text-strong)]">{title}</div>
        {hasValues && (
          <div className="flex flex-wrap justify-end gap-2 text-[10px] text-[var(--workspace-text-muted)]">
            {series.map((entry) => <span key={entry.label} className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: entry.color }} />{entry.label}</span>)}
          </div>
        )}
      </div>
      {hasValues ? (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-28 w-full" role="img" aria-label={title}>
            <line x1={paddingX} x2={width - paddingX} y1={paddingY} y2={paddingY} stroke="var(--workspace-border-soft)" strokeDasharray="3 4" />
            <line x1={paddingX} x2={width - paddingX} y1={height / 2} y2={height / 2} stroke="var(--workspace-border-soft)" strokeDasharray="3 4" />
            <line x1={paddingX} x2={width - paddingX} y1={height - paddingY} y2={height - paddingY} stroke="var(--workspace-border-soft)" strokeDasharray="3 4" />
            {series.map((entry) => {
              const points = history
                .map((point, index) => {
                  const value = entry.getValue(point.snapshot)
                  return value === null || !Number.isFinite(value) ? null : `${xForIndex(index)},${yForValue(value)}`
                })
                .filter(Boolean)
                .join(' ')
              return <polyline key={entry.label} fill="none" stroke={entry.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" points={points} />
            })}
          </svg>
          <div className="flex items-center justify-between text-[10px] text-[var(--workspace-text-subtle)]">
            <span>{new Date(history[0]?.sampledAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{new Date(history.at(-1)?.sampledAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </>
      ) : (
        <div className="flex h-28 items-center justify-center text-center text-xs text-[var(--workspace-text-muted)]">{emptyText}</div>
      )}
      {hasValues && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--workspace-text-subtle)]">
          {series.map((entry) => {
            const value = [...history].reverse().map((point) => entry.getValue(point.snapshot)).find((item): item is number => item !== null && Number.isFinite(item)) ?? null
            return <span key={entry.label}>{entry.label}: {formatTrendValue(value, unit)}</span>
          })}
        </div>
      )}
    </div>
  )
}

function MonitorOverview({
  latest,
  history,
  t,
}: {
  latest: ServerMonitorLatest
  history: ServerMonitorHistoryPoint[]
  t: TFunction
}) {
  const snapshot = latest.snapshot
  return (
    <AssetDetailSection
      icon={Activity}
      title={t('workspace.monitor.title')}
      meta={t('workspace.monitor.retention')}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-muted)]"><Gauge className="h-3.5 w-3.5" />{t('workspace.monitor.load')}</div>
          <div className="mt-1 font-mono text-sm text-[var(--workspace-text-strong)]">{snapshot?.load1 ?? '--'} / {snapshot?.load5 ?? '--'} / {snapshot?.load15 ?? '--'}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-muted)]"><Timer className="h-3.5 w-3.5" />{t('workspace.monitor.uptime')}</div>
          <div className="mt-1 text-sm text-[var(--workspace-text-strong)]">{formatUptime(snapshot?.uptimeSeconds ?? null, t)}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-muted)]"><Wifi className="h-3.5 w-3.5" />{t('workspace.monitor.network')}</div>
          <div className="mt-1 text-sm text-[var(--workspace-text-strong)]">↓ {formatBytesPerSecond(snapshot?.networkRxBytesPerSec ?? null) ?? '--'} · ↑ {formatBytesPerSecond(snapshot?.networkTxBytesPerSec ?? null) ?? '--'}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-[var(--workspace-text-muted)]"><Clock className="h-3.5 w-3.5" />{t('workspace.monitor.latency')}</div>
          <div className="mt-1 text-sm text-[var(--workspace-text-strong)]">{snapshot?.latencyMs === null || snapshot?.latencyMs === undefined ? '--' : `${Math.round(snapshot.latencyMs)} ms`}</div>
        </div>
      </div>
      <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-2">
        <MonitorTrendChart
          title={t('workspace.monitor.trend.cpu')}
          history={history}
          unit="%"
          emptyText={t('workspace.monitor.historyEmpty')}
          series={[{ label: t('workspace.common.cpu'), color: 'var(--workspace-primary-400)', getValue: (entry) => entry.cpuPercent }]}
        />
        <MonitorTrendChart
          title={t('workspace.monitor.trend.memory')}
          history={history}
          unit="%"
          emptyText={t('workspace.monitor.historyEmpty')}
          series={[{ label: t('workspace.common.memory'), color: '#38bdf8', getValue: (entry) => entry.memoryPercent }]}
        />
        <MonitorTrendChart
          title={t('workspace.monitor.trend.disk')}
          history={history}
          unit="%"
          emptyText={t('workspace.monitor.historyEmpty')}
          series={[{ label: t('workspace.common.disk'), color: '#f59e0b', getValue: (entry) => entry.diskPercent }]}
        />
        <MonitorTrendChart
          title={t('workspace.monitor.trend.network')}
          history={history}
          unit="rate"
          emptyText={t('workspace.monitor.historyEmpty')}
          series={[
            { label: t('workspace.monitor.receive'), color: '#34d399', getValue: (entry) => entry.networkRxBytesPerSec },
            { label: t('workspace.monitor.transmit'), color: '#fb7185', getValue: (entry) => entry.networkTxBytesPerSec },
          ]}
        />
      </div>
    </AssetDetailSection>
  )
}

function riskOf(values: Array<number | null | undefined>): 'tight' | 'high' | 'ok' | null {
  const real = values.filter((value): value is number => value != null)
  if (!real.length) return null
  const max = Math.max(...real)
  return max >= ASSET_RISK_TIGHT ? 'tight' : max >= ASSET_RISK_HIGH ? 'high' : 'ok'
}

/** v3 "剩余资源": what is left on the box, from the latest sample, with a 24h trend. */
function RemainingResources({ metrics, snapshot, history, isMobile, t }: {
  metrics: ReturnType<typeof getDisplayMetric>; snapshot: ServerMonitorSnapshot | null; history: ServerMonitorHistoryPoint[]; isMobile: boolean; t: TFunction
}) {
  const since = (history[history.length - 1]?.sampledAt ?? 0) - 24 * 3_600_000
  const recent = history.filter((point) => point.sampledAt >= since)
  const trend = (pick: (snapshot: ServerMonitorSnapshot) => number | null) => recent.map((point) => pick(point.snapshot))
  const free = (used: number | null, total: number | null) => used != null && total != null ? Math.max(0, total - used) : null
  const cards: Array<{ kind: 'cpu' | 'memory' | 'disk'; label: string; value: ReactNode; aside?: ReactNode; used: number | null; trend: Array<number | null> }> = [
    { kind: 'cpu', label: t('workspace.asset.cpuIdle'), used: metrics.cpuPercent,
      value: metrics.cpuPercent == null ? '—' : <>{Math.round(100 - metrics.cpuPercent)}<small className="text-sm">%</small>{snapshot?.load1 != null && <small className="ml-1.5 text-xs font-normal text-[var(--workspace-text-muted)]">{t('workspace.asset.loadValue', { value: snapshot.load1.toFixed(2) })}</small>}</>,
      trend: trend((point) => point.cpuPercent == null ? null : 100 - point.cpuPercent) },
    { kind: 'memory', label: t('workspace.asset.memoryAvailable'), used: metrics.memoryPercent,
      value: free(snapshot?.memoryUsedBytes ?? null, snapshot?.memoryTotalBytes ?? null) != null ? formatBytes(free(snapshot!.memoryUsedBytes, snapshot!.memoryTotalBytes)) : metrics.memoryPercent == null ? '—' : `${Math.round(100 - metrics.memoryPercent)}%`,
      aside: snapshot?.memoryTotalBytes ? t('workspace.asset.totalValue', { value: formatBytes(snapshot.memoryTotalBytes) ?? '—' }) : undefined,
      trend: trend((point) => free(point.memoryUsedBytes, point.memoryTotalBytes)) },
    { kind: 'disk', label: t('workspace.asset.diskAvailable'), used: metrics.diskPercent,
      value: free(snapshot?.diskUsedBytes ?? null, snapshot?.diskTotalBytes ?? null) != null ? formatBytes(free(snapshot!.diskUsedBytes, snapshot!.diskTotalBytes)) : metrics.diskPercent == null ? '—' : `${Math.round(100 - metrics.diskPercent)}%`,
      aside: snapshot?.diskTotalBytes ? t('workspace.asset.totalValue', { value: formatBytes(snapshot.diskTotalBytes) ?? '—' }) : undefined,
      trend: trend((point) => free(point.diskUsedBytes, point.diskTotalBytes)) },
  ]
  const risk = riskOf([metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent])
  return (
    <section data-tour="monitor-resources">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.asset.remaining')}</h3>
        <span className="text-[11px] text-[var(--workspace-text-subtle)]">{recent.length > 1 ? t('workspace.asset.remainingTrend') : t('workspace.asset.remainingLatest')}</span>
      </div>
      <div className={cn('grid gap-3', isMobile ? 'grid-cols-1' : 'md:grid-cols-3')}>
        {cards.map((card) => (
          <div key={card.kind} data-testid={`asset-remaining-${card.kind}`} className="min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--workspace-text-muted)]"><span>{card.label}</span>{card.aside && <span className="italic text-[var(--workspace-text-subtle)]">{card.aside}</span>}</div>
            <div className="mt-1.5 text-2xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{card.value}</div>
            <SegmentedMeter kind={card.kind} value={card.used} segments={16} className="mt-2" />
            <div className="mt-1.5 text-[11px] text-[var(--workspace-text-subtle)]">{card.used == null ? t('workspace.common.notAvailable') : t('workspace.asset.usedValue', { value: Math.round(card.used) })}</div>
            {card.trend.filter((value) => value != null).length > 1 && <div className="mt-2 flex justify-center"><Sparkline values={card.trend} width={200} height={30} color={card.kind === 'cpu' ? 'var(--workspace-metric-cpu-from, var(--workspace-primary-400))' : card.kind === 'memory' ? 'var(--workspace-primary-400)' : 'var(--workspace-status-good)'} /></div>}
          </div>
        ))}
      </div>
      {risk && <p data-testid="asset-risk-verdict" className={cn('mt-3 flex items-center gap-1.5 text-xs', risk === 'tight' ? 'text-[color:var(--workspace-status-bad-text)]' : risk === 'high' ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[color:var(--workspace-status-good-text)]')}>
        {risk === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {t(`workspace.asset.risk.${risk}Verdict`)} · {t('workspace.asset.riskRule', { tight: ASSET_RISK_TIGHT, high: ASSET_RISK_HIGH })}
      </p>}
    </section>
  )
}

/** v3 "项目目录": discovered projects and Agent registrations in one list, each tagged with where it came from. */
function ProjectDirectory({ projects, deployments, t }: {
  projects: Array<{ project: WorkspaceInventoryProject; signals: string[] }>; deployments: McpDeploymentRecord[]; t: TFunction
}) {
  const byPath = new Map<string, { path: string; kind?: string; signals: string[]; discovered: boolean; deployment?: McpDeploymentRecord }>()
  for (const { project, signals } of projects) byPath.set(project.path, { path: project.path, kind: project.kind, signals, discovered: true })
  for (const deployment of deployments) {
    const existing = byPath.get(deployment.deploymentPath)
    if (existing) existing.deployment = deployment
    else byPath.set(deployment.deploymentPath, { path: deployment.deploymentPath, kind: deployment.projectKind, signals: [], discovered: false, deployment })
  }
  const rows = [...byPath.values()]
  return (
    <section data-testid="asset-project-directory">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.asset.projectDirectory')}</h3>
        <span className="text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.asset.projectCount', { count: rows.length })}</span>
      </div>
      {rows.length === 0 ? <div className="rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] px-4 py-5 text-sm text-[var(--workspace-text-muted)]">{t('workspace.asset.noProjects')}</div> : (
        <div className="divide-y divide-[color:var(--workspace-border-soft)] rounded-xl border border-[color:var(--workspace-border-soft)]">
          {rows.map((row) => {
            const running = row.signals.some(isRunningSignal)
            return (
              <div key={row.path} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--workspace-text-strong)]" title={row.path}>{row.path}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {(row.kind || row.deployment?.name) && <Badge>{row.kind || row.deployment?.name}</Badge>}
                  {row.signals.filter((signal) => !isRunningSignal(signal)).slice(0, 2).map((signal) => <Badge key={signal}>{signal}</Badge>)}
                  {running && <span className="inline-flex items-center gap-1 text-xs text-[color:var(--workspace-status-good-text)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--workspace-status-good)]" />{row.signals.find(isRunningSignal)}</span>}
                  {row.deployment && <Badge tone={agentDeploymentTone(row.deployment.status)}>{agentDeploymentStatusLabel(row.deployment.status, t)}</Badge>}
                </span>
                <span className="flex shrink-0 gap-1">
                  {row.discovered && <Badge>{t('workspace.assetDiscovery.title')}</Badge>}
                  {row.deployment && <Badge tone="info">{t('workspace.asset.agentRegistered')}</Badge>}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-[var(--workspace-text-subtle)]"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('workspace.asset.projectSourcesNote')}</p>
    </section>
  )
}

function AssetListToolbar({
  hosts,
  visibleCount,
  groupFilter,
  tagFilter,
  sortMode,
  query,
  onGroupFilter,
  onTagFilter,
  onSortMode,
  onQueryChange,
}: {
  hosts: HostProfile[]
  visibleCount: number
  groupFilter: string
  tagFilter: Set<string>
  sortMode: AssetSortMode
  query: string
  onGroupFilter: (group: string) => void
  onTagFilter: (tags: Set<string>) => void
  onSortMode: (mode: AssetSortMode) => void
  onQueryChange: (value: string) => void
}) {
  const { t } = useT()
  const [tagOpen, setTagOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    hosts.forEach((host) => {
      const group = host.group || 'Custom'
      counts.set(group, (counts.get(group) ?? 0) + 1)
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [hosts])
  const tags = useMemo(() => {
    const set = new Set<string>()
    hosts.forEach((host) => host.tags?.forEach((tag) => set.add(tag)))
    return Array.from(set).sort()
  }, [hosts])
  const sortLabels: Record<AssetSortMode, string> = {
    recent: t('workspace.asset.sort.recent'),
    name: t('workspace.asset.sort.name'),
    resource: t('workspace.asset.sort.resource'),
    status: t('workspace.asset.sort.status'),
  }
  const chip = (active: boolean) => cn('inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
    active ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]')

  return (
    <div className="space-y-2.5 border-b border-[color:var(--workspace-border-soft)] p-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('workspace.asset.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-[13px] text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
          />
        </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => { setTagOpen((value) => !value); setSortOpen(false) }}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
            tagFilter.size > 0
              ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]'
              : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
          )}
        >
          <Tags className="h-3.5 w-3.5" />
          {t('workspace.asset.tags')}{tagFilter.size > 0 ? ` ${tagFilter.size}` : ''}
          <ChevronDown className="h-3 w-3" />
        </button>
        {tagOpen && (
          <>
            <button type="button" aria-label={t('workspace.asset.closeTagFilter')} className="fixed inset-0 z-40 cursor-default" onClick={() => setTagOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-xl">
              {tagFilter.size > 0 && (
                <button
                  type="button"
                  onClick={() => { onTagFilter(new Set()); setTagOpen(false) }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text)]"
                >
                  {t('workspace.asset.clearTags')}
                </button>
              )}
              <div className="max-h-60 overflow-auto">
                {tags.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-[var(--workspace-text-muted)]">{t('workspace.asset.noTags')}</div>
                ) : tags.map((tag) => {
                  const active = tagFilter.has(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        const next = new Set(tagFilter)
                        if (active) next.delete(tag)
                        else next.add(tag)
                        onTagFilter(next)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                        active ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]',
                      )}
                    >
                      <span className={cn('flex h-4 w-4 items-center justify-center rounded border text-[10px]', active ? 'border-[color:var(--workspace-border-glow)] bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]' : 'border-[color:var(--workspace-border-soft)]')}>
                        {active && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{tag}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => { setSortOpen((value) => !value); setTagOpen(false) }}
          className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]"
        >
          <ArrowDownWideNarrow className="h-3.5 w-3.5" />
          <span>{sortLabels[sortMode]}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {sortOpen && (
          <>
            <button type="button" aria-label={t('workspace.asset.closeSortMenu')} className="fixed inset-0 z-40 cursor-default" onClick={() => setSortOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-xl">
              {(Object.keys(sortLabels) as AssetSortMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { onSortMode(mode); setSortOpen(false) }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                    sortMode === mode ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]',
                  )}
                >
                  <span>{sortLabels[mode]}</span>
                  {sortMode === mode && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      </div>
      {groups.length > 0 && <div className="flex items-center gap-1 overflow-x-auto">
        <button type="button" aria-pressed={groupFilter === 'All'} onClick={() => onGroupFilter('All')} className={chip(groupFilter === 'All')}>{t('workspace.common.all')}</button>
        {groups.map(([group, count]) => (
          <button key={group} type="button" aria-pressed={groupFilter === group} onClick={() => onGroupFilter(groupFilter === group ? 'All' : group)} className={chip(groupFilter === group)}>
            {groupLabel(group, t)}<span className="font-semibold">{count}</span>
          </button>
        ))}
      </div>}
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--workspace-text-muted)]">
        <span>{t('workspace.asset.totalHosts')}</span><span aria-hidden="true">·</span><span>{t('workspace.serverIndex.matched', { visible: visibleCount, total: hosts.length })}</span>
      </div>
    </div>
  )
}

function AssetInventoryHeader({
  hosts,
  cachedCount,
  readyCount,
  serviceCount,
  projectCount,
  errorCount,
  onScan,
  onScanFiltered,
  scanning,
  lastScanAt,
  onImportSsh,
  onCreateHost,
  headerExtraAction,
  tabs,
  activeTab,
  onTabChange,
}: {
  hosts: HostProfile[]
  cachedCount: number
  readyCount: number
  serviceCount: number
  projectCount: number
  errorCount: number
  onScan: () => void
  onScanFiltered?: () => void
  scanning: boolean
  lastScanAt: number | null
  onImportSsh?: () => void
  onCreateHost?: () => void
  headerExtraAction?: ReactNode
  tabs?: Array<WorkspaceResourceHeaderTab & { count?: number }>
  activeTab?: string
  onTabChange?: (tab: string) => void
}) {
  const { t } = useT()
  if (hosts.length === 0) return null
  const minutesAgo = lastScanAt ? Math.max(0, Math.round((Date.now() - lastScanAt) / 60_000)) : null
  const ghost = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-60'
  const stat = (value: number, label: string, warn = false) => <span className="inline-flex items-baseline gap-1">
    <b className={cn('text-xl font-bold tabular-nums', warn ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-strong)]')}>{value}</b>
    <span className="text-xs text-[var(--workspace-text-muted)]">{label}</span>
  </span>

  return (
    <header className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('nav.assetInventory')}</h1>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">
            {t('workspace.asset.description')} · {minutesAgo == null ? t('workspace.asset.waitingScan') : t('workspace.asset.lastScanAgo', { minutes: minutesAgo })}
            {cachedCount > 0 && <> · {t('workspace.asset.cachedNote', { count: cachedCount })}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {headerExtraAction}
          {onImportSsh && <button type="button" onClick={onImportSsh} className={ghost} title={t('workspace.asset.importSsh')}><FileDown className="h-3.5 w-3.5" /><span className="hidden xl:inline">{t('workspace.asset.importSsh')}</span></button>}
          {onCreateHost && <button type="button" onClick={onCreateHost} className={ghost}><Plus className="h-3.5 w-3.5" />{t('workspace.asset.newConnection')}</button>}
          {onScanFiltered && <button type="button" onClick={onScanFiltered} disabled={scanning} className={ghost}><Filter className="h-3.5 w-3.5" />{t('workspace.asset.scanFiltered')}</button>}
          <button type="button" onClick={onScan} disabled={scanning}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-[13px] font-semibold text-[var(--workspace-primary-foreground)] transition-colors hover:bg-[color:var(--workspace-primary-400)] disabled:cursor-not-allowed disabled:opacity-60">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}{t('workspace.asset.scanAll')}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-3 border-b border-[color:var(--workspace-border-soft)] md:flex-row md:items-end md:justify-between">
        {tabs?.length ? <div role="tablist" className="flex gap-5">
          {tabs.map((tab) => {
            const active = activeTab === tab.key
            return <button key={tab.key} type="button" role="tab" aria-selected={active} disabled={tab.disabled} onClick={() => onTabChange?.(tab.key)}
              className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 pb-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                active ? 'border-primary text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
              {tab.label}{tab.count != null && <span aria-hidden="true" className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{tab.count}</span>}
            </button>
          })}
        </div> : <span />}
        <div data-testid="asset-header-stats" className="flex flex-wrap items-baseline gap-5 pb-2.5" title={`${readyCount}/${hosts.length} ${t('workspace.asset.metricHosts')}`}>
          {stat(hosts.length, t('workspace.asset.metricHosts'))}
          {stat(serviceCount, t('workspace.asset.metricServices'))}
          {stat(projectCount, t('workspace.asset.metricProjects'))}
          {errorCount > 0 && stat(errorCount, t('workspace.asset.metricErrors'), true)}
        </div>
      </div>
    </header>
  )
}

export function WorkspaceAssetInventoryApp({
  activeVaultId,
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  initialView = 'assets',
  presentation = 'panel',
  onOpenTerminal,
  onOpenProviderConsole,
  onEditHost,
  onImportSsh,
  onCreateHost,
  headerExtraAction,
}: WorkspaceAssetInventoryAppProps) {
  const initialHost = useMemo(() => {
    if (selectedHostId) return hosts.find((host) => host.id === selectedHostId)
    if (hostAddress) return hosts.find((host) => host.address === hostAddress)
    return hosts[0]
  }, [hostAddress, hosts, selectedHostId])

  const [view, setView] = useState<'assets' | 'tools' | 'deployments'>(initialView)
  const [selectedKey, setSelectedKey] = useState(() => (initialHost ? hostKey(initialHost) : ''))
  const [managedToolHostId, setManagedToolHostId] = useState(() => initialHost?.id ?? selectedHostId ?? null)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState('All')
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => new Set())
  const [sortMode, setSortMode] = useState<AssetSortMode>('recent')
  const sharedStates = useWorkspaceInventoryStates()
  const monitorStates = useServerMonitorStates()
  const [agentDeployments, setAgentDeployments] = useState<McpDeploymentRecord[]>([])
  const [agentDeploymentsObservedAt, setAgentDeploymentsObservedAt] = useState<number | null>(null)
  const [states, setStates] = useState<Record<string, HostInventoryState>>(() => {
    const shared = selectWorkspaceInventoryStatesForHosts(hosts)
    return Object.entries(loadWorkspaceInventoryCache(hosts)).reduce<Record<string, HostInventoryState>>((next, [key, entry]) => {
      next[key] = { status: 'ready', inventory: entry.inventory }
      return next
    }, { ...shared })
  })
  const [lastScanAt, setLastScanAt] = useState<number | null>(() => {
    const cachedEntries = Object.values(loadWorkspaceInventoryCache(hosts))
    return cachedEntries.reduce<number | null>((latest, entry) => Math.max(latest ?? 0, entry.updatedAt), null)
  })
  const scanRunIdRef = useRef(0)
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  const { t } = useT()

  useEffect(() => {
    let cancelled = false
    if (!activeVaultId) {
      setAgentDeployments([])
      setAgentDeploymentsObservedAt(null)
      return
    }
    void listMcpDeploymentRecords(activeVaultId).then((result) => {
      if (cancelled) return
      setAgentDeployments(result.projects)
      setAgentDeploymentsObservedAt(result.observedAt)
    }).catch(() => {
      if (cancelled) return
      setAgentDeployments([])
      setAgentDeploymentsObservedAt(null)
    })
    return () => { cancelled = true }
  }, [activeVaultId])

  const agentDeploymentsByHost = useMemo(() => {
    const grouped = new Map<string, McpDeploymentRecord[]>()
    agentDeployments.forEach((deployment) => {
      const current = grouped.get(deployment.hostId) ?? []
      current.push(deployment)
      grouped.set(deployment.hostId, current)
    })
    return grouped
  }, [agentDeployments])

  useEffect(() => {
    if (!selectedKey && initialHost) setSelectedKey(hostKey(initialHost))
  }, [initialHost, selectedKey])

  useEffect(() => {
    if (!managedToolHostId && initialHost) setManagedToolHostId(initialHost.id)
  }, [initialHost, managedToolHostId])

  useEffect(() => {
    setStates((prev) => ({ ...selectWorkspaceInventoryStatesForHosts(hosts, prev), ...selectWorkspaceInventoryStatesForHosts(hosts, sharedStates) }))
  }, [hosts, sharedStates])

  const hostRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    const filtered = hosts.filter((host) => {
      if (groupFilter !== 'All' && (host.group || 'Custom') !== groupFilter) return false
      if (tagFilter.size > 0 && !host.tags?.some((tag) => tagFilter.has(tag))) return false
      const state = states[hostKey(host)]
      const inventory = state?.inventory
      const monitor = monitorStates[getServerMonitorHostKey(host)]
      const registeredProjects = agentDeploymentsByHost.get(host.id) ?? []
      const network = networkByAddress[host.address]
      const searchData: WorkspaceServerSearchData = {
        network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
        system: [inventory?.resource.os, inventory?.resource.kernel, monitor?.latest?.snapshot?.os, monitor?.latest?.snapshot?.kernel],
        tools: getInstalledToolSearchValues(inventory),
        projects: [
          ...getProjectSearchValues(inventory),
          ...(inventory?.containers.flatMap((container) => [container.name, container.image]) ?? []),
          ...(inventory?.pm2.map((process) => process.raw) ?? []),
          ...registeredProjects.flatMap((project) => [
            project.name,
            project.deploymentPath,
            project.projectKind,
            project.status,
            project.agentName,
            project.runtime?.language,
            project.runtime?.packageManager,
          ]),
        ],
      }
      return workspaceServerMatchesSearch(host, normalizedQuery, searchData)
    })

    return filtered.sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name)
      if (sortMode === 'resource') {
        const resourcePressure = (host: HostProfile) => Math.max(
          getResourcePressure(states[hostKey(host)]),
          getMonitorResourcePressure(monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot),
        )
        return resourcePressure(b) - resourcePressure(a)
      }
      if (sortMode === 'status') {
        const score = (host: HostProfile) => {
          const status = states[hostKey(host)]?.status
          const monitorStatus = monitorStates[getServerMonitorHostKey(host)]?.latest?.status
          if (monitorStatus === 'offline' || status === 'error') return 0
          if (monitorStatus === 'stale' || monitorStatus === 'paused' || status === 'scanning') return 1
          if (monitorStatus === 'checking' || status === 'idle') return 2
          return 3
        }
        return score(a) - score(b)
      }
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    })
  }, [agentDeploymentsByHost, groupFilter, hosts, monitorStates, networkByAddress, query, sortMode, states, tagFilter])

  const selectedHost = useMemo(() => {
    return hostRows.find((host) => hostKey(host) === selectedKey) ?? hostRows[0] ?? hosts.find((host) => hostKey(host) === selectedKey) ?? hosts[0]
  }, [hostRows, hosts, selectedKey])

  const selectedState = selectedHost ? states[hostKey(selectedHost)] : undefined
  const selectedInventory = selectedState?.inventory
  const selectedMonitor = selectedHost ? monitorStates[getServerMonitorHostKey(selectedHost)] : undefined
  const selectedMonitorSnapshot = selectedMonitor?.latest?.snapshot ?? null
  const selectedDisplayMetrics = getDisplayMetric(selectedInventory, selectedMonitorSnapshot, t)
  const selectedConsoleLink = selectedHost ? getServerConsoleLink(selectedHost) : null
  const readyStates = Object.values(states).filter((state) => state.status === 'ready')
  const scanningCount = Object.values(states).filter((state) => state.status === 'scanning').length
  const errorCount = Object.values(states).filter((state) => state.status === 'error').length
    + Object.values(monitorStates).filter((state) => state.latest?.status === 'offline').length
  const projectCount = readyStates.reduce((total, state) => total + (state.inventory?.projects.length ?? 0), 0)
  const serviceCount = readyStates.reduce((total, state) => total + (state.inventory?.services.filter((service) => service.active === 'active').length ?? 0), 0)
  const cachedCount = Object.values(states).filter((state) => state.inventory).length
  const selectedNetwork = selectedHost ? networkByAddress[selectedHost.address] : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const selectedAgentDeployments = selectedHost ? (agentDeploymentsByHost.get(selectedHost.id) ?? []).filter((deployment) => {
    if (!normalizedQuery) return true
    return [
      deployment.name,
      deployment.deploymentPath,
      deployment.projectKind,
      deployment.status,
      deployment.agentName,
      deployment.notes,
      deployment.runtime?.language,
      deployment.runtime?.packageManager,
      deployment.runtime?.processManager,
      deployment.source?.repository,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery)
  }) : []
  const isMobile = presentation === 'mobile'

  function openToolManagerForSelectedHost() {
    if (selectedHost) setManagedToolHostId(selectedHost.id)
    setView('tools')
  }

  async function scanHosts(targetHosts: HostProfile[], options: { force?: boolean } = {}) {
    const runId = ++scanRunIdRef.current
    const result = await scanWorkspaceInventoryHosts({
      hosts: targetHosts,
      vaultId: activeVaultId,
      resolveAuthSecret,
      concurrency: SCAN_CONCURRENCY,
      currentStates: states,
      isCurrent: () => scanRunIdRef.current === runId,
      refreshIntervalMs: options.force ? 0 : undefined,
    })
    if (scanRunIdRef.current === runId && result.scannedHosts.length > 0) {
      setLastScanAt(Date.now())
    }
  }

  useEffect(() => {
    let cancelled = false
    void loadWorkspaceInventoryPersistedCache(hosts).then((cache) => {
      if (cancelled) return
      const sharedReadyStates = createReadyWorkspaceInventoryStates(cache)
      mergeWorkspaceInventoryStates(sharedReadyStates)
      setStates((prev) => {
        const next = { ...prev }
        Object.entries(cache).forEach(([key, entry]) => {
          if (next[key]?.status !== 'error' && !next[key]?.inventory) next[key] = { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
        })
        return next
      })
      setLastScanAt((prev) => {
        const latest = Object.values(cache).reduce<number | null>((next, entry) => Math.max(next ?? 0, entry.updatedAt), null)
        return Math.max(prev ?? 0, latest ?? 0) || null
      })
    })

    if (hosts.length > 0) {
      void scanHosts(hosts)
    }
    return () => {
      cancelled = true
      scanRunIdRef.current += 1
    }
  }, [hosts, resolveAuthSecret])

  if (hosts.length === 0) {
    return (
      <div data-tour="monitor-page">
        <WorkspaceEmptyState
          title={t('workspace.asset.emptyTitle')}
          description={t('workspace.asset.emptyDescription')}
        />
      </div>
    )
  }

  const filteredProjects = selectedInventory?.projects
    .map((project) => ({
      project,
      signals: getProjectDeploymentSignals(project, selectedInventory, t),
    }))
    .filter((entry) => projectMatches(entry.project, normalizedQuery, entry.signals)) ?? []
  const componentStatusCount = selectedInventory?.tools.length ?? 0
  const toolCount = readyStates.reduce((sum, state) => sum + (state.inventory?.tools.length ?? 0), 0)
  const headerTabs: Array<WorkspaceResourceHeaderTab & { count?: number }> = [
    { key: 'assets', label: t('workspace.asset.assetsTab'), icon: Network },
    { key: 'tools', label: t('workspace.asset.toolsTab'), icon: Wrench, count: toolCount },
    { key: 'deployments', label: t('workspace.asset.deploymentsTab'), icon: GitBranch, count: projectCount + agentDeployments.length },
  ]
  const handleHeaderTabChange = (tab: string) => {
    if (tab === 'tools') openToolManagerForSelectedHost()
    else if (tab === 'assets' || tab === 'deployments') setView(tab)
  }

  const handleServerSelect = (key: string) => {
    setSelectedKey(key)
    const nextHost = hosts.find((host) => hostKey(host) === key)
    if (nextHost) setManagedToolHostId(nextHost.id)
  }

  return (
    <div
      data-testid="workspace-asset-inventory-app"
      data-tour="monitor-page"
      className={cn(
        'flex min-w-0 flex-col text-[var(--workspace-text)]',
        isMobile ? 'min-h-0 gap-4 overflow-visible' : 'h-full min-h-[34rem] overflow-hidden',
      )}
    >
      <AssetInventoryHeader
          tabs={headerTabs}
          activeTab={view}
          onTabChange={handleHeaderTabChange}
          hosts={hosts}
          cachedCount={cachedCount}
          readyCount={readyStates.length}
          serviceCount={serviceCount}
          projectCount={projectCount}
          errorCount={errorCount}
          onScan={() => void scanHosts(hosts, { force: true })}
          onScanFiltered={hostRows.length > 0 && hostRows.length !== hosts.length ? () => void scanHosts(hostRows, { force: true }) : undefined}
          scanning={scanningCount > 0}
          lastScanAt={lastScanAt}
          onImportSsh={onImportSsh}
          onCreateHost={onCreateHost}
          headerExtraAction={headerExtraAction}
        />

      <div className={cn(
        'grid min-w-0 gap-4',
        isMobile ? 'pt-0' : 'min-h-0 flex-1 pt-4 xl:grid-cols-[minmax(20rem,0.68fr)_minmax(0,1.42fr)]',
      )}>
        <WorkspaceServerList
          variant="compact"
          header={<AssetListToolbar hosts={hosts} visibleCount={hostRows.length} groupFilter={groupFilter} tagFilter={tagFilter} sortMode={sortMode} query={query}
            onGroupFilter={setGroupFilter} onTagFilter={setTagFilter} onSortMode={setSortMode} onQueryChange={setQuery} />}
          hosts={hostRows}
          totalCount={hosts.length}
          selectedKey={selectedHost ? hostKey(selectedHost) : selectedKey}
          getHostKey={hostKey}
          onSelect={handleServerSelect}
          emptyText={t('workspace.asset.noMatch')}
          renderStatusIcon={(host) => <HostStatusDot state={states[hostKey(host)] ?? { status: 'idle' }} />}
          getStatusBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            const monitor = monitorStates[getServerMonitorHostKey(host)]?.latest
            if (monitor) {
              return { label: monitorStatusLabel(monitor.status, t), tone: monitorStatusTone(monitor.status) }
            }
            if (state.status === 'unsupported') return { label: t('workspace.monitor.status.unsupported'), tone: 'default' }
            if (state.status === 'error') return { label: t('workspace.asset.inaccessible'), tone: 'bad' }
            if (state.status === 'scanning') return { label: t('workspace.monitor.status.checking'), tone: 'info' }
            return { label: t('workspace.monitor.status.checking'), tone: 'info' }
          }}
          getPrimaryBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            if (state.status === 'error') return undefined
            const metrics = getDisplayMetric(state.inventory, monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot, t)
            return getRiskBadge([metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent], t)
          }}
          renderLeading={(host) => {
            const os = monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot?.os || states[hostKey(host)]?.inventory?.resource.os
            return <span className={cn('relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', os ? 'sb-os-badge' : 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]')} style={os ? { '--os': osBrandColor(os) } as CSSProperties : undefined}>
              <WorkspaceOsIcon os={os} className="h-4 w-4" />
              <span className="absolute -bottom-0.5 -right-0.5"><HostStatusDot state={states[hostKey(host)] ?? { status: 'idle' }} /></span>
            </span>
          }}
          renderRegionLine={(host) => {
            const network = networkByAddress[host.address]
            return network ? <HostRegionLine network={network} /> : null
          }}
          getSystemLabel={(host) => {
            const monitor = monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot
            return monitor?.os || states[hostKey(host)]?.inventory?.resource.os
          }}
          getSearchData={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            const monitor = monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot
            const network = networkByAddress[host.address]
            return {
              network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
              system: [inventory?.resource.os, inventory?.resource.kernel, monitor?.os, monitor?.kernel],
              tools: getInstalledToolSearchValues(inventory),
              projects: getProjectSearchValues(inventory),
            }
          }}
          getResourceMetrics={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            const monitor = monitorStates[getServerMonitorHostKey(host)]?.latest?.snapshot
            const metrics = getDisplayMetric(inventory, monitor, t)
            if (
              metrics.cpuPercent === null
              && metrics.memoryPercent === null
              && metrics.diskPercent === null
            ) return undefined
            return metrics
          }}
          renderFooter={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            const monitor = monitorStates[getServerMonitorHostKey(host)]?.latest
              const registeredProjects = agentDeploymentsByHost.get(host.id) ?? []
              const latestRegistration = registeredProjects[0]
            const source = monitor?.snapshot ? t('workspace.monitor.source.live') : inventory ? t('workspace.monitor.source.inventory') : t('workspace.monitor.source.pending')
            return (
              <div className="mt-2 text-[11px] text-[var(--workspace-text-subtle)]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Bot className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" />
                    <span className="truncate">{t('workspace.agentDeployments.summary', { count: registeredProjects.length })}</span>
                    {latestRegistration && <span className="truncate">· {agentDeploymentStatusLabel(latestRegistration.status, t)}</span>}
                  </div>
                <div>{monitor?.snapshot?.os || inventory?.resource.os ? t('workspace.asset.version', { version: monitor?.snapshot?.os || inventory?.resource.os || '' }) : t('workspace.asset.versionPending')}</div>
                  <div>{source}{monitor?.lastSuccessAt ? ` · ${new Date(monitor.lastSuccessAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}{agentDeploymentsObservedAt ? ` · ${t('workspace.agentDeployments.updatedAt', { time: new Date(agentDeploymentsObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}` : ''}</div>
              </div>
            )
          }}
          onRowDoubleClick={host => { if (hasSshConnection(host)) onOpenTerminal?.(host); else onEditHost?.(host) }}
          presentation={isMobile ? 'mobile' : 'panel'}
        />

        <div
          className={cn(
            'min-w-0',
            isMobile ? 'overflow-visible' : 'min-h-0 overflow-auto',
            view === 'assets' && !isMobile && 'rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-4 shadow-[var(--workspace-shadow-card)]',
          )}
        >
          {view === 'tools' ? (
            <WorkspaceToolManagerApp
              vaultId={activeVaultId}
              selectedHostId={selectedHost?.id ?? managedToolHostId ?? selectedHostId}
              hostAddress={hostAddress}
              hosts={hosts}
              resolveAuthSecret={resolveAuthSecret}
              onOpenTerminal={onOpenTerminal}
              hideHeader
              hideHostList
            />
          ) : view === 'deployments' ? (
            <ProjectDeploymentsPanel
              activeVaultId={activeVaultId}
              agentDeployments={agentDeployments}
              selectedHostId={selectedHost?.id ?? selectedHostId}
              hosts={hosts}
              resolveAuthSecret={resolveAuthSecret}
              onOpenTerminal={onOpenTerminal}
              hideHeader
              hideHostList
            />
          ) : !selectedHost ? (
            <WorkspaceEmptyState title={t('workspace.asset.noSelectedTitle')} description={t('workspace.asset.noSelectedDescription')} />
          ) : (
            <div className={cn('space-y-5', isMobile && 'pb-2')}>
              <div data-tour="monitor-status" className={cn('flex flex-col gap-3', !isMobile && 'lg:flex-row lg:items-start lg:justify-between')}>
                <div className="flex min-w-0 items-start gap-3">
                  <span className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', (selectedMonitorSnapshot?.os || selectedInventory?.resource.os) ? 'sb-os-badge' : 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}
                    style={(selectedMonitorSnapshot?.os || selectedInventory?.resource.os) ? { '--os': osBrandColor(selectedMonitorSnapshot?.os || selectedInventory?.resource.os || '') } as CSSProperties : undefined}>
                    <WorkspaceOsIcon os={selectedMonitorSnapshot?.os || selectedInventory?.resource.os} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <HostStatusDot state={selectedState ?? { status: 'idle' }} />
                      <span className="truncate text-xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{selectedHost.name}</span>
                      <Badge>{groupLabel(selectedHost.group || 'Custom', t)}</Badge>
                      {selectedMonitor?.latest && <Badge tone={monitorStatusTone(selectedMonitor.latest.status)}>{monitorStatusLabel(selectedMonitor.latest.status, t)}</Badge>}
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-[var(--workspace-text-muted)]">
                      <span className="font-mono">{selectedHost.username}@{selectedHost.address}:{selectedHost.port}</span>
                      {selectedNetwork && <span className="inline-flex items-center gap-1">· <HostRegionMeta network={selectedNetwork} /></span>}
                      <span>· {selectedMonitorSnapshot?.os || <HostSystemMeta resource={selectedInventory?.resource} fallbackKey="workspace.asset.versionPending" />}</span>
                      {(selectedMonitorSnapshot?.kernel || selectedInventory?.resource.kernel) && <span className="font-mono">· {selectedMonitorSnapshot?.kernel || selectedInventory?.resource.kernel}</span>}
                      {selectedState?.updatedAt ? <span>· {t('workspace.asset.scannedAgo', { minutes: Math.max(0, Math.round((Date.now() - selectedState.updatedAt) / 60_000)) })}</span> : null}
                    </div>
                    {(selectedHost.tags ?? []).length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{(selectedHost.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                  <button type="button" onClick={() => void scanHosts([selectedHost], { force: true })} disabled={selectedState?.status === 'scanning'}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-60">
                    {selectedState?.status === 'scanning' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}{t('workspace.asset.scanThisVps')}
                  </button>
                  {selectedConsoleLink && onOpenProviderConsole && (
                    <button type="button" onClick={() => onOpenProviderConsole(selectedConsoleLink.url, selectedHost)}
                      aria-label={t('workspace.asset.openConsole', { label: selectedConsoleLink.label })} title={t('workspace.asset.openConsole', { label: selectedConsoleLink.label })}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] px-2.5 text-xs font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)]">
                      <ExternalLink className="h-3.5 w-3.5" /><span>{t('workspace.asset.console', { label: selectedConsoleLink.label })}</span>
                    </button>
                  )}
                  {onEditHost && (
                    <button type="button" onClick={() => onEditHost(selectedHost)} title={t('workspace.asset.edit')}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)]">
                      <Pencil className="h-3.5 w-3.5" />{t('workspace.asset.edit')}
                    </button>
                  )}
                  {onOpenTerminal && (
                    <button type="button" disabled={!hasSshConnection(selectedHost)} onClick={() => onOpenTerminal(selectedHost)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--workspace-accent-subtle)] px-3 text-xs font-semibold text-[var(--workspace-accent-text)] transition-colors hover:bg-[color:var(--workspace-primary-500)] hover:text-[var(--workspace-primary-foreground)] disabled:opacity-50">
                      <SquareTerminal className="h-3.5 w-3.5" />{t('workspace.asset.terminal')}
                    </button>
                  )}
                </div>
              </div>

              {selectedState?.status === 'error' && (
                <div className="rounded-xl border border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
                  {t('workspace.asset.inaccessible')}
                </div>
              )}

              {selectedMonitor?.latest?.error && selectedMonitor.latest.status !== 'online' && (
                <div className={cn(
                  'rounded-xl border px-4 py-3 text-sm',
                  selectedMonitor.latest.status === 'offline'
                    ? 'border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]'
                    : 'border-[var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]',
                )}>
                  {selectedMonitor.latest.error}
                </div>
              )}

              {selectedInventory || selectedMonitor?.latest ? (
                <>
                  <RemainingResources metrics={selectedDisplayMetrics} snapshot={selectedMonitorSnapshot} history={selectedMonitor?.history ?? []} isMobile={isMobile} t={t} />
                  <div data-tour="monitor-source" className="flex flex-wrap items-center gap-2 text-xs text-[var(--workspace-text-muted)]">
                    <span>{t('workspace.monitor.sourceLabel')}</span>
                    <Badge tone={selectedMonitorSnapshot ? 'good' : 'default'}>
                      {selectedMonitorSnapshot ? t('workspace.monitor.source.live') : t('workspace.monitor.source.inventory')}
                    </Badge>
                    {selectedMonitor?.latest?.lastSuccessAt && (
                      <span>{t('workspace.monitor.sampledAt', { time: new Date(selectedMonitor.latest.lastSuccessAt).toLocaleString() })}</span>
                    )}
                  </div>

                  {selectedMonitor?.latest && (
                    <details data-tour="monitor-trends" className="group rounded-xl border border-[color:var(--workspace-border-soft)] px-3 py-2">
                      <summary className="cursor-pointer list-none text-xs font-medium text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]">{t('workspace.asset.moreMetrics')}</summary>
                      <div className="mt-3"><MonitorOverview latest={selectedMonitor.latest} history={selectedMonitor.history} t={t} /></div>
                    </details>
                  )}

                  {selectedInventory ? (
                    <section>
                      <div className="mb-2.5 flex items-center justify-between">
                        <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('workspace.asset.components')}<span className="ml-1.5 font-mono text-[11px] font-normal text-[var(--workspace-text-subtle)]">{componentStatusCount}</span></h3>
                        <button type="button" onClick={openToolManagerForSelectedHost} aria-label={t('workspace.asset.manageCurrentTools')} title={t('workspace.asset.manageCurrentTools')}
                          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--workspace-accent-text)] hover:underline">
                          <Settings2 className="h-3.5 w-3.5" />{t('workspace.asset.manageTools')} →
                        </button>
                      </div>
                      <div className={cn('grid gap-2', isMobile ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4')}>
                        {selectedInventory.tools.map((tool) => {
                          const serviceName = getInventoryToolServiceName(tool.id)
                          const service = serviceName ? selectedInventory.services.find((entry) => entry.name === serviceName) : undefined
                          const tone = service ? getServiceTone(service.active) : null
                          return (
                            <div key={`${tool.id}-${tool.binary}`} data-testid="asset-component" className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5" title={tool.path || tool.binary}>
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-surface-700)]"><WorkspaceServiceIcon name={tool.id} className="h-4 w-4 text-[var(--workspace-text)]" /></span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{tool.name}</span>
                                <span className="block truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{tool.version.match(/\d+(?:\.\d+)+/)?.[0] ?? (tool.version || tool.binary)}</span>
                              </span>
                              {service && <span className="sr-only">{service.active || service.enabled}</span>}
                              {service && <span aria-hidden="true" title={service.active || service.enabled} className={cn('h-2 w-2 shrink-0 rounded-full', tone === 'good' ? 'bg-[var(--workspace-status-good)]' : tone === 'bad' ? 'bg-[var(--workspace-status-bad)]' : tone === 'warn' ? 'bg-[var(--workspace-status-warn)]' : 'bg-[var(--workspace-text-subtle)]')} />}
                            </div>
                          )
                        })}
                        {componentStatusCount === 0 && <div className="text-sm text-[var(--workspace-text-muted)]">{t('workspace.asset.noComponents')}</div>}
                      </div>
                    </section>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-panel)] px-4 py-5 text-sm text-[var(--workspace-text-muted)]">
                      {t('workspace.monitor.inventoryPending')}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex min-h-[18rem] items-center justify-center rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-panel)] px-6 text-center text-sm text-[var(--workspace-text-muted)]">
                  {selectedState?.status === 'error'
                    ? t('workspace.asset.hostInaccessibleRetry')
                    : selectedState?.status === 'scanning'
                      ? t('workspace.asset.scanningHost')
                      : t('workspace.asset.scanHostHint')}
                </div>
              )}

              <ProjectDirectory projects={selectedInventory ? filteredProjects : []} deployments={selectedAgentDeployments} t={t} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
