import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { ProjectDeploymentsPanel, getProjectDeploymentSignals } from '@/components/project-deployments-panel'
import {
  fetchWorkspaceInventory,
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  saveWorkspaceInventoryCacheEntry,
  type WorkspaceInventory,
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
  FolderGit2,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  Settings2,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceServerList, workspaceServerMatchesSearch, type WorkspaceServerSearchData } from './workspace-server-list'
import { WorkspaceToolManagerApp, TOOL_CATALOG } from './workspace-tool-manager-app'

interface WorkspaceAssetInventoryAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  initialView?: 'assets' | 'tools' | 'deployments'
  onOpenConsole?: () => void
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

const SCAN_CONCURRENCY = 3

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
  if (state.status === 'ready') return '可访问'
  if (state.status === 'error') return '无法访问'
  return '未扫描'
}

function getHostScanTone(state: HostInventoryState): 'default' | 'good' | 'warn' | 'bad' {
  if (state.status === 'ready') return 'good'
  if (state.status === 'error') return 'bad'
  if (state.status === 'scanning') return 'warn'
  return 'default'
}

function getNetworkTone(network: HostNetworkDisplay): 'default' | 'good' | 'warn' | 'bad' | 'info' {
  if (network.scope === 'public') return 'info'
  if (network.scope === 'private') return 'good'
  if (network.locationStatus === 'error') return 'warn'
  return 'default'
}

function HostNetworkBadges({ network }: { network: HostNetworkDisplay }) {
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge tone={getNetworkTone(network)}>{network.scopeLabel}</Badge>
      <Badge>{network.versionLabel}</Badge>
      <span className="min-w-0 truncate text-[11px] text-[var(--workspace-text-subtle)]">{network.resolvedLocationLabel}</span>
    </div>
  )
}

export function WorkspaceAssetInventoryApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  initialView = 'assets',
  onOpenConsole,
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
  const runIdRef = useRef(0)
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

    return hosts.filter((host) => {
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
  }, [hosts, networkByAddress, query, states])

  const selectedHost = useMemo(() => {
    return hosts.find((host) => hostKey(host) === selectedKey) ?? hostRows[0] ?? hosts[0]
  }, [hostRows, hosts, selectedKey])

  const selectedState = selectedHost ? states[hostKey(selectedHost)] : undefined
  const selectedInventory = selectedState?.inventory
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
    if (runIdRef.current === runId) setLastScanAt(Date.now())
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
      runIdRef.current += 1
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
      <div className="flex flex-col gap-4 border-b border-[color:var(--workspace-border-strong)] pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-subtle)]">
            <Network className="h-3.5 w-3.5" />
            VPS Asset Inventory
          </div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">资源总览</div>
          <div className="mt-1 max-w-3xl text-sm text-[var(--workspace-text-muted)]">
            把所有 VPS 的剩余资源、已安装工具、运行服务和疑似部署项目放到一张可搜索的资产地图里。
          </div>
          {cachedCount > 0 && (
            <div className="mt-2 text-xs text-[var(--workspace-text-subtle)]">
              已先显示 {cachedCount} 台 VPS 的本地缓存，后台扫描完成后会自动更新。
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void scanHosts(hostRows.length > 0 ? hostRows : hosts)}
            disabled={scanningCount > 0}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.18)] px-4 text-sm font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(19,127,236,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scanningCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            扫描{hostRows.length > 0 && hostRows.length !== hosts.length ? '筛选结果' : '全部'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><ServerCog className="h-4 w-4" />主机</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{readyStates.length}/{hosts.length}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><ShieldCheck className="h-4 w-4" />活跃服务</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{serviceCount}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><FolderGit2 className="h-4 w-4" />疑似项目</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{projectCount}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.46)] p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]"><AlertTriangle className="h-4 w-4" />异常</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--workspace-text-strong)]">{errorCount}</div>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索主机、IP、地区、工具、项目路径..."
            className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.72)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
          />
        </div>
        <div className="text-xs text-[var(--workspace-text-muted)]">
          {lastScanAt ? `上次扫描 ${new Date(lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待首次扫描'}
        </div>
      </div>

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
            return { label: getHostScanLabel(state), tone: getHostScanTone(state) }
          }}
          getPrimaryBadge={(host) => {
            const state = states[hostKey(host)] ?? { status: 'idle' as const }
            if (state.status === 'error') return { label: '无法访问', tone: 'bad' }
            return { label: state.inventory?.projects.length ? `${state.inventory.projects.length} 项目` : '资产', tone: state.status === 'ready' ? 'info' : 'default' }
          }}
          renderNetworkLine={(host) => {
            const network = networkByAddress[host.address]
            return network ? <HostNetworkBadges network={network} /> : null
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
          renderMetrics={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            return (
              <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px] text-[var(--workspace-text-muted)]">
                <div>CPU {formatPercent(inventory?.resource.cpuPercent ?? null)}</div>
                <div>MEM {formatPercent(inventory?.resource.memoryPercent ?? null)}</div>
                <div>DISK {formatPercent(inventory?.resource.diskPercent ?? null)}</div>
              </div>
            )
          }}
          renderFooter={(host) => {
            const inventory = states[hostKey(host)]?.inventory
            return (
              <div className="mt-2 text-[11px] text-[var(--workspace-text-subtle)]">
                {inventory?.resource.os ? `版本 ${inventory.resource.os}` : '版本待扫描'}
              </div>
            )
          }}
        />

        <div className="min-h-0 overflow-auto rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.38)] p-4">
          {!selectedHost ? (
            <WorkspaceEmptyState title="没有选择 VPS" description="选择一台主机查看资源、工具、服务和部署项目。" />
          ) : (
            <div className="space-y-4">
              <div className="border-b border-[color:var(--workspace-border-strong)] pb-4">
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
                    {selectedState && <Badge tone={getHostScanTone(selectedState)}>{getHostScanLabel(selectedState)}</Badge>}
                    {selectedNetwork && <Badge tone={getNetworkTone(selectedNetwork)}>{selectedNetwork.scopeLabel}</Badge>}
                    {selectedNetwork && <Badge>{selectedNetwork.versionLabel}</Badge>}
                    {selectedNetwork && <Badge>{selectedNetwork.resolvedLocationLabel}</Badge>}
                    {(selectedHost.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                    {selectedInventory?.resource.os && <Badge>{selectedInventory.resource.os}</Badge>}
                    {selectedInventory?.resource.kernel && <Badge>{selectedInventory.resource.kernel}</Badge>}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {onOpenConsole && (
                    <button
                      type="button"
                      onClick={onOpenConsole}
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.72)] px-3 text-xs font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(30,44,60,0.9)]"
                    >
                      <SquareTerminal className="h-3.5 w-3.5" />
                      控制台
                    </button>
                  )}
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
