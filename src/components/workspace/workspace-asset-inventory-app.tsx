import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { ProjectDeploymentsPanel, getProjectDeploymentSignals } from '@/components/project-deployments-panel'
import {
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
  type WorkspaceInventoryProject,
} from '@/lib/workspace-inventory'
import { getServerConsoleLink } from '@/lib/server-console'
import {
  createReadyWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  selectWorkspaceInventoryStatesForHosts,
  useWorkspaceInventoryStates,
} from '@/lib/workspace-inventory-state'
import { scanWorkspaceInventoryHosts } from '@/lib/workspace-inventory-scan'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Cpu,
  ExternalLink,
  FileDown,
  FolderGit2,
  GitBranch,
  Grid2X2,
  HardDrive,
  List,
  Loader2,
  MemoryStick,
  Network,
  Settings2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  SquareTerminal,
  Tags,
  Wrench,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspacePanelHeader } from './workspace-panel-header'
import { WorkspaceServerList, workspaceServerMatchesSearch, type WorkspaceServerSearchData } from './workspace-server-list'
import { WorkspaceToolManagerApp, TOOL_CATALOG } from './workspace-tool-manager-app'

interface WorkspaceAssetInventoryAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  initialView?: 'assets' | 'tools' | 'deployments'
  onOpenTerminal?: (host: HostProfile) => void
  onOpenProviderConsole?: (url: string, host: HostProfile) => void
  onEditHost?: (host: HostProfile) => void
  onImportSsh?: () => void
  onCreateHost?: () => void
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
type AssetSummaryMode = 'grid' | 'compact'

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

function formatPercent(value: number | null) {
  return value === null ? 'n/a' : `${Math.round(value)}%`
}

function getUsageTone(value: number | null) {
  if (value === null) return 'bg-slate-500'
  if (value >= 90) return 'bg-red-400'
  if (value >= 75) return 'bg-amber-300'
  return 'bg-emerald-300'
}

function getRiskLabel(value: number | null) {
  if (value === null) return '未知'
  if (value >= 90) return '紧张'
  if (value >= 75) return '偏高'
  return '充足'
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
  const width = value === null ? 0 : Math.min(100, Math.max(0, value))

  return (
    <div className="min-w-0 rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.54)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-[color:var(--workspace-primary-300)]" />
          <span className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{label}</span>
        </div>
        <span className="font-mono text-xs font-semibold text-[var(--workspace-text-strong)]">{formatPercent(value)}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[rgba(15,23,42,0.95)]">
        <div className={cn('h-full rounded-full transition-[width] duration-300', getUsageTone(value))} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--workspace-text-muted)]">
        <span>{getRiskLabel(value)}</span>
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
        tone === 'good' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-200',
        tone === 'bad' && 'border-red-500/30 bg-red-500/10 text-red-200',
        tone === 'info' && 'border-sky-500/30 bg-sky-500/10 text-sky-200',
        tone === 'default' && 'border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.7)] text-[var(--workspace-text)]',
      )}
    >
      <span className="truncate">{children}</span>
    </span>
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
  if (state.status === 'scanning') return <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--workspace-primary-300)]" />
  if (state.status === 'ready') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
  if (state.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
  return <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />
}

function getHostScanLabel(state: HostInventoryState) {
  if (state.status === 'scanning') return '扫描中'
  if (state.status === 'error') return '无法访问'
  return '未扫描'
}

function HostRegionLine({ network }: { network: HostNetworkDisplay }) {
  return <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{network.resolvedLocationLabel}</div>
}

function groupLabel(group: string) {
  const labels: Record<string, string> = {
    Production: '生产',
    Development: '开发',
    Staging: '预发布',
    Custom: '自定义',
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

function AssetMetricCard({
  icon: Icon,
  label,
  value,
  compact = false,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: ReactNode
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.32)]',
        compact ? 'px-3 py-2' : 'px-3 py-3',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-[color:var(--workspace-primary-300)]" />
        <span className="truncate text-[11px] font-medium text-[var(--workspace-text-muted)]">{label}</span>
      </div>
      <div className={cn('mt-1 truncate font-mono font-semibold text-[var(--workspace-text-strong)]', compact ? 'text-sm' : 'text-base')}>
        {value}
      </div>
    </div>
  )
}

function AssetInventoryHeader({
  hosts,
  visibleCount,
  cachedCount,
  groupFilter,
  tagFilter,
  sortMode,
  summaryMode,
  query,
  onGroupFilter,
  onTagFilter,
  onSortMode,
  onSummaryMode,
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
}: {
  hosts: HostProfile[]
  visibleCount: number
  cachedCount: number
  groupFilter: string
  tagFilter: Set<string>
  sortMode: AssetSortMode
  summaryMode: AssetSummaryMode
  query: string
  onGroupFilter: (group: string) => void
  onTagFilter: (tags: Set<string>) => void
  onSortMode: (mode: AssetSortMode) => void
  onSummaryMode: (mode: AssetSummaryMode) => void
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
}) {
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
    recent: '最近优先',
    name: '名称排序',
    resource: '资源压力',
    status: '状态优先',
  }

  if (hosts.length === 0) return null

  const note = (
    <div className="space-y-1">
      {cachedCount > 0 && (
        <div>已先显示 {cachedCount} 台 VPS 的本地缓存，后台扫描完成后会自动更新。</div>
      )}
      <div>{lastScanAt ? `上次扫描 ${new Date(lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待首次扫描'}</div>
    </div>
  )

  return (
    <WorkspacePanelHeader
      className="border-b border-[color:var(--workspace-border-strong)] pb-4"
      headerClassName="xl:flex-row xl:items-start xl:justify-between"
      eyebrow={<><Network className="h-3.5 w-3.5" />VPS Asset Inventory</>}
      title="资源总览"
      description="把所有 VPS 的剩余资源、已安装工具、运行服务和疑似部署项目放到一张可搜索的资产地图里。"
      note={note}
      actionsClassName="justify-start xl:justify-end"
      actions={
        <>
          <button
            type="button"
            onClick={onScan}
            disabled={scanning}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] px-3 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[rgba(30,44,60,0.82)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {scanLabel}
          </button>
          {onImportSsh && (
            <button
              type="button"
              onClick={onImportSsh}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] px-3 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[rgba(30,44,60,0.82)]"
            >
              <FileDown className="h-3.5 w-3.5" />
              导入 SSH 配置
            </button>
          )}
          {onCreateHost && (
            <button
              type="button"
              onClick={onCreateHost}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-[color:var(--workspace-primary-500)] px-3 text-xs font-semibold text-white transition-colors hover:bg-[color:var(--workspace-primary-400)]"
            >
              <Plus className="h-3.5 w-3.5" />
              新建连接
            </button>
          )}
        </>
      }
      contentClassName="mt-4 space-y-4"
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)]">
        <div className="min-w-0">
          <div className="flex items-end gap-2">
            <span className="text-3xl font-semibold leading-none text-[var(--workspace-text-strong)]">{hosts.length}</span>
            <span className="pb-1 text-sm text-[var(--workspace-text-muted)]">全部主机</span>
            {visibleCount !== hosts.length && (
              <span className="pb-1 text-xs text-[var(--workspace-text-subtle)]">{visibleCount} 台匹配</span>
            )}
          </div>
          {groups.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex h-2 overflow-hidden rounded-full bg-[rgba(148,163,184,0.18)]">
                {groups.map(([group, count], index) => (
                  <div
                    key={group}
                    className={cn('h-full', ASSET_GROUP_COLORS[index % ASSET_GROUP_COLORS.length])}
                    style={{ width: `${(count / hosts.length) * 100}%` }}
                    title={`${groupLabel(group)} ${count}`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {groups.map(([group, count], index) => (
                  <button
                    key={group}
                    type="button"
                    onClick={() => onGroupFilter(groupFilter === group ? 'All' : group)}
                    className={cn(
                      'inline-flex items-center gap-1.5 text-xs transition-colors',
                      groupFilter === group ? 'text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', ASSET_GROUP_COLORS[index % ASSET_GROUP_COLORS.length])} />
                    <span>{groupLabel(group)}</span>
                    <span className="font-semibold">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-1 rounded-lg bg-[rgba(24,35,48,0.42)] p-0.5">
            {['All', ...groups.map(([group]) => group)].map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => onGroupFilter(group)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  groupFilter === group
                    ? 'bg-[rgba(8,15,22,0.84)] text-[var(--workspace-text-strong)] shadow-sm'
                    : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                )}
              >
                {group === 'All' ? '全部' : groupLabel(group)}
              </button>
            ))}
          </div>
          <div className="mt-4 relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索主机、IP、地区、工具、项目路径..."
              className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.72)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
            />
          </div>
        </div>
        <div className={cn('grid gap-2 sm:grid-cols-2 xl:grid-cols-4', summaryMode === 'compact' ? 'items-stretch' : '')}>
          <AssetMetricCard icon={ServerCog} label="主机" value={`${readyCount}/${hosts.length}`} compact={summaryMode === 'compact'} />
          <AssetMetricCard icon={Boxes} label="服务" value={serviceCount} compact={summaryMode === 'compact'} />
          <AssetMetricCard icon={FolderGit2} label="项目" value={projectCount} compact={summaryMode === 'compact'} />
          <AssetMetricCard icon={AlertTriangle} label="异常" value={errorCount} compact={summaryMode === 'compact'} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => { setTagOpen((value) => !value); setSortOpen(false) }}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition-colors',
              tagFilter.size > 0
                ? 'border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.14)] text-[var(--workspace-text-strong)]'
                : 'border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] text-[var(--workspace-text)] hover:bg-[rgba(30,44,60,0.82)]',
            )}
          >
            <Tags className="h-3.5 w-3.5" />
            标签{tagFilter.size > 0 ? ` ${tagFilter.size}` : ''}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {tagOpen && (
            <>
              <button type="button" aria-label="关闭标签筛选" className="fixed inset-0 z-40 cursor-default" onClick={() => setTagOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] p-1 shadow-xl">
                {tagFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={() => { onTagFilter(new Set()); setTagOpen(false) }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-[var(--workspace-text-muted)] transition-colors hover:bg-[rgba(24,35,48,0.72)] hover:text-[var(--workspace-text)]"
                  >
                    清除标签筛选
                  </button>
                )}
                <div className="max-h-60 overflow-auto">
                  {tags.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-[var(--workspace-text-muted)]">暂无标签</div>
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
                          active ? 'bg-[rgba(19,127,236,0.14)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[rgba(24,35,48,0.72)]',
                        )}
                      >
                        <span className={cn('flex h-4 w-4 items-center justify-center rounded border text-[10px]', active ? 'border-[color:var(--workspace-border-glow)] bg-[color:var(--workspace-primary-500)] text-white' : 'border-[color:var(--workspace-border-soft)]')}>
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
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] px-3 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[rgba(30,44,60,0.82)]"
          >
            <Clock className="h-3.5 w-3.5" />
            {sortLabels[sortMode]}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {sortOpen && (
            <>
              <button type="button" aria-label="关闭排序菜单" className="fixed inset-0 z-40 cursor-default" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] p-1 shadow-xl">
                {(Object.keys(sortLabels) as AssetSortMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { onSortMode(mode); setSortOpen(false) }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                      sortMode === mode ? 'bg-[rgba(19,127,236,0.14)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[rgba(24,35,48,0.72)]',
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

        <div className="inline-flex h-9 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.52)] p-0.5">
          <button
            type="button"
            aria-label="卡片摘要"
            onClick={() => onSummaryMode('grid')}
            className={cn('flex h-8 w-8 items-center justify-center rounded-lg transition-colors', summaryMode === 'grid' ? 'bg-[rgba(8,15,22,0.84)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]')}
          >
            <Grid2X2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="紧凑摘要"
            onClick={() => onSummaryMode('compact')}
            className={cn('flex h-8 w-8 items-center justify-center rounded-lg transition-colors', summaryMode === 'compact' ? 'bg-[rgba(8,15,22,0.84)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]')}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>
    </WorkspacePanelHeader>
  )
}

export function WorkspaceAssetInventoryApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  initialView = 'assets',
  onOpenTerminal,
  onOpenProviderConsole,
  onEditHost,
  onImportSsh,
  onCreateHost,
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
  const [summaryMode, setSummaryMode] = useState<AssetSummaryMode>('grid')
  const sharedStates = useWorkspaceInventoryStates()
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
      const network = networkByAddress[host.address]
      const searchData: WorkspaceServerSearchData = {
        network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
        system: [inventory?.resource.os, inventory?.resource.kernel],
        tools: getInstalledToolSearchValues(inventory),
        projects: [
          ...getProjectSearchValues(inventory),
          ...(inventory?.containers.flatMap((container) => [container.name, container.image]) ?? []),
          ...(inventory?.pm2.map((process) => process.raw) ?? []),
        ],
      }
      return workspaceServerMatchesSearch(host, normalizedQuery, searchData)
    })

    return filtered.sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name)
      if (sortMode === 'resource') return getResourcePressure(states[hostKey(b)]) - getResourcePressure(states[hostKey(a)])
      if (sortMode === 'status') {
        const score = (host: HostProfile) => {
          const status = states[hostKey(host)]?.status
          if (status === 'error') return 0
          if (status === 'scanning') return 1
          if (status === 'idle') return 2
          return 3
        }
        return score(a) - score(b)
      }
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    })
  }, [groupFilter, hosts, networkByAddress, query, sortMode, states, tagFilter])

  const selectedHost = useMemo(() => {
    return hostRows.find((host) => hostKey(host) === selectedKey) ?? hostRows[0] ?? hosts.find((host) => hostKey(host) === selectedKey) ?? hosts[0]
  }, [hostRows, hosts, selectedKey])

  const selectedState = selectedHost ? states[hostKey(selectedHost)] : undefined
  const selectedInventory = selectedState?.inventory
  const selectedConsoleLink = selectedHost ? getServerConsoleLink(selectedHost) : null
  const readyStates = Object.values(states).filter((state) => state.status === 'ready')
  const scanningCount = Object.values(states).filter((state) => state.status === 'scanning').length
  const errorCount = Object.values(states).filter((state) => state.status === 'error').length
  const projectCount = readyStates.reduce((total, state) => total + (state.inventory?.projects.length ?? 0), 0)
  const serviceCount = readyStates.reduce((total, state) => total + (state.inventory?.services.filter((service) => service.active === 'active').length ?? 0), 0)
  const cachedCount = Object.values(states).filter((state) => state.inventory).length
  const selectedNetwork = selectedHost ? networkByAddress[selectedHost.address] : undefined

  function openToolManagerForSelectedHost() {
    if (selectedHost) setManagedToolHostId(selectedHost.id)
    setView('tools')
  }

  async function scanHosts(targetHosts: HostProfile[]) {
    const runId = ++scanRunIdRef.current
    await scanWorkspaceInventoryHosts({
      hosts: targetHosts,
      resolveAuthSecret,
      concurrency: SCAN_CONCURRENCY,
      currentStates: states,
      isCurrent: () => scanRunIdRef.current === runId,
    })
    if (scanRunIdRef.current === runId) {
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
      <WorkspaceEmptyState
        title="还没有可扫描的 VPS"
        description="先在主机列表添加服务器，资源总览会把所有 VPS 的资源、工具、服务和部署项目关系聚合到这里。"
      />
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filteredProjects = selectedInventory?.projects
    .map((project) => ({
      project,
      signals: getProjectDeploymentSignals(project, selectedInventory),
    }))
    .filter((entry) => projectMatches(entry.project, normalizedQuery, entry.signals)) ?? []
  const componentStatusCount = selectedInventory?.tools.length ?? 0

  return (
    <div data-testid="workspace-asset-inventory-app" className="flex h-full min-h-[34rem] min-w-0 flex-col overflow-hidden text-[var(--workspace-text)]">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.58)] p-1">
          <button
            type="button"
            onClick={() => setView('assets')}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors',
              view === 'assets'
                ? 'bg-[rgba(19,127,236,0.22)] text-[var(--workspace-text-strong)]'
                : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            <Network className="h-3.5 w-3.5" />
            资源总览
          </button>
          <button
            type="button"
            onClick={openToolManagerForSelectedHost}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors',
              view === 'tools'
                ? 'bg-[rgba(19,127,236,0.22)] text-[var(--workspace-text-strong)]'
                : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            <Wrench className="h-3.5 w-3.5" />
            工具管理
          </button>
          <button
            type="button"
            onClick={() => setView('deployments')}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors',
              view === 'deployments'
                ? 'bg-[rgba(19,127,236,0.22)] text-[var(--workspace-text-strong)]'
                : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            <GitBranch className="h-3.5 w-3.5" />
            部署项目
          </button>
        </div>
      </div>

      {view === 'tools' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <WorkspaceToolManagerApp
            selectedHostId={managedToolHostId ?? selectedHostId}
            hostAddress={hostAddress}
            hosts={hosts}
            resolveAuthSecret={resolveAuthSecret}
          />
        </div>
      ) : view === 'deployments' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectDeploymentsPanel
            selectedHostId={selectedHostId}
            hosts={hosts}
            resolveAuthSecret={resolveAuthSecret}
          />
        </div>
      ) : (
        <>
        <AssetInventoryHeader
          hosts={hosts}
          visibleCount={hostRows.length}
          cachedCount={cachedCount}
          groupFilter={groupFilter}
          tagFilter={tagFilter}
          sortMode={sortMode}
          summaryMode={summaryMode}
          query={query}
          onGroupFilter={setGroupFilter}
          onTagFilter={setTagFilter}
          onSortMode={setSortMode}
          onSummaryMode={setSummaryMode}
          onQueryChange={setQuery}
          readyCount={readyStates.length}
          serviceCount={serviceCount}
          projectCount={projectCount}
          errorCount={errorCount}
          onScan={() => void scanHosts(hostRows.length > 0 ? hostRows : hosts)}
          scanning={scanningCount > 0}
          scanLabel={`扫描${hostRows.length > 0 && hostRows.length !== hosts.length ? '筛选结果' : '全部'}`}
          lastScanAt={lastScanAt}
          onImportSsh={onImportSsh}
          onCreateHost={onCreateHost}
        />

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(20rem,0.72fr)_minmax(0,1.35fr)]">
        <WorkspaceServerList
          hosts={hostRows}
          totalCount={hosts.length}
          selectedKey={selectedHost ? hostKey(selectedHost) : selectedKey}
          getHostKey={hostKey}
          onSelect={(key) => setSelectedKey(key)}
          emptyText="没有匹配的 VPS 资产。"
          renderStatusIcon={(host) => <HostStatusDot state={states[hostKey(host)] ?? { status: 'idle' }} />}
          getStatusBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            if (state.status === 'error') return { label: '无法访问', tone: 'bad' }
            return undefined
          }}
          getPrimaryBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            if (state.status === 'error') return undefined
            return { label: state.inventory?.projects.length ? `${state.inventory.projects.length} 项目` : '资产', tone: state.status === 'ready' ? 'info' : 'default' }
          }}
          renderRegionLine={(host) => {
            const network = networkByAddress[host.address]
            return network ? <HostRegionLine network={network} /> : null
          }}
          getSearchData={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            const network = networkByAddress[host.address]
            return {
              network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
              system: [inventory?.resource.os, inventory?.resource.kernel],
              tools: getInstalledToolSearchValues(inventory),
              projects: getProjectSearchValues(inventory),
            }
          }}
          getResourceMetrics={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            if (!inventory) return undefined
            return {
              cpuPercent: inventory?.resource.cpuPercent,
              memoryPercent: inventory?.resource.memoryPercent,
              diskPercent: inventory?.resource.diskPercent,
              cpuDetail: inventory?.resource.uptime,
              memoryDetail: inventory?.resource.memoryText,
              diskDetail: inventory?.resource.diskText,
            }
          }}
          renderFooter={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            return (
              <div className="mt-2 text-[11px] text-[var(--workspace-text-subtle)]">
                {inventory?.resource.os ? `版本 ${inventory.resource.os}` : '版本待扫描'}
              </div>
            )
          }}
          onRowDoubleClick={onOpenTerminal}
        />

        <div className="min-h-0 overflow-auto rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.38)] p-4">
          {!selectedHost ? (
            <WorkspaceEmptyState title="没有选择 VPS" description="选择一台主机查看资源、工具、服务和部署项目。" />
          ) : (
            <div className="space-y-4">
              <div className="border-b border-[color:var(--workspace-border-strong)] pb-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-lg font-semibold text-[var(--workspace-text-strong)]">
                      <ServerCog className="h-5 w-5 text-[color:var(--workspace-primary-300)]" />
                      <span className="truncate">{selectedHost.name}</span>
                    </div>
                    <div className="mt-1 text-sm text-[var(--workspace-text-muted)]">
                      {selectedHost.username}@{selectedHost.address}:{selectedHost.port}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge>{selectedHost.group || 'Custom'}</Badge>
                      {selectedState?.status === 'error' && <Badge tone="bad">{getHostScanLabel(selectedState)}</Badge>}
                      {selectedNetwork && <Badge>{selectedNetwork.resolvedLocationLabel}</Badge>}
                      {(selectedHost.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                      {selectedInventory?.resource.os && <Badge>{selectedInventory.resource.os}</Badge>}
                      {selectedInventory?.resource.kernel && <Badge>{selectedInventory.resource.kernel}</Badge>}
                    </div>
                  </div>
                  {(onOpenTerminal || onEditHost || (selectedConsoleLink && onOpenProviderConsole)) && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      {onOpenTerminal && (
                        <button
                          type="button"
                          onClick={() => onOpenTerminal(selectedHost)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(30,44,60,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <SquareTerminal className="h-3.5 w-3.5" />
                          终端
                        </button>
                      )}
                      {onEditHost && (
                        <button
                          type="button"
                          onClick={() => onEditHost(selectedHost)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(30,44,60,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </button>
                      )}
                      {selectedConsoleLink && onOpenProviderConsole && (
                        <button
                          type="button"
                          onClick={() => onOpenProviderConsole(selectedConsoleLink.url, selectedHost)}
                          aria-label={`打开 ${selectedConsoleLink.label} 控制台`}
                          title={`打开 ${selectedConsoleLink.label} 控制台`}
                          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(30,44,60,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>{selectedConsoleLink.label} 控制台</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void scanHosts([selectedHost])}
                    disabled={selectedState?.status === 'scanning'}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(30,44,60,0.9)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {selectedState?.status === 'scanning' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    扫描此 VPS
                  </button>
                </div>
              </div>

              {selectedState?.status === 'error' && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                  无法访问
                </div>
              )}

              {selectedInventory ? (
                <>
                  <div className="grid gap-3 md:grid-cols-3">
                    <ResourceMeter icon={Cpu} label="CPU" value={selectedInventory.resource.cpuPercent} detail={selectedInventory.resource.uptime} />
                    <ResourceMeter icon={MemoryStick} label="内存" value={selectedInventory.resource.memoryPercent} detail={selectedInventory.resource.memoryText} />
                    <ResourceMeter icon={HardDrive} label="磁盘" value={selectedInventory.resource.diskPercent} detail={selectedInventory.resource.diskText} />
                  </div>

                  <section className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.42)] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]"><Boxes className="h-4 w-4" />组件状态</div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--workspace-text-muted)]">{componentStatusCount}</span>
                        <button
                          type="button"
                          onClick={openToolManagerForSelectedHost}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]"
                          aria-label="管理当前服务器工具"
                          title="管理当前服务器工具"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="grid max-h-64 gap-2 overflow-auto md:grid-cols-2 2xl:grid-cols-3">
                      {selectedInventory.tools.map((tool) => {
                        const serviceName = getInventoryToolServiceName(tool.id)
                        const service = serviceName
                          ? selectedInventory.services.find((entry) => entry.name === serviceName)
                          : undefined
                        return (
                          <div key={`${tool.id}-${tool.binary}`} className="min-w-0 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[rgba(15,23,42,0.62)] px-3 py-2">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <div className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{tool.name}</div>
                              {service && <Badge tone={getServiceTone(service.active)}>{service.active || service.enabled}</Badge>}
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{tool.binary}</div>
                          </div>
                        )
                      })}
                      {componentStatusCount === 0 && <div className="text-sm text-[var(--workspace-text-muted)]">未识别到常用组件。</div>}
                    </div>
                  </section>

                  <section className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.42)] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]"><FolderGit2 className="h-4 w-4" />项目目录</div>
                      <span className="text-xs text-[var(--workspace-text-muted)]">{filteredProjects.length}</span>
                    </div>
                    <div className="grid gap-2 xl:grid-cols-2">
                      {filteredProjects.map(({ project, signals }) => {
                        const isRunning = signals.some(isRunningSignal)
                        return (
                          <div
                            key={`${project.path}-${project.kind}`}
                            className={cn(
                              'min-w-0 rounded-lg border px-3 py-2',
                              isRunning
                                ? 'border-emerald-500/30 bg-emerald-500/5'
                                : 'border-[color:var(--workspace-border-soft)] bg-[rgba(15,23,42,0.62)]',
                            )}
                          >
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <div className="truncate text-xs font-semibold text-[var(--workspace-text-strong)]">{project.name || project.kind}</div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {isRunning && <Badge tone="good">运行中</Badge>}
                                <Badge>{project.kind}</Badge>
                              </div>
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{project.path}</div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {signals.slice(0, 4).map((signal) => (
                                <Badge key={signal} tone={isRunningSignal(signal) ? 'good' : 'default'}>{signal}</Badge>
                              ))}
                              {signals.length === 0 && <span className="text-[11px] text-[var(--workspace-text-subtle)]">未匹配到运行信号</span>}
                            </div>
                            {project.modifiedAt && <div className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">{project.modifiedAt}</div>}
                          </div>
                        )
                      })}
                      {filteredProjects.length === 0 && <div className="text-sm text-[var(--workspace-text-muted)]">未发现匹配的项目痕迹。</div>}
                    </div>
                  </section>
                </>
              ) : (
                <div className="flex min-h-[18rem] items-center justify-center rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.35)] px-6 text-center text-sm text-[var(--workspace-text-muted)]">
                  {selectedState?.status === 'error'
                    ? '这台 VPS 当前无法访问，重新扫描会再次尝试连接。'
                    : selectedState?.status === 'scanning'
                      ? '正在扫描这台 VPS...'
                      : '点击扫描以读取这台 VPS 的资产信息。'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  )
}
