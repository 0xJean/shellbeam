import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { useHostNetworkMetadata, type HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { HostRegionMeta } from '@/components/host-display-meta'
import { cn } from '@/lib/utils'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { isUnknownOperationError, runConfirmedOperation, type OperationJob } from '@/lib/operation-job'
import type { CommandRunResult } from '@/lib/sessions'
import { executeVerifiedServiceAction, type DiagnosticServiceAction, type VerifiedDiagnosticResult } from '@/lib/workspace-diagnostics'
import { TOOL_CATALOG, TOOL_CATEGORIES, buildToolActionCommand, executeVerifiedToolPackageAction, parseToolStatus, rootHelperScript, toolCommandSummary, type ToolAction, type ToolCategoryId, type ToolDefinition, type ToolStatus } from '@/lib/workspace-tools'
import {
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryCache,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
} from '@/lib/workspace-inventory'
import {
  loadWorkspaceToolStatuses,
  saveWorkspaceToolStatus,
} from '@/lib/workspace-tool-status'
import {
  createReadyWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  selectWorkspaceInventoryStatesForHosts,
  useWorkspaceInventoryStates,
} from '@/lib/workspace-inventory-state'
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Download,
  PackageOpen,
  PackagePlus,
  PackageSearch,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search,
  Shield,
  Square,
  TerminalSquare,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOsIcon } from './workspace-os-icon'
import { WorkspaceResourceOverviewHeader } from './workspace-resource-overview-header'
import { WorkspaceServerList } from './workspace-server-list'
import { WorkspaceServiceIcon } from './workspace-service-icon'
import { Dialog, DialogContent } from '../ui/dialog'

interface WorkspaceToolManagerAppProps {
  vaultId?: string
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenTerminal?: (host: HostProfile) => void
  preheader?: ReactNode
  hideHeader?: boolean
  hideHostList?: boolean
}

interface HostInventoryState {
  status: 'idle' | 'scanning' | 'ready' | 'error' | 'unsupported'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

type TFunction = ReturnType<typeof useT>['t']

function getCategoryLabel(category: ToolCategoryId, t: TFunction) {
  const labelKey = TOOL_CATEGORIES.find((item) => item.id === category)?.labelKey
  return labelKey ? t(labelKey) : category
}

function getToolDescription(tool: ToolDefinition, t: TFunction) {
  return t(tool.descriptionKey)
}

function ToolLogo({ tool, size = 'sm' }: { tool: ToolDefinition; size?: 'sm' | 'lg' }) {
  const dimensions = size === 'lg' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-xl'
  const imageSize = size === 'lg' ? 'h-7 w-7' : 'h-5 w-5'

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] shadow-sm',
        dimensions,
      )}
      title={tool.name}
      aria-hidden="true"
    >
      <WorkspaceServiceIcon name={tool.id} slug={tool.logoSlug} className={imageSize} />
    </div>
  )
}

function getStatusBadge(status: ToolStatus | undefined, t: ReturnType<typeof useT>['t']) {
  if (!status || status.installed === null) return { label: t('workspace.tools.statusUnknown'), className: 'border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]' }
  if (status.installed) return { label: t('workspace.tools.statusInstalled'), className: 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' }
  return { label: t('workspace.tools.statusMissing'), className: 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' }
}

function getServiceBadge(status: ToolStatus | undefined, t: ReturnType<typeof useT>['t']) {
  const value = status?.serviceActive
  if (!value) return { label: t('workspace.tools.noService'), className: 'border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]' }
  if (value === 'active') return { label: t('workspace.tools.serviceActive'), className: 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' }
  if (value === 'failed') return { label: t('workspace.tools.serviceFailed'), className: 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]' }
  if (value === 'inactive') return { label: t('workspace.tools.serviceInactive'), className: 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' }
  if (value === 'activating') return { label: t('workspace.tools.serviceActivating'), className: 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' }
  return { label: value, className: 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' }
}

function getActionIcon(action: ToolAction) {
  if (action === 'check') return PackageSearch
  if (action === 'install') return PackagePlus
  if (action === 'upgrade') return Download
  if (action === 'uninstall') return Trash2
  if (action === 'start') return Play
  if (action === 'stop') return Square
  if (action === 'restart') return RotateCw
  if (action === 'enable') return Power
  if (action === 'disable') return PowerOff
  if (action === 'status') return TerminalSquare
  return PackageOpen
}

const CATEGORY_ICONS: Record<ToolCategoryId, LucideIcon> = {
  web: PackageSearch,
  database: PackageOpen,
  cacheQueue: CircleDot,
  containers: PackageOpen,
  runtime: TerminalSquare,
  packageManagers: PackagePlus,
  buildOps: PackageSearch,
  securityNetwork: Shield,
  aiAgents: CircleAlert,
  processManagers: TerminalSquare,
}

function getCategoryIcon(category: ToolCategoryId) {
  return CATEGORY_ICONS[category]
}

function formatInstallType(recipe: ToolDefinition['install'], t: ReturnType<typeof useT>['t']) {
  if (!recipe) return t('workspace.tools.statusOnly')
  if (recipe.type === 'package') return t('workspace.tools.installType.package')
  if (recipe.type === 'npm') return t('workspace.tools.installType.npm')
  return t('workspace.tools.installType.pipx')
}

function toolMatchesSearch(tool: ToolDefinition, query: string, t: ReturnType<typeof useT>['t']) {
  if (!query) return true
  const haystack = [
    tool.name,
    tool.id,
    tool.binary,
    getToolDescription(tool, t),
    getCategoryLabel(tool.category, t),
    ...(tool.aliases ?? []),
  ].join(' ').toLowerCase()
  return haystack.includes(query)
}

function getInitialManagedHostId(hosts: HostProfile[], selectedHostId?: string | null, hostAddress?: string | null) {
  const preferredHost = resolveWorkspaceHost(hosts, { selectedHostId, hostAddress })
  return preferredHost?.id ?? hosts[0]?.id ?? ''
}

function hostKey(host: HostProfile) {
  return getWorkspaceInventoryHostKey(host)
}

function formatAge(timestamp: number | undefined, t: ReturnType<typeof useT>['t']) {
  if (!timestamp) return t('workspace.tools.notScanned')
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('workspace.tools.justNow')
  if (minutes < 60) return t('workspace.tools.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('workspace.tools.hoursAgo', { count: hours })
  return t('workspace.tools.daysAgo', { count: Math.floor(hours / 24) })
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

function HostStatusIcon({ state }: { state?: HostInventoryState }) {
  if (state?.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--workspace-status-bad)]" />
  if (state?.inventory || state?.status === 'ready') {
    return (
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
        <WorkspaceOsIcon os={state.inventory?.resource.os} className="h-4 w-4 text-[var(--workspace-text-muted)]" />
        <CheckCircle2 className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[var(--workspace-surface-row)] text-[color:var(--workspace-status-good)]" />
      </span>
    )
  }
  return <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" />
}

function HostNetworkLine({ network }: { network?: HostNetworkDisplay }) {
  if (!network) return null
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--workspace-text-subtle)]">
      <HostRegionMeta network={network} />
    </div>
  )
}

export function WorkspaceToolManagerApp({
  vaultId,
  selectedHostId = null,
  hostAddress = null,
  hosts: providedHosts,
  resolveAuthSecret,
  onOpenTerminal,
  preheader,
  hideHeader = false,
  hideHostList = false,
}: WorkspaceToolManagerAppProps) {
  const hosts = useMemo(() => providedHosts.filter((entry) => !vaultId || !entry.vaultId || entry.vaultId === vaultId).map((entry) => ({ ...entry, vaultId: vaultId ?? entry.vaultId })), [providedHosts, vaultId])
  const { t } = useT()
  const toolStatusPersistenceError = t('workspace.tools.persistenceUnavailable')
  const [category, setCategory] = useState<ToolCategoryId | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedToolId, setSelectedToolId] = useState(TOOL_CATALOG[0].id)
  const [statuses, setStatuses] = useState<Record<string, ToolStatus>>({})
  const [toolStatusesLoaded, setToolStatusesLoaded] = useState(false)
  const [running, setRunning] = useState<{ toolId: string; action: ToolAction } | null>(null)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [managedHostId, setManagedHostId] = useState(() => getInitialManagedHostId(hosts, selectedHostId, hostAddress))
  const [detailOpen, setDetailOpen] = useState(false)
  const sharedInventoryStates = useWorkspaceInventoryStates()
  const [inventoryStates, setInventoryStates] = useState<Record<string, HostInventoryState>>(() => {
    const shared = selectWorkspaceInventoryStatesForHosts(hosts)
    return Object.entries(loadWorkspaceInventoryCache(hosts)).reduce<Record<string, HostInventoryState>>((next, [key, entry]) => {
      next[key] = { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
      return next
    }, { ...shared })
  })

  const host = useMemo(() => hosts.find((entry) => entry.id === managedHostId) ?? null, [hosts, managedHostId])
  const hostScope = JSON.stringify([vaultId ?? host?.vaultId, host?.id, host?.address, host?.port, host?.username, host?.jumpHostId, host?.jumpHost, host?.jumpPort, host?.jumpUser])
  const actionGeneration = useRef(0)
  const networkByAddress = useHostNetworkMetadata(hosts.map((entry) => entry.address))

  const query = searchQuery.trim().toLowerCase()
  const visibleTools = useMemo(
    () => TOOL_CATALOG.filter((tool) => (category === 'all' || tool.category === category) && toolMatchesSearch(tool, query, t)),
    [category, query, t],
  )

  const selectedTool = useMemo(
    () => visibleTools.find((tool) => tool.id === selectedToolId)
      ?? TOOL_CATALOG.find((tool) => tool.id === selectedToolId)
      ?? visibleTools[0]
      ?? TOOL_CATALOG[0],
    [selectedToolId, visibleTools],
  )

  const selectedStatus = statuses[selectedTool.id]
  const checkedCount = Object.values(statuses).filter((status) => status.checkedAt).length
  const installedCount = Object.values(statuses).filter((status) => status.installed).length

  async function runToolAction(action: ToolAction, tool = selectedTool, options: { silent?: boolean; generation?: number } = {}) {
    if (!host) return
    const generation = options.generation ?? actionGeneration.current
    if (generation !== actionGeneration.current) return
    const serviceMutation = ['start', 'stop', 'restart', 'enable', 'disable'].includes(action)
    const packageMutation = action === 'install' || action === 'upgrade' || action === 'uninstall'
    const serviceUnit = tool.service?.endsWith('.service') ? tool.service : `${tool.service}.service`
    const risk = packageMutation || (serviceMutation && action !== 'start' && action !== 'enable') ? 'high' : serviceMutation ? 'low' : 'read-only'
    const jumpProfile = hosts.find((entry) => entry.id === host.jumpHostId)
    const route = host.jumpHostId || host.jumpHost?.trim() ? `ProxyJump ${jumpProfile?.name ?? host.jumpHost ?? host.jumpHostId}` : 'direct'
    async function run(command: string): Promise<CommandRunResult> {
      if (generation !== actionGeneration.current) throw new Error('Tool scope changed before command execution')
      try {
        const result = await runWorkspaceRemoteCommand({ host: host!, vaultId: vaultId ?? host?.vaultId, resolveAuthSecret, command })
        if (generation !== actionGeneration.current) throw new Error('Tool operation transport scope changed before observation')
        return result
      } catch (error) {
        // Do not let native command details enter the generic exception journal.
        throw new Error(isUnknownOperationError(error) ? 'Tool operation transport disconnected' : 'Tool operation could not be executed')
      }
    }

    setRunning({ toolId: tool.id, action })
    setError('')
    if (!options.silent) {
      setOutput('')
    }

    try {
      const execution = await runConfirmedOperation<VerifiedDiagnosticResult>({
        host, vaultId, action: `${serviceMutation ? 'service' : 'tool'}.${action}`,
        target: serviceMutation ? serviceUnit : tool.id, risk,
        paramsSummary: `tool=${tool.id}; recipe=${packageMutation ? tool.install?.type ?? 'unavailable' : 'diagnostic'}; verification=${serviceMutation ? 'service-state' : packageMutation ? 'tool-presence-and-version' : 'read-only'}`,
        confirmMessage: t('workspace.tools.operationReview', {
          host: `${host.name} · ${host.username}@${host.address}:${host.port || 22}`, route,
          action: t(`workspace.tools.action.${action}`), target: tool.name,
          risk: t(risk === 'high' ? 'files.operation.highRisk' : 'files.operation.lowRisk'),
          command: toolCommandSummary(tool, action),
        }),
        execute: async () => {
          if (packageMutation) return executeVerifiedToolPackageAction(run, tool, action, t)
          if (serviceMutation) return executeVerifiedServiceAction(async (command) => {
            if (command.startsWith('systemctl show ')) {
              try { return await run(command) } catch {
                return { stdout: '', stderr: '', exitCode: 125, durationMs: 0, errorCode: 'remote_state_unknown' }
              }
            }
            return run(`${rootHelperScript(t)}\nsb_root ${command}`)
          }, serviceUnit, action as DiagnosticServiceAction)
          const result = await run(buildToolActionCommand(tool, action, t))
          return { ...result, resultSummary: `tool=${tool.id}; observation=${action}; exit=${result.exitCode}` }
        },
        getResult: (result) => result,
      })
      if (generation !== actionGeneration.current) return
      if (!execution) {
        if (!options.silent) setOutput(t('workspace.operation.cancelled'))
        return
      }
      const result = execution.value
      const operationJob: OperationJob = execution.job
      const combined = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ''].filter(Boolean).join('\n')
      const operationSummary = `job=${operationJob.jobId} audit=${operationJob.auditId} status=${operationJob.status}\n${operationJob.resultSummary ?? ''}\n\n`
      const displayOutput = `${operationSummary}${combined || t('workspace.tools.actionCompleted', { action: t(`workspace.tools.action.${action}`) })}`

      const active = result.stdout.match(/^ActiveState=([a-z-]+)$/m)?.[1]
      const enabled = result.stdout.match(/^UnitFileState=([a-z-]+)$/m)?.[1]
      const parsedStatus = result.stdout.includes('__SB_INSTALLED=') ? parseToolStatus(result.stdout)
        : serviceMutation && active ? { ...statuses[tool.id], installed: statuses[tool.id]?.installed ?? null, serviceActive: active, serviceEnabled: enabled, checkedAtMs: Date.now() }
          : null
      if (parsedStatus) {
        try { await saveWorkspaceToolStatus(host, tool, parsedStatus, vaultId ?? host.vaultId) } catch { throw new Error(toolStatusPersistenceError) }
        if (generation !== actionGeneration.current) return
        setStatuses((current) => ({
          ...current,
          [tool.id]: parsedStatus,
        }))
      }

      if (!options.silent) {
        setOutput(displayOutput)
      }

      if (result.exitCode !== 0) {
        setError(t('workspace.tools.remoteCommandExited', { code: result.exitCode }))
      }
    } catch (caught) {
      if (generation !== actionGeneration.current) return
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      if (!options.silent) setOutput(message)
    } finally {
      if (generation === actionGeneration.current) setRunning(null)
    }
  }

  async function scanVisibleTools() {
    if (!host) return
    const generation = actionGeneration.current
    for (const tool of visibleTools.slice(0, 24)) {
      if (generation !== actionGeneration.current) return
      await runToolAction('check', tool, { silent: true, generation })
    }
  }

  useLayoutEffect(() => {
    const generations = actionGeneration
    generations.current++
    setToolStatusesLoaded(false)
    setStatuses({})
    setRunning(null)
    setOutput('')
    setError('')
    setDetailOpen(false)
    return () => { generations.current++ }
  }, [hostScope])

  useEffect(() => {
    let cancelled = false
    const generation = actionGeneration.current
    void loadWorkspaceToolStatuses(host, vaultId ?? host?.vaultId).then((persistedStatuses) => {
      if (cancelled || generation !== actionGeneration.current) return
      setStatuses(persistedStatuses)
      setToolStatusesLoaded(true)
    }).catch(() => {
      if (cancelled || generation !== actionGeneration.current) return
      setError(toolStatusPersistenceError)
      setToolStatusesLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [host, hostScope, vaultId, toolStatusPersistenceError])

  useEffect(() => {
    setManagedHostId((current) => {
      const next = getInitialManagedHostId(hosts, selectedHostId, hostAddress)
      if (hideHostList) return next ?? current
      if (hosts.some((entry) => entry.id === current)) return current
      return next
    })
  }, [hideHostList, hostAddress, hosts, selectedHostId])

  useEffect(() => {
    setInventoryStates((prev) => ({
      ...Object.fromEntries(hosts.flatMap((entry) => prev[hostKey(entry)] ? [[hostKey(entry), prev[hostKey(entry)]]] : [])),
      ...selectWorkspaceInventoryStatesForHosts(hosts, sharedInventoryStates),
    }))
  }, [hosts, sharedInventoryStates])

  useEffect(() => {
    let cancelled = false
    void loadWorkspaceInventoryPersistedCache(hosts).then((cache) => {
      if (cancelled) return
      const sharedReadyStates = createReadyWorkspaceInventoryStates(cache)
      mergeWorkspaceInventoryStates(sharedReadyStates)
      setInventoryStates((prev) => {
        const next: Record<string, HostInventoryState> = {}
        hosts.forEach((entry) => {
          const key = hostKey(entry)
          const cached = cache[key]
          const existing = prev[key]
          if (existing?.status === 'error') {
            next[key] = existing
          } else if (cached) {
            next[key] = { status: 'ready', inventory: cached.inventory, updatedAt: cached.updatedAt }
          } else if (existing) {
            next[key] = existing
          } else {
            next[key] = { status: 'idle' }
          }
        })
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [hosts])

  useEffect(() => {
    if (!visibleTools.some((tool) => tool.id === selectedToolId)) {
      setSelectedToolId(visibleTools[0]?.id ?? TOOL_CATALOG[0].id)
    }
  }, [selectedToolId, visibleTools])

  useEffect(() => {
    if (!host || !toolStatusesLoaded || statuses[selectedTool.id]?.checkedAt) return
    void runToolAction('check', selectedTool, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, selectedTool.id, toolStatusesLoaded])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.tools.emptyTitle')}
        description={t('workspace.tools.emptyDescription')}
      />
    )
  }

  const installActions: ToolAction[] = ['check', 'install', 'upgrade', 'uninstall']
  const serviceActions: ToolAction[] = ['status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs']
  const statusBadge = getStatusBadge(selectedStatus, t)
  const toolSearchControl = (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
      <input
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder={t('workspace.tools.searchPlaceholder')}
        className="h-10 w-full rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
      />
    </div>
  )
  const scanVisibleButton = (
    <button
      type="button"
      onClick={() => void scanVisibleTools()}
      disabled={running !== null || visibleTools.length === 0}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', running?.action === 'check' && 'animate-spin')} />
      {t('workspace.tools.scanVisible')}
    </button>
  )

  return (
    <div data-testid="workspace-tool-manager-app" data-selected-host-id={host?.id ?? ''} className="space-y-4">
      {hideHeader ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-panel)] p-3 md:flex-row md:items-center md:justify-between">
          {toolSearchControl}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">{t('workspace.tools.toolsCount', { count: TOOL_CATALOG.length })}</span>
            <span className="rounded-full border border-[color:var(--workspace-border-soft)] px-2.5 py-1 text-[11px] text-[var(--workspace-text-muted)]">{checkedCount} {t('workspace.tools.checked')}</span>
            <span className="rounded-full border border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] px-2.5 py-1 text-[11px] text-[color:var(--workspace-status-good-text)]">{installedCount} {t('workspace.tools.installed')}</span>
            {scanVisibleButton}
          </div>
        </div>
      ) : (
        <WorkspaceResourceOverviewHeader
          preheader={preheader}
          eyebrow={t('workspace.tools.eyebrow')}
          title={t('workspace.tools.title')}
          description={t('workspace.tools.description')}
          actions={scanVisibleButton}
          total={TOOL_CATALOG.length}
          totalLabel={t('workspace.tools.totalTools')}
          totalMeta={<span className="text-xs text-[var(--workspace-text-subtle)]">{hosts.length} {t('workspace.tools.vps')}</span>}
          visibleCount={visibleTools.length}
          visibleLabel={t('workspace.tools.visible')}
          search={toolSearchControl}
          metrics={[
            { key: 'hosts', label: t('workspace.tools.vps'), value: hosts.length, icon: TerminalSquare },
            { key: 'checked', label: t('workspace.tools.checked'), value: checkedCount, icon: PackageSearch },
            { key: 'installed', label: t('workspace.tools.installed'), value: installedCount, icon: CheckCircle2 },
          ]}
        />
      )}

      <div className={cn('grid min-h-[34rem] gap-4', hideHostList ? 'xl:grid-cols-[minmax(15rem,0.44fr)_minmax(0,1.35fr)]' : 'xl:grid-cols-[minmax(22rem,0.72fr)_minmax(15rem,0.44fr)_minmax(0,1.35fr)]')}>
        {!hideHostList && (
          <WorkspaceServerList
            hosts={hosts}
            totalCount={hosts.length}
            selectedKey={host.id}
            getHostKey={(entry) => entry.id}
            onSelect={(key) => setManagedHostId(key)}
            itemTestIdPrefix="workspace-tool-host"
            renderStatusIcon={(entry) => <HostStatusIcon state={inventoryStates[hostKey(entry)]} />}
            getStatusBadge={(entry) => {
              const state = inventoryStates[hostKey(entry)]
              if (state?.status === 'error') return { label: t('workspace.serverIndex.inaccessible'), tone: 'bad' }
              return undefined
            }}
            getPrimaryBadge={(entry) => {
              const state = inventoryStates[hostKey(entry)]
              if (!state?.inventory) return { label: entry.authType }
              return { label: t('workspace.tools.toolsCount', { count: state.inventory.tools.length }), tone: 'info' }
            }}
            renderRegionLine={(entry) => <HostNetworkLine network={networkByAddress[entry.address]} />}
            getSystemLabel={(entry) => inventoryStates[hostKey(entry)]?.inventory?.resource.os}
            getSearchData={(entry) => {
              const state = inventoryStates[hostKey(entry)]
              const network = networkByAddress[entry.address]
              return {
                network: [network?.scopeLabel, network?.versionLabel, network?.resolvedLocationLabel],
                system: [state?.inventory?.resource.os, state?.inventory?.resource.kernel],
                tools: getInstalledToolSearchValues(state?.inventory),
                projects: getProjectSearchValues(state?.inventory),
              }
            }}
            getResourceMetrics={(entry) => {
              const inventory = inventoryStates[hostKey(entry)]?.inventory
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
            renderFooter={(entry) => {
              const state = inventoryStates[hostKey(entry)]
              return (
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--workspace-text-subtle)]">
                  <span>{formatAge(state?.updatedAt, t)}</span>
                  {state?.status === 'error'
                    ? <span className="truncate text-[color:var(--workspace-status-bad-text)]">{t('workspace.serverIndex.inaccessible')}</span>
                    : <span className="truncate">{state?.inventory?.resource.os || t('workspace.tools.notScanned')}</span>}
                </div>
              )
            }}
            onRowDoubleClick={(entry) => onOpenTerminal?.(entry)}
          />
        )}

        <aside className="space-y-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-3 shadow-[var(--workspace-shadow-card)]">
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={cn(
              'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
              category === 'all'
                ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]'
                : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            <span>{t('workspace.tools.allTools')}</span>
            <span className="text-xs">{TOOL_CATALOG.length}</span>
          </button>
          {TOOL_CATEGORIES.map((item) => {
            const count = TOOL_CATALOG.filter((tool) => tool.category === item.id).length
            const Icon = getCategoryIcon(item.id)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setCategory(item.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
                  category === item.id
                    ? 'bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]'
                    : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{t(item.labelKey)}</span>
                </span>
                <span className="text-xs">{count}</span>
              </button>
            )
          })}
        </aside>

        <section className="min-w-0 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-card)]">
          <div data-testid="workspace-tool-catalog" className="max-h-[32rem] overflow-auto">
            {visibleTools.length === 0 ? (
              <div className="px-4 py-8 text-sm text-[var(--workspace-text-muted)]">{t('workspace.tools.noMatchingTools')}</div>
            ) : (
              visibleTools.map((tool) => {
                const isSelected = tool.id === selectedTool.id
                const toolStatus = statuses[tool.id]
                const badge = getStatusBadge(toolStatus, t)
                const service = getServiceBadge(toolStatus, t)
                return (
                  <button
                    key={tool.id}
                    type="button"
                    data-testid={`workspace-tool-card-${tool.id}`}
                    onClick={() => {
                      setSelectedToolId(tool.id)
                      setDetailOpen(true)
                    }}
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3 text-left text-sm transition-colors last:border-b-0',
                      isSelected ? 'bg-[var(--workspace-accent-soft)]' : 'hover:bg-[var(--workspace-surface-800)]',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ToolLogo tool={tool} />
                        <div className="min-w-0">
                          <span className="block truncate font-semibold text-[var(--workspace-text-strong)]">{tool.name}</span>
                          <span className="block truncate text-[11px] text-[var(--workspace-text-muted)]">{tool.binary}</span>
                        </div>
                      </div>
                      <div className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{getToolDescription(tool, t)}</div>
                    </div>
                    <div>
                      <span className={cn('rounded-full border px-2 py-1 text-[11px] font-medium', badge.className)}>
                        {badge.label}
                      </span>
                    </div>
                    <div>
                      <span className={cn('rounded-full border px-2 py-1 text-[11px] font-medium', tool.service ? service.className : 'border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]')}>
                        {tool.service ? service.label : t('workspace.tools.binaryBadge')}
                      </span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </section>

      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="w-[min(72rem,calc(100vw-2rem))] rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-0 text-[var(--workspace-text)] shadow-[var(--workspace-shadow-overlay)]">
          <section className="min-w-0 p-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(24rem,0.75fr)]">
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--workspace-text-muted)]">{getCategoryLabel(selectedTool.category, t)}</div>
                    <h3 className="mt-2 truncate text-2xl font-semibold tracking-tight">{selectedTool.name}</h3>
                    <p className="mt-1 text-sm text-[var(--workspace-text-muted)]">{getToolDescription(selectedTool, t)}</p>
                  </div>
                  <ToolLogo tool={selectedTool} size="lg" />
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2">
                    <div className="text-[var(--workspace-text-muted)]">{t('workspace.tools.binary')}</div>
                    <div className="mt-1 truncate font-medium">{selectedTool.binary}</div>
                  </div>
                  <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2">
                    <div className="text-[var(--workspace-text-muted)]">{t('workspace.tools.install')}</div>
                    <div className="mt-1 truncate font-medium">{formatInstallType(selectedTool.install, t)}</div>
                  </div>
                  <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2">
                    <div className="text-[var(--workspace-text-muted)]">{t('workspace.tools.status')}</div>
                    <div className="mt-1 flex items-center gap-1.5 font-medium">
                      {selectedStatus?.installed ? <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--workspace-status-good)]" /> : <CircleDot className="h-3.5 w-3.5 text-[var(--workspace-text-muted)]" />}
                      {statusBadge.label}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2">
                    <div className="text-[var(--workspace-text-muted)]">{t('workspace.tools.service')}</div>
                    <div className="mt-1 truncate font-medium">{selectedTool.service ?? t('workspace.tools.noServiceValue')}</div>
                  </div>
                </div>

                {selectedStatus?.version && (
                  <div className="mt-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2 text-xs">
                    <div className="text-[var(--workspace-text-muted)]">{t('workspace.tools.version')}</div>
                    <div className="mt-1 break-words font-medium">{selectedStatus.version}</div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)]">{t('workspace.tools.packageActions')}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {installActions.map((action) => {
                      const Icon = getActionIcon(action)
                      const disabled = running !== null || (action !== 'check' && !selectedTool.install)
                      return (
                        <button
                          key={action}
                          type="button"
                          onClick={() => void runToolAction(action)}
                          disabled={disabled}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs font-medium capitalize transition-colors hover:bg-[var(--workspace-surface-800)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <Icon className={cn('h-3.5 w-3.5', running?.toolId === selectedTool.id && running.action === action && 'animate-spin')} />
                          {running?.toolId === selectedTool.id && running.action === action ? t('workspace.tools.running') : t(`workspace.tools.action.${action}`)}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedTool.service && (
                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)]">{t('workspace.tools.serviceActions')}</div>
                    <div className="grid grid-cols-2 gap-2">
                      {serviceActions.map((action) => {
                        const Icon = getActionIcon(action)
                        return (
                          <button
                            key={action}
                            type="button"
                            onClick={() => void runToolAction(action)}
                            disabled={running !== null}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs font-medium capitalize transition-colors hover:bg-[var(--workspace-surface-800)] disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <Icon className={cn('h-3.5 w-3.5', running?.toolId === selectedTool.id && running.action === action && 'animate-spin')} />
                            {running?.toolId === selectedTool.id && running.action === action ? t('workspace.tools.running') : t(`workspace.tools.action.${action}`)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="mt-4 flex gap-2 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">
                <CircleAlert className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </section>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-4 shadow-[var(--workspace-shadow-card)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)]">
            <Shield className="h-3.5 w-3.5" />
            {t('workspace.tools.remoteOutput')}
          </div>
          <div className="text-xs text-[var(--workspace-text-muted)]">{selectedStatus?.checkedAt ? t('workspace.tools.checkedAt', { time: selectedStatus.checkedAt }) : selectedTool.name}</div>
        </div>
        <pre data-testid="workspace-tool-output" className="mt-3 max-h-[16rem] overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-3 text-xs leading-6 text-[var(--workspace-text)]">
          {output || (running ? t('workspace.tools.runningRemoteCommand') : t('workspace.tools.noCommandOutput'))}
        </pre>
      </div>
    </div>
  )
}
