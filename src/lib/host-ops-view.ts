import { groupKomariAlertIncidents } from './komari-alert-incidents'
import { observationVaultIds, scopeObservationHosts } from './host-observation-scope'
import { hydrateLocalOpsHost } from './local-ops-persistence'
import type { HostProfile } from './hosts'
import { getHostIdentity } from './host-identity'
import {
  getServerMonitorHostKey,
  listServerMonitorLatest,
  type ServerMonitorLatest,
  type ServerMonitorSnapshot,
  type ServerMonitorStatus,
} from './server-monitor'
import {
  loadWorkspaceInventoryHostStateSnapshots,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
  type WorkspaceInventoryCache,
  type WorkspaceInventoryHostStateSnapshot,
  type WorkspaceInventoryResource,
} from './workspace-inventory'
import { listOperationAudit, type OperationAuditEntry } from './operation-job'
import { operationTransport } from './operation-job'
import { refreshProbeSnapshotFreshness } from './probe-scheduler'
import type { ProbeProviderTelemetry, ProbeSnapshot } from './probe-provider'
import { listPersistedProbeSnapshots, type PersistedProbeSnapshotRecord } from './probe-persistence'
import type { KomariAlertSummary } from './komari'
import type { KomariAlertAuditEntry, KomariAlertRecord, KomariAlertState } from './komari-alerts'
import type { ShellbeamAgentRecord } from './shellbeam-agent'
import { PROBE_ALERT_EVALUATION_FRESHNESS_MS, type LocalAlertEvaluation, type LocalAlertRecord, type LocalAlertState } from './local-alert-rules'
import { loadLocalAlertState } from './local-ops-store'
import type { NotificationSeverity } from './notification-policy'
import { listShellbeamAgents } from './shellbeam-agent'
import { isCurrentKomariAlert, isCurrentKomariSnapshot, loadCurrentKomariSources, type CurrentKomariSource } from './komari-source-eligibility'

export type OperationTransport = ReturnType<typeof operationTransport>

/**
 * The state shown by the host-list operations view.  Values stay nullable when
 * no probe has produced them; a missing inventory must not look like a healthy
 * host with zero services or processes.
 */
export type HostOpsHealthState = ServerMonitorStatus | 'checking' | 'unknown' | 'jump-unavailable'
export type HostOpsProvider = 'ssh-agentless' | 'komari' | 'shellbeam-agent' | 'unknown'

export interface HostOpsRoute {
  transport: OperationTransport
  jumpHost?: string
  jumpHostName?: string
  jumpPort?: number
  jumpUser?: string
}

export interface HostOpsServiceSummary {
  available: boolean
  total: number | null
  active: number | null
  failed: number | null
  inactive: number | null
  enabled: number | null
  updatedAt: number | null
}

export interface HostOpsProcessSummary {
  available: boolean
  /** Number of process entries available from the inventory probe (PM2 today). */
  total: number | null
  pm2: number | null
  updatedAt: number | null
}

export type HostOpsCapability = 'files' | 'processes' | 'services' | 'logs' | 'docker' | 'port-checks' | 'metrics'

export interface HostOpsFreshness {
  sampledAt: number | null
  updatedAt: number | null
  ageMs: number | null
  stale: boolean
  ttlMs?: number | null
  expiresAt?: number | null
  expiryReason?: 'ttl-expired' | null
}

export interface HostOpsOperationSummary {
  total: number
  active: number
  failed: number
  unknown: number
  latestStatus: OperationAuditEntry['status'] | null
  latestAt: number | null
}

export type HostOpsProbeState = 'fresh' | 'stale' | 'recovered' | 'error' | 'unknown'

export interface HostOpsProbeStatus {
  state: HostOpsProbeState
  providerKind: string
  providerId: string
  nodeId?: string
  sampledAt: number | null
  receivedAt: number | null
  persisted: boolean
  telemetry?: ProbeProviderTelemetry | null
  error?: string
}

export interface HostOpsHealth {
  state: HostOpsHealthState
  provider: HostOpsProvider
  transport: OperationTransport
  freshness: HostOpsFreshness
  error?: string
  lastSuccessAt?: number | null
  fallbackProvider?: HostOpsProvider
  fallbackReason?: string
  alertSummary?: KomariAlertSummary | null
  /** Local Komari lifecycle counts are kept beside the provider aggregate.
   * The provider's active count can remain non-zero after a local
   * acknowledge/close, so collapsing these values would make the host card
   * look stale after an MCP action. */
  alertLifecycle?: HostOpsAlertLifecycleSummary | null
  agent?: Pick<ShellbeamAgentRecord, 'status' | 'health' | 'version' | 'capabilities' | 'lastHeartbeatAt' | 'lastCheckedAt'> | null
  /** Durable ProbeProvider state rendered beside the selected health source. */
  probe?: HostOpsProbeStatus | null
}

export interface HostOpsAlertLifecycleSummary {
  total: number
  open: number
  active: number
  acknowledged: number
  resolved: number
  closed: number
  latestOperationJobId: string | null
}

export interface HostOpsProbeEvaluation {
  ruleId: string
  section: 'metrics' | 'inventory'
  state: LocalAlertEvaluation['state']
  /** Original collection sample, never a journal update or cache receipt time. */
  sampledAt: number | null
}

export function validHostOpsSampleTime(value: unknown, now = Date.now()): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now && value <= 8_640_000_000_000_000 ? value : undefined
}

/** Only canonical built-in SSH collection evaluations belong in this view.
 * The journal's live state can outlast its evidence while the dashboard is open. */
export function hostProbeEvaluations(evaluations: ReadonlyArray<Pick<LocalAlertEvaluation, 'ruleId' | 'state'> & { sampledAt?: number | null }>, now = Date.now()): HostOpsProbeEvaluation[] {
  return evaluations.flatMap((evaluation) => {
    const section = /^probe:ssh-agentless:[a-f0-9]{32}:(metrics|inventory)$/.exec(evaluation.ruleId)?.[1]
    if (section !== 'metrics' && section !== 'inventory') return []
    const sampledAt = validHostOpsSampleTime(evaluation.sampledAt, now) ?? null
    const state = evaluation.state === 'disabled' ? 'disabled' : sampledAt !== null && now - sampledAt <= PROBE_ALERT_EVALUATION_FRESHNESS_MS ? evaluation.state : 'unknown'
    return [{ ruleId: evaluation.ruleId, section, sampledAt, state }]
  })
}

export interface HostOpsView {
  host: HostProfile
  hostKey: string
  route: HostOpsRoute
  health: HostOpsHealth
  resource: WorkspaceInventoryResource | null
  metrics: ServerMonitorSnapshot | null
  inventory: WorkspaceInventory | null
  serviceSummary: HostOpsServiceSummary
  processSummary: HostOpsProcessSummary
  operationSummary: HostOpsOperationSummary
  audits: OperationAuditEntry[]
  latestAudit: OperationAuditEntry | null
  /** Host-scoped lifecycle rows used by the inline Komari alert actions. */
  komariAlerts: KomariAlertRecord[]
  komariAlertAudits: KomariAlertAuditEntry[]
  localAlerts?: LocalAlertRecord[]
  localAlertEvaluations?: HostOpsProbeEvaluation[]
  localAlertOpen?: number
  highestAlertSeverity?: NotificationSeverity | null
  alertOpenCount?: number | null
  capabilities?: HostOpsCapability[]
}

export interface BuildHostOpsViewsInput {
  hosts: HostProfile[]
  monitorLatest?: ServerMonitorLatest[]
  inventoryCache?: WorkspaceInventoryCache
  inventoryStates?: Record<string, WorkspaceInventoryHostStateSnapshot>
  audits?: OperationAuditEntry[]
  komariSnapshots?: ProbeSnapshot[]
  /** Generic ProbeProvider rows hydrated from the vault-scoped local cache. */
  probeSnapshots?: ProbeSnapshot[]
  komariAlertStates?: KomariAlertState[]
  /** Supplied by persisted readers; omitted only for already scoped projections. */
  komariSources?: readonly CurrentKomariSource[]
  shellbeamAgents?: ShellbeamAgentRecord[]
  localAlertStates?: Record<string, LocalAlertState>
  now?: number
  staleAfterMs?: number
}

/** Optional monitoring must not manufacture an operations panel for a new host. */
export function hasHostOpsEvidence(view: HostOpsView | null | undefined): boolean {
  if (!view) return false
  const probe = view.health.probe
  const agent = view.health.agent
  const observedProbe = probe && (probe.state !== 'unknown' || probe.sampledAt || probe.error || probe.telemetry)
  const configuredAgent = agent && !['not-installed', 'unknown', 'retired'].includes(agent.status)
  return Boolean(view.resource || view.metrics || view.inventory || observedProbe || configuredAgent
    || view.health.error || (view.health.state !== 'unknown' && view.health.state !== 'checking')
    || view.audits.length || view.komariAlertAudits.length || view.komariAlerts.length || view.localAlerts?.length
    || (view.alertOpenCount ?? 0) > 0 || view.localAlertEvaluations?.some((evaluation) => evaluation.sampledAt !== null))
}

function isActive(value: string) {
  return value === 'active' || value === 'running'
}

function isFailed(value: string) {
  return value === 'failed' || value === 'failure'
}

function isInactive(value: string) {
  return value === 'inactive' || value === 'dead' || value === 'exited'
}

function isEnabled(value: string) {
  return value === 'enabled' || value === 'static' || value === 'indirect'
}

function serviceSummary(inventory: WorkspaceInventory | null, updatedAt: number | null): HostOpsServiceSummary {
  if (!inventory) {
    return { available: false, total: null, active: null, failed: null, inactive: null, enabled: null, updatedAt }
  }
  const services = inventory.services ?? []
  return {
    available: true,
    total: services.length,
    active: services.filter((service) => isActive(service.active)).length,
    failed: services.filter((service) => isFailed(service.active)).length,
    inactive: services.filter((service) => isInactive(service.active)).length,
    enabled: services.filter((service) => isEnabled(service.enabled)).length,
    updatedAt,
  }
}

function processSummary(inventory: WorkspaceInventory | null, updatedAt: number | null): HostOpsProcessSummary {
  if (!inventory) return { available: false, total: null, pm2: null, updatedAt }
  const pm2 = Array.isArray(inventory.pm2) ? inventory.pm2.length : 0
  return { available: true, total: pm2, pm2, updatedAt }
}

function freshness(
  monitor: ServerMonitorLatest | undefined,
  inventory: WorkspaceInventory | null,
  inventoryUpdatedAt: number | null,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  now: number,
  staleAfterMs: number,
): HostOpsFreshness {
  // Once metrics are selected, only their own sample can establish age.
  // An inventory refresh or a newer failed attempt is not a new metric sample.
  const sampledCandidates = (monitor?.snapshot ? [monitor.snapshot.sampledAt] : [
    inventory?.scannedAt,
    monitor?.lastSuccessAt ?? undefined,
    state?.updatedAt,
  ]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now)
  const sampledAt = sampledCandidates.length > 0 ? Math.max(...sampledCandidates) : null
  const updatedAt = monitor?.snapshot ? monitor.updatedAt || null : Math.max(
    monitor?.updatedAt ?? 0,
    inventoryUpdatedAt ?? 0,
    state?.updatedAt ?? 0,
  ) || null
  const ageMs = sampledAt === null ? null : Math.max(0, now - sampledAt)
  return {
    sampledAt,
    updatedAt,
    ageMs,
    stale: ageMs !== null && ageMs > staleAfterMs,
    ttlMs: sampledAt === null ? null : staleAfterMs,
    expiresAt: sampledAt === null ? null : sampledAt + staleAfterMs,
    expiryReason: ageMs !== null && ageMs > staleAfterMs ? 'ttl-expired' : null,
  }
}

/** Structured route errors take precedence over the legacy message matcher.
 * In particular a target host-key/auth failure must not be blamed on its jump. */
export function hostOpsConnectionFailureStage(value: unknown): 'jump' | 'target' | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const offset = value.indexOf('{')
  if (offset >= 0) {
    try {
      const raw = JSON.parse(value.slice(offset)) as Record<string, unknown>
      if (raw.routeStage === 'jump' || raw.source === 'jump') return 'jump'
      if (raw.routeStage === 'target' || raw.source === 'target') return 'target'
      if (typeof raw.code === 'string') {
        if (/^jump_/.test(raw.code)) return 'jump'
        if (/^target_|^host_key_/.test(raw.code)) return 'target'
      }
    } catch { /* older provider errors remain readable text */ }
  }
  return /proxy[ -]?jump|jump host|jump tunnel|bastion|ssh jump [a-z_]+/i.test(value) ? 'jump' : null
}
function observedCapabilities(inventory: WorkspaceInventory | null, snapshot: ProbeSnapshot | undefined, hasSsh: boolean, linuxSsh: boolean): HostOpsCapability[] {
  const result = new Set<HostOpsCapability>()
  for (const capability of snapshot?.provider.capabilities ?? []) if (['metrics', 'processes', 'services', 'logs'].includes(capability)) result.add(capability as HostOpsCapability)
  if (hasSsh) result.add('files')
  if (linuxSsh) for (const capability of ['processes', 'logs', 'port-checks', 'metrics'] as const) result.add(capability)
  if (inventory?.services.length || inventory?.tools.some((tool) => tool.binary === 'systemctl')) result.add('services')
  if (inventory?.containers.length || inventory?.tools.some((tool) => tool.binary === 'docker' || tool.id === 'docker')) result.add('docker')
  return [...result].sort()
}

function healthState(
  monitor: ServerMonitorLatest | undefined,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  freshnessValue: HostOpsFreshness,
  probeSnapshot?: ProbeSnapshot,
): HostOpsHealthState {
  const stages = [monitor?.error, state?.error, ...(probeSnapshot?.errors.map((error) => error.message) ?? [])].map(hostOpsConnectionFailureStage)
  const jumpUnavailable = stages.includes('jump') && !stages.includes('target')
  if (probeSnapshot && (!monitor || probeSnapshot.receivedAt >= monitor.updatedAt)) {
    if (probeSnapshot.health === 'unsupported') return 'unsupported'
    if (probeSnapshot.telemetry?.status === 'failed' || probeSnapshot.health === 'offline') return jumpUnavailable ? 'jump-unavailable' : 'offline'
    if (probeSnapshot.health === 'unknown') return 'unknown'
    if (probeSnapshot.health === 'paused') return 'paused'
    if (probeSnapshot.telemetry?.status === 'recovered' || probeSnapshot.health === 'stale') return jumpUnavailable ? 'jump-unavailable' : 'stale'
  }
  if (monitor?.status) {
    if (monitor.status === 'checking') return 'checking'
    if ((monitor.status === 'offline' || monitor.status === 'stale') && jumpUnavailable) return 'jump-unavailable'
    if (monitor.status === 'online' && freshnessValue.sampledAt === null) return 'unknown'
    if (monitor.status === 'online' && freshnessValue.stale) return 'stale'
    return monitor.status
  }
  if (state?.status === 'unsupported') return 'unsupported'
  if (state?.status === 'error') return jumpUnavailable ? 'jump-unavailable' : 'offline'
  if (state?.status === 'ready') return freshnessValue.stale ? 'stale' : 'online'
  if (probeSnapshot) {
    if (probeSnapshot.health === 'offline') return jumpUnavailable ? 'jump-unavailable' : 'offline'
    if (probeSnapshot.health === 'stale' || freshnessValue.stale) return 'stale'
    if (probeSnapshot.health === 'online') return 'online'
  }
  return 'unknown'
}

function providerFor(
  monitor: ServerMonitorLatest | undefined,
  inventory: WorkspaceInventory | null,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  audits: OperationAuditEntry[],
  shellbeamAgent?: ShellbeamAgentRecord,
  probeSnapshot?: ProbeSnapshot,
): HostOpsProvider {
  // Persisted monitor/inventory records currently come from the built-in
  // ProbeProvider. Keep this mapping in one place so Komari can be added
  // without changing the host-list data contract.
  if (monitor || inventory || state) return 'ssh-agentless'
  const auditedProvider = audits.find((audit) => audit.provider)?.provider
  if (auditedProvider === 'ssh-agentless' || auditedProvider === 'shellbeam-agent') {
    return auditedProvider
  }
  if (shellbeamAgent) return 'shellbeam-agent'
  if (probeSnapshot?.provider.kind === 'ssh-agentless' || probeSnapshot?.provider.kind === 'komari' || probeSnapshot?.provider.kind === 'shellbeam-agent') return probeSnapshot.provider.kind
  return 'unknown'
}

function komariMonitorForHost(host: HostProfile, snapshot: ProbeSnapshot | undefined): ServerMonitorLatest | undefined {
  const observation = snapshot?.metrics
  if (!observation) return undefined
  const status: ServerMonitorStatus = snapshot.telemetry?.status === 'failed' ? 'offline'
    : snapshot.telemetry?.status === 'recovered' ? 'stale'
      : snapshot.health === 'unknown' ? 'checking'
        : snapshot.health
  return {
    hostKey: getServerMonitorHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port,
    status,
    snapshot: observation.data,
    lastAttemptAt: snapshot.receivedAt,
    lastSuccessAt: observation.freshness.sampledAt,
    error: snapshot.errors[0]?.message,
    probeTelemetry: snapshot.telemetry ?? null,
    updatedAt: snapshot.receivedAt,
  }
}

function komariAlertStateForHost(
  host: HostProfile,
  snapshots: ProbeSnapshot[],
  states: KomariAlertState[],
  sources?: readonly CurrentKomariSource[],
): { summary: HostOpsAlertLifecycleSummary; alerts: KomariAlertRecord[]; audits: KomariAlertAuditEntry[] } | null {
  const providerNodes = snapshots
    .filter((snapshot) => snapshot.host.hostId === host.id)
    .map((snapshot) => snapshot.provider.nodeId
      ? { integrationId: snapshot.provider.id, nodeId: snapshot.provider.nodeId }
      : null)
    .filter((value): value is { integrationId: string; nodeId: string } => value !== null)
  const alerts = states
    .flatMap((state) => state.alerts)
    .filter((alert) => alert.hostId === host.id || providerNodes.some((provider) => provider.integrationId === alert.integrationId && provider.nodeId === alert.nodeId))
    .filter((alert) => !sources || isCurrentKomariAlert(alert, host, sources, snapshots))
  if (alerts.length === 0) return null
  const incidents = groupKomariAlertIncidents(alerts).map((incident) => incident.alert)
  const alertIds = new Set(alerts.map((alert) => alert.alertId))
  const audits = states
    .flatMap((state) => state.audit)
    .filter((entry) => alertIds.has(entry.alertId))
    .sort((left, right) => right.at - left.at)
  const latestOperationJobId = states
    .flatMap((state) => state.audit)
    .filter((entry) => alertIds.has(entry.alertId) && entry.operationJobId)
    .sort((left, right) => right.at - left.at)[0]?.operationJobId ?? null
  return {
    summary: {
      total: incidents.length,
      open: incidents.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged').length,
      active: incidents.filter((alert) => alert.status === 'active').length,
      acknowledged: incidents.filter((alert) => alert.status === 'acknowledged').length,
      resolved: incidents.filter((alert) => alert.status === 'resolved').length,
      closed: incidents.filter((alert) => alert.status === 'closed').length,
      latestOperationJobId,
    },
    alerts: [...alerts].sort((left, right) => right.lastSeenAt - left.lastSeenAt),
    audits,
  }
}

function probeStatus(
  snapshot: ProbeSnapshot | undefined,
  persisted = false,
  monitor?: ServerMonitorLatest,
): HostOpsProbeStatus | null {
  // The monitor scan and Workspace can have a fresh in-memory scheduler row
  // before the durable ProbeSnapshot write completes. Keep that telemetry
  // visible in the same session instead of making the host card look blind.
  const monitorTelemetry = monitor?.probeTelemetry ?? null
  if (!snapshot && !monitorTelemetry) return null
  const observation = snapshot?.metrics ?? snapshot?.inventory
  const sampledAt = observation?.freshness.sampledAt ?? monitor?.snapshot?.sampledAt ?? null
  const receivedAt = snapshot?.receivedAt || observation?.freshness.receivedAt || monitor?.updatedAt || null
  const candidateTelemetry = snapshot?.telemetry ?? (!snapshot || snapshot.provider.kind === 'ssh-agentless' ? monitorTelemetry : null)
  const telemetry = monitor?.snapshot && !candidateTelemetry?.sections.includes('metrics') ? null : candidateTelemetry
  const hasRecovery = Boolean(snapshot?.errors.some((error) => error.code === 'stale-cache-fallback')) || telemetry?.status === 'recovered' || telemetry?.recovered === true
  const hasError = Boolean(snapshot?.errors.length) || telemetry?.status === 'failed'
  const state: HostOpsProbeState = hasRecovery
    ? 'recovered'
    : snapshot?.health === 'stale' || Boolean(observation?.freshness.expired) || monitor?.status === 'stale'
      ? 'stale'
      : snapshot?.health === 'offline' || monitor?.status === 'offline' || hasError
        ? 'error'
        : snapshot?.health === 'online' || monitor?.status === 'online'
          ? 'fresh'
          : 'unknown'
  return {
    state,
    providerKind: snapshot?.provider.kind ?? 'ssh-agentless',
    providerId: snapshot?.provider.id ?? 'ssh-agentless',
    ...(snapshot?.provider.nodeId ? { nodeId: snapshot.provider.nodeId } : {}),
    sampledAt,
    receivedAt,
    persisted,
    telemetry,
    ...(snapshot?.errors[0]?.message || monitor?.error ? { error: snapshot?.errors[0]?.message ?? monitor?.error } : {}),
  }
}

function snapshotKey(snapshot: ProbeSnapshot) {
  return `${snapshot.provider.kind}:${snapshot.provider.id}:${snapshot.host.hostId}`
}

function freshestSnapshot(current: ProbeSnapshot | undefined, candidate: ProbeSnapshot) {
  if (!current) return candidate
  return (candidate.receivedAt || 0) >= (current.receivedAt || 0) ? candidate : current
}

/** A platform rejection in one collector cannot hide a current observation
 * supplied by another provider for the same host. */
function preferredHostProbe(current: ProbeSnapshot | undefined, candidate: ProbeSnapshot) {
  if (!current) return candidate
  const freshMetrics = (snapshot: ProbeSnapshot) => snapshot.health === 'online' && snapshot.telemetry?.status !== 'failed' && snapshot.telemetry?.status !== 'recovered' && snapshot.metrics && !snapshot.metrics.freshness.expired
  if (!freshMetrics(current) && freshMetrics(candidate)) return candidate
  if (!freshMetrics(candidate) && freshMetrics(current)) return current
  return freshestSnapshot(current, candidate)
}

const auditStatusRank = (status: OperationAuditEntry['status']) => status === 'queued' ? 0 : status === 'running' ? 1 : 2
const compareAudits = (left: OperationAuditEntry, right: OperationAuditEntry) => right.createdAt - left.createdAt || auditStatusRank(right.status) - auditStatusRank(left.status)

function operationSummary(audits: OperationAuditEntry[]): HostOpsOperationSummary {
  // Audit events are immutable transitions; counts describe current jobs.
  const latest = new Map<string, OperationAuditEntry>()
  for (const audit of audits) {
    const previous = latest.get(audit.jobId)
    if (!previous || audit.createdAt > previous.createdAt || (audit.createdAt === previous.createdAt && auditStatusRank(audit.status) > auditStatusRank(previous.status))) latest.set(audit.jobId, audit)
  }
  audits = [...latest.values()].sort(compareAudits)
  return {
    total: audits.length,
    active: audits.filter((audit) => audit.status === 'queued' || audit.status === 'running').length,
    failed: audits.filter((audit) => audit.status === 'failed').length,
    unknown: audits.filter((audit) => audit.status === 'unknown').length,
    latestStatus: audits[0]?.status ?? null,
    latestAt: audits[0]?.createdAt ?? null,
  }
}

/** Build deterministic per-host operations data from persisted probe records. */
export function buildHostOpsViews({
  hosts,
  monitorLatest = [],
  inventoryCache = {},
  inventoryStates = {},
  audits = [],
  komariSnapshots = [],
  probeSnapshots = [],
  komariAlertStates = [],
  komariSources,
  shellbeamAgents = [],
  localAlertStates = {},
  now = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
}: BuildHostOpsViewsInput): Record<string, HostOpsView> {
  // Persisted freshness flags are point-in-time values. Recompute them while
  // rebuilding the host list so reopening the dashboard in another session
  // cannot present an expired Komari observation as fresh.
  const refresh = (snapshot: ProbeSnapshot) => {
    const refreshed = refreshProbeSnapshotFreshness(snapshot, now)
    // Inventory has a separate cadence. Its expiry cannot invalidate a current
    // metric observation from an otherwise successful provider.
    return snapshot.health === 'online' && refreshed.metrics && !refreshed.metrics.freshness.expired
      ? { ...refreshed, health: 'online' as const } : refreshed
  }
  const current = (snapshot: ProbeSnapshot) => snapshot.provider.kind !== 'komari' || !komariSources
    || hosts.some((host) => isCurrentKomariSnapshot(snapshot, host, komariSources))
  const refreshedKomariSnapshots = komariSnapshots.filter(current).map(refresh)
  const refreshedProbeSnapshots = probeSnapshots.filter(current).map(refresh)
  const monitorByKey = new Map(monitorLatest.map((entry) => [entry.hostKey, entry]))
  const allProbeSnapshots = [...refreshedKomariSnapshots, ...refreshedProbeSnapshots].reduce<ProbeSnapshot[]>((rows, snapshot) => {
    const index = rows.findIndex((current) => snapshotKey(current) === snapshotKey(snapshot))
    if (index < 0) rows.push(snapshot)
    else rows[index] = freshestSnapshot(rows[index], snapshot)
    return rows
  }, [])
  const komariByHostId = new Map<string, ProbeSnapshot>()
  for (const snapshot of allProbeSnapshots.filter((row) => row.provider.kind === 'komari')) {
    komariByHostId.set(snapshot.host.hostId, preferredHostProbe(komariByHostId.get(snapshot.host.hostId), snapshot))
  }
  const probeByHostId = new Map<string, ProbeSnapshot>()
  for (const snapshot of allProbeSnapshots) probeByHostId.set(snapshot.host.hostId, preferredHostProbe(probeByHostId.get(snapshot.host.hostId), snapshot))
  const agentByHostId = new Map(shellbeamAgents.map((record) => [record.hostId, record]))

  return hosts.reduce<Record<string, HostOpsView>>((result, host) => {
    const hostKey = getServerMonitorHostKey(host)
    const storedSshMonitor = monitorByKey.get(hostKey)
    const latestSshProbe = allProbeSnapshots.filter((snapshot) => snapshot.host.hostId === host.id && snapshot.provider.kind === 'ssh-agentless'
      && (snapshot.metrics || (!snapshot.inventory && (!snapshot.telemetry || snapshot.telemetry.sections.includes('metrics'))))).sort((left, right) => right.receivedAt - left.receivedAt)[0]
    const sshMonitor = storedSshMonitor && latestSshProbe && latestSshProbe.receivedAt > storedSshMonitor.updatedAt
      ? { ...storedSshMonitor, status: latestSshProbe.telemetry?.status === 'failed' ? 'offline' as const : latestSshProbe.telemetry?.status === 'recovered' ? 'stale' as const : latestSshProbe.health === 'unknown' ? 'checking' as const : latestSshProbe.health,
        snapshot: latestSshProbe.health === 'unsupported' ? null : latestSshProbe.metrics?.data ?? storedSshMonitor.snapshot, error: latestSshProbe.errors[0]?.message, probeTelemetry: latestSshProbe.telemetry, updatedAt: latestSshProbe.receivedAt }
      : storedSshMonitor
    const komariSnapshot = komariByHostId.get(host.id)
    const probeSnapshot = probeByHostId.get(host.id)
    const selectedProbeSnapshot = probeSnapshot && komariSnapshot ? preferredHostProbe(komariSnapshot, probeSnapshot) : komariSnapshot ?? probeSnapshot
    const shellbeamAgent = agentByHostId.get(host.id)
    const komariMonitor = komariMonitorForHost(host, komariSnapshot)
    const genericMonitor = komariMonitorForHost(host, probeSnapshot)
    const usable = (snapshot: ProbeSnapshot | undefined) => Boolean(snapshot?.health === 'online' && snapshot.telemetry?.status !== 'failed' && snapshot.telemetry?.status !== 'recovered' && snapshot.metrics && !snapshot.metrics.freshness.expired)
    const komariFresh = usable(komariSnapshot)
    const genericFresh = usable(probeSnapshot)
    const sshFresh = Boolean(sshMonitor?.status === 'online' && sshMonitor.snapshot && sshMonitor.snapshot.sampledAt > 0 && sshMonitor.snapshot.sampledAt <= now && now <= sshMonitor.snapshot.sampledAt + staleAfterMs && (!latestSshProbe || latestSshProbe.receivedAt < sshMonitor.updatedAt || usable(latestSshProbe)))
    const monitor = komariMonitor && komariFresh
      ? komariMonitor
      : genericMonitor && genericFresh && !sshFresh
        ? genericMonitor
        : sshMonitor ?? komariMonitor ?? genericMonitor
    const inventoryEntry = inventoryCache[hostKey]
    const probeInventory = selectedProbeSnapshot?.inventory?.data ?? null
    const inventory = inventoryEntry?.inventory ?? probeInventory
    const inventoryUpdatedAt = inventoryEntry?.updatedAt ?? selectedProbeSnapshot?.inventory?.freshness.receivedAt ?? null
    const state = inventoryStates[hostKey]
    const jumpProfile = host.jumpHostId ? hosts.find((candidate) => candidate.id === host.jumpHostId) : undefined
    const jump = getHostIdentity(host, hosts).jump
    const route: HostOpsRoute = {
      transport: operationTransport(host),
      ...(jump?.address ? { jumpHost: jump.address } : {}),
      ...(jumpProfile ? { jumpHostName: jumpProfile.name } : {}),
      ...(jump?.port ? { jumpPort: jump.port } : {}),
      ...(jump?.username ? { jumpUser: jump.username } : {}),
    }
    const allHostAudits = audits
      .filter((audit) => audit.hostId === host.id || (!audit.hostId && audit.hostAddress === host.address))
      .sort(compareAudits)
    const hostAudits = allHostAudits.slice(0, 10)
    const selectedProvider: HostOpsProvider = monitor === komariMonitor && komariMonitor
      ? 'komari'
      : monitor === genericMonitor && genericMonitor && probeSnapshot ? probeSnapshot.provider.kind
        : monitor === sshMonitor && sshMonitor ? 'ssh-agentless'
          : !inventoryEntry && probeInventory && selectedProbeSnapshot ? selectedProbeSnapshot.provider.kind
          : providerFor(sshMonitor, inventory, state, allHostAudits, shellbeamAgent, probeSnapshot)
    let freshnessValue = freshness(monitor, inventory, inventoryUpdatedAt, state, now, staleAfterMs)
    const selectedObservation = monitor === komariMonitor && komariMonitor ? komariSnapshot?.metrics : monitor === genericMonitor && genericMonitor ? probeSnapshot?.metrics : allProbeSnapshots.find((snapshot) => snapshot.host.hostId === host.id && snapshot.provider.kind === 'ssh-agentless' && snapshot.metrics?.freshness.sampledAt === monitor?.snapshot?.sampledAt)?.metrics
    if (selectedObservation && monitor?.snapshot?.sampledAt === selectedObservation.freshness.sampledAt) {
      const stamp = selectedObservation.freshness
      const validSample = Number.isFinite(stamp.sampledAt) && stamp.sampledAt > 0 && stamp.sampledAt <= now
      freshnessValue = { ...freshnessValue, sampledAt: validSample ? stamp.sampledAt : null, updatedAt: stamp.receivedAt, ageMs: validSample ? now - stamp.sampledAt : null, stale: validSample && (stamp.expired || now > stamp.expiresAt), ttlMs: stamp.ttlMs, expiresAt: validSample ? stamp.expiresAt : null, expiryReason: validSample && (stamp.expired || now > stamp.expiresAt) ? 'ttl-expired' : null }
    }
    const metricProbe = monitor === komariMonitor && komariMonitor ? komariSnapshot
      : monitor === genericMonitor && genericMonitor ? probeSnapshot
        : monitor === sshMonitor && sshMonitor ? allProbeSnapshots.find((snapshot) => snapshot.host.hostId === host.id && snapshot.provider.kind === 'ssh-agentless' && snapshot.metrics?.freshness.sampledAt === sshMonitor.snapshot?.sampledAt)
          : selectedProbeSnapshot
    const monitorError = monitor?.error?.trim()
    const stateError = monitor && monitor !== sshMonitor ? undefined : state?.error?.trim()
    const alertState = komariAlertStateForHost(host, allProbeSnapshots, komariAlertStates, komariSources)
    const localAlerts = (localAlertStates[host.id]?.alerts ?? []).filter((alert) => alert.hostId === host.id)
    const openLocal = localAlerts.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged')
    const openKomari = groupKomariAlertIncidents(alertState?.alerts ?? []).map((incident) => incident.alert).filter((alert) => alert.status === 'active' || alert.status === 'acknowledged')
    const severityRanks = ['info', 'warning', 'critical']
    const highestAlertSeverity = [...openLocal, ...openKomari].map((alert) => alert.severity).sort((a, b) => severityRanks.indexOf(b) - severityRanks.indexOf(a))[0] ?? null
    const komariOpenCount = alertState?.summary.open ?? selectedProbeSnapshot?.alerts?.active ?? (selectedProbeSnapshot?.alerts?.unsupported ? null : 0)
    const view: HostOpsView = {
      host,
      hostKey,
      route,
      health: {
        state: healthState(monitor, monitor && monitor !== sshMonitor ? undefined : state, freshnessValue, metricProbe),
        provider: selectedProvider === 'unknown' ? providerFor(monitor, inventory, state, allHostAudits, shellbeamAgent, selectedProbeSnapshot) : selectedProvider,
        probe: probeStatus(
          metricProbe,
          refreshedProbeSnapshots.some((snapshot) => snapshotKey(snapshot) === (metricProbe ? snapshotKey(metricProbe) : '')),
          // Only attach scheduler telemetry to a matching SSH provider. A
          // Komari snapshot must never inherit a local SSH collection result.
          monitor === sshMonitor ? sshMonitor : undefined,
        ),
        transport: route.transport,
        freshness: freshnessValue,
        error: monitorError || stateError || undefined,
        lastSuccessAt: monitor?.lastSuccessAt ?? null,
        ...(selectedProbeSnapshot?.alerts
          ? { alertSummary: selectedProbeSnapshot.alerts }
          : {}),
        ...(alertState ? { alertLifecycle: alertState.summary } : {}),
        ...(shellbeamAgent ? { agent: shellbeamAgent } : {}),
        ...(selectedProvider === 'komari' && sshMonitor?.snapshot
          ? { fallbackProvider: 'ssh-agentless' as const, fallbackReason: 'Komari metrics selected; SSH data retained as fallback.' }
          : selectedProvider === 'ssh-agentless' && komariSnapshot
            ? { fallbackProvider: 'komari' as const, fallbackReason: 'Komari metrics were unavailable or stale; SSH data selected.' }
            : {}),
      },
      resource: inventory?.resource ?? null,
      metrics: monitor?.snapshot ?? null,
      inventory,
      serviceSummary: serviceSummary(inventory, inventoryUpdatedAt),
      processSummary: processSummary(inventory, inventoryUpdatedAt),
      operationSummary: operationSummary(allHostAudits),
      audits: hostAudits,
      latestAudit: hostAudits[0] ?? null,
      komariAlerts: alertState?.alerts ?? [],
      komariAlertAudits: alertState?.audits ?? [],
      localAlerts,
      localAlertEvaluations: hostProbeEvaluations(localAlertStates[host.id]?.evaluations ?? [], now),
      localAlertOpen: openLocal.length,
      alertOpenCount: komariOpenCount === null ? null : komariOpenCount + openLocal.length,
      highestAlertSeverity,
      capabilities: healthState(monitor, monitor && monitor !== sshMonitor ? undefined : state, freshnessValue, metricProbe) === 'unsupported' ? ['files'] : observedCapabilities(inventory, selectedProbeSnapshot, Boolean(sshMonitor || inventoryEntry || state?.status === 'ready'), sshMonitor?.status !== 'unsupported' && Boolean(sshMonitor?.snapshot || inventoryEntry || state?.status === 'ready')),
    }
    result[host.id] = view
    return result
  }, {})
}

/** Load all persisted sources used by the host operations view in parallel. */
export async function loadHostOpsViews(
  hosts: HostProfile[],
  options: { auditLimit?: number; staleAfterMs?: number; now?: number; komariSnapshots?: ProbeSnapshot[]; komariAlertStates?: KomariAlertState[]; shellbeamAgents?: ShellbeamAgentRecord[]; vaultId?: string } = {},
) {
  if (hosts.length === 0) return {}
  hosts = scopeObservationHosts(hosts, options.vaultId)
  await Promise.allSettled(hosts.map((host) => hydrateLocalOpsHost(options.vaultId ?? host.vaultId, host.id, true)))
  const [monitorLatest, inventoryCache, inventoryStates, audits, persistedAgents, persistedProbeRows, komariSources] = await Promise.all([
    listServerMonitorLatest(observationVaultIds(hosts)),
    loadWorkspaceInventoryPersistedCache(hosts),
    loadWorkspaceInventoryHostStateSnapshots(hosts),
    listOperationAudit({
      ...(options.vaultId ? { vaultId: options.vaultId } : {}),
      limit: options.auditLimit ?? 200,
    }),
    options.shellbeamAgents ? Promise.resolve(options.shellbeamAgents) : listShellbeamAgents({ vaultId: options.vaultId }),
    options.vaultId ? listPersistedProbeSnapshots({ vaultId: options.vaultId }).catch(() => [] as PersistedProbeSnapshotRecord[]) : Promise.resolve([] as PersistedProbeSnapshotRecord[]),
    loadCurrentKomariSources(observationVaultIds(hosts)),
  ])
  return buildHostOpsViews({
    hosts,
    monitorLatest,
    inventoryCache,
    inventoryStates,
    audits,
    komariSnapshots: options.komariSnapshots,
    probeSnapshots: persistedProbeRows.filter((row) => row.vaultId === options.vaultId
      && hosts.some((host) => host.id === row.hostId && host.vaultId === row.vaultId)
      && row.snapshot.host.hostId === row.hostId && row.snapshot.provider.id === row.providerId && row.snapshot.provider.kind === row.providerKind)
      .map((row) => refreshProbeSnapshotFreshness(row.snapshot, options.now ?? Date.now())),
    komariAlertStates: options.komariAlertStates,
    komariSources,
    shellbeamAgents: persistedAgents,
    localAlertStates: Object.fromEntries(hosts.map((host) => [host.id, loadLocalAlertState(options.vaultId ?? host.vaultId, host.id)])),
    now: options.now,
    staleAfterMs: options.staleAfterMs,
  })
}
