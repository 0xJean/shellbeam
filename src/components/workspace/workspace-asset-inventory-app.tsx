import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
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
import { getResourceUsageFillClassName, RESOURCE_USAGE_BAD_THRESHOLD, RESOURCE_USAGE_WARN_THRESHOLD } from '@/lib/resource-usage'
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
  Boxes,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Cpu,
  ExternalLink,
  FileDown,
  FolderGit2,
  Gauge,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Settings2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Timer,
  Tags,
  Wifi,
  Wrench,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOsIcon } from './workspace-os-icon'
import { WorkspaceResourceOverviewHeader, type WorkspaceResourceGroup, type WorkspaceResourceHeaderTab } from './workspace-resource-overview-header'
import { WorkspaceServiceIcon } from './workspace-service-icon'
import { WorkspaceServerList, workspaceServerMatchesSearch, type WorkspaceServerSearchData } from './workspace-server-list'
import { WorkspaceToolManagerApp, TOOL_CATALOG } from './workspace-tool-manager-app'

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
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

const SCAN_CONCURRENCY = 3
const ASSET_GROUP_COLORS = [
  'bg-[color:var(--workspace-primary-400)]',
  'bg-emerald-400',
  'bg-sky-400',
  'bg-amber-300',
  'bg-violet-400',
  'bg-rose-400',
  'bg-cyan-400',
  'bg-orange-400',
]

type AssetSortMode = 'recent' | 'name' | 'resource' | 'status'
type TFunction = ReturnType<typeof useT>['t']

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

function formatPercent(value: number | null, t: TFunction) {
  return value === null ? t('workspace.common.notAvailable') : `${Math.round(value)}%`
}

function getRiskLabel(value: number | null, t: TFunction) {
  if (value === null) return t('workspace.asset.unknown')
  if (value >= RESOURCE_USAGE_BAD_THRESHOLD) return t('workspace.asset.riskTight')
  if (value >= RESOURCE_USAGE_WARN_THRESHOLD) return t('workspace.asset.riskHigh')
  return t('workspace.asset.riskEnough')
}

function ResourceMeter({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: number | null
  detail?: string
}) {
  const { t } = useT()
  const width = value === null ? 0 : Math.min(100, Math.max(0, value))

  return (
    <div className="min-w-0 rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-4 py-3 shadow-[var(--workspace-shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
            <Icon className="h-4 w-4" />
          </span>
          <span className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{label}</span>
        </div>
        <span className="font-mono text-xs font-semibold text-[var(--workspace-text-strong)]">{formatPercent(value, t)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--workspace-meter-track)]">
        <div className={cn('h-full rounded-full transition-[width] duration-300', getResourceUsageFillClassName(value))} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--workspace-text-muted)]">
        <span>{getRiskLabel(value, t)}</span>
        {detail && <span className="truncate text-right">{detail}</span>}
      </div>
    </div>
  )
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
    <section className="rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-4 shadow-[var(--workspace-shadow-card)]">
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

function getHostScanLabel(state: HostInventoryState, t: TFunction) {
  if (state.status === 'scanning') return t('workspace.asset.scanning')
  if (state.status === 'error') return t('workspace.asset.inaccessible')
  return t('workspace.asset.notScanned')
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

function AssetInventoryHeader({
  hosts,
  visibleCount,
  cachedCount,
  groupFilter,
  tagFilter,
  sortMode,
  query,
  onGroupFilter,
  onTagFilter,
  onSortMode,
  onQueryChange,
  readyCount,
  serviceCount,
  projectCount,
  errorCount,
  onScan,
  scanning,
  scanLabel,
  lastScanAt,
  onImportSsh,
  onCreateHost,
  headerExtraAction,
  preheader,
  tabs,
  activeTab,
  onTabChange,
}: {
  hosts: HostProfile[]
  visibleCount: number
  cachedCount: number
  groupFilter: string
  tagFilter: Set<string>
  sortMode: AssetSortMode
  query: string
  onGroupFilter: (group: string) => void
  onTagFilter: (tags: Set<string>) => void
  onSortMode: (mode: AssetSortMode) => void
  onQueryChange: (value: string) => void
  readyCount: number
  serviceCount: number
  projectCount: number
  errorCount: number
  onScan: () => void
  scanning: boolean
  scanLabel: string
  lastScanAt: number | null
  onImportSsh?: () => void
  onCreateHost?: () => void
  headerExtraAction?: ReactNode
  preheader?: ReactNode
  tabs?: WorkspaceResourceHeaderTab[]
  activeTab?: string
  onTabChange?: (tab: string) => void
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

  if (hosts.length === 0) return null

  const resourceGroups: WorkspaceResourceGroup[] = groups.map(([group, count], index) => ({
    key: group,
    label: groupLabel(group, t),
    count,
    colorClassName: ASSET_GROUP_COLORS[index % ASSET_GROUP_COLORS.length],
  }))

  const note = (
    <div className="space-y-1">
      {cachedCount > 0 && (
        <div>{t('workspace.asset.cachedNote', { count: cachedCount })}</div>
      )}
      <div>{lastScanAt ? t('workspace.asset.lastScan', { time: new Date(lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('workspace.asset.waitingScan')}</div>
    </div>
  )

  return (
    <>
      <WorkspaceResourceOverviewHeader
        preheader={preheader}
        eyebrow={<><Network className="h-3.5 w-3.5" />{t('workspace.asset.eyebrow')}</>}
        title={t('workspace.asset.title')}
        description={t('workspace.asset.description')}
        note={note}
        actions={
          <>
            {headerExtraAction}
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
                <Clock className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{sortLabels[sortMode]}</span>
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
          </>
        }
        total={hosts.length}
        totalLabel={t('workspace.asset.totalHosts')}
        visibleCount={visibleCount}
        visibleLabel={t('workspace.asset.matchedHosts')}
        groups={resourceGroups}
        selectedGroup={groupFilter}
        allGroupLabel={t('workspace.common.all')}
        onGroupSelect={onGroupFilter}
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('workspace.asset.searchPlaceholder')}
              className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
            />
          </div>
        }
        controls={
          <>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onScan}
              disabled={scanning}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {scanLabel}
            </button>
            <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">
              {readyCount}/{hosts.length} {t('workspace.asset.metricHosts')}
            </span>
            <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">
              {serviceCount} {t('workspace.asset.metricServices')}
            </span>
            <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">
              {projectCount} {t('workspace.asset.metricProjects')}
            </span>
            {errorCount > 0 && (
              <span className="rounded-full border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-2.5 py-1 text-[11px] text-[var(--workspace-status-bad-text)]">
                {errorCount} {t('workspace.asset.metricErrors')}
              </span>
            )}
            {onImportSsh && (
              <button
                type="button"
                onClick={onImportSsh}
                className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
              >
                <FileDown className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('workspace.asset.importSsh')}</span>
              </button>
            )}
            {onCreateHost && (
              <button
                type="button"
                onClick={onCreateHost}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-[color:var(--workspace-primary-500)] px-3 text-xs font-semibold text-[var(--workspace-primary-foreground)] transition-colors hover:bg-[color:var(--workspace-primary-400)]"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('workspace.asset.newConnection')}
              </button>
            )}
          </>
        }
      />

      {tabs?.length ? (
        <div role="tablist" className="mt-4 flex flex-wrap gap-1 rounded-lg bg-[var(--workspace-surface-800)] p-0.5">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={tab.disabled}
                onClick={() => onTabChange?.(tab.key)}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)] shadow-sm ring-1 ring-[var(--workspace-border-glow)]'
                    : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                {Icon && <Icon className="h-3.5 w-3.5" />}
                {tab.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </>
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
    setStates((prev) => ({ ...prev, ...selectWorkspaceInventoryStatesForHosts(hosts, sharedStates) }))
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
  const headerTabs: WorkspaceResourceHeaderTab[] = [
    { key: 'assets', label: t('workspace.asset.assetsTab'), icon: Network },
    { key: 'tools', label: t('workspace.asset.toolsTab'), icon: Wrench },
    { key: 'deployments', label: t('workspace.asset.deploymentsTab'), icon: GitBranch },
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
          visibleCount={hostRows.length}
          cachedCount={cachedCount}
          groupFilter={groupFilter}
          tagFilter={tagFilter}
          sortMode={sortMode}
          query={query}
          onGroupFilter={setGroupFilter}
          onTagFilter={setTagFilter}
          onSortMode={setSortMode}
          onQueryChange={setQuery}
          readyCount={readyStates.length}
          serviceCount={serviceCount}
          projectCount={projectCount}
          errorCount={errorCount}
          onScan={() => void scanHosts(hostRows.length > 0 ? hostRows : hosts, { force: true })}
          scanning={scanningCount > 0}
          scanLabel={hostRows.length > 0 && hostRows.length !== hosts.length ? t('workspace.asset.scanFiltered') : t('workspace.asset.scanAll')}
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
            if (state.status === 'error') return { label: t('workspace.asset.inaccessible'), tone: 'bad' }
            if (state.status === 'scanning') return { label: t('workspace.monitor.status.checking'), tone: 'info' }
            return { label: t('workspace.monitor.status.checking'), tone: 'info' }
          }}
          getPrimaryBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            if (state.status === 'error') return undefined
            return { label: state.inventory?.projects.length ? t('workspace.asset.projectsCount', { count: state.inventory.projects.length }) : t('workspace.asset.assetBadge'), tone: state.status === 'ready' ? 'info' : 'default' }
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
          onRowDoubleClick={onOpenTerminal}
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
            <div className={cn('space-y-4', isMobile && 'pb-2')}>
              <div className={cn(
                'rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-card)]',
                isMobile ? 'p-3' : 'p-4',
              )}>
                <div className={cn('flex flex-col gap-4', !isMobile && 'lg:flex-row lg:items-start lg:justify-between')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
                        <WorkspaceOsIcon os={selectedMonitorSnapshot?.os || selectedInventory?.resource.os} className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{selectedHost.name}</div>
                        <div className="mt-1 truncate text-sm text-[var(--workspace-text-muted)]">
                          {selectedHost.username}@{selectedHost.address}:{selectedHost.port}
                        </div>
                      </div>
                    </div>
                    <div data-tour="monitor-status" className="mt-3 flex flex-wrap gap-2">
                      <Badge>{groupLabel(selectedHost.group || 'Custom', t)}</Badge>
                      {selectedMonitor?.latest && (
                        <Badge tone={monitorStatusTone(selectedMonitor.latest.status)}>
                          {monitorStatusLabel(selectedMonitor.latest.status, t)}
                        </Badge>
                      )}
                      {selectedState?.status === 'error' && <Badge tone="bad">{getHostScanLabel(selectedState, t)}</Badge>}
                      {selectedNetwork && (
                        <Badge>
                          <HostRegionMeta network={selectedNetwork} />
                        </Badge>
                      )}
                      {(selectedHost.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                      <Badge>
                        {selectedMonitorSnapshot?.os
                          || <HostSystemMeta resource={selectedInventory?.resource} fallbackKey="workspace.asset.versionPending" />}
                      </Badge>
                      {(selectedMonitorSnapshot?.kernel || selectedInventory?.resource.kernel) && <Badge>{selectedMonitorSnapshot?.kernel || selectedInventory?.resource.kernel}</Badge>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                    <button
                      type="button"
                      onClick={() => void scanHosts([selectedHost], { force: true })}
                      disabled={selectedState?.status === 'scanning'}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {selectedState?.status === 'scanning' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {t('workspace.asset.scanThisVps')}
                    </button>
                    {(onOpenTerminal || onEditHost || (selectedConsoleLink && onOpenProviderConsole)) && (
                      <>
                      {onOpenTerminal && (
                        <button
                          type="button"
                          onClick={() => onOpenTerminal(selectedHost)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-[color:var(--workspace-primary-500)] px-3 text-xs font-semibold text-[var(--workspace-primary-foreground)] transition-colors hover:bg-[color:var(--workspace-primary-400)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <SquareTerminal className="h-3.5 w-3.5" />
                          {t('workspace.asset.terminal')}
                        </button>
                      )}
                      {onEditHost && (
                        <button
                          type="button"
                          onClick={() => onEditHost(selectedHost)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {t('workspace.asset.edit')}
                        </button>
                      )}
                      {selectedConsoleLink && onOpenProviderConsole && (
                        <button
                          type="button"
                          onClick={() => onOpenProviderConsole(selectedConsoleLink.url, selectedHost)}
                          aria-label={t('workspace.asset.openConsole', { label: selectedConsoleLink.label })}
                          title={t('workspace.asset.openConsole', { label: selectedConsoleLink.label })}
                          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>{t('workspace.asset.console', { label: selectedConsoleLink.label })}</span>
                        </button>
                      )}
                      </>
                    )}
                  </div>
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
                  <div data-tour="monitor-resources" className={cn('grid gap-3', isMobile ? 'grid-cols-1' : 'md:grid-cols-3')}>
                    <ResourceMeter icon={Cpu} label={t('workspace.common.cpu')} value={selectedDisplayMetrics.cpuPercent} detail={selectedDisplayMetrics.cpuDetail} />
                    <ResourceMeter icon={MemoryStick} label={t('workspace.common.memory')} value={selectedDisplayMetrics.memoryPercent} detail={selectedDisplayMetrics.memoryDetail} />
                    <ResourceMeter icon={HardDrive} label={t('workspace.common.disk')} value={selectedDisplayMetrics.diskPercent} detail={selectedDisplayMetrics.diskDetail} />
                  </div>

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
                    <div data-tour="monitor-trends">
                      <MonitorOverview
                        latest={selectedMonitor.latest}
                        history={selectedMonitor.history}
                        t={t}
                      />
                    </div>
                  )}

                  {selectedInventory ? (
                    <>
                  <AssetDetailSection
                    icon={Boxes}
                    title={t('workspace.asset.components')}
                    meta={componentStatusCount}
                    action={
                        <button
                          type="button"
                          onClick={openToolManagerForSelectedHost}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
                          aria-label={t('workspace.asset.manageCurrentTools')}
                          title={t('workspace.asset.manageCurrentTools')}
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                    }
                  >
                    <div className={cn('grid gap-2', isMobile ? 'grid-cols-1' : 'md:grid-cols-2 2xl:grid-cols-3')}>
                      {selectedInventory.tools.map((tool) => {
                        const serviceName = getInventoryToolServiceName(tool.id)
                        const service = serviceName
                          ? selectedInventory.services.find((entry) => entry.name === serviceName)
                          : undefined
                        return (
                          <div key={`${tool.id}-${tool.binary}`} className="min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <WorkspaceServiceIcon name={tool.id} className="h-4 w-4 text-[var(--workspace-text-muted)]" />
                                <div className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{tool.name}</div>
                              </div>
                              {service && <Badge tone={getServiceTone(service.active)}>{service.active || service.enabled}</Badge>}
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{tool.binary}</div>
                          </div>
                        )
                      })}
                      {componentStatusCount === 0 && <div className="text-sm text-[var(--workspace-text-muted)]">{t('workspace.asset.noComponents')}</div>}
                    </div>
                  </AssetDetailSection>
                    </>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-panel)] px-4 py-5 text-sm text-[var(--workspace-text-muted)]">
                      {t('workspace.monitor.inventoryPending')}
                    </div>
                  )}

                  {selectedInventory && <AssetDetailSection
                    icon={FolderGit2}
                    title={t('workspace.assetDiscovery.title')}
                    meta={filteredProjects.length}
                  >
                    <p className="mb-3 text-xs leading-5 text-[var(--workspace-text-muted)]">{t('workspace.assetDiscovery.description')}</p>
                    <div className={cn('grid gap-2', isMobile ? 'grid-cols-1' : 'xl:grid-cols-2')}>
                      {filteredProjects.map(({ project, signals }) => {
                        const isRunning = signals.some(isRunningSignal)
                        return (
                          <div
                            key={`${project.path}-${project.kind}`}
                            className={cn(
                              'min-w-0 rounded-xl border px-3 py-2.5',
                              isRunning
                                ? 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)]'
                                : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)]',
                            )}
                          >
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <div className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{project.name || project.kind}</div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {isRunning && <Badge tone="good">{t('workspace.asset.running')}</Badge>}
                                <Badge>{project.kind}</Badge>
                              </div>
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{project.path}</div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {signals.slice(0, 4).map((signal) => (
                                <Badge key={signal} tone={isRunningSignal(signal) ? 'good' : 'default'}>{signal}</Badge>
                              ))}
                              {signals.length === 0 && <span className="text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.asset.noRunSignals')}</span>}
                            </div>
                            {project.modifiedAt && <div className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">{project.modifiedAt}</div>}
                          </div>
                        )
                      })}
                      {filteredProjects.length === 0 && <div className="text-sm text-[var(--workspace-text-muted)]">{t('workspace.asset.noProjects')}</div>}
                    </div>
                  </AssetDetailSection>}
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

              <AssetDetailSection
                icon={Bot}
                title={t('workspace.agentDeployments.title')}
                meta={t('workspace.agentDeployments.count', { count: selectedAgentDeployments.length })}
              >
                <p className="mb-3 text-xs leading-5 text-[var(--workspace-text-muted)]">{t('workspace.agentDeployments.description')}</p>
                {selectedAgentDeployments.length > 0 ? (
                  <div className={cn('grid gap-2', isMobile ? 'grid-cols-1' : 'xl:grid-cols-2')}>
                    {selectedAgentDeployments.map((deployment) => (
                      <div key={`${deployment.clientId}:${deployment.deploymentId}`} className="min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] px-3 py-2.5">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{deployment.name || deployment.projectKind}</div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{deployment.deploymentPath}</div>
                          </div>
                          <Badge tone={agentDeploymentTone(deployment.status)}>{agentDeploymentStatusLabel(deployment.status, t)}</Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {deployment.agentName && <Badge tone="info">{t('workspace.agentDeployments.agent', { name: deployment.agentName })}</Badge>}
                          {deployment.projectKind && <Badge>{deployment.projectKind}</Badge>}
                          {deployment.runtime?.language && <Badge>{deployment.runtime.language}{deployment.runtime.version ? ` ${deployment.runtime.version}` : ''}</Badge>}
                          {deployment.runtime?.packageManager && <Badge>{deployment.runtime.packageManager}</Badge>}
                        </div>
                        {deployment.source?.repository && <div className="mt-2 truncate text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.agentDeployments.source')}: {deployment.source.repository}</div>}
                        <div className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.agentDeployments.updatedAt', { time: new Date(deployment.updatedAt).toLocaleString() })}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-panel)] px-4 py-5 text-sm text-[var(--workspace-text-muted)]">
                    {t('workspace.agentDeployments.empty')}
                  </div>
                )}
              </AssetDetailSection>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
