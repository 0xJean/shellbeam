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
import { fill } from '@/lib/locales/probe-install'
import { workspaceToolsCopy } from '@/lib/locales/workspace-files-tools'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleArrowUp,
  CircleDot,
  CodeXml,
  Container,
  Database,
  Globe,
  Hammer,
  Info,
  Layers,
  Package,
  PackageOpen,
  PackagePlus,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  ScanSearch,
  ScrollText,
  Search,
  Shield,
  Sparkles,
  Square,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOsIcon } from './workspace-os-icon'
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

type ChipTone = 'neutral' | 'good' | 'warn' | 'bad'

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]',
  good: 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
  warn: 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
  bad: 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
}

function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', CHIP_TONES[tone])}>{children}</span>
}

function getStatusBadge(status: ToolStatus | undefined, t: TFunction): { label: string; tone: ChipTone } {
  if (!status || status.installed === null) return { label: t('workspace.tools.statusUnknown'), tone: 'neutral' }
  if (status.installed) return { label: t('workspace.tools.statusInstalled'), tone: 'good' }
  return { label: t('workspace.tools.statusMissing'), tone: 'bad' }
}

function getServiceBadge(status: ToolStatus | undefined, t: TFunction, notCheckedLabel: string): { label: string; tone: ChipTone } {
  if (!status?.checkedAt && !status?.serviceActive) return { label: notCheckedLabel, tone: 'neutral' }
  const value = status?.serviceActive
  if (!value) return { label: t('workspace.tools.noService'), tone: 'neutral' }
  if (value === 'active') return { label: t('workspace.tools.serviceActive'), tone: 'good' }
  if (value === 'failed') return { label: t('workspace.tools.serviceFailed'), tone: 'bad' }
  if (value === 'inactive') return { label: t('workspace.tools.serviceInactive'), tone: 'warn' }
  if (value === 'activating') return { label: t('workspace.tools.serviceActivating'), tone: 'warn' }
  return { label: value, tone: 'warn' }
}

const DANGER_ACTIONS = new Set<ToolAction>(['upgrade', 'uninstall', 'stop', 'restart', 'disable'])

function getActionIcon(action: ToolAction) {
  if (action === 'check') return ScanSearch
  if (action === 'install') return PackagePlus
  if (action === 'upgrade') return CircleArrowUp
  if (action === 'uninstall') return Trash2
  if (action === 'start') return Play
  if (action === 'stop') return Square
  if (action === 'restart') return RotateCw
  if (action === 'enable') return Power
  if (action === 'disable') return PowerOff
  if (action === 'status') return Info
  if (action === 'logs') return ScrollText
  return PackageOpen
}

const CATEGORY_ICONS: Record<ToolCategoryId, LucideIcon> = {
  web: Globe,
  database: Database,
  cacheQueue: Zap,
  containers: Container,
  runtime: CodeXml,
  packageManagers: Package,
  buildOps: Hammer,
  securityNetwork: Shield,
  aiAgents: Sparkles,
  processManagers: Activity,
}

function formatInstallType(recipe: ToolDefinition['install'], t: TFunction) {
  if (!recipe) return t('workspace.tools.statusOnly')
  if (recipe.type === 'package') return t('workspace.tools.installType.package')
  if (recipe.type === 'npm') return t('workspace.tools.installType.npm')
  return t('workspace.tools.installType.pipx')
}

function toolMatchesSearch(tool: ToolDefinition, query: string, t: TFunction) {
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

function formatAge(timestamp: number | undefined, t: TFunction) {
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
  const { t, locale } = useT()
  const tc = workspaceToolsCopy[locale]
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
  const selectedServiceBadge = getServiceBadge(selectedStatus, t, tc.notChecked)
  const toolSearchControl = (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
      <input
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder={t('workspace.tools.searchPlaceholder')}
        className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-sm text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
      />
    </div>
  )
  const scanVisibleButton = (
    <button
      type="button"
      onClick={() => void scanVisibleTools()}
      disabled={running !== null || visibleTools.length === 0}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {running?.action === 'check' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
      {t('workspace.tools.scanVisible')}
    </button>
  )
  const scanNote = <span className="shrink-0 text-[11px] text-[var(--workspace-text-subtle)]">{tc.scanNote}</span>
  const categoryItem = (id: ToolCategoryId | 'all', Icon: LucideIcon, label: string, count: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setCategory(id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
        category === id
          ? 'bg-[var(--workspace-surface-700)] font-medium text-[var(--workspace-text-strong)] shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]'
          : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px] text-[var(--workspace-text-subtle)]">{count}</span>
    </button>
  )
  const renderActionButton = (action: ToolAction, disabled: boolean) => {
    const Icon = getActionIcon(action)
    const isRunning = running?.toolId === selectedTool.id && running.action === action
    return (
      <button
        key={action}
        type="button"
        onClick={() => void runToolAction(action)}
        disabled={disabled}
        className={cn(
          'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-45',
          DANGER_ACTIONS.has(action)
            ? 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] hover:brightness-110'
            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]',
        )}
      >
        <Icon className={cn('h-3.5 w-3.5', isRunning && 'animate-spin')} />
        {isRunning ? t('workspace.tools.running') : t(`workspace.tools.action.${action}`)}
      </button>
    )
  }

  return (
    <div data-testid="workspace-tool-manager-app" data-selected-host-id={host?.id ?? ''} className="flex flex-col gap-4 text-[var(--workspace-text)]">
      {hideHeader ? (
        <div className="sb-card flex flex-col gap-3 bg-[var(--workspace-surface-900)] p-3 md:flex-row md:items-center md:justify-between">
          {toolSearchControl}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {scanNote}
            <span className="rounded-md bg-[var(--workspace-surface-700)] px-2 py-1 text-[11px] text-[var(--workspace-text-muted)]">{t('workspace.tools.toolsCount', { count: TOOL_CATALOG.length })}</span>
            <span className="rounded-md bg-[var(--workspace-surface-700)] px-2 py-1 text-[11px] text-[var(--workspace-text-muted)]">{checkedCount} {t('workspace.tools.checked')}</span>
            <span className="rounded-md bg-[var(--workspace-status-good-bg)] px-2 py-1 text-[11px] text-[color:var(--workspace-status-good-text)]">{installedCount} {t('workspace.tools.installed')}</span>
            {scanVisibleButton}
          </div>
        </div>
      ) : (
        <>
          {preheader}
          <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{tc.title}</h2>
              <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                <span>{t('workspace.tools.title')}</span>
                {' · '}
                {fill(tc.summary, { host: host.name, total: TOOL_CATALOG.length, checked: checkedCount, installed: installedCount })}
              </p>
            </div>
            {scanVisibleButton}
          </header>
        </>
      )}

      <div
        className={cn(
          'grid items-start gap-4',
          hideHostList ? 'lg:grid-cols-[11rem_minmax(0,1fr)]' : 'lg:grid-cols-[11rem_minmax(0,1fr)] xl:grid-cols-[minmax(19rem,22rem)_11rem_minmax(0,1fr)]',
        )}
      >
        {!hideHostList && (
          <div className="flex max-h-[24rem] min-w-0 flex-col lg:col-span-2 xl:col-span-1 xl:max-h-[calc(100vh-12rem)]">
            <WorkspaceServerList
              variant="compact"
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
                return { label: formatAge(state?.updatedAt, t) }
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
                  cpuPercent: inventory.resource.cpuPercent,
                  memoryPercent: inventory.resource.memoryPercent,
                  diskPercent: inventory.resource.diskPercent,
                  cpuDetail: inventory.resource.uptime,
                  memoryDetail: inventory.resource.memoryText,
                  diskDetail: inventory.resource.diskText,
                }
              }}
              onRowDoubleClick={(entry) => onOpenTerminal?.(entry)}
            />
          </div>
        )}

        <nav className="min-w-0 space-y-0.5">
          {categoryItem('all', Layers, t('workspace.tools.allTools'), TOOL_CATALOG.length)}
          {TOOL_CATEGORIES.map((item) => categoryItem(item.id, CATEGORY_ICONS[item.id], t(item.labelKey), TOOL_CATALOG.filter((tool) => tool.category === item.id).length))}
        </nav>

        <div className="flex min-w-0 flex-col gap-3">
          {!hideHeader && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {toolSearchControl}
              {scanNote}
            </div>
          )}
          <div data-testid="workspace-tool-catalog" className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
            {visibleTools.length === 0 ? (
              <div className="col-span-full px-1 py-8 text-sm text-[var(--workspace-text-muted)]">{t('workspace.tools.noMatchingTools')}</div>
            ) : (
              visibleTools.map((tool) => {
                const isSelected = detailOpen && tool.id === selectedTool.id
                const toolStatus = statuses[tool.id]
                const badge = getStatusBadge(toolStatus, t)
                const service = tool.service ? getServiceBadge(toolStatus, t, tc.notChecked) : { label: t('workspace.tools.binaryBadge'), tone: 'neutral' as const }
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
                      'sb-card flex min-w-0 flex-col gap-2.5 bg-[var(--workspace-surface-900)] p-4 text-left transition-colors hover:bg-[var(--workspace-surface-800)]',
                      isSelected && 'ring-1 ring-[hsl(var(--primary))]',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ToolLogo tool={tool} />
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{tool.name}</span>
                        <span className="block truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{tool.binary}</span>
                      </div>
                    </div>
                    <p className="line-clamp-2 min-h-[2rem] text-xs leading-4 text-[var(--workspace-text-muted)]">{getToolDescription(tool, t)}</p>
                    <div className="mt-auto flex flex-wrap gap-1.5">
                      <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
                      <StatusChip tone={service.tone}>{service.label}</StatusChip>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="w-[min(56rem,calc(100vw-2rem))] rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-0 text-[var(--workspace-text)] shadow-[var(--workspace-shadow-overlay)] md:max-w-[56rem]">
          <section className="flex min-w-0 flex-col gap-4 p-5">
            <div className="flex items-start gap-3">
              <ToolLogo tool={selectedTool} size="lg" />
              <div className="min-w-0 flex-1">
                <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold text-[var(--workspace-text-strong)]">
                  <span className="truncate">{selectedTool.name}</span>
                  <StatusChip tone="neutral">{getCategoryLabel(selectedTool.category, t)}</StatusChip>
                </h3>
                <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{getToolDescription(selectedTool, t)}</p>
              </div>
              <button
                type="button"
                aria-label={tc.close}
                title={tc.close}
                onClick={() => setDetailOpen(false)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2.5 text-xs sm:grid-cols-[5rem_minmax(0,1fr)_5rem_minmax(0,1fr)]">
              <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.tools.binary')}</dt>
              <dd className="truncate font-mono text-[var(--workspace-text-strong)]">{selectedStatus?.path ?? selectedTool.binary}</dd>
              <dt className="text-[var(--workspace-text-subtle)]">{tc.installMethod}</dt>
              <dd className="truncate text-[var(--workspace-text-strong)]">{formatInstallType(selectedTool.install, t)}</dd>
              <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.tools.status')}</dt>
              <dd className="flex min-w-0 items-center gap-1.5 text-[var(--workspace-text-strong)]">
                {selectedStatus?.installed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[color:var(--workspace-status-good)]" /> : <CircleDot className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-muted)]" />}
                {statusBadge.label}
              </dd>
              <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.tools.service')}</dt>
              <dd className="truncate font-mono text-[var(--workspace-text-strong)]">
                {selectedTool.service ? `${selectedTool.service} · ${selectedServiceBadge.label}` : t('workspace.tools.noServiceValue')}
              </dd>
              <dt className="text-[var(--workspace-text-subtle)]">{t('workspace.tools.version')}</dt>
              <dd className="break-words font-mono text-[var(--workspace-text-strong)]">{selectedStatus?.version ?? '—'}</dd>
              <dt className="text-[var(--workspace-text-subtle)]">{tc.checkedAt}</dt>
              <dd className="truncate font-mono text-[var(--workspace-text-strong)]">{selectedStatus?.checkedAt ?? '—'}</dd>
            </dl>

            <div className={cn('grid gap-4', selectedTool.service && 'md:grid-cols-2')}>
              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--workspace-text-subtle)]">{t('workspace.tools.packageActions')}</div>
                <div className="flex flex-wrap gap-2">
                  {installActions.map((action) => renderActionButton(action, running !== null || (action !== 'check' && !selectedTool.install)))}
                </div>
              </div>
              {selectedTool.service && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-[var(--workspace-text-subtle)]">
                    {t('workspace.tools.serviceActions')}
                    <span className="ml-2 font-normal text-[var(--workspace-text-subtle)] opacity-80">{tc.serviceRisk}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {serviceActions.map((action) => renderActionButton(action, running !== null))}
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="flex gap-2 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">
                <CircleAlert className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="sb-card overflow-hidden bg-[var(--workspace-surface-900)]">
              <div className="flex items-center justify-between gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                <h4 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('workspace.tools.remoteOutput')}</h4>
                <span className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{selectedStatus?.checkedAt ? t('workspace.tools.checkedAt', { time: selectedStatus.checkedAt }) : selectedTool.name}</span>
              </div>
              <pre data-testid="workspace-tool-output" className="max-h-[16rem] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-[var(--workspace-text)]">
                {output || (running ? t('workspace.tools.runningRemoteCommand') : t('workspace.tools.noCommandOutput'))}
              </pre>
            </div>
          </section>
        </DialogContent>
      </Dialog>
    </div>
  )
}
