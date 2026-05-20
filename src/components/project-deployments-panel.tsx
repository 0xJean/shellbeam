import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { t as translate, useT } from '@/lib/i18n'
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
import { WorkspaceResourceOverviewHeader } from './workspace/workspace-resource-overview-header'
import { WorkspaceServerList } from './workspace/workspace-server-list'

interface ProjectDeploymentsPanelProps {
  selectedHostId?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenTerminal?: (host: HostProfile) => void
  preheader?: ReactNode
  hideHeader?: boolean
  hideHostList?: boolean
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

type DeploymentStatus = 'running' | 'detected' | 'stale'
type DeploymentViewStatus = DeploymentStatus | 'inaccessible'
type TFunction = ReturnType<typeof useT>['t']

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

function formatPercent(value: number | null | undefined, t: TFunction) {
  return value == null ? t('workspace.common.notAvailable') : `${Math.round(value)}%`
}

function formatAge(timestamp: number | undefined, t: TFunction) {
  if (!timestamp) return t('workspace.deployments.notScanned')
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('workspace.deployments.justNow')
  if (minutes < 60) return t('workspace.deployments.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('workspace.deployments.hoursAgo', { count: hours })
  return t('workspace.deployments.daysAgo', { count: Math.floor(hours / 24) })
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
        tone === 'default' && 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text)]',
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

function StatusBadge({ status, t }: { status: DeploymentViewStatus; t: TFunction }) {
  if (status === 'running') return <Badge tone="good">{t('workspace.deployments.statusLabelRunning')}</Badge>
  if (status === 'stale') return <Badge tone="warn">{t('workspace.deployments.statusLabelStale')}</Badge>
  if (status === 'inaccessible') return <Badge tone="bad">{t('workspace.deployments.statusLabelInaccessible')}</Badge>
  return <Badge tone="info">{t('workspace.deployments.statusLabelDetected')}</Badge>
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

export function getProjectDeploymentSignals(project: WorkspaceInventoryProject, inventory: WorkspaceInventory, t?: TFunction) {
  const needle = projectNeedle(project)
  const pathParts = project.path.split('/').filter(Boolean).map(normalizeSignal)
  const aliases = new Set([needle, ...pathParts.slice(-2)])
  const signals: string[] = []
  const tr = t ?? translate

  inventory.containers.forEach((container) => {
    const haystack = normalizeSignal(`${container.name} ${container.image} ${container.ports}`)
    if ([...aliases].some((alias) => alias && haystack.includes(alias))) {
      signals.push(tr('workspace.deployments.signal.docker', {
        container: container.name,
        status: container.status || tr('workspace.deployments.signal.detected'),
      }))
    }
  })

  inventory.pm2.forEach((process) => {
    const raw = normalizeSignal(process.raw)
    if ([...aliases].some((alias) => alias && raw.includes(alias))) {
      signals.push(tr('workspace.deployments.signal.pm2', { raw: process.raw }))
    }
  })

  const activeReverseProxy = inventory.services.find((service) => (
    ['nginx', 'caddy', 'apache2', 'httpd'].includes(service.name) && service.active === 'active'
  ))
  if (activeReverseProxy) signals.push(tr('workspace.deployments.signal.reverseProxy', { service: activeReverseProxy.name, status: tr('workspace.deployments.signal.running') }))

  return signals
}

function getProjectStatus(project: WorkspaceInventoryProject, inventory: WorkspaceInventory, updatedAt: number, t?: TFunction): DeploymentStatus {
  if (Date.now() - updatedAt > STALE_AFTER_MS) return 'stale'
  const signals = getProjectDeploymentSignals(project, inventory, t)
  if (signals.some((signal) => /up|online|active|运行中|正在|已启动/i.test(signal))) return 'running'
  return 'detected'
}

export function buildProjectDeploymentRows(hosts: HostProfile[], cache: WorkspaceInventoryCache, t?: TFunction): ProjectDeploymentRow[] {
  return hosts.flatMap((host) => {
    const entry = cache[hostKey(host)]
    if (!entry?.inventory) return []
    return entry.inventory.projects.map((project) => {
      const signals = getProjectDeploymentSignals(project, entry.inventory, t)
      return {
        id: `${hostKey(host)}:${project.path}:${project.kind}`,
        host,
        inventory: entry.inventory,
        project,
        status: getProjectStatus(project, entry.inventory, entry.updatedAt, t),
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
  preheader,
  hideHeader = false,
  hideHostList = false,
}: ProjectDeploymentsPanelProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | DeploymentViewStatus>('all')
  const [selectedKey, setSelectedKey] = useState(() => {
    const selectedHost = selectedHostId ? hosts.find((host) => host.id === selectedHostId) : null
    return selectedHost ? hostKey(selectedHost) : hideHostList && hosts[0] ? hostKey(hosts[0]) : 'all'
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

  const deploymentRows = useMemo(() => buildProjectDeploymentRows(hosts, cache, t), [cache, hosts, t])
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
    setSelectedKey((current) => {
      const selectedHost = selectedHostId ? hosts.find((host) => host.id === selectedHostId) : null
      const selectedHostKey = selectedHost ? hostKey(selectedHost) : null

      if (hideHostList) return selectedHostKey ?? (hosts[0] ? hostKey(hosts[0]) : 'all')
      if (selectedHostKey && current === 'all') return selectedHostKey
      if (current !== 'all' && !hosts.some((host) => hostKey(host) === current)) return selectedHostKey ?? 'all'
      return current
    })
  }, [hideHostList, hosts, selectedHostId])

  const statusOptions = [
    { key: 'all' as const, label: t('workspace.deployments.statusLabelAll') },
    { key: 'running' as const, label: t('workspace.deployments.statusLabelRunning') },
    { key: 'detected' as const, label: t('workspace.deployments.statusLabelDetected') },
    { key: 'stale' as const, label: t('workspace.deployments.statusLabelStale') },
    { key: 'inaccessible' as const, label: t('workspace.deployments.statusLabelInaccessible') },
  ]
  const deploymentSearchControl = (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('workspace.deployments.searchPlaceholder')}
        className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
      />
    </div>
  )
  const scanDeploymentsButton = (
    <button
      type="button"
      onClick={() => void scanHosts(selectedKey === 'all' ? hosts : hosts.filter((host) => hostKey(host) === selectedKey))}
      disabled={scanningCount > 0}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-soft)] px-3 text-xs font-semibold text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-accent-muted)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {scanningCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {selectedKey === 'all' ? t('workspace.deployments.scanAll') : t('workspace.deployments.scanCurrent')}
    </button>
  )
  const statusFilterControls = (
    <div className="flex flex-wrap gap-2">
      {statusOptions.map((status) => (
        <button
          key={status.key}
          type="button"
          onClick={() => setStatusFilter(status.key)}
          className={cn(
            'h-10 rounded-xl border px-3 text-xs font-semibold transition-colors',
            statusFilter === status.key
              ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]'
              : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
          )}
        >
          {status.label}
        </button>
      ))}
    </div>
  )

  if (hosts.length === 0) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.deployments.emptyTitle')}
        description={t('workspace.deployments.emptyDescription')}
      />
    )
  }

  return (
    <div data-testid="project-deployments-panel" data-selected-host-key={selectedKey} className="flex min-h-[34rem] min-w-0 flex-col text-[var(--workspace-text)]">
      {!hideHeader && (
        <WorkspaceResourceOverviewHeader
          preheader={preheader}
          eyebrow={<><GitBranch className="h-3.5 w-3.5" />{t('workspace.deployments.eyebrow')}</>}
          title={t('workspace.deployments.title')}
          description={t('workspace.deployments.description')}
          note={loadingCache ? t('workspace.deployments.loadingCache') : t('workspace.deployments.loadedCache', { count: scannedHostCount })}
          actions={scanDeploymentsButton}
          total={deploymentRows.length}
          totalLabel={t('workspace.deployments.total')}
          visibleCount={filteredRows.length}
          visibleLabel={t('workspace.deployments.visible')}
          search={deploymentSearchControl}
          metrics={[
            { key: 'hosts', icon: ServerCog, label: t('workspace.deployments.metricScannedHosts'), value: `${scannedHostCount}/${hosts.length}` },
            { key: 'projects', icon: FolderGit2, label: t('workspace.deployments.metricProjects'), value: deploymentRows.length },
            { key: 'signals', icon: Boxes, label: t('workspace.deployments.metricSignals'), value: runningCount },
            { key: 'services', icon: Database, label: t('workspace.deployments.metricActiveServices'), value: activeServiceCount },
          ]}
          controls={statusFilterControls}
        />
      )}

      {hideHeader && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-panel)] p-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            {deploymentSearchControl}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">
                {filteredRows.length} {t('workspace.deployments.visible')}
              </span>
              <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">
                {scannedHostCount}/{hosts.length} {t('workspace.deployments.metricScannedHosts')}
              </span>
              {scanDeploymentsButton}
            </div>
          </div>
          {statusFilterControls}
        </div>
      )}

      <div className={cn('grid min-h-0 flex-1 gap-4', hideHostList ? 'xl:grid-cols-1' : 'xl:grid-cols-[minmax(20rem,0.42fr)_minmax(0,1fr)]')}>
        {!hideHostList && (
          <WorkspaceServerList
            hosts={hosts}
            totalCount={hosts.length}
            selectedKey={selectedKey}
            getHostKey={hostKey}
            onSelect={(key) => setSelectedKey(key)}
            allOption={{
              key: 'all',
              title: t('workspace.deployments.allServers'),
              subtitle: t('workspace.deployments.deploymentsCount', { count: deploymentRows.length }),
              badge: { label: hosts.length },
            }}
            renderStatusIcon={(host) => <HostStatusIcon state={states[hostKey(host)]} />}
            getStatusBadge={(host) => {
              const state = states[hostKey(host)]
              if (state?.status === 'error') return { label: t('workspace.deployments.statusLabelInaccessible'), tone: 'bad' }
              return undefined
            }}
            getPrimaryBadge={(host) => {
              const state = states[hostKey(host)]
              const rows = deploymentRows.filter((row) => hostKey(row.host) === hostKey(host))
              if (state?.status === 'error') return undefined
              return {
                label: t('workspace.deployments.projectsCount', { count: rows.length }),
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
                  <span>{formatAge(state?.updatedAt, t)}</span>
                  {state?.status === 'error'
                    ? <span className="truncate text-red-200">{t('workspace.deployments.statusLabelInaccessible')}</span>
                    : <span>{state?.inventory?.resource.os || t('workspace.deployments.versionPending')}</span>}
                </div>
              )
            }}
            onRowDoubleClick={onOpenTerminal}
          />
        )}

        <section className="min-h-0 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]">
          <div className="grid grid-cols-[minmax(14rem,1.15fr)_minmax(10rem,0.8fr)_8rem_9rem] gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-subtle)]">
            <span>{t('workspace.deployments.projectColumn')}</span>
            <span>{t('workspace.deployments.serverColumn')}</span>
            <span>{t('workspace.deployments.statusColumn')}</span>
            <span>{t('workspace.deployments.resourceColumn')}</span>
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
                    {row.signals.length === 0 && <span className="text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.deployments.noProcessSignals')}</span>}
                  </div>
                </div>
                <div className="min-w-0 self-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{row.host.name}</div>
                    {rowHostState?.status === 'error' && <Badge tone="bad">{t('workspace.deployments.statusLabelInaccessible')}</Badge>}
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{row.host.username}@{row.host.address}</div>
                  <HostNetworkLine network={rowNetwork} />
                  {row.inventory.resource.os && <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.deployments.version', { version: row.inventory.resource.os })}</div>}
                  <div className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">{t('workspace.deployments.snapshotAge', { age: formatAge(row.updatedAt, t) })}</div>
                </div>
                <div className="self-center">
                  <StatusBadge status={row.displayStatus} t={t} />
                </div>
                <div className="self-center space-y-1 font-mono text-[11px] text-[var(--workspace-text)]">
                  <div className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.cpuPercent, t)}</div>
                  <div className="flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.memoryPercent, t)}</div>
                  <div className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />{formatPercent(row.inventory.resource.diskPercent, t)}</div>
                </div>
                </div>
              )
            })}
            {filteredRows.length === 0 && (
              <div className="flex min-h-[20rem] items-center justify-center px-6 text-center">
                <div>
                  <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">
                    {deploymentRows.length === 0 ? t('workspace.deployments.noSnapshotTitle') : t('workspace.deployments.noMatchTitle')}
                  </div>
                  <div className="mt-1 text-sm text-[var(--workspace-text-muted)]">
                    {deploymentRows.length === 0 ? t('workspace.deployments.noSnapshotDescription') : t('workspace.deployments.noMatchDescription')}
                  </div>
                  {deploymentRows.length === 0 && (
                    <button
                      type="button"
                      onClick={() => void scanHosts(hosts)}
                      disabled={scanningCount > 0}
                      className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.18)] px-4 text-sm font-semibold text-[var(--workspace-text-strong)] transition-colors hover:bg-[rgba(19,127,236,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {scanningCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      {t('workspace.deployments.scanAll')}
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
