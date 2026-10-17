import type { HostProfile } from './hosts'
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
import { listShellbeamAgents } from './shellbeam-agent'

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

export interface HostOpsFreshness {
  sampledAt: number | null
  updatedAt: number | null
  ageMs: number | null
  stale: boolean
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
  shellbeamAgents?: ShellbeamAgentRecord[]
  now?: number
  staleAfterMs?: number
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
  const sampledCandidates = [
    monitor?.snapshot?.sampledAt,
    inventory?.scannedAt,
    monitor?.lastSuccessAt ?? undefined,
    state?.updatedAt,
  ].filter((value): value is number => typeof value === 'number' && value > 0)
  const sampledAt = sampledCandidates.length > 0 ? Math.max(...sampledCandidates) : null
  const updatedAt = Math.max(
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
  }
}

function healthState(
  monitor: ServerMonitorLatest | undefined,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  freshnessValue: HostOpsFreshness,
  probeSnapshot?: ProbeSnapshot,
): HostOpsHealthState {
  const errorText = `${monitor?.error ?? ''} ${state?.error ?? ''}`.toLowerCase()
  const jumpUnavailable = /proxy[ -]?jump|jump host|jump tunnel|bastion/.test(errorText)
  if (monitor?.status) {
    if (monitor.status === 'checking') return 'checking'
    if (monitor.status === 'offline' && jumpUnavailable) return 'jump-unavailable'
    if (monitor.status === 'online' && freshnessValue.stale) return 'stale'
    return monitor.status
  }
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
  if (auditedProvider === 'ssh-agentless' || auditedProvider === 'komari' || auditedProvider === 'shellbeam-agent') {
    return auditedProvider
  }
  if (shellbeamAgent) return 'shellbeam-agent'
  if (probeSnapshot?.provider.kind === 'ssh-agentless' || probeSnapshot?.provider.kind === 'komari' || probeSnapshot?.provider.kind === 'shellbeam-agent') return probeSnapshot.provider.kind
  return 'unknown'
}

function komariMonitorForHost(host: HostProfile, snapshot: ProbeSnapshot | undefined): ServerMonitorLatest | undefined {
  const observation = snapshot?.metrics
  if (!observation || (snapshot.health !== 'online' && snapshot.health !== 'stale')) return undefined
  const status: ServerMonitorStatus = snapshot.health
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
    updatedAt: snapshot.receivedAt,
  }
}

function komariAlertStateForHost(
  host: HostProfile,
  snapshots: ProbeSnapshot[],
  states: KomariAlertState[],
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
  if (alerts.length === 0) return null
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
      total: alerts.length,
      open: alerts.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged').length,
      active: alerts.filter((alert) => alert.status === 'active').length,
      acknowledged: alerts.filter((alert) => alert.status === 'acknowledged').length,
      resolved: alerts.filter((alert) => alert.status === 'resolved').length,
      closed: alerts.filter((alert) => alert.status === 'closed').length,
      latestOperationJobId,
    },
    alerts: [...alerts].sort((left, right) => right.lastSeenAt - left.lastSeenAt),
    audits,
  }
}

function probeStatus(snapshot: ProbeSnapshot | undefined, persisted = false): HostOpsProbeStatus | null {
  if (!snapshot) return null
  const observation = snapshot.metrics ?? snapshot.inventory
  const sampledAt = observation?.freshness.sampledAt ?? null
  const receivedAt = snapshot.receivedAt || observation?.freshness.receivedAt || null
  const hasRecovery = snapshot.errors.some((error) => error.code === 'stale-cache-fallback')
  const hasError = snapshot.errors.length > 0
  const state: HostOpsProbeState = hasRecovery
    ? 'recovered'
    : snapshot.health === 'stale' || Boolean(observation?.freshness.expired)
      ? 'stale'
      : snapshot.health === 'offline' || hasError
        ? 'error'
        : snapshot.health === 'online'
          ? 'fresh'
          : 'unknown'
  return {
    state,
    providerKind: snapshot.provider.kind,
    providerId: snapshot.provider.id,
    ...(snapshot.provider.nodeId ? { nodeId: snapshot.provider.nodeId } : {}),
    sampledAt,
    receivedAt,
    persisted,
    telemetry: snapshot.telemetry ?? null,
    ...(snapshot.errors[0]?.message ? { error: snapshot.errors[0].message } : {}),
  }
}

function snapshotKey(snapshot: ProbeSnapshot) {
  return `${snapshot.provider.kind}:${snapshot.provider.id}:${snapshot.host.hostId}`
}

function freshestSnapshot(current: ProbeSnapshot | undefined, candidate: ProbeSnapshot) {
  if (!current) return candidate
  return (candidate.receivedAt || 0) >= (current.receivedAt || 0) ? candidate : current
}

function operationSummary(audits: OperationAuditEntry[]): HostOpsOperationSummary {
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
  shellbeamAgents = [],
  now = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
}: BuildHostOpsViewsInput): Record<string, HostOpsView> {
  // Persisted freshness flags are point-in-time values. Recompute them while
  // rebuilding the host list so reopening the dashboard in another session
  // cannot present an expired Komari observation as fresh.
  const refreshedKomariSnapshots = komariSnapshots.map((snapshot) => refreshProbeSnapshotFreshness(snapshot, now))
  const refreshedProbeSnapshots = probeSnapshots.map((snapshot) => refreshProbeSnapshotFreshness(snapshot, now))
  const monitorByKey = new Map(monitorLatest.map((entry) => [entry.hostKey, entry]))
  const allProbeSnapshots = [...refreshedKomariSnapshots, ...refreshedProbeSnapshots].reduce<ProbeSnapshot[]>((rows, snapshot) => {
    const index = rows.findIndex((current) => snapshotKey(current) === snapshotKey(snapshot))
    if (index < 0) rows.push(snapshot)
    else rows[index] = freshestSnapshot(rows[index], snapshot)
    return rows
  }, [])
  const komariByHostId = new Map(refreshedKomariSnapshots.map((snapshot) => [snapshot.host.hostId, snapshot]))
  const probeByHostId = new Map<string, ProbeSnapshot>()
  for (const snapshot of allProbeSnapshots) probeByHostId.set(snapshot.host.hostId, freshestSnapshot(probeByHostId.get(snapshot.host.hostId), snapshot))
  const agentByHostId = new Map(shellbeamAgents.map((record) => [record.hostId, record]))

  return hosts.reduce<Record<string, HostOpsView>>((result, host) => {
    const hostKey = getServerMonitorHostKey(host)
    const sshMonitor = monitorByKey.get(hostKey)
    const komariSnapshot = komariByHostId.get(host.id)
    const probeSnapshot = probeByHostId.get(host.id)
    const selectedProbeSnapshot = komariSnapshot ?? probeSnapshot
    const shellbeamAgent = agentByHostId.get(host.id)
    const komariMonitor = komariMonitorForHost(host, komariSnapshot)
    const genericMonitor = komariMonitorForHost(host, probeSnapshot)
    const komariFresh = Boolean(komariSnapshot?.metrics && !komariSnapshot.metrics.freshness.expired)
    const monitor = komariMonitor && (komariFresh || !sshMonitor?.snapshot)
      ? komariMonitor
      : sshMonitor ?? genericMonitor
    const inventoryEntry = inventoryCache[hostKey]
    const probeInventory = selectedProbeSnapshot?.inventory?.data ?? null
    const inventory = inventoryEntry?.inventory ?? probeInventory
    const inventoryUpdatedAt = inventoryEntry?.updatedAt ?? selectedProbeSnapshot?.inventory?.freshness.receivedAt ?? null
    const state = inventoryStates[hostKey]
    const route: HostOpsRoute = {
      transport: operationTransport(host),
      ...(host.jumpHost?.trim() ? { jumpHost: host.jumpHost.trim() } : {}),
      ...(host.jumpPort ? { jumpPort: host.jumpPort } : {}),
      ...(host.jumpUser?.trim() ? { jumpUser: host.jumpUser.trim() } : {}),
    }
    const allHostAudits = audits
      .filter((audit) => audit.hostId === host.id || (!audit.hostId && audit.hostAddress === host.address))
      .sort((a, b) => b.createdAt - a.createdAt)
    const hostAudits = allHostAudits.slice(0, 10)
    const selectedProvider: HostOpsProvider = monitor === komariMonitor && komariMonitor
      ? 'komari'
      : providerFor(sshMonitor, inventory, state, allHostAudits, shellbeamAgent, probeSnapshot)
    const freshnessValue = freshness(monitor, inventory, inventoryUpdatedAt, state, now, staleAfterMs)
    const monitorError = monitor?.error?.trim()
    const stateError = state?.error?.trim()
    const alertState = komariAlertStateForHost(host, allProbeSnapshots, komariAlertStates)
    const view: HostOpsView = {
      host,
      hostKey,
      route,
      health: {
        state: healthState(monitor, state, freshnessValue, selectedProbeSnapshot),
        provider: selectedProvider === 'unknown' ? providerFor(monitor, inventory, state, allHostAudits, shellbeamAgent, selectedProbeSnapshot) : selectedProvider,
        probe: probeStatus(selectedProbeSnapshot, refreshedProbeSnapshots.some((snapshot) => snapshotKey(snapshot) === (selectedProbeSnapshot ? snapshotKey(selectedProbeSnapshot) : ''))),
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
          : selectedProvider === 'ssh-agentless' && komariSnapshot?.metrics
            ? { fallbackProvider: 'komari' as const, fallbackReason: 'Komari metrics were unavailable or stale; SSH data selected.' }
            : {}),
      },
      resource: inventory?.resource ?? null,
      metrics: monitor?.snapshot ?? null,
      inventory,
      serviceSummary: serviceSummary(inventory, inventoryUpdatedAt),
      processSummary: processSummary(inventory, inventoryUpdatedAt),
      operationSummary: operationSummary(hostAudits),
      audits: hostAudits,
      latestAudit: hostAudits[0] ?? null,
      komariAlerts: alertState?.alerts ?? [],
      komariAlertAudits: alertState?.audits ?? [],
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
  const [monitorLatest, inventoryCache, inventoryStates, audits, persistedAgents, persistedProbeRows] = await Promise.all([
    listServerMonitorLatest(),
    loadWorkspaceInventoryPersistedCache(hosts),
    loadWorkspaceInventoryHostStateSnapshots(hosts),
    listOperationAudit({
      ...(options.vaultId ? { vaultId: options.vaultId } : {}),
      limit: options.auditLimit ?? 200,
    }),
    options.shellbeamAgents ? Promise.resolve(options.shellbeamAgents) : listShellbeamAgents({ vaultId: options.vaultId }),
    options.vaultId ? listPersistedProbeSnapshots({ vaultId: options.vaultId }).catch(() => [] as PersistedProbeSnapshotRecord[]) : Promise.resolve([] as PersistedProbeSnapshotRecord[]),
  ])
  return buildHostOpsViews({
    hosts,
    monitorLatest,
    inventoryCache,
    inventoryStates,
    audits,
    komariSnapshots: options.komariSnapshots,
    probeSnapshots: persistedProbeRows.map((row) => refreshProbeSnapshotFreshness(row.snapshot, options.now ?? Date.now())),
    komariAlertStates: options.komariAlertStates,
    shellbeamAgents: persistedAgents,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
  })
}
