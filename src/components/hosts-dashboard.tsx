import { monitoringAlertTitle } from '@/lib/monitoring-presentation'
import { hasSshConnection } from '@/lib/hosts'
import { HostMetadataSyncNotice } from './host-metadata-sync-panel'
import { matchesHostSearch } from '@/lib/host-search'
import { getHostIdentity } from '@/lib/host-identity'
import type { WorkspaceAppId } from '@/lib/workspace'
import { HostOpsAdvancedFilters } from '@/components/host-ops-filters'
import { DEFAULT_HOST_OPS_FILTERS, matchesHostOpsFilters, type HostOpsFilters } from '@/lib/host-ops-filters'
import { LOCAL_OPS_CHANGED_EVENT, loadLocalAlertState } from '@/lib/local-ops-store'
import { runLocalAlertAction } from '@/lib/local-alert-actions'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import { LOCAL_OPS_PERSISTENCE_EVENT, localOpsPersistenceError } from '@/lib/local-ops-persistence'
import { getProbeAlertRuntimeDiagnostic, PROBE_ALERT_RUNTIME_CHANGED } from '@/lib/probe-alert-runtime-state'
import { HostGridCard, HostListItem, type HostOperationalSummary } from '@/components/host-card'
import { HOST_BUCKETS, hostBucket } from '@/lib/host-grouping'
import { HostListScrollArea } from '@/components/host-list-scroll-area'
import { HostCreateDialog } from '@/components/host-create-dialog'
import { HostEditorDialog } from '@/components/host-editor-dialog'
import { PullToRefresh } from '@/components/pull-to-refresh'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { HostAlertsCenter } from './host-alerts-center'
import { buildHostIncidents, type HostIncident } from '@/lib/host-incidents'
import { hostPresentationCopy } from '@/lib/locales/host-presentation'
import { Input } from '@/components/ui/input'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'
import type { VaultMeta } from '@/lib/vaults'
import { DEFAULT_GROUPS } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceInventoryHealthStatus, useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { listMcpDeploymentRecords, type McpDeploymentRecord } from '@/lib/mcp'
import { hasHostOpsEvidence, hostProbeEvaluations, loadHostOpsViews, type HostOpsView } from '@/lib/host-ops-view'
import { buildKomariProbeLinks, checkKomariLinkedProbe, type KomariProbeLink } from '@/lib/komari-probe-link'
import { runConfirmedOperation } from '@/lib/operation-job'
import { runKomariAlertAction, type KomariAlertAction } from '@/lib/komari-alert-actions'
import type { KomariAlertRecord, KomariAlertState } from '@/lib/komari-alerts'
import { groupKomariAlertIncidents, isHistoricalKomariAlert } from '@/lib/komari-alert-incidents'
import { listShellbeamAgents } from '@/lib/shellbeam-agent'
import { listKomariIntegrations } from '@/lib/komari-config'
import { normalizeKomariEndpoint } from '@/lib/komari'
import { isCurrentKomariAlert, isCurrentKomariSnapshot, loadCurrentKomariSource, loadCurrentKomariSources } from '@/lib/komari-source-eligibility'
import { KOMARI_MAPPING_CHANGED_EVENT, confirmedKomariSyncAt, getKomariMappingState, manualKomariMappings, loadKomariPersistence, persistKomariAlertState, persistKomariSync } from '@/lib/komari-persistence'
import { readKomariAlertState } from '@/lib/komari-persistence'
import { dispatchAndPersistKomariAlertNotifications, emitKomariAlertNotification } from '@/lib/komari-alert-notifications'
import { loadNotificationPolicy } from '@/lib/notification-policy'
import { MAX_BATCH_HOSTS, runBatchDockerOperation, runBatchOperation, runBatchServiceOperation, type BatchOperationResult } from '@/lib/multi-host-operations'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { DEFAULT_KOMARI_SYNC_TTL_MS, isKomariSyncFresh, reconcileKomariProbeAlerts, syncKomariIntegration } from '@/lib/komari-sync'
import { ArrowDownAZ, ArrowUpZA, CalendarArrowDown, Bell, CalendarArrowUp, ChevronDown, FileDown, LayoutGrid, List, Plus, RefreshCw, Search, Server, SlidersHorizontal, Tag, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SshImportDialog } from './ssh-import-dialog'
import { KomariAlertsDashboardPanel } from './komari-alerts-dashboard-panel'
import { HOST_CONNECTION_COLUMNS, HOST_LIST_COLUMNS, HOST_RESOURCE_COLUMNS } from './host-list-layout'
import { HostMoveDialog } from './host-move-dialog'
import { HostBatchFloatingBar, HostKpiRow, HostStatusSegments, ProbeCoverageBanner } from './hosts-overview'
import { ProbeInstallDialog } from './probe-install-dialog'
import MultiHostOperationsPanel, { type MultiHostOperationKind, type MultiHostOperationRequest, type MultiHostOperationResult } from './multi-host-operations-panel'
import type { WorkspaceResourceGroup } from './workspace/workspace-resource-overview-header'

type SortMode = 'az' | 'za' | 'newest' | 'oldest'
type HostStatusFilter = 'all' | 'online' | 'stale' | 'checking' | 'offline' | 'paused' | 'unsupported' | 'unknown' | 'jump-unavailable'
type HostHealthStatus = Exclude<HostStatusFilter, 'all'>
export type HostOpsRefreshStatus = 'idle' | 'refreshing' | 'fresh' | 'recovered' | 'error'
const SORT_KEY = 'shellbeam.hostSortMode'
function formatHostOpsRefreshTime(timestamp: number | null): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getHostHealthStatus(view: HostOpsView | undefined, fallback: HostHealthStatus, loading: boolean): HostHealthStatus {
  if (view?.health.state === 'unsupported') return 'unsupported'
  if (view?.health.state === 'paused') return 'paused'
  if (view?.health.state === 'jump-unavailable') return 'jump-unavailable'
  if (view?.health.state === 'online' || view?.health.state === 'stale' || view?.health.state === 'offline' || view?.health.state === 'checking' || view?.health.state === 'unknown') return view.health.state
  return loading && fallback === 'unknown' ? 'checking' : fallback
}

export function HostOpsRefreshIndicator({
  status,
  lastRefreshedAt,
  error,
}: {
  status: HostOpsRefreshStatus
  lastRefreshedAt: number | null
  error: string | null
}) {
  const { t } = useT()
  const time = formatHostOpsRefreshTime(lastRefreshedAt)
  const label = status === 'refreshing'
    ? t('hosts.refreshStatus.refreshing')
    : status === 'recovered'
      ? t('hosts.refreshStatus.recovered', { time })
      : status === 'error'
        ? t('hosts.refreshStatus.error')
        : status === 'fresh'
          ? t('hosts.refreshStatus.updated', { time })
          : t('hosts.refreshStatus.idle')
  const tone = status === 'error'
    ? 'text-[color:var(--workspace-status-bad-text)]'
    : status === 'recovered'
      ? 'text-[color:var(--workspace-status-warn-text)]'
      : status === 'refreshing'
        ? 'text-[color:var(--workspace-status-info-text)]'
        : 'text-[var(--workspace-text-subtle)]'

  return (
    <span
      data-testid="host-ops-refresh-status"
      data-status={status}
      title={error ?? undefined}
      role="status"
      aria-live="polite"
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-[11px]', tone)}
    >
      <RefreshCw className={cn('h-3 w-3 shrink-0', status === 'refreshing' && 'animate-spin')} />
      <span className="truncate">{label}</span>
    </span>
  )
}

interface HostsDashboardProps {
  activeVaultId?: string
  hosts: HostProfile[]
  selectedHostId: string | null
  loading: boolean
  defaultUsername?: string
  onSelectHost: (hostId: string) => void
  onConnectHost?: (hostId: string) => void
  onOpenWorkspace?: (hostId: string, app: WorkspaceAppId) => void
  onCreateHost: (draft: HostProfileDraft) => Promise<HostProfile | void>
  onUpdateHost: (host: HostProfile, draft: HostProfileDraft) => Promise<void>
  onDeleteHost: (hostId: string) => Promise<void>
  openAddForm?: boolean
  onAddFormClose?: () => void
  externalSearch?: string
  onExternalSearchChange?: (q: string) => void
  onScanHosts?: (hosts: HostProfile[]) => Promise<void>
  onRefreshHosts?: () => Promise<void>
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultName?: string
  /** All Vaults; hosts can move to any other one. */
  vaults?: ReadonlyArray<Pick<VaultMeta, 'id' | 'name'>>
  headerExtraAction?: ReactNode
}

function komariAlertHostVersion(host: HostProfile, hosts: readonly HostProfile[]): string {
  const version = (row: HostProfile) => [row.name, row.updatedAt, row.authType, row.secretKeyRef, row.passwordKeyRef, row.privateKeyRef]
  const jump = host.jumpHostId ? hosts.find((row) => row.id === host.jumpHostId) : undefined
  return JSON.stringify([getHostIdentity(host, hosts), version(host), jump ? version(jump) : null])
}

function hostOpsToCardSummary(
  view?: HostOpsView,
  komariProbe?: KomariProbeLink,
  onKomariProbeAction?: HostOperationalSummary['onKomariProbeAction'],
  komariProbeBusy = false,
  onKomariAlertAction?: HostOperationalSummary['onKomariAlertAction'],
  komariAlertBusy?: string | null,
): HostOperationalSummary | undefined {
  if (!view || (!hasHostOpsEvidence(view) && !komariProbe)) return undefined
  const latestAudit = view.latestAudit
  const alertSummary = view.health.alertSummary
  const alertLifecycle = view.health.alertLifecycle
  const alertIncidents = groupKomariAlertIncidents(view.komariAlerts).filter(({ alert }) => !isHistoricalKomariAlert(alert))
  return {
    serviceTotal: view.serviceSummary.total,
    serviceActive: view.serviceSummary.active,
    serviceFailed: view.serviceSummary.failed,
    processTotal: view.processSummary.total,
    processRunning: view.processSummary.pm2,
    ...(alertSummary ? {
      alertTotal: 0,
      alertActive: 0,
      alertUnsupported: alertSummary.unsupported === true,
    } : {}),
    ...(alertLifecycle ? {
      alertTotal: alertIncidents.length,
      alertActive: alertIncidents.filter(({ alert }) => alert.status === 'active').length,
      alertUnsupported: false,
      alertAcknowledged: alertLifecycle.acknowledged,
      alertClosed: alertLifecycle.closed,
      alertOpen: alertLifecycle.open,
      alertLinkedJobId: alertLifecycle.latestOperationJobId,
    } : {}),
    komariAlerts: view.komariAlerts,
    komariAlertAudits: view.komariAlertAudits,
    onKomariAlertAction,
    komariAlertBusy,
    auditCount: view.operationSummary.total,
    auditActive: view.operationSummary.active,
    auditFailed: view.operationSummary.failed,
    auditUnknown: view.operationSummary.unknown,
    latestAudit: latestAudit
      ? {
          action: latestAudit.action,
          target: latestAudit.target,
          status: latestAudit.status,
          createdAt: latestAudit.createdAt,
          transport: latestAudit.transport,
          provider: latestAudit.provider,
          auditId: latestAudit.auditId,
          jobId: latestAudit.jobId,
          source: latestAudit.source,
        }
      : undefined,
    audits: view.audits,
    provider: view.health.provider === 'unknown' ? undefined : view.health.provider,
    ...(view.health.probe ? {
      probeProviderId: view.health.probe.providerId,
      probeState: view.health.probe.state,
      probeError: view.health.probe.error,
      probeErrorCode: view.health.probe.telemetry?.lastErrorCode,
      probeTelemetry: view.health.probe.telemetry,
    } : {}),
    sampledAt: view.health.freshness.sampledAt ?? undefined,
    ttlMs: view.health.freshness.ttlMs,
    expiresAt: view.health.freshness.expiresAt,
    expiryReason: view.health.freshness.expiryReason,
    capabilities: view.capabilities,
    highestAlertSeverity: view.highestAlertSeverity,
    localAlertOpen: view.localAlertOpen,
    localAlerts: view.localAlerts,
    localAlertEvaluations: view.localAlertEvaluations,
    transport: view.health.transport,
    jumpHostName: view.route.jumpHostName,
    jumpHost: view.route.jumpHost,
    jumpPort: view.route.jumpPort,
    jumpUser: view.route.jumpUser,
    ...(view.health.agent ? {
      agentStatus: view.health.agent.status,
      agentHealth: view.health.agent.health,
      agentVersion: view.health.agent.version,
      agentHeartbeatAt: view.health.agent.lastHeartbeatAt,
    } : {}),
    ...(komariProbe ? { komariProbe, onKomariProbeAction, komariProbeBusy } : {}),
  }
}

export function HostsDashboard({
  activeVaultId,
  hosts, selectedHostId, loading, defaultUsername = 'root',
  onSelectHost, onConnectHost, onOpenWorkspace, onCreateHost, onUpdateHost, onDeleteHost,
  openAddForm = false, onAddFormClose,
    externalSearch, onExternalSearchChange, onScanHosts, onRefreshHosts,
    vaultKeys = [], vaultUnlocked = false, onSaveToVault, onLoadVaultSecret, vaultName = 'Vault',
    vaults = [], headerExtraAction,
}: HostsDashboardProps) {
  const [internalSearch, setInternalSearch] = useState('')
  const effectiveSearch = externalSearch ?? internalSearch
  const setEffectiveSearch = onExternalSearchChange ?? setInternalSearch
  const [groupFilter, setGroupFilter] = useState('All')
  const [showAddForm, setShowAddForm] = useState(openAddForm)
  const rootRef = useRef<HTMLDivElement>(null)
  const batchPanelRef = useRef<HTMLDivElement>(null)
  const [batchOperation, setBatchOperation] = useState<MultiHostOperationKind>('health-check')
  useEffect(() => {
    // ⌘N opens "new host" while the host page is on screen (Ctrl+N stays with the terminal).
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n') return
      if (!rootRef.current?.getClientRects().length) return
      event.preventDefault()
      setShowAddForm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { setShowAddForm((prev) => (openAddForm ? true : prev)) }, [openAddForm])
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [showSshImport, setShowSshImport] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem(SORT_KEY) as SortMode) || 'newest')
  const [advancedFilters, setAdvancedFilters] = useState<HostOpsFilters>({ ...DEFAULT_HOST_OPS_FILTERS })
  const [filterNow, setFilterNow] = useState(Date.now)
  const [statusFilter, setStatusFilter] = useState<HostStatusFilter>('all')
  const [sortOpen, setSortOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const { t, locale } = useT()
  const presentationCopy = hostPresentationCopy[locale]
  const presentationOwner = JSON.stringify([activeVaultId, vaultUnlocked])
  const preferenceKey = `shellbeam:host-monitoring-summary:${activeVaultId ?? 'none'}`
  const readMonitoringPreference = () => {
    try { return localStorage.getItem(preferenceKey) === 'visible' } catch { return false }
  }
  const [presentation, setPresentation] = useState(() => ({ owner: presentationOwner, monitoring: readMonitoringPreference(), alerts: false, batch: false, selected: [] as string[] }))
  if (presentation.owner !== presentationOwner) {
    setPresentation({ owner: presentationOwner, monitoring: readMonitoringPreference(), alerts: false, batch: false, selected: [] })
    setAdvancedFilters({ ...DEFAULT_HOST_OPS_FILTERS })
    setStatusFilter('all')
  }
  const currentPresentation = presentation.owner === presentationOwner ? presentation : { owner: presentationOwner, monitoring: readMonitoringPreference(), alerts: false, batch: false, selected: [] as string[] }
  const [batchBusy, setBatchBusy] = useState(false)
  const [probeInstallHost, setProbeInstallHost] = useState<HostProfile | null>(null)
  // Hosts being moved to another Vault, kept apart from the batch selection that a finished move clears.
  const [moveRequest, setMoveRequest] = useState<{ vaultId: string; hosts: HostProfile[] } | null>(null)
  const canMoveHosts = !!activeVaultId && vaults.some(vault => vault.id !== activeVaultId)
  const openHostMove = (picked: HostProfile[]) => {
    const movable = picked.filter(host => !host.vaultId || host.vaultId === activeVaultId)
    if (activeVaultId && movable.length) setMoveRequest({ vaultId: activeVaultId, hosts: movable })
  }
  const handleHostsMoved = async (movedIds: string[]) => {
    setPresentation(current => ({ ...current, selected: current.selected.filter(id => !movedIds.includes(id)) }))
    await onRefreshHosts?.()
  }
  const sharedStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  const [agentDeployments, setAgentDeployments] = useState<McpDeploymentRecord[]>([])
  const [scopedHostOpsViews, setScopedHostOpsViews] = useState<{ vaultId?: string; views: Record<string, HostOpsView> }>({ views: {} })
  const hostOpsViews = useMemo(() => scopedHostOpsViews.vaultId === activeVaultId ? scopedHostOpsViews.views : {}, [scopedHostOpsViews, activeVaultId])
  const [scopedKomariProbeLinks, setScopedKomariProbeLinks] = useState<{ vaultId?: string; links: KomariProbeLink[] }>({ links: [] })
  const komariProbeLinks = useMemo(() => scopedKomariProbeLinks.vaultId === activeVaultId ? scopedKomariProbeLinks.links : [], [scopedKomariProbeLinks, activeVaultId])
  const currentOpsVault = useRef(activeVaultId)
  currentOpsVault.current = activeVaultId
  const opsRefreshSequence = useRef(0)
  const opsMounted = useRef(true)
  useEffect(() => {
    const mounted = opsMounted
    const sequence = opsRefreshSequence
    mounted.current = true
    return () => { mounted.current = false; sequence.current++ }
  }, [])
  const [komariProbeAction, setKomariProbeAction] = useState<{ vaultId?: string; key: string; sequence: number } | null>(null)
  const [komariAlertAction, setKomariAlertAction] = useState<{ vaultId?: string; key: string; sequence: number; generation: number } | null>(null)
  const komariProbeActionKey = komariProbeAction && komariProbeAction.vaultId === activeVaultId ? komariProbeAction.key : null
  const komariActionSequence = useRef(0)
  const localScope = useRef({ vaultId: activeVaultId, unlocked: vaultUnlocked, generation: 0, hosts })
  if (localScope.current.vaultId !== activeVaultId || localScope.current.unlocked !== vaultUnlocked) localScope.current.generation++
  localScope.current = { ...localScope.current, vaultId: activeVaultId, unlocked: vaultUnlocked, hosts }
  const alertScopeGeneration = localScope.current.generation
  const [integrationIncidents, setIntegrationIncidents] = useState<{ generation: number; incidents: HostIncident[] }>({ generation: -1, incidents: [] })
  const receiveIntegrationIncidents = useCallback((incidents: HostIncident[]) => {
    if (localScope.current.generation !== alertScopeGeneration || !localScope.current.unlocked) return
    setIntegrationIncidents({ generation: alertScopeGeneration, incidents })
  }, [alertScopeGeneration])
  const komariAlertActionKey = komariAlertAction && komariAlertAction.vaultId === activeVaultId && komariAlertAction.generation === localScope.current.generation ? komariAlertAction.key : null
  const komariAlertContext = useRef({ hostVersions: new Map<string, string>(), hostGenerations: new Map<string, number>(), mappingGenerations: new Map<string, number>() })
  const komariAlertPending = useRef<{ sequence: number; isCurrent: () => boolean } | null>(null)
  const scopedActionHosts = hosts.filter((host) => !host.vaultId || host.vaultId === activeVaultId)
  const hostVersions = new Map(scopedActionHosts.map((host) => [host.id, komariAlertHostVersion(host, scopedActionHosts)]))
  for (const id of new Set([...komariAlertContext.current.hostVersions.keys(), ...hostVersions.keys()])) {
    if (komariAlertContext.current.hostVersions.get(id) !== hostVersions.get(id)) {
      komariAlertContext.current.hostGenerations.set(id, (komariAlertContext.current.hostGenerations.get(id) ?? 0) + 1)
    }
  }
  komariAlertContext.current.hostVersions = hostVersions
  const localActionSequence = useRef(0)
  const localActionPending = useRef<{ generation: number; sequence: number } | null>(null)
  const [localAlertAction, setLocalAlertAction] = useState<{ vaultId: string; generation: number; sequence: number; hostId: string; ruleId: string } | null>(null)
  const [localAlertError, setLocalAlertError] = useState<{ vaultId: string; generation: number; hostId: string } | null>(null)
  const visibleLocalAction = localAlertAction !== null && localAlertAction.vaultId === activeVaultId && localAlertAction.generation === localScope.current.generation ? localAlertAction : null
  const [hostOpsLoading, setHostOpsLoading] = useState(false)
  const [hostOpsRefreshStatus, setHostOpsRefreshStatus] = useState<HostOpsRefreshStatus>('idle')
  const [hostOpsLastRefreshedAt, setHostOpsLastRefreshedAt] = useState<number | null>(null)
  const [hostOpsRefreshError, setHostOpsRefreshError] = useState<string | null>(null)
  const refreshHostOps = useCallback(async (forceKomari = false) => {
    if (!opsMounted.current || currentOpsVault.current !== activeVaultId) return
    const sequence = ++opsRefreshSequence.current
    const generation = localScope.current.generation
    const isCurrent = () => opsMounted.current && currentOpsVault.current === activeVaultId
      && localScope.current.generation === generation && opsRefreshSequence.current === sequence
    setHostOpsLoading(true)
    setHostOpsRefreshStatus('refreshing')
    setHostOpsRefreshError(null)
    let recoveredFromPersistence = false
    try {
      const observationHosts = hosts.filter(host => !host.vaultId || host.vaultId === activeVaultId)
        .map(host => ({ ...host, vaultId: host.vaultId ?? activeVaultId }))
      let komariSnapshots = undefined
      const komariRecords: Array<{
        integrationId: string
        endpoint: string
        lastSyncedAt: number | null
        snapshots: Awaited<ReturnType<typeof syncKomariIntegration>>['snapshots']
        mappings: Awaited<ReturnType<typeof syncKomariIntegration>>['mapping']['mappings']
        alertState: Awaited<ReturnType<typeof syncKomariIntegration>>['alertState']
        alertAudit: Awaited<ReturnType<typeof syncKomariIntegration>>['alertAudit']
      }> = []
      if (activeVaultId && onLoadVaultSecret && vaultUnlocked) {
        const integrations = await listKomariIntegrations(activeVaultId).catch(() => [])
        const enabledIntegrations = integrations.filter((integration) => integration.enabled && integration.vaultId === activeVaultId)
        const syncResults = await Promise.allSettled(
          enabledIntegrations
            .map(async (integration) => {
              const source = await loadCurrentKomariSource(integration)
              if (!source.state || source.error) throw new Error('KOMARI_MAPPING_READ_FAILED')
              const cached = source.state
              if (!isCurrent()) throw new Error('KOMARI_REFRESH_SUPERSEDED')
              const cachedSnapshots = cached.snapshots.map((entry) => entry.snapshot)
                .filter(snapshot => observationHosts.some(host => isCurrentKomariSnapshot(snapshot, host, [source])))
              const cachedAlertState = readKomariAlertState(cached.syncState)
              const lastSyncedAt = cached.lastSyncedAt
              const confirmedSyncAt = confirmedKomariSyncAt(integration, cached.syncState)
              const ttlMs = cached.syncState?.ttlMs ?? DEFAULT_KOMARI_SYNC_TTL_MS
              if (!forceKomari && isKomariSyncFresh(confirmedSyncAt, Date.now(), ttlMs)) {
                const cachedAlerts = reconcileKomariProbeAlerts({
                  integrationId: integration.id,
                  snapshots: cachedSnapshots,
                  alertState: cachedAlertState,
                  now: Date.now(),
                })
                const baselineSignature = (state: KomariAlertState | null) => JSON.stringify((state?.probeBaselines ?? [])
                  .map((row) => JSON.stringify([row.integrationId, row.endpoint ?? '', row.nodeId, row.hostId, row.lastHealthySampledAt])).sort())
                if (cachedAlerts.alertAudit.length > 0
                  || baselineSignature(cachedAlerts.alertState) !== baselineSignature(cachedAlertState)) {
                  await persistKomariAlertState({
                    integrationId: integration.id,
                    state: cachedAlerts.alertState,
                    lastSyncedAt: lastSyncedAt ?? undefined,
                    ttlMs,
                  }).catch(() => undefined)
                }
                return { integrationId: integration.id, endpoint: integration.endpoint, lastSyncedAt: confirmedSyncAt, snapshots: cachedSnapshots, mappings: cached.mappings, alertState: cachedAlerts.alertState, alertAudit: cachedAlerts.alertAudit }
              }

              const apiKey = await onLoadVaultSecret(integration.credentialRef)
              if (!isCurrent()) throw new Error('KOMARI_REFRESH_SUPERSEDED')
              if (!apiKey) return { integrationId: integration.id, endpoint: integration.endpoint, lastSyncedAt: confirmedSyncAt, snapshots: cachedSnapshots, mappings: cached.mappings, alertState: cachedAlertState, alertAudit: [] }
              const mappingState = await getKomariMappingState(activeVaultId, integration.id)
              if (!isCurrent()) throw new Error('KOMARI_REFRESH_SUPERSEDED')
              const result = await syncKomariIntegration({
                integrationId: integration.id,
                vaultId: activeVaultId ?? undefined,
                config: { endpoint: integration.endpoint, token: apiKey },
                hosts,
                explicitMappings: manualKomariMappings(mappingState.mappings),
                lastSyncedAt: confirmedSyncAt,
                ttlMs,
                force: forceKomari,
                alertState: cachedAlertState,
                previousSnapshots: cachedSnapshots,
              })
              if (!isCurrent()) throw new Error('KOMARI_REFRESH_SUPERSEDED')
              if (!result.skipped) {
                await persistKomariSync({
                  integrationId: integration.id,
                  vaultId: activeVaultId,
                  expectedMappingRevision: mappingState.revision,
                  // Keep the last successful metric row when a later probe
                  // only returns an error or an empty Komari record.
                  snapshots: result.snapshots.filter((snapshot) => snapshot.metrics !== null),
                  mappings: result.mapping.mappings,
                  updatedAt: result.syncedAt,
                  ttlMs,
                  alertSummary: result.alerts,
                  alertState: result.alertState,
                })
              }
              return {
                integrationId: integration.id,
                endpoint: integration.endpoint,
                lastSyncedAt: result.skipped ? confirmedSyncAt : result.syncedAt,
                snapshots: result.skipped ? cachedSnapshots : result.snapshots,
                mappings: result.skipped ? cached.mappings : result.mapping.mappings,
                alertState: result.skipped ? cachedAlertState : result.alertState,
                alertAudit: result.skipped ? [] : result.alertAudit,
              }
            }),
        )
        // A failed remote sync must not discard the last durable Komari
        // mapping, snapshot, or alert lifecycle. Rehydrate that integration
        // by index so another session still sees its host card state while
        // the next scheduled refresh retries the endpoint.
        const recoveredRecords = await Promise.all(syncResults.map(async (result, index) => {
          if (result.status === 'fulfilled') return result.value
          recoveredFromPersistence = true
          const integration = enabledIntegrations[index]
          const cached = await loadKomariPersistence(integration.id).catch(() => ({ snapshots: [], mappings: [], syncState: null, lastSyncedAt: null }))
          return {
            integrationId: integration.id,
            endpoint: integration.endpoint,
            lastSyncedAt: confirmedKomariSyncAt(integration, cached.syncState),
            snapshots: cached.snapshots.map((entry) => entry.snapshot),
            mappings: cached.mappings,
            alertState: readKomariAlertState(cached.syncState),
            alertAudit: [],
          }
        }))
        if (!isCurrent()) return
        komariSnapshots = recoveredRecords
          .map((record) => { komariRecords.push(record); return record.snapshots })
          .flat()
      }
      if (!isCurrent()) return
      // Fresh rows deliver once; TTL cache hits may retry bounded, durable
      // channel failures without replaying the historical alert journal.
      if (komariRecords.length > 0) {
        const sources = await loadCurrentKomariSources(activeVaultId ? [activeVaultId] : [])
        if (!isCurrent()) return
        const notificationPolicy = loadNotificationPolicy()
        await Promise.all(komariRecords.map(async (record) => {
          if (!record.alertState) return
          const source = sources.find(source => source.integration.id === record.integrationId && !source.error && source.state)
          if (!source?.state || normalizeKomariEndpoint(record.endpoint) !== normalizeKomariEndpoint(source.integration.endpoint)) return
          const alerts = record.alertState.alerts.filter(alert => {
            if (alert.hostId || alert.nodeId) return observationHosts.some(host => isCurrentKomariAlert(alert, host, sources, record.snapshots))
            return confirmedKomariSyncAt(source.integration, source.state!.syncState) !== null
          })
          const ids = new Set(alerts.map(alert => alert.alertId))
          const state = { ...record.alertState, alerts, audit: record.alertState.audit.filter(audit => ids.has(audit.alertId)) }
          try {
            await dispatchAndPersistKomariAlertNotifications(record.integrationId, state, {
              isCurrent,
              policy: notificationPolicy,
              audit: record.alertAudit.filter(audit => ids.has(audit.alertId)),
              retryPending: true,
              onLocal: emitKomariAlertNotification,
            })
          } catch (error) {
            // A notification sink is optional; a delivery failure must not
            // hide fresh host health data or the persisted Komari audit.
            console.warn('Komari alert notification delivery failed', error)
          }
        }))
      }
      const views = await loadHostOpsViews(hosts, {
        auditLimit: 250,
        komariSnapshots,
        komariAlertStates: komariRecords.map((record) => record.alertState).filter((state): state is NonNullable<typeof state> => state !== null),
        vaultId: activeVaultId,
      })
      if (!isCurrent()) return
      setScopedHostOpsViews({ vaultId: activeVaultId, views })
      setHostOpsLastRefreshedAt(Date.now())
      setHostOpsRefreshStatus(recoveredFromPersistence ? 'recovered' : 'fresh')
      if (komariRecords.length > 0) {
        const [agents, sources] = await Promise.all([
          listShellbeamAgents({ vaultId: activeVaultId }).catch(() => []),
          loadCurrentKomariSources(activeVaultId ? [activeVaultId] : []),
        ])
        if (!isCurrent()) return
        setScopedKomariProbeLinks({ vaultId: activeVaultId, links: sources.flatMap(source => {
          if (source.error || !source.state) return []
          const record = komariRecords.find(record => record.integrationId === source.integration.id)
          if (!record || normalizeKomariEndpoint(record.endpoint) !== normalizeKomariEndpoint(source.integration.endpoint)) return []
          const snapshots = record.snapshots.filter(snapshot => observationHosts.some(host => isCurrentKomariSnapshot(snapshot, host, sources)))
          const alertState = record.alertState ? {
            ...record.alertState,
            alerts: record.alertState.alerts.filter(alert => observationHosts.some(host => isCurrentKomariAlert(alert, host, sources, snapshots))),
          } : null
          return buildKomariProbeLinks({
            integrationId: source.integration.id,
            vaultId: activeVaultId,
            endpoint: source.integration.endpoint,
            lastSyncedAt: record.lastSyncedAt,
            hosts,
            mappings: source.state.mappings,
            snapshots,
            shellbeamAgents: agents,
            alertState,
          })
        }) })
      } else {
        setScopedKomariProbeLinks({ vaultId: activeVaultId, links: [] })
      }
    } catch (error) {
      if (!isCurrent()) return
      // A remote sync can fail while the durable ProbeProvider, Komari and
      // OperationJob rows remain available locally. Keep the last rendered
      // view visible and make one persistence-only read so a refresh failure
      // in another session never blanks the host list.
      console.warn('Host operations refresh failed; retaining persisted view', error)
      setHostOpsRefreshError(error instanceof Error ? error.message : String(error))
      try {
        const persistedViews = await loadHostOpsViews(hosts, {
          auditLimit: 250,
          vaultId: activeVaultId,
        })
        if (!isCurrent()) return
        if (Object.keys(persistedViews).length > 0) {
          setScopedHostOpsViews({ vaultId: activeVaultId, views: persistedViews })
          setHostOpsLastRefreshedAt(Date.now())
          setHostOpsRefreshStatus('recovered')
        } else {
          setHostOpsRefreshStatus('error')
        }
      } catch (fallbackError) {
        if (!isCurrent()) return
        console.warn('Persisted host operations refresh failed', fallbackError)
        setHostOpsRefreshError(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
        setHostOpsRefreshStatus('error')
      }
    } finally {
      if (isCurrent()) setHostOpsLoading(false)
    }
  }, [activeVaultId, hosts, onLoadVaultSecret, vaultUnlocked])

  const resolveKomariHostSecret = useCallback(async (host: HostProfile) => {
    if (!onLoadVaultSecret) throw new Error('Vault secret resolver is unavailable')
    const key = host.authType === 'password' ? host.passwordKeyRef : host.privateKeyRef
    if (!key) throw new Error(`No ${host.authType} reference is configured for ${host.name}`)
    const secret = await onLoadVaultSecret(key)
    if (!secret) throw new Error(`Vault secret is unavailable for ${host.name}`)
    return secret
  }, [onLoadVaultSecret])

  const handleKomariProbeAction = useCallback(async (action: 'check-probe' | 'install-probe', link: KomariProbeLink) => {
    if (!link.mapping || !activeVaultId || currentOpsVault.current !== activeVaultId) return
    const host = hosts.find((candidate) => candidate.id === link.mapping?.hostId && (!candidate.vaultId || candidate.vaultId === activeVaultId))
    if (!host) return
    const key = `${link.integrationId}:${link.nodeId}:${action}`
    const sequence = ++komariActionSequence.current
    setKomariProbeAction({ vaultId: activeVaultId, key, sequence })
    try {
      const verifyTarget = async () => {
        if (!opsMounted.current || currentOpsVault.current !== activeVaultId) throw new Error('KOMARI_MAPPING_SCOPE_MISMATCH')
        const latest = await getKomariMappingState(activeVaultId, link.integrationId)
        if (currentOpsVault.current !== activeVaultId || !latest.mappings.some((mapping) => mapping.nodeId === link.nodeId && mapping.hostId === host.id)) throw new Error('KOMARI_MAPPING_CONFLICT')
      }
      await verifyTarget()
      const mappings = [link.mapping]
      if (action === 'check-probe') {
        await runConfirmedOperation({
          host, vaultId: activeVaultId, action: 'agent.check', target: `Komari node ${link.nodeId}`, provider: 'shellbeam-agent', risk: 'read-only', confirmMessage: '',
          execute: () => checkKomariLinkedProbe({ integrationId: link.integrationId, nodeId: link.nodeId, vaultId: activeVaultId, mappings, hosts, resolveAuthSecret: resolveKomariHostSecret, validateTarget: verifyTarget }),
          getResult: (value) => value.result,
        })
      } else {
        // The Overview panel owns catalog trust, signed downloads and explicit
        // installation confirmation. A host card must never invoke an absent
        // or unsigned legacy executable as an installation shortcut.
        if (!onOpenWorkspace) return
        onSelectHost(host.id)
        onOpenWorkspace(host.id, 'overview')
        return
      }
      await refreshHostOps(true)
    } catch (error) {
      // The bridge persists rejected/failed OperationJobs. Keep the host list
      // usable while the audit remains the source of truth for the details.
      console.error('Komari Probe operation failed', error)
    } finally {
      setKomariProbeAction((current) => current && current.vaultId === activeVaultId && current.key === key && current.sequence === sequence ? null : current)
    }
  }, [activeVaultId, hosts, refreshHostOps, resolveKomariHostSecret, onOpenWorkspace, onSelectHost])

  const handleKomariAlertAction = useCallback(async (host: HostProfile, action: KomariAlertAction, alert: KomariAlertRecord) => {
    if (!activeVaultId || !vaultUnlocked) return
    const generation = localScope.current.generation
    const hostGeneration = komariAlertContext.current.hostGenerations.get(host.id)
    const mappingGeneration = komariAlertContext.current.mappingGenerations.get(alert.integrationId) ?? 0
    const isCurrent = () => opsMounted.current && localScope.current.generation === generation
      && localScope.current.vaultId === activeVaultId && localScope.current.unlocked
      && komariAlertContext.current.hostVersions.has(host.id)
      && komariAlertContext.current.hostGenerations.get(host.id) === hostGeneration
      && (komariAlertContext.current.mappingGenerations.get(alert.integrationId) ?? 0) === mappingGeneration
    if (!isCurrent() || (host.vaultId && host.vaultId !== activeVaultId)
      || komariAlertContext.current.hostVersions.get(host.id) !== komariAlertHostVersion(host, localScope.current.hosts.filter((row) => !row.vaultId || row.vaultId === activeVaultId))
      || komariAlertPending.current?.isCurrent()) return
    const key = `${action}:${alert.alertId}`
    const sequence = ++komariActionSequence.current
    komariAlertPending.current = { sequence, isCurrent }
    setKomariAlertAction({ vaultId: activeVaultId, key, sequence, generation })
    try {
      const [persisted, integrations] = await Promise.all([loadKomariPersistence(alert.integrationId), listKomariIntegrations(activeVaultId)])
      if (!isCurrent()) return
      if (!integrations.some((integration) => integration.id === alert.integrationId && integration.vaultId === activeVaultId)) return
      const state = readKomariAlertState(persisted.syncState)
      if (!state) throw new Error('Komari alert state is unavailable; refresh the host first')
      const current = groupKomariAlertIncidents(state.alerts).map(({ alert: incident }) => incident).find((row) => row.alertId === alert.alertId && row.integrationId === alert.integrationId
        && row.fingerprint === alert.fingerprint && row.firstSeenAt === alert.firstSeenAt
        && row.nodeId === alert.nodeId && row.hostId === alert.hostId)
      if (!current) return
      // Explicit historical ownership remains actionable on the original host
      // after a remap. A node-only record needs a current binding, and cannot
      // borrow another host's historical ownership merely via the node ID.
      if (current.hostId) {
        if (current.hostId !== host.id) return
      } else {
        if (!current.nodeId) return
        const mapping = await getKomariMappingState(activeVaultId, alert.integrationId)
        if (!isCurrent() || !mapping.mappings.some((row) => row.nodeId === current.nodeId && row.hostId === host.id)) return
      }
      if (!isCurrent()) return
      await runKomariAlertAction(action, {
        host,
        integrationId: alert.integrationId,
        state,
        alertId: alert.alertId,
        vaultId: activeVaultId,
        isCurrent,
        lastSyncedAt: persisted.lastSyncedAt ?? undefined,
        ttlMs: persisted.syncState?.ttlMs,
        confirmMessage: t(
          action === 'acknowledge' ? 'hosts.alert.confirmAcknowledge' : 'hosts.alert.confirmClose',
          { host: host.name, alert: monitoringAlertTitle(current, locale) },
        ),
      })
    } catch (error) {
      if (isCurrent()) console.error('Komari alert operation failed', error)
    } finally {
      if (isCurrent()) await refreshHostOps(true).catch((error) => {
        console.error('Komari host operations refresh failed', error)
      })
      if (komariAlertPending.current?.sequence === sequence) komariAlertPending.current = null
      setKomariAlertAction((current) => current?.sequence === sequence ? null : current)
    }
  }, [activeVaultId, vaultUnlocked, refreshHostOps, t, locale])

  const handleLocalAlertAction = useCallback(async (host: HostProfile, alert: LocalAlertRecord, action: 'acknowledge' | 'close') => {
    if (!activeVaultId || !vaultUnlocked) return
    const generation = localScope.current.generation
    const hostKey = getWorkspaceInventoryHostKey(host)
    const isCurrent = () => opsMounted.current && localScope.current.generation === generation
      && localScope.current.vaultId === activeVaultId && localScope.current.unlocked
      && localScope.current.hosts.some((candidate) => candidate.id === host.id && (!candidate.vaultId || candidate.vaultId === activeVaultId) && getWorkspaceInventoryHostKey(candidate) === hostKey)
    if (!isCurrent() || (localActionPending.current?.generation === generation)) return
    const current = loadLocalAlertState(activeVaultId, host.id).alerts.find((row) => row.ruleId === alert.ruleId && row.hostId === host.id)
    // A stale card cannot act on a different incident or a replaced source.
    if (!current || current.openedAt !== alert.openedAt || current.source !== alert.source || current.metric !== alert.metric || current.transport !== alert.transport
      || (action === 'acknowledge' ? current.status !== 'active' : !['active', 'acknowledged', 'resolved'].includes(current.status))) return
    const sequence = ++localActionSequence.current
    localActionPending.current = { generation, sequence }
    setLocalAlertAction({ vaultId: activeVaultId, generation, sequence, hostId: host.id, ruleId: current.ruleId })
    setLocalAlertError(null)
    try {
      await runLocalAlertAction({ vaultId: activeVaultId, host, ruleId: current.ruleId, action,
        confirmMessage: t(action === 'acknowledge' ? 'localOps.confirmAcknowledge' : 'localOps.confirmClose', { host: host.name, alert: current.name }), isCurrent })
    } catch {
      if (isCurrent()) setLocalAlertError({ vaultId: activeVaultId, generation, hostId: host.id })
    } finally {
      if (isCurrent()) await refreshHostOps().catch(() => undefined)
      if (localActionPending.current?.sequence === sequence) localActionPending.current = null
      setLocalAlertAction((pending) => pending?.sequence === sequence ? null : pending)
    }
  }, [activeVaultId, vaultUnlocked, refreshHostOps, t])

  useEffect(() => { void refreshHostOps() }, [activeVaultId, refreshHostOps])

  useEffect(() => {
    const invalidateMapping = (event: Event) => {
      const detail = (event as CustomEvent<{ vaultId: string; integrationId: string }>).detail
      if (!detail || detail.vaultId !== activeVaultId || currentOpsVault.current !== activeVaultId) return
      komariAlertContext.current.mappingGenerations.set(detail.integrationId, (komariAlertContext.current.mappingGenerations.get(detail.integrationId) ?? 0) + 1)
      opsRefreshSequence.current++
      const affectedHosts = new Set(komariProbeLinks.filter((link) => link.integrationId === detail.integrationId).flatMap((link) => link.hostId ? [link.hostId] : []))
      setScopedKomariProbeLinks((current) => current.vaultId !== activeVaultId ? current : { ...current, links: current.links.filter((link) => link.integrationId !== detail.integrationId) })
      setScopedHostOpsViews((current) => current.vaultId !== activeVaultId ? current : { ...current, views: Object.fromEntries(Object.entries(current.views).filter(([hostId, view]) => !(view.health.provider === 'komari' && (view.health.probe?.providerId === detail.integrationId || affectedHosts.has(hostId))))) })
    }
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, invalidateMapping)
    return () => window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, invalidateMapping)
  }, [activeVaultId, komariProbeLinks])

  // MCP acknowledgement/close actions update the persisted Komari journal in
  // another session. Re-read the local cache when this view returns to the
  // foreground and during a long open session so the host card reflects the
  // same lifecycle and OperationJob audit without requiring a full reload.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const refreshWhenVisible = () => {
      // Returning to the foreground is the cross-session boundary: another
      // window may have acknowledged an alert or completed a job while this
      // one was suspended, so bypass the Komari TTL and re-read persistence.
      if (document.visibilityState === 'visible') void refreshHostOps(true)
    }
    const refreshFromPeerSession = () => { void refreshHostOps(true) }
    const refreshOnInterval = () => {
      // Keep the periodic persistence/audit refresh cheap; visibility changes
      // are the explicit point where a remote Komari sync should bypass TTL.
      if (document.visibilityState === 'visible') void refreshHostOps()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('shellbeam:host-ops-refresh', refreshFromPeerSession)
    const timer = window.setInterval(refreshOnInterval, 15_000)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('shellbeam:host-ops-refresh', refreshFromPeerSession)
      window.clearInterval(timer)
    }
  }, [refreshHostOps])

  const handleMultiHostOperation = useCallback(async (request: MultiHostOperationRequest): Promise<MultiHostOperationResult> => {
    const selectedHosts = request.hostIds
      .map((hostId) => hosts.find((host) => host.id === hostId))
      .filter((host): host is HostProfile => Boolean(host))
    if (selectedHosts.length === 0) throw new Error('No selected hosts are available')

    const operationLabel = request.operation === 'docker.restart'
      ? t('multiHost.operations.dockerRestart')
      : request.operation === 'service.restart'
        ? t('multiHost.operations.serviceRestart')
        : t('multiHost.operations.healthCheck')
    const confirmation = t('multiHost.confirm', {
      operation: operationLabel,
      target: request.target ?? t('multiHost.operations.healthCheck'),
      count: selectedHosts.length,
      hosts: selectedHosts.map((host) => host.name).join(', '),
    })
    const routes = selectedHosts.map((host) => {
      const jump = host.jumpHostId ? hosts.find((profile) => profile.id === host.jumpHostId) : null
      const path = host.jumpHostId
        ? `ProxyJump ${jump ? `${jump.username}@${jump.address}:${jump.port || 22}` : host.jumpHostId}`
        : host.jumpHost ? `ProxyJump ${host.jumpUser || host.username}@${host.jumpHost}:${host.jumpPort || 22}` : 'direct'
      return `${host.name} · ${host.username}@${host.address}:${host.port || 22} · ${path}`
    }).join('\n')
    const command = request.operation === 'docker.restart' ? `docker restart ${request.target}` : request.operation === 'service.restart' ? `systemctl restart ${request.target}` : 'uptime'
    const confirmMessage = `${confirmation}\n\n${t('multiHost.commandPreview', { command, routes })}`
    let batch: BatchOperationResult<unknown>
    if (request.operation === 'docker.restart') {
      if (!request.target) throw new Error('A Docker container name is required')
      batch = await runBatchDockerOperation({
        vaultId: activeVaultId,
        hosts: selectedHosts,
        containerName: request.target,
        dockerAction: 'restart',
        resolveAuthSecret: resolveKomariHostSecret,
        confirmMessage,
      })
    } else if (request.operation === 'service.restart') {
      if (!request.target) throw new Error('A systemd service name is required')
      batch = await runBatchServiceOperation({
        vaultId: activeVaultId,
        hosts: selectedHosts,
        serviceName: request.target,
        serviceAction: 'restart',
        resolveAuthSecret: resolveKomariHostSecret,
        confirmMessage,
      })
    } else if (request.operation === 'health-check') {
      batch = await runBatchOperation({
        vaultId: activeVaultId,
        hosts: selectedHosts,
        action: 'health.refresh',
        target: 'remote-health',
        risk: 'read-only',
        confirmMessage,
        confirm: () => true,
        execute: (host) => runWorkspaceRemoteCommand({
          host,
          vaultId: activeVaultId,
          resolveAuthSecret: resolveKomariHostSecret,
          command: "printf '__SHELLBEAM_HEALTH=ok\n'; uptime -p 2>/dev/null || true",
        }),
        getResult: (value) => value,
      })
    } else {
      throw new Error('Unsupported multi-host operation')
    }

    await refreshHostOps(true)
    return {
      operation: request.operation,
      status: batch.status,
      results: batch.outcomes.map((outcome) => ({
        hostId: outcome.host.id,
        status: outcome.status,
        jobId: outcome.job?.jobId ?? null,
        auditId: outcome.job?.auditId ?? null,
        transport: outcome.transport,
        resultSummary: outcome.resultSummary ?? outcome.job?.resultSummary ?? null,
        errorSummary: outcome.errorSummary ?? outcome.job?.errorSummary ?? null,
      })),
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
    }
  }, [activeVaultId, hosts, refreshHostOps, resolveKomariHostSecret, t])


  useEffect(() => {
    let cancelled = false
    if (!activeVaultId) {
      setAgentDeployments([])
      return
    }
    void listMcpDeploymentRecords(activeVaultId).then((result) => {
      if (!cancelled) setAgentDeployments(result.projects)
    }).catch(() => {
      if (!cancelled) setAgentDeployments([])
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

  const operationalSummaryByHost = useMemo(() => {
    const summaries = new Map<string, HostOperationalSummary | undefined>()
    hosts.forEach((host) => {
      const link = host.monitoringMode === 'ssh' ? undefined : komariProbeLinks.find((candidate) => candidate.hostId === host.id)
      const busy = link ? komariProbeActionKey === `${link.integrationId}:${link.nodeId}:${link.recommendedAction}` : false
      const alertBusy = komariAlertActionKey
        ? komariAlertActionKey.slice(komariAlertActionKey.indexOf(':') + 1)
        : null
      const summary = hostOpsToCardSummary(
        hostOpsViews[host.id],
        link,
        link?.recommendedAction === 'install-probe' && !onOpenWorkspace ? undefined : handleKomariProbeAction,
        busy,
        (action, alert) => handleKomariAlertAction(host, action, alert),
        alertBusy,
      )
      const viewVault = hostOpsViews[host.id]?.host.vaultId
      const sameVault = !!activeVaultId && (!host.vaultId || host.vaultId === activeVaultId) && (!viewVault || viewVault === activeVaultId)
      summaries.set(host.id, summary ? { ...summary,
        vaultId: sameVault ? activeVaultId : undefined,
        localAlerts: sameVault ? summary.localAlerts : [],
        // The interval triggers ageing; a just-completed sample may be newer
        // than that tick, so validate it against the current wall clock.
        localAlertEvaluations: sameVault ? hostProbeEvaluations(summary.localAlertEvaluations ?? [], Math.max(filterNow, Date.now())) : [],
        onLocalAlertAction: sameVault && vaultUnlocked ? (alert, action) => handleLocalAlertAction(host, alert, action) : undefined,
        localAlertBusy: visibleLocalAction ? visibleLocalAction.hostId === host.id ? visibleLocalAction.ruleId : '*' : null,
        localAlertError: localAlertError !== null && localAlertError.vaultId === activeVaultId && localAlertError.generation === localScope.current.generation && localAlertError.hostId === host.id,
        localAlertPersistenceError: sameVault && !!localOpsPersistenceError(activeVaultId, host.id),
        probeAlertLifecycleError: sameVault && !!getProbeAlertRuntimeDiagnostic(activeVaultId, host.id),
      } : undefined)
    })
    return summaries
  }, [handleKomariAlertAction, handleKomariProbeAction, handleLocalAlertAction, hostOpsViews, hosts, komariAlertActionKey, komariProbeActionKey, komariProbeLinks, onOpenWorkspace, activeVaultId, vaultUnlocked, visibleLocalAction, localAlertError, filterNow])

  useEffect(() => {
    const updateLocalAlerts = () => {
      setScopedHostOpsViews((current) => current.vaultId !== activeVaultId ? current : { ...current, views: Object.fromEntries(Object.entries(current.views).map(([id, view]) => {
        if (view.host.vaultId && view.host.vaultId !== activeVaultId) return [id, { ...view, localAlerts: [], localAlertEvaluations: [], localAlertOpen: 0 }]
        const state = loadLocalAlertState(activeVaultId, id)
        const localAlerts = state.alerts.filter((alert) => alert.hostId === id)
        const open = localAlerts.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged')
        const komari = groupKomariAlertIncidents(view.komariAlerts).map(({ alert }) => alert).filter(alert => !isHistoricalKomariAlert(alert)).filter((alert) => alert.status === 'active' || alert.status === 'acknowledged')
        const rank = ['info', 'warning', 'critical']
        const highestAlertSeverity = [...open, ...komari].map((alert) => alert.severity).sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0] ?? null
        return [id, { ...view, localAlerts, localAlertEvaluations: hostProbeEvaluations(state.evaluations), localAlertOpen: open.length, highestAlertSeverity, alertOpenCount: view.alertOpenCount == null ? null : view.alertOpenCount - (view.localAlertOpen ?? 0) + open.length }]
      })) })
    }
    const clock = window.setInterval(() => setFilterNow(Date.now()), 15_000)
    window.addEventListener(LOCAL_OPS_CHANGED_EVENT, updateLocalAlerts)
    window.addEventListener(LOCAL_OPS_PERSISTENCE_EVENT, updateLocalAlerts)
    window.addEventListener(PROBE_ALERT_RUNTIME_CHANGED, updateLocalAlerts)
    window.addEventListener('storage', updateLocalAlerts)
    return () => { window.clearInterval(clock); window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, updateLocalAlerts); window.removeEventListener(LOCAL_OPS_PERSISTENCE_EVENT, updateLocalAlerts); window.removeEventListener(PROBE_ALERT_RUNTIME_CHANGED, updateLocalAlerts); window.removeEventListener('storage', updateLocalAlerts) }
  }, [activeVaultId])
  const osOptions = useMemo(() => [...new Set(Object.values(hostOpsViews).map((view) => view.metrics?.os || view.resource?.os || '').filter(Boolean))].sort(), [hostOpsViews])

  function hostKey(host: HostProfile) {
    return getWorkspaceInventoryHostKey(host)
  }

  function handleSortChange(mode: SortMode) {
    setSortMode(mode)
    localStorage.setItem(SORT_KEY, mode)
    setSortOpen(false)
  }

  const allExistingGroups = useMemo(() => {
    const set = new Set<string>([...DEFAULT_GROUPS])
    hosts.forEach((h) => { if (h.group) set.add(h.group) })
    return Array.from(set)
  }, [hosts])

  const allExistingTags = useMemo(() => {
    const set = new Set<string>()
    hosts.forEach((h) => h.tags?.forEach((tg) => set.add(tg)))
    return Array.from(set).sort()
  }, [hosts])

  function handleConnect(hostId: string) {
    onSelectHost(hostId)
    onConnectHost?.(hostId)
  }

  function handleRefreshHost(hostId: string) {
    const host = hosts.find((item) => item.id === hostId)
    if (!host || !onScanHosts) return
    setHostOpsRefreshError(null)
    void onScanHosts([host]).then(() => refreshHostOps()).catch(() => setHostOpsRefreshError(t('hostOps.refreshFailed')))
  }

  async function handleCheckAllStatus() {
    if (!onScanHosts || filteredHosts.length === 0) return
    setCheckingStatus(true)
    try {
      await onScanHosts(filteredHosts)
      await refreshHostOps()
    } finally {
      setCheckingStatus(false)
    }
  }

  const handleRefreshAll = useCallback(async () => {
    await Promise.allSettled([
      onRefreshHosts?.(),
      refreshHostOps(true),
    ])
  }, [onRefreshHosts, refreshHostOps])

  const filteredHosts = useMemo(() => {
    const q = effectiveSearch.trim().toLowerCase()
    let filtered = hosts
    if (q) {
      filtered = hosts.filter(
        (h) =>
          matchesHostSearch(h, q, hosts) ||
          (agentDeploymentsByHost.get(h.id)?.some((deployment) => [deployment.name, deployment.deploymentPath, deployment.status].filter(Boolean).join(' ').toLowerCase().includes(q)) ?? false)
      )
    }
    if (groupFilter !== 'All') {
      filtered = filtered.filter((h) => (h.group || 'Custom') === groupFilter)
    }
    if (tagFilter.size > 0) {
      filtered = filtered.filter((h) => h.tags?.some((tg) => tagFilter.has(tg)))
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter((h) => getHostHealthStatus(hostOpsViews[h.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(h)]), hostOpsLoading) === statusFilter)
    }
    filtered = filtered.filter((host) => matchesHostOpsFilters(hostOpsViews[host.id], advancedFilters, filterNow))
    const sorted = [...filtered]
    switch (sortMode) {
      case 'az': sorted.sort((a, b) => a.name.localeCompare(b.name)); break
      case 'za': sorted.sort((a, b) => b.name.localeCompare(a.name)); break
      case 'newest': sorted.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)); break
      case 'oldest': sorted.sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt)); break
    }
    return sorted
  }, [agentDeploymentsByHost, hosts, effectiveSearch, groupFilter, sharedStates, statusFilter, tagFilter, sortMode, hostOpsLoading, hostOpsViews, advancedFilters, filterNow])

  const statusCounts = useMemo(() => hosts.reduce<Record<Exclude<HostStatusFilter, 'all'>, number>>((counts, host) => {
    const status = getHostHealthStatus(hostOpsViews[host.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(host)]), hostOpsLoading)
    counts[status] += 1
    return counts
  }, { online: 0, stale: 0, checking: 0, offline: 0, paused: 0, unsupported: 0, unknown: 0, 'jump-unavailable': 0 }), [hosts, sharedStates, hostOpsLoading, hostOpsViews])

  const allGroupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    hosts.forEach((h) => {
      const g = h.group || 'Custom'
      counts.set(g, (counts.get(g) ?? 0) + 1)
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [hosts])
  const resourceGroups = useMemo<WorkspaceResourceGroup[]>(() => (
    allGroupCounts.map(([group, count], index) => ({
      key: group,
      label: t(`group.${group}`) !== `group.${group}` ? t(`group.${group}`) : group,
      count,
      colorClassName: groupColors[index % groupColors.length],
    }))
  ), [allGroupCounts, t])
  const statusFilterLabels: Record<HostStatusFilter, string> = {
    all: t('hosts.statusAll'),
    online: t('hosts.statusOnline'),
    stale: t('hosts.statusStale'),
    checking: t('hosts.statusChecking'),
    offline: t('hosts.statusOffline'),
    paused: t('hosts.statusPaused'),
    unsupported: t('hosts.statusUnsupported'),
    unknown: t('hosts.statusUnknown'),
    'jump-unavailable': t('hosts.statusJumpUnavailable'),
  }
  const hasOperations = [...operationalSummaryByHost.values()].some(Boolean)
  const hasAdvancedFilters = Object.keys(DEFAULT_HOST_OPS_FILTERS).some(key => advancedFilters[key as keyof HostOpsFilters] !== DEFAULT_HOST_OPS_FILTERS[key as keyof HostOpsFilters])
  const hasMonitoring = hosts.some(host => {
    const view = hostOpsViews[host.id]
    return !!(view?.metrics || view?.resource || (view && view.health.provider !== 'unknown') || sharedStates[hostKey(host)]?.inventory?.resource)
  })
  const showMonitoring = hasMonitoring && currentPresentation.monitoring
  const showResources = showMonitoring || hosts.some(host => !!(hostOpsViews[host.id]?.metrics
    || hostOpsViews[host.id]?.resource || sharedStates[hostKey(host)]?.inventory?.resource))
  const providerOptions = [...new Set(Object.values(hostOpsViews).map(view => view.health.provider))]
  const incidents = [...new Map([
    ...(integrationIncidents.generation === alertScopeGeneration && vaultUnlocked ? integrationIncidents.incidents : []),
    ...buildHostIncidents(hosts, operationalSummaryByHost, activeVaultId),
  ].map(incident => [incident.key, incident])).values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
  const openIncidents = incidents.filter(row => !row.historyOnly && (row.status === 'active' || row.status === 'acknowledged')).length
  const selectedBatchIds = currentPresentation.selected.filter(id => filteredHosts.some(host => host.id === id && hasSshConnection(host) && (!host.vaultId || host.vaultId === activeVaultId)))
  const batchEligible = filteredHosts.filter(host => hasSshConnection(host) && (!host.vaultId || host.vaultId === activeVaultId))
  const batchSelection = (host: HostProfile) => currentPresentation.batch ? {
    selected: selectedBatchIds.includes(host.id),
    disabled: !hasSshConnection(host) || batchBusy || (!selectedBatchIds.includes(host.id) && selectedBatchIds.length >= MAX_BATCH_HOSTS),
    onChange: () => setPresentation(current => current.owner !== presentationOwner || batchBusy ? current : {
      ...current, selected: selectedBatchIds.includes(host.id) ? selectedBatchIds.filter(id => id !== host.id) : [...selectedBatchIds, host.id].slice(0, MAX_BATCH_HOSTS),
    }),
  } : undefined
  const displayStatus = (host: HostProfile) => operationalSummaryByHost.get(host.id) || sharedStates[hostKey(host)]?.inventory
    ? getHostHealthStatus(hostOpsViews[host.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(host)]), hostOpsLoading)
    : undefined
  const groupFilterChips = resourceGroups.length > 0 ? <div data-testid="host-group-filter" className="space-y-1.5">
    <div className="text-xs font-medium text-[var(--workspace-text-muted)]">{t('hosts.groupFilter')}</div>
    <div className="flex flex-wrap gap-1.5">
      {[{ key: 'All', label: t('hosts.all'), count: hosts.length }, ...resourceGroups].map((group) => (
        <button key={group.key} type="button" aria-pressed={groupFilter === group.key} onClick={() => setGroupFilter(group.key)}
          className={cn('rounded-md border px-2 py-1 text-xs', groupFilter === group.key ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
          {group.label} <span className="tabular-nums opacity-70">{group.count}</span>
        </button>
      ))}
    </div>
  </div> : null
  const bucketOf = (host: HostProfile) => {
    const view = hostOpsViews[host.id]
    const resource = view?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource
    const open = showMonitoring ? (view?.alertOpenCount ?? view?.localAlertOpen ?? 0) : 0
    const readings = showMonitoring ? (view?.metrics ? [view.metrics.cpuPercent, view.metrics.memoryPercent, view.metrics.diskPercent] : [resource?.cpuPercent, resource?.memoryPercent, resource?.diskPercent]) : []
    return hostBucket(displayStatus(host), open, readings)
  }

  return (
    <div ref={rootRef} className="flex min-w-0 w-full flex-col text-[var(--workspace-text)]">
      <HostMetadataSyncNotice vaultId={activeVaultId} unlocked={!!vaultUnlocked} hosts={hosts} onEdit={setEditingHost} />
      <div data-testid="hosts-header" className="space-y-4 pb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('nav.hosts')}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-[var(--workspace-text-muted)]">
              <span>{t('hosts.headerSummary', { total: hosts.length, online: statusCounts.online })}</span>
              {filteredHosts.length !== hosts.length && <span>· {t('hosts.headerVisible', { count: filteredHosts.length })}</span>}
              {(hasOperations || hostOpsRefreshError) && <><span aria-hidden="true">·</span><HostOpsRefreshIndicator
                status={hostOpsRefreshStatus}
                lastRefreshedAt={hostOpsLastRefreshedAt}
                error={hostOpsRefreshError}
              /></>}
              <button type="button" onClick={() => void handleRefreshAll()} disabled={hostOpsLoading} data-testid="host-ops-refresh"
                className="inline-flex items-center gap-1 rounded px-1 font-medium text-[var(--workspace-accent-text)] hover:underline disabled:opacity-60">
                <RefreshCw className={cn('h-3.5 w-3.5', hostOpsLoading && 'animate-spin')} />{t('hosts.refreshOps')}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {headerExtraAction}
            {incidents.length > 0 && <Button size="sm" variant="outline" data-testid="host-alerts-open" className="h-9 gap-1.5 border-[color:var(--workspace-status-warn)]/40 bg-[var(--workspace-status-warn-bg)] text-xs text-[color:var(--workspace-status-warn-text)] hover:bg-[var(--workspace-status-warn-bg)]" onClick={() => setPresentation(current => ({ ...current, alerts: true }))}>
              <Bell className="h-3.5 w-3.5" />{presentationCopy.alerts} · {openIncidents} {presentationCopy.open}
            </Button>}
            <button
              type="button"
              onClick={() => setShowSshImport(true)}
              className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] h-9 px-3 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
            >
              <FileDown className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('hosts.importSsh')}</span>
            </button>
            <Button data-tour="host-create" size="sm" onClick={() => setShowAddForm(!showAddForm)} className="h-9 gap-1.5 text-xs bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-400)]">
              <Plus className="h-3.5 w-3.5" /> {t('hosts.addHost')}
              <kbd className="ml-1 hidden rounded border border-current/30 px-1 font-sans text-[10px] opacity-75 sm:inline">⌘N</kbd>
            </Button>
          </div>
        </div>
      <HostKpiRow total={hosts.length} online={statusCounts.online} offline={statusCounts.offline + statusCounts['jump-unavailable']} stale={statusCounts.stale} openAlerts={openIncidents}
        readings={hosts.map(host => { const view = hostOpsViews[host.id]; const resource = view?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource; return { host, cpu: view?.metrics ? view.metrics.cpuPercent : resource?.cpuPercent, disk: view?.metrics ? view.metrics.diskPercent : resource?.diskPercent } })}
        onOpenAlerts={vaultUnlocked ? () => setPresentation(current => ({ ...current, alerts: true })) : undefined} />
      {vaultUnlocked && showMonitoring && <ProbeCoverageBanner hosts={hosts.filter(host => !host.vaultId || host.vaultId === activeVaultId)} osOf={host => (hostOpsViews[host.id]?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource)?.os} />}
        <div data-testid="hosts-toolbar" className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-72">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
              <Input value={effectiveSearch} onChange={(e) => setEffectiveSearch(e.target.value)} placeholder={t('hosts.search')} className="h-10 border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 text-sm text-[var(--workspace-text-strong)] placeholder:text-[var(--workspace-text-subtle)]" />
            </div>
          </div>
            {(hasOperations || statusFilter !== 'all') && <HostStatusSegments value={statusFilter} counts={statusCounts} labels={statusFilterLabels} label={t('hosts.statusFilter')} onChange={setStatusFilter} />}
          <div className="flex-1" />
            {(hasOperations || hasMonitoring || hasAdvancedFilters) && <details className="relative" data-testid="host-view-options">
              <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs font-medium text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]"><SlidersHorizontal className="h-3.5 w-3.5" />{presentationCopy.filters}{groupFilter !== 'All' && <span className="rounded bg-[var(--workspace-accent-subtle)] px-1 text-[10px] text-[var(--workspace-accent-text)]">1</span>}</summary>
              <div className="fixed inset-x-3 bottom-3 z-40 max-h-[75dvh] space-y-3 overflow-y-auto rounded-xl border bg-[var(--workspace-surface-950)] p-4 shadow-xl xl:absolute xl:inset-x-auto xl:bottom-auto xl:right-0 xl:top-full xl:mt-2 xl:w-[38rem]">
                <div className="flex items-center justify-between xl:hidden">
                  <span className="text-sm font-medium">{presentationCopy.filters}</span>
                  <Button size="sm" variant="ghost" aria-label={t('common.close')} onClick={event => event.currentTarget.closest('details')?.removeAttribute('open')}><X className="h-4 w-4" /></Button>
                </div>
                {groupFilterChips}
                {hasMonitoring && <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" data-testid="host-monitoring-summary-toggle" checked={currentPresentation.monitoring} onChange={event => {
                    const monitoring = event.target.checked
                    setPresentation(current => ({ ...current, monitoring }))
                    try { localStorage.setItem(preferenceKey, monitoring ? 'visible' : 'hidden') } catch { /* A display preference may remain session-only. */ }
                  }} />
                  <span>{presentationCopy.monitoring}<span className="mt-1 block text-muted-foreground">{presentationCopy.monitoringHint}</span></span>
                </label>}
                <HostOpsAdvancedFilters value={advancedFilters} onChange={setAdvancedFilters} osOptions={osOptions} providerOptions={providerOptions} />
              </div>
            </details>}
            {!(hasOperations || hasMonitoring || hasAdvancedFilters) && resourceGroups.length > 1 && <details className="relative" data-testid="host-group-options">
              <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs font-medium text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]"><SlidersHorizontal className="h-3.5 w-3.5" />{groupFilter === 'All' ? t('hosts.groupFilter') : (resourceGroups.find(group => group.key === groupFilter)?.label ?? groupFilter)}</summary>
              <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border bg-[var(--workspace-surface-950)] p-3 shadow-xl">{groupFilterChips}</div>
            </details>}
            <div className="relative">
              <button type="button" onClick={() => { setTagFilterOpen((v) => !v); setSortOpen(false) }}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  tagFilter.size > 0 ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
                <Tag className="h-3.5 w-3.5" />
                {tagFilter.size > 0 ? (
                  <>
                    <span className="hidden sm:inline">{tagFilter.size} {t('hosts.tagsSelected')}</span>
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--workspace-accent-muted)] sm:hidden"><span className="text-[10px] text-[var(--workspace-text-strong)]">{tagFilter.size}</span></span>
                  </>
                ) : (
                  <span className="hidden sm:inline">{t('hosts.filterByTag')}</span>
                )}
                <ChevronDown className="h-3 w-3" />
              </button>
              {tagFilterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTagFilterOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-xl">
                    {tagFilter.size > 0 && (
                      <button type="button" onClick={() => { setTagFilter(new Set()); setTagFilterOpen(false) }}
                        className="flex w-full items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]">
                        <X className="h-3 w-3" />{t('hosts.clearTags')}
                      </button>
                    )}
                    <div className="max-h-60 overflow-y-auto p-1">
                      {allExistingTags.length === 0 ? (
                        <p className="px-3 py-3 text-center text-xs text-[var(--workspace-text-muted)]">{t('hosts.noTags')}</p>
                      ) : allExistingTags.map((tg) => {
                        const active = tagFilter.has(tg)
                        return (
                          <button key={tg} type="button"
                            onClick={() => setTagFilter((prev) => { const next = new Set(prev); if (active) next.delete(tg); else next.add(tg); return next })}
                            className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                              active ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]')}>
                            <span className={cn('flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                              active ? 'border-[color:var(--workspace-accent-solid)] bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)]' : 'border-[color:var(--workspace-border-soft)]')}>
                              {active && '✓'}
                            </span>
                            <span className="flex-1 text-left truncate">{tg}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button type="button" onClick={() => { setSortOpen((v) => !v); setTagFilterOpen(false) }}
                className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]">
                {sortMode === 'az' && <ArrowDownAZ className="h-3.5 w-3.5" />}
                {sortMode === 'za' && <ArrowUpZA className="h-3.5 w-3.5" />}
                {sortMode === 'newest' && <CalendarArrowDown className="h-3.5 w-3.5" />}
                {sortMode === 'oldest' && <CalendarArrowUp className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">{t(`hosts.sort.${sortMode}`)}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-xl">
                    {([['az', ArrowDownAZ], ['za', ArrowUpZA], ['newest', CalendarArrowDown], ['oldest', CalendarArrowUp]] as const).map(([mode, Icon]) => (
                      <button key={mode} type="button" onClick={() => handleSortChange(mode)}
                        className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                          sortMode === mode ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]')}>
                        <Icon className="h-4 w-4" />
                        <span className="flex-1 text-left">{t(`hosts.sort.${mode}`)}</span>
                        {sortMode === mode && <span className="text-[color:var(--workspace-accent-solid)]">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {hosts.length > 1 && <Button size="sm" variant="outline" data-testid="host-batch-select" className="h-8 text-xs" disabled={batchBusy} onClick={() => setPresentation(current => ({ ...current, batch: !current.batch, selected: [] }))}>
              {currentPresentation.batch ? presentationCopy.done : presentationCopy.batch}
            </Button>}
            {onScanHosts && filteredHosts.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => void handleCheckAllStatus()} disabled={checkingStatus} className="h-9 gap-1.5 text-xs">
                <RefreshCw className={cn('h-3.5 w-3.5', checkingStatus && 'animate-spin')} />
                {checkingStatus ? t('hosts.checking') : t('hosts.checkStatus')}
              </Button>
            )}
            <div data-testid="host-view-toggle" className="flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-0.5">
              <button type="button" onClick={() => setViewMode('grid')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'grid' ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')} title={t('hosts.gridView')}>
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setViewMode('list')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'list' ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')} title={t('hosts.listView')}>
                <List className="h-4 w-4" />
              </button>
            </div>
        </div>
          {currentPresentation.batch && selectedBatchIds.length > 0 && <HostBatchFloatingBar key={`bar:${presentationOwner}`} hosts={filteredHosts.filter(host => selectedBatchIds.includes(host.id))}
            onOperation={operation => { setBatchOperation(operation); requestAnimationFrame(() => batchPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })) }}
            onExit={() => setPresentation(current => ({ ...current, batch: false, selected: [] }))}
            onMoveToVault={canMoveHosts ? () => openHostMove(filteredHosts.filter(host => selectedBatchIds.includes(host.id))) : undefined} />}
          {moveRequest && moveRequest.vaultId === activeVaultId && <HostMoveDialog open sourceVaultId={moveRequest.vaultId} vaults={vaults} hosts={moveRequest.hosts}
            onOpenChange={open => { if (!open) setMoveRequest(null) }} onMoved={handleHostsMoved} />}
          {probeInstallHost && <ProbeInstallDialog host={hosts.find(host => host.id === probeInstallHost.id) ?? probeInstallHost} open onOpenChange={open => { if (!open) setProbeInstallHost(null) }} />}
          <KomariAlertsDashboardPanel headless onAdditionalIncidents={receiveIntegrationIncidents} activeVaultId={activeVaultId} vaultUnlocked={vaultUnlocked} hosts={hosts} />
          <Dialog labelledBy="host-alerts-title" open={currentPresentation.alerts && vaultUnlocked} onOpenChange={alerts => setPresentation(current => ({ ...current, alerts }))}>
            <DialogContent className="w-full max-w-3xl p-5 md:w-full md:max-w-3xl">
              <Button variant="ghost" size="sm" className="absolute right-3 top-3" aria-label={t('common.close')} onClick={() => setPresentation(current => ({ ...current, alerts: false }))}><X className="h-4 w-4" /></Button>
              <HostAlertsCenter key={presentationOwner} incidents={incidents} onOpenHost={hostId => {
                setPresentation(current => ({ ...current, alerts: false }))
                onSelectHost(hostId); onOpenWorkspace?.(hostId, 'overview')
              }} />
            </DialogContent>
          </Dialog>
          <HostCreateDialog vaultId={activeVaultId} availableHosts={hosts}
            open={showAddForm}
            defaultUsername={defaultUsername}
            vaultKeys={vaultKeys}
            vaultUnlocked={vaultUnlocked}
            onSaveToVault={onSaveToVault}
            onLoadVaultSecret={onLoadVaultSecret}
            vaultName={vaultName}
            existingGroups={allExistingGroups}
            existingTags={allExistingTags}
            onSubmit={async (draft, options) => { const created = await onCreateHost(draft); setShowAddForm(false); onAddFormClose?.(); if (options?.installProbe && created) setProbeInstallHost(created) }}
            onCancel={() => { setShowAddForm(false); onAddFormClose?.() }}
          />

          <HostEditorDialog availableHosts={hosts.filter((host) => host.id !== editingHost?.id)}
            host={editingHost}
            defaultUsername={defaultUsername}
            vaultKeys={vaultKeys}
            vaultUnlocked={vaultUnlocked}
            onSaveToVault={onSaveToVault}
            onLoadVaultSecret={onLoadVaultSecret}
            vaultName={vaultName}
            existingGroups={allExistingGroups}
            existingTags={allExistingTags}
            onSubmit={async (host, draft) => { await onUpdateHost(host, draft); setEditingHost(null) }}
            onCancel={() => setEditingHost(null)}
          />

        <PullToRefresh onRefresh={handleRefreshAll} className="min-w-0 overflow-visible pb-6">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <RefreshCw className="h-8 w-8 animate-spin text-[var(--workspace-text-subtle)]" />
                <p className="mt-3 text-sm text-[var(--workspace-text-muted)]">{t('hosts.loading')}</p>
              </div>
            ) : filteredHosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--workspace-surface-700)]">
                  <Server className="h-8 w-8 text-[var(--workspace-text-subtle)]" />
                </div>
                <p className="text-sm font-medium text-[var(--workspace-text-strong)]">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatch') : t('hosts.noHosts')}
                </p>
                <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatchHint') : t('hosts.noHostsHint')}
                </p>
                {!effectiveSearch.trim() && groupFilter === 'All' && (
                  <Button className="mt-5 gap-1.5 bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-400)]" onClick={() => setShowAddForm(true)}><Plus className="h-4 w-4" /> {t('hosts.addHost')}</Button>
                )}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="space-y-6">
                {HOST_BUCKETS.map((bucket) => {
                  const members = filteredHosts.filter((host) => bucketOf(host) === bucket)
                  if (!members.length) return null
                  return <section key={bucket} data-testid={`host-bucket-${bucket}`} aria-label={t(`hosts.bucket.${bucket}`)} className="space-y-3">
                    <h3 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--workspace-text-muted)]">
                      <span className={cn('h-2 w-2 rounded-full', bucket === 'attention' ? 'bg-[var(--workspace-status-warn)]' : bucket === 'normal' ? 'bg-[var(--workspace-status-good)]' : 'bg-[var(--workspace-text-subtle)]')} />
                      <span className="text-[var(--workspace-text-strong)]">{t(`hosts.bucket.${bucket}`)}</span>
                      <span className="rounded-full bg-[var(--workspace-surface-700)] px-1.5 text-[11px] font-medium tabular-nums">{members.length}</span>
                      <span className="text-xs font-normal text-[var(--workspace-text-subtle)]">{t(`hosts.bucket.${bucket}Hint`)}</span>
                      <span className="h-px flex-1 bg-[color:var(--workspace-border-soft)]" />
                    </h3>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {members.map((host) => (
                  <HostGridCard
                    key={`${presentationOwner}:${host.id}`}
                    host={host}
                    isSelected={selectedHostId === host.id}
                    status={displayStatus(host)}
                    monitoring={showMonitoring}
                    batchSelection={batchSelection(host)}
                    resource={hostOpsViews[host.id]?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource}
                    metrics={hostOpsViews[host.id]?.metrics ?? undefined}
                    operations={operationalSummaryByHost.get(host.id)}
                    network={networkByAddress[host.address]}
                    agentDeploymentCount={agentDeploymentsByHost.get(host.id)?.length ?? 0}
                    agentDeploymentStatus={agentDeploymentsByHost.get(host.id)?.[0]?.status}
                    onConnect={handleConnect}
                    onOpenWorkspace={onOpenWorkspace}
                    onRefresh={onScanHosts ? handleRefreshHost : undefined}
                    onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                    onDelete={(id) => void onDeleteHost(id)}
                    onMoveToVault={canMoveHosts ? (id) => openHostMove(hosts.filter(host => host.id === id)) : undefined}
                    onSelect={onSelectHost}
                  />
                ))}
                    </div>
                  </section>
                })}
              </div>
            ) : (
              <div className="sb-card min-w-0 overflow-hidden">
                {(statusFilter !== 'all' || tagFilter.size > 0 || groupFilter !== 'All') && <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                  <span className="text-xs text-[var(--workspace-text-muted)]">{t('hosts.listPanelMeta', { visible: filteredHosts.length, total: hosts.length })}</span>
                  <div className="flex flex-wrap gap-2">
                    {statusFilter !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-accent-muted)]"
                      >
                        <X className="h-3 w-3" />
                        {statusFilterLabels[statusFilter]}
                      </button>
                    )}
                    {tagFilter.size > 0 && (
                      <span className="rounded-full border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-accent-text)]">
                        {tagFilter.size} {t('hosts.tagsSelected')}
                      </span>
                    )}
                    {groupFilter !== 'All' && (
                      <span className="rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-text-muted)]">
                        {t(`group.${groupFilter}`) !== `group.${groupFilter}` ? t(`group.${groupFilter}`) : groupFilter}
                      </span>
                    )}
                  </div>
                </div>}
                <HostListScrollArea monitoring={showMonitoring} resources={showResources}>
                    <div data-testid="host-list-header" data-monitoring={showMonitoring} className={cn("hidden border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]/60 px-4 py-2.5 text-xs font-medium text-[var(--workspace-text-subtle)] xl:grid xl:items-center", showMonitoring ? HOST_LIST_COLUMNS : showResources ? HOST_RESOURCE_COLUMNS : HOST_CONNECTION_COLUMNS)}>
                      <span>{currentPresentation.batch ? <input type="checkbox" data-testid="host-select-all" aria-label={presentationCopy.selectAll} disabled={batchBusy || !batchEligible.length}
                        checked={batchEligible.length > 0 && selectedBatchIds.length === Math.min(batchEligible.length, MAX_BATCH_HOSTS)}
                        onChange={event => { const all = event.target.checked; setPresentation(current => current.owner !== presentationOwner || batchBusy ? current : { ...current, selected: all ? batchEligible.slice(0, MAX_BATCH_HOSTS).map(host => host.id) : [] }) }} /> : t('hosts.columnIndex')}</span>
                      <span>{t('hosts.columnHost')}</span>
                      <span>{t('hosts.columnLocation')}</span>
                      <span>{t('hosts.columnIp')}</span>
                      {showMonitoring && <span>{t('hosts.columnUpdated')}</span>}
                      {showResources && <span>{t('hosts.columnResource')}</span>}
                      {showMonitoring && <span>{t('hosts.columnOperations')}</span>}
                      <span>{t('hosts.columnStatus')}</span>
                      <span className="text-right">{t('hosts.columnActions')}</span>
                    </div>
                    <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                      {filteredHosts.map((host, index) => (
                        <HostListItem
                          key={`${presentationOwner}:${host.id}`}
                          index={index + 1}
                          host={host}
                          isSelected={selectedHostId === host.id}
                          status={displayStatus(host)}
                          resources={showResources}
                          monitoring={showMonitoring}
                          batchSelection={batchSelection(host)}
                          resource={hostOpsViews[host.id]?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource}
                          metrics={hostOpsViews[host.id]?.metrics ?? undefined}
                          operations={operationalSummaryByHost.get(host.id)}
                          network={networkByAddress[host.address]}
                          agentDeploymentCount={agentDeploymentsByHost.get(host.id)?.length ?? 0}
                          agentDeploymentStatus={agentDeploymentsByHost.get(host.id)?.[0]?.status}
                          onSelect={onSelectHost}
                          onConnect={handleConnect}
                          onOpenWorkspace={onOpenWorkspace}
                          onRefresh={onScanHosts ? handleRefreshHost : undefined}
                          onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                          onDelete={(id) => void onDeleteHost(id)}
                          onMoveToVault={canMoveHosts ? (id) => openHostMove(hosts.filter(host => host.id === id)) : undefined}
                        />
                      ))}
                    </div>
                </HostListScrollArea>
              </div>
            )}
        </PullToRefresh>
          {currentPresentation.batch && selectedBatchIds.length > 0 && <div ref={batchPanelRef} className="mt-4 pb-20"><MultiHostOperationsPanel
            key={`${presentationOwner}:${selectedBatchIds.join(',')}:${batchOperation}`} hosts={filteredHosts.filter(host => selectedBatchIds.includes(host.id))}
            initialSelectedHostIds={selectedBatchIds} selectionFromList initialOperation={batchOperation}
            onRunOperation={async request => { setBatchBusy(true); try { return await handleMultiHostOperation(request) } finally { setBatchBusy(false) } }}
          /></div>}
      </div>

        {showSshImport && (
          <SshImportDialog
            onClose={() => setShowSshImport(false)}
            onImported={() => { setShowSshImport(false); onRefreshHosts?.() }}
          />
        )}
    </div>
  )
}

const groupColors = [
  'bg-[color:var(--workspace-primary-500)]',
  'bg-[color:var(--workspace-status-good)]',
  'bg-[color:var(--workspace-status-info)]',
  'bg-[color:var(--workspace-status-warn)]',
  'bg-[color:var(--workspace-group-staging)]',
  'bg-[color:var(--workspace-status-bad)]',
  'bg-[color:var(--workspace-metric-network-from)]',
  'bg-[color:var(--workspace-group-default)]',
]
