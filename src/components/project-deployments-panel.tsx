import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import {
  fetchWorkspaceInventory,
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  saveWorkspaceInventoryCacheEntry,
  type WorkspaceInventory,
  type WorkspaceInventoryCache,
  type WorkspaceInventoryProject,
} from '@/lib/workspace-inventory'
import {
  createReadyWorkspaceInventoryStates,
  getWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  selectWorkspaceInventoryStatesForHosts,
  useWorkspaceInventoryStates,
} from '@/lib/workspace-inventory-state'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDot,
  Cpu,
  Database,
  FolderGit2,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Search,
  ServerCog,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace/workspace-empty-state'
import { WorkspacePanelHeader } from './workspace/workspace-panel-header'
import { WorkspaceServerList } from './workspace/workspace-server-list'

interface ProjectDeploymentsPanelProps {
  selectedHostId?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenTerminal?: (host: HostProfile) => void
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

type DeploymentStatus = 'running' | 'detected' | 'stale'
type DeploymentViewStatus = DeploymentStatus | 'inaccessible'

interface ProjectDeploymentRow {
  id: string
  host: HostProfile
  inventory: WorkspaceInventory
  project: WorkspaceInventoryProject
  status: DeploymentStatus
  signals: string[]
  updatedAt: number
}

const SCAN_CONCURRENCY = 3
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

function formatPercent(value: number | null | undefined) {
  return value == null ? 'n/a' : `${Math.round(value)}%`
}

function formatAge(timestamp?: number) {
  if (!timestamp) return '未扫描'
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
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

function StatusBadge({ status }: { status: DeploymentViewStatus }) {
  if (status === 'running') return <Badge tone="good">运行中</Badge>
  if (status === 'stale') return <Badge tone="warn">缓存过期</Badge>
  if (status === 'inaccessible') return <Badge tone="bad">无法访问</Badge>
  return <Badge tone="info">已发现</Badge>
}

function HostStatusIcon({ state }: { state?: HostInventoryState }) {
  if (state?.status === 'scanning') return <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--workspace-primary-300)]" />
  if (state?.status === 'ready') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
  if (state?.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
  return <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />
}


function HostNetworkLine({ network }: { network?: HostNetworkDisplay }) {
  if (!network) return null
  return <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{network.resolvedLocationLabel}</div>
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

function getDeploymentViewStatus(row: ProjectDeploymentRow, state?: HostInventoryState): DeploymentViewStatus {
  return state?.status === 'error' ? 'inaccessible' : row.status
}

function normalizeSignal(value: string) {
  return value.trim().toLowerCase()
}

function projectNeedle(project: WorkspaceInventoryProject) {
  return normalizeSignal(project.name || project.path.split('/').filter(Boolean).at(-1) || project.kind)
}

export function getProjectDeploymentSignals(project: WorkspaceInventoryProject, inventory: WorkspaceInventory) {
  const needle = projectNeedle(project)
  const pathParts = project.path.split('/').filter(Boolean).map(normalizeSignal)
  const aliases = new Set([needle, ...pathParts.slice(-2)])
  const signals: string[] = []

  inventory.containers.forEach((container) => {
    const haystack = normalizeSignal(`${container.name} ${container.image} ${container.ports}`)
    if ([...aliases].some((alias) => alias && haystack.includes(alias))) {
      signals.push(`Docker: ${container.name} · ${container.status || 'detected'}`)
    }
  })

  inventory.pm2.forEach((process) => {
    const raw = normalizeSignal(process.raw)
    if ([...aliases].some((alias) => alias && raw.includes(alias))) {
      signals.push(`PM2: ${process.raw}`)
    }
  })

  const activeReverseProxy = inventory.services.find((service) => (
    ['nginx', 'caddy', 'apache2', 'httpd'].includes(service.name) && service.active === 'active'
  ))
  if (activeReverseProxy) signals.push(`${activeReverseProxy.name}: active`)

  return signals
}

function getProjectStatus(project: WorkspaceInventoryProject, inventory: WorkspaceInventory, updatedAt: number): DeploymentStatus {
  if (Date.now() - updatedAt > STALE_AFTER_MS) return 'stale'
  const signals = getProjectDeploymentSignals(project, inventory)
  if (signals.some((signal) => /up|online|active/i.test(signal))) return 'running'
  return 'detected'
}

export function buildProjectDeploymentRows(hosts: HostProfile[], cache: WorkspaceInventoryCache): ProjectDeploymentRow[] {
  return hosts.flatMap((host) => {
    const entry = cache[hostKey(host)]
    if (!entry?.inventory) return []
    return entry.inventory.projects.map((project) => {
      const signals = getProjectDeploymentSignals(project, entry.inventory)
      return {
        id: `${hostKey(host)}:${project.path}:${project.kind}`,
        host,
        inventory: entry.inventory,
        project,
        status: getProjectStatus(project, entry.inventory, entry.updatedAt),
        signals,
        updatedAt: entry.updatedAt,
      }
    })
  }).sort((a, b) => {
    const hostCompare = a.host.name.localeCompare(b.host.name)
    if (hostCompare !== 0) return hostCompare
    return a.project.name.localeCompare(b.project.name)
  })
}

export function ProjectDeploymentsPanel({
  selectedHostId = null,
  hosts,
  resolveAuthSecret,
  onOpenTerminal,
}: ProjectDeploymentsPanelProps) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | DeploymentViewStatus>('all')
  const [selectedKey, setSelectedKey] = useState(() => {
    const selectedHost = selectedHostId ? hosts.find((host) => host.id === selectedHostId) : null
    return selectedHost ? hostKey(selectedHost) : 'all'
  })
  const sharedStates = useWorkspaceInventoryStates()
  const [states, setStates] = useState<Record<string, HostInventoryState>>(() => {
    const shared = selectWorkspaceInventoryStatesForHosts(hosts)
    return Object.entries(loadWorkspaceInventoryCache(hosts)).reduce<Record<string, HostInventoryState>>((next, [key, entry]) => {
      next[key] = { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
      return next
    }, { ...shared })
  })
  const [loadingCache, setLoadingCache] = useState(true)
  const runIdRef = useRef(0)

  const cache = useMemo(() => {
    return Object.entries(states).reduce<WorkspaceInventoryCache>((next, [key, state]) => {
      if (state.inventory) next[key] = { inventory: state.inventory, updatedAt: state.updatedAt ?? state.inventory.scannedAt }
      return next
    }, {})
  }, [states])

  const deploymentRows = useMemo(() => buildProjectDeploymentRows(hosts, cache), [cache, hosts])
  const deploymentViewRows = useMemo(() => {
    return deploymentRows.map((row) => ({
      ...row,
      displayStatus: getDeploymentViewStatus(row, states[hostKey(row.host)]),
    }))
  }, [deploymentRows, states])
  const scanningCount = Object.values(states).filter((state) => state.status === 'scanning').length
  const scannedHostCount = Object.values(states).filter((state) => state.inventory).length
  const runningCount = deploymentViewRows.filter((row) => row.displayStatus === 'running').length
  const activeServiceCount = Object.values(states).reduce((total, state) => (
    total + (state.inventory?.services.filter((service) => service.active === 'active').length ?? 0)
  ), 0)
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  useEffect(() => {
    setStates((prev) => ({ ...prev, ...selectWorkspaceInventoryStatesForHosts(hosts, sharedStates) }))
  }, [hosts, sharedStates])

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return deploymentViewRows.filter((row) => {
      const network = networkByAddress[row.host.address]
      if (selectedKey !== 'all' && hostKey(row.host) !== selectedKey) return false
      if (statusFilter !== 'all' && row.displayStatus !== statusFilter) return false
      if (!normalizedQuery) return true
      return [
        row.host.name,
        row.host.address,
        row.host.username,
        row.project.name,
        row.project.kind,
        row.project.path,
        row.inventory.resource.os,
        row.inventory.resource.kernel,
        network?.scopeLabel ?? '',
        network?.resolvedLocationLabel ?? '',
        row.signals.join(' '),
      ].join(' ').toLowerCase().includes(normalizedQuery)
    })
  }, [deploymentViewRows, networkByAddress, query, selectedKey, statusFilter])

  async function scanHosts(targetHosts: HostProfile[]) {
    const runId = ++runIdRef.current
    const pending = targetHosts.slice()
    const scanningStates = targetHosts.reduce<Record<string, HostInventoryState>>((next, host) => {
      const key = hostKey(host)
      next[key] = { status: 'scanning', inventory: states[key]?.inventory, updatedAt: states[key]?.updatedAt }
      return next
    }, {})
    mergeWorkspaceInventoryStates(scanningStates)
    setStates((prev) => {
      const next = { ...prev }
      targetHosts.forEach((host) => {
        const key = hostKey(host)
        next[key] = { status: 'scanning', inventory: prev[key]?.inventory, updatedAt: prev[key]?.updatedAt }
      })
      return next
    })

    async function worker() {
      while (pending.length > 0 && runIdRef.current === runId) {
        const host = pending.shift()
        if (!host) return
        const key = hostKey(host)
        try {
          const inventory = await fetchWorkspaceInventory({ host, resolveAuthSecret })
          if (runIdRef.current !== runId) return
          saveWorkspaceInventoryCacheEntry(host, inventory)
          const nextState = { status: 'ready' as const, inventory, updatedAt: Date.now() }
          mergeWorkspaceInventoryStates({ [key]: nextState })
          setStates((prev) => ({ ...prev, [key]: nextState }))
        } catch (error) {
          if (runIdRef.current !== runId) return
          const message = error instanceof Error ? error.message : String(error)
          const previousState = getWorkspaceInventoryStates()[key]
          const nextState = {
            status: 'error',
            inventory: previousState?.inventory,
            updatedAt: previousState?.updatedAt,
            error: message,
          } satisfies HostInventoryState
          mergeWorkspaceInventoryStates({ [key]: nextState })
          setStates((prev) => ({
            ...prev,
            [key]: {
              ...nextState,
              inventory: prev[key]?.inventory ?? nextState.inventory,
              updatedAt: prev[key]?.updatedAt ?? nextState.updatedAt,
            },
          }))
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targetHosts.length) }, () => worker()))
  }

  useEffect(() => {
    let cancelled = false
    setLoadingCache(true)
    void loadWorkspaceInventoryPersistedCache(hosts).then((persistedCache) => {
      if (cancelled) return
      const sharedReadyStates = createReadyWorkspaceInventoryStates(persistedCache)
      mergeWorkspaceInventoryStates(sharedReadyStates)
      setStates((prev) => {
        const next = { ...prev }
        Object.entries(persistedCache).forEach(([key, entry]) => {
          if (next[key]?.status !== 'error') next[key] = { status: next[key]?.status ?? 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
        })
        return next
      })
      setLoadingCache(false)
    })

    return () => {
      cancelled = true
      runIdRef.current += 1
    }
  }, [hosts])

  useEffect(() => {
    if (!selectedHostId || selectedKey !== 'all') return
    const selectedHost = hosts.find((host) => host.id === selectedHostId)
    if (selectedHost) setSelectedKey(hostKey(selectedHost))
  }, [hosts, selectedHostId, selectedKey])

  if (hosts.length === 0) {
    return (
      <WorkspaceEmptyState
        title="还没有可管理的 VPS"
        description="先添加服务器。扫描一次后，部署项目面板会从本地快照快速恢复每台服务器的部署状态。"
      />
    )
  }

  return (
    <div data-testid="project-deployments-panel" className="flex min-h-[34rem] min-w-0 flex-col text-[var(--workspace-text)]">
      <WorkspacePanelHeader
        eyebrow={<><GitBranch className="h-3.5 w-3.5" />Deployed Projects</>}
        title="部署项目"
        description="按服务器聚合疑似项目、Docker/PM2/systemd 信号和资源余量，用来快速确认部署项目位于哪台 VPS 上。"
        note={loadingCache ? '正在读取本地快照...' : `已载入 ${scannedHostCount} 台 VPS 的本地快照`}
        actions={
          <button
            type="button"
            onClick={() => void scanHosts(selectedKey === 'all' ? hosts : hosts.filter((host) => hostKey(host) === selectedKey))}
            disabled={scanningCount > 0}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.18)] px-4 text-sm font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(19,127,236,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scanningCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {selectedKey === 'all' ? '扫描全部 VPS' : '扫描当前 VPS'}
          </button>
        }
        contentClassName="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><ServerCog className="h-4 w-4" />已扫描主机</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{scannedHostCount}/{hosts.length}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><FolderGit2 className="h-4 w-4" />疑似部署</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{deploymentRows.length}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><Boxes className="h-4 w-4" />运行信号</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{runningCount}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><Database className="h-4 w-4" />活跃服务</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{activeServiceCount}</div>
          </div>
        </div>

        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目、路径、服务器、运行信号..."
              className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.72)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'running', 'detected', 'stale', 'inaccessible'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={cn(
                  'h-10 rounded-xl border px-3 text-xs font-semibold transition-colors',
                  statusFilter === status
                    ? 'border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.18)] text-[var(--workspace-text-strong)]'
                    : 'border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.62)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                {status === 'all' ? '全部' : status === 'running' ? '运行中' : status === 'detected' ? '已发现' : status === 'stale' ? '缓存过期' : '无法访问'}
              </button>
            ))}
          </div>
        </div>
      </WorkspacePanelHeader>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(20rem,0.42fr)_minmax(0,1fr)]">
        <WorkspaceServerList
          hosts={hosts}
          totalCount={hosts.length}
          selectedKey={selectedKey}
          getHostKey={hostKey}
          onSelect={(key) => setSelectedKey(key)}
          allOption={{
            key: 'all',
            title: '全部服务器',
            subtitle: `${deploymentRows.length} 个疑似部署`,
            badge: { label: hosts.length },
          }}
          renderStatusIcon={(host) => <HostStatusIcon state={states[hostKey(host)]} />}
          getStatusBadge={(host) => {
            const state = states[hostKey(host)]
            if (state?.status === 'error') return { label: '无法访问', tone: 'bad' }
            return undefined
          }}
          getPrimaryBadge={(host) => {
            const state = states[hostKey(host)]
            const rows = deploymentRows.filter((row) => hostKey(row.host) === hostKey(host))
            if (state?.status === 'error') return undefined
            return {
              label: `${rows.length} 项目`,
              tone: rows.some((row) => row.status === 'running') ? 'good' : rows.length > 0 ? 'info' : 'default',
            }
          }}
          renderRegionLine={(host) => <HostNetworkLine network={networkByAddress[host.address]} />}
          getSearchData={(host) => {
            const key = hostKey(host)
            const state = states[key]
            const rows = deploymentRows.filter((row) => hostKey(row.host) === key)
            const network = networkByAddress[host.address]
            return {
              network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
              system: [state?.inventory?.resource.os, state?.inventory?.resource.kernel],
              tools: getInstalledToolSearchValues(state?.inventory),
              projects: rows.flatMap((row) => [
                row.project.name,
                row.project.kind,
                row.project.path,
                ...row.signals,
              ]),
            }
          }}
          getResourceMetrics={(host) => {
            const state = states[hostKey(host)]
            if (!state?.inventory) return undefined
            return {
              cpuPercent: state?.inventory?.resource.cpuPercent,
              memoryPercent: state?.inventory?.resource.memoryPercent,
              diskPercent: state?.inventory?.resource.diskPercent,
              cpuDetail: state?.inventory?.resource.uptime,
              memoryDetail: state?.inventory?.resource.memoryText,
              diskDetail: state?.inventory?.resource.diskText,
            }
          }}
          renderFooter={(host) => {
            const state = states[hostKey(host)]
            return (
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--workspace-text-subtle)]">
                <span>{formatAge(state?.updatedAt)}</span>
                {state?.status === 'error' ? <span className="truncate text-red-200">无法访问</span> : <span>{state?.inventory?.resource.os || '版本待扫描'}</span>}
              </div>
            )
          }}
          onRowDoubleClick={onOpenTerminal}
        />

        <section className="min-h-0 overflow-hidden rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.38)]">
          <div className="grid grid-cols-[minmax(14rem,1.15fr)_minmax(10rem,0.8fr)_8rem_9rem] gap-3 border-b border-[color:var(--workspace-border-strong)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-subtle)]">
            <span>项目</span>
            <span>服务器</span>
            <span>状态</span>
            <span>资源</span>
          </div>
          <div className="max-h-[58vh] overflow-auto">
            {filteredRows.map((row) => {
              const rowHostState = states[hostKey(row.host)]
              const rowNetwork = networkByAddress[row.host.address]
              return (
                <div
                  key={row.id}
                  className={cn(
                    'grid grid-cols-[minmax(14rem,1.15fr)_minmax(10rem,0.8fr)_8rem_9rem] gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3 last:border-b-0',
                    rowHostState?.status === 'error' && 'bg-red-500/5',
                  )}
                >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderGit2 className="h-4 w-4 shrink-0 text-[color:var(--workspace-primary-300)]" />
                    <div className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{row.project.name || row.project.kind}</div>
                    <Badge>{row.project.kind}</Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{row.project.path}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.signals.slice(0, 3).map((signal) => <Badge key={signal} tone="default">{signal}</Badge>)}
                    {row.signals.length === 0 && <span className="text-[11px] text-[var(--workspace-text-subtle)]">未匹配到进程信号</span>}
                  </div>
                </div>
                <div className="min-w-0 self-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{row.host.name}</div>
                    {rowHostState?.status === 'error' && <Badge tone="bad">无法访问</Badge>}
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{row.host.username}@{row.host.address}</div>
                  <HostNetworkLine network={rowNetwork} />
                  {row.inventory.resource.os && <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">版本 {row.inventory.resource.os}</div>}
                  <div className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">快照 {formatAge(row.updatedAt)}</div>
                </div>
                <div className="self-center">
                  <StatusBadge status={row.displayStatus} />
                </div>
                <div className="self-center space-y-1 font-mono text-[11px] text-[var(--workspace-text)]">
                  <div className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.cpuPercent)}</div>
                  <div className="flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.memoryPercent)}</div>
                  <div className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.diskPercent)}</div>
                </div>
                </div>
              )
            })}
            {filteredRows.length === 0 && (
              <div className="flex min-h-[20rem] items-center justify-center px-6 text-center">
                <div>
                  <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">
                    {deploymentRows.length === 0 ? '还没有部署项目快照' : '没有匹配的部署项目'}
                  </div>
                  <div className="mt-1 text-sm text-[var(--workspace-text-muted)]">
                    {deploymentRows.length === 0 ? '扫描 VPS 后会在本地记录项目路径、服务和运行信号。' : '调整搜索词、状态或服务器筛选。'}
                  </div>
                  {deploymentRows.length === 0 && (
                    <button
                      type="button"
                      onClick={() => void scanHosts(hosts)}
                      disabled={scanningCount > 0}
                      className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.18)] px-4 text-sm font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(19,127,236,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {scanningCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      扫描全部 VPS
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}
