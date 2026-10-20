import { isKomariWaitingForFirstReport } from './komari-first-report'
import { normalizeKomariEndpoint } from './komari'
import type { HostProfile } from './hosts'
import type { KomariAlertSummary } from './komari'
import type { KomariHostMapping } from './komari-mapping'
import {
  checkShellbeamAgent,
  runShellbeamAgentOperation,
  type ShellbeamAgentCommandResult,
  type ShellbeamAgentOperationResult,
  type ShellbeamAgentRecord,
} from './shellbeam-agent'
import type { ProbeSnapshot } from './probe-provider'
import { persistKomariAlertOperationLink } from './komari-alert-actions'
import type { KomariAlertState } from './komari-alerts'

/** Mapping status is kept separate from probe/Komari health so a missing
 * integration never looks like a remote host outage. */
export type KomariProbeLinkStatus = 'linked' | 'unmapped' | 'conflict'
export type KomariProbeDataState = 'online' | 'stale' | 'offline' | 'unknown'
export type KomariProbeLifecycleState = ShellbeamAgentRecord['status'] | 'not-recorded'

export interface KomariProbeLink {
  integrationId: string
  nodeId: string
  hostId: string | null
  mapping: KomariHostMapping | null
  status: KomariProbeLinkStatus
  /** The persisted lifecycle rows for this integration. A caller may use the
   * host/node fields to choose one alert before linking a confirmed operation. */
  alertState: KomariAlertState | null
  /** Read-only Komari state associated with this node. */
  komari: {
    state: KomariProbeDataState
    waitingForFirstReport?: boolean
    sampledAt: number | null
    receivedAt: number | null
    /** Successful integration sync, independent of node sampling or mapping writes. */
    lastSyncedAt?: number | null
    alerts: KomariAlertSummary | null
    snapshot: ProbeSnapshot | null
  }
  /** ShellBeam Probe lifecycle metadata, if the host has a persisted record. */
  probe: {
    state: KomariProbeLifecycleState
    health: ShellbeamAgentRecord['health'] | null
    version: string | null
    lastHeartbeatAt: number | null
    record: ShellbeamAgentRecord | null
  }
  /** A UI may offer this action, but it must still use the explicit bridge below. */
  recommendedAction: 'none' | 'check-probe' | 'install-probe' | 'inspect-komari'
}

export interface KomariProbeTarget {
  integrationId: string
  nodeId: string
  host: HostProfile
  mapping: KomariHostMapping
}

export class KomariProbeLinkError extends Error {
  readonly code: 'invalid-integration' | 'invalid-node' | 'mapping-unavailable' | 'mapping-conflict' | 'host-unavailable'

  constructor(
    code: KomariProbeLinkError['code'],
    message: string = code,
  ) {
    super(message)
    this.name = 'KomariProbeLinkError'
    this.code = code
  }
}

type MappingWithIntegration = KomariHostMapping & { integrationId?: string | null }

function required(value: string, field: 'integration' | 'node') {
  const normalized = value.trim()
  if (!normalized) {
    throw new KomariProbeLinkError(field === 'integration' ? 'invalid-integration' : 'invalid-node', `Komari ${field} id is required`)
  }
  return normalized
}

function mappingBelongsToIntegration(mapping: MappingWithIntegration, integrationId: string) {
  // Legacy callers pass KomariHostMapping without an integrationId after
  // loading one integration at a time. When present, the field is enforced.
  return !mapping.integrationId || mapping.integrationId.trim() === integrationId
}

/**
 * Resolve an explicit, durable Komari mapping into a HostProfile. This is the
 * security boundary for Komari-triggered Probe actions: node ids never become
 * SSH targets by themselves, and duplicate mappings are rejected.
 */
export function resolveKomariProbeTarget(options: {
  integrationId: string
  nodeId: string
  mappings: MappingWithIntegration[]
  hosts: HostProfile[]
}): KomariProbeTarget {
  const integrationId = required(options.integrationId, 'integration')
  const nodeId = required(options.nodeId, 'node')
  const matches = options.mappings.filter((mapping) => mapping.nodeId === nodeId && mappingBelongsToIntegration(mapping, integrationId))
  if (matches.length === 0) throw new KomariProbeLinkError('mapping-unavailable', `Komari node ${nodeId} is not mapped to a host`)
  if (matches.length > 1) throw new KomariProbeLinkError('mapping-conflict', `Komari node ${nodeId} has conflicting host mappings`)
  const mapping = matches[0]
  const hostMatches = options.mappings.filter((candidate) => candidate.hostId === mapping.hostId && mappingBelongsToIntegration(candidate, integrationId))
  if (hostMatches.length > 1) throw new KomariProbeLinkError('mapping-conflict', `Host ${mapping.hostId} has conflicting Komari mappings`)
  const host = options.hosts.find((candidate) => candidate.id === mapping.hostId)
  if (!host) throw new KomariProbeLinkError('host-unavailable', `Mapped host ${mapping.hostId} is unavailable`)
  return { integrationId, nodeId, host, mapping }
}

function komariDataState(snapshot: ProbeSnapshot | null, now: number): KomariProbeDataState {
  if (!snapshot) return 'unknown'
  if (snapshot.health === 'offline') return 'offline'
  if (snapshot.health === 'unknown') return 'unknown'
  const observation = snapshot.metrics ?? snapshot.inventory
  if (snapshot.health === 'stale' || observation?.freshness.expired || (observation && now > observation.freshness.expiresAt)) return 'stale'
  return observation ? 'online' : 'unknown'
}

function probeLifecycleState(record: ShellbeamAgentRecord | null): KomariProbeLifecycleState {
  return record?.status ?? 'not-recorded'
}

/** Keep each host card bounded to its own lifecycle rows. The persisted state
 * may contain hundreds of alerts for an integration, but a Probe link only
 * needs rows that can be attached to this mapped node/host. */
function scopedAlertState(state: KomariAlertState | null | undefined, nodeId: string, hostId: string | null): KomariAlertState | null {
  if (!state) return null
  const alerts = state.alerts.filter((alert) => alert.nodeId === nodeId || (hostId !== null && alert.hostId === hostId))
  if (alerts.length === state.alerts.length && state.audit.length <= 1_000) return state
  const alertIds = new Set(alerts.map((alert) => alert.alertId))
  return {
    ...state,
    alerts,
    audit: state.audit.filter((entry) => alertIds.has(entry.alertId)).slice(-1_000),
  }
}

function recommendedAction(options: {
  status: KomariProbeLinkStatus
  komariState: KomariProbeDataState
  probe: ShellbeamAgentRecord | null
}): KomariProbeLink['recommendedAction'] {
  if (options.status !== 'linked') return 'inspect-komari'
  if (options.komariState === 'offline' || options.komariState === 'unknown') return 'inspect-komari'
  if (!options.probe || options.probe.status === 'not-installed' || options.probe.status === 'retired') return 'install-probe'
  if (options.probe.health === 'offline' || options.probe.health === 'unknown') return 'check-probe'
  return 'none'
}

/**
 * Join persisted Komari snapshots/mappings with ShellBeam Probe lifecycle
 * records. The resulting object is safe for host-list cards and alert actions:
 * it carries source and freshness explicitly and never turns Komari metrics
 * into proof that an SSH operation succeeded.
 */
export function buildKomariProbeLinks(options: {
  integrationId: string
  vaultId?: string
  endpoint?: string
  lastSyncedAt?: number | null
  hosts: HostProfile[]
  mappings: MappingWithIntegration[]
  snapshots?: ProbeSnapshot[]
  shellbeamAgents?: ShellbeamAgentRecord[]
  alertState?: KomariAlertState | null
  now?: number
}): KomariProbeLink[] {
  const integrationId = required(options.integrationId, 'integration')
  const now = options.now ?? Date.now()
  const endpoint = options.endpoint ? normalizeKomariEndpoint(options.endpoint) : null
  const hosts = options.hosts.filter((host) => !options.vaultId || !host.vaultId || host.vaultId === options.vaultId)
  const hostIds = new Set(hosts.map((host) => host.id))
  const snapshots = (options.snapshots ?? []).filter((snapshot) => snapshot.provider.kind === 'komari' && snapshot.provider.id === integrationId)
  const endpointMatches = (snapshot: ProbeSnapshot) => {
    if (!endpoint) return true
    try { return normalizeKomariEndpoint(snapshot.provider.endpoint ?? '') === endpoint } catch { return false }
  }
  const snapshotByNode = new Map<string, ProbeSnapshot>()
  snapshots.forEach((snapshot) => {
    const nodeId = snapshot.provider.nodeId?.trim()
    if (nodeId && !snapshotByNode.has(nodeId)) snapshotByNode.set(nodeId, snapshot)
  })
  const agentByHost = new Map((options.shellbeamAgents ?? []).filter((record) => !options.vaultId || record.vaultId === options.vaultId).map((record) => [record.hostId, record]))
  const mappings = options.mappings.filter((mapping) => mappingBelongsToIntegration(mapping, integrationId) && (!options.vaultId || hostIds.has(mapping.hostId)))
  const nodeIds = new Set<string>([
    ...mappings.map((mapping) => mapping.nodeId),
    ...snapshots.map((snapshot) => snapshot.provider.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)),
  ])
  const links: KomariProbeLink[] = []
  for (const nodeId of nodeIds) {
    const matches = mappings.filter((mapping) => mapping.nodeId === nodeId)
    const mapping = matches.length === 1 ? matches[0] : null
    const hostMatches = mapping ? mappings.filter((candidate) => candidate.hostId === mapping.hostId) : []
    const candidate = snapshotByNode.get(nodeId) ?? null
    const hostId = mapping?.hostId ?? null
    const snapshot = candidate && endpointMatches(candidate) && (!mapping || candidate.host.hostId === hostId) ? candidate : null
    const probe = hostId ? agentByHost.get(hostId) ?? null : null
    const status: KomariProbeLinkStatus = matches.length > 1 || hostMatches.length > 1 ? 'conflict' : mapping ? 'linked' : 'unmapped'
    const state = komariDataState(snapshot, now)
    const syncAt = options.lastSyncedAt
    const lastSyncedAt = status === 'linked' && (!candidate || snapshot !== null) && typeof syncAt === 'number' && Number.isFinite(syncAt) && syncAt > 0 && syncAt <= now ? syncAt : null
    links.push({
      integrationId,
      nodeId,
      hostId,
      mapping,
      status,
      alertState: scopedAlertState(options.alertState, nodeId, hostId),
      komari: {
        state,
        waitingForFirstReport: isKomariWaitingForFirstReport(snapshot, options.alertState?.probeBaselines),
        sampledAt: snapshot?.metrics?.freshness.sampledAt ?? snapshot?.inventory?.freshness.sampledAt ?? null,
        receivedAt: snapshot?.receivedAt ?? null,
        lastSyncedAt,
        alerts: snapshot?.alerts ?? null,
        snapshot,
      },
      probe: {
        state: probeLifecycleState(probe),
        health: probe?.health ?? null,
        version: probe?.version ?? null,
        lastHeartbeatAt: probe?.lastHeartbeatAt ?? null,
        record: probe,
      },
      recommendedAction: recommendedAction({ status, komariState: state, probe }),
    })
  }
  return links.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

/**
 * Attach lifecycle metadata to a Komari snapshot without changing its source,
 * metrics, health or freshness. This is useful when one provider row is passed
 * through host-list/Workspace code that already understands `snapshot.agent`.
 */
export function attachShellbeamProbeToKomariSnapshot(
  snapshot: ProbeSnapshot,
  agent: ShellbeamAgentRecord | null | undefined,
): ProbeSnapshot {
  if (snapshot.provider.kind !== 'komari' || !agent) return snapshot
  return {
    ...snapshot,
    agent: {
      status: agent.status,
      version: agent.version ?? null,
      nodeId: agent.agentId ?? null,
      capabilities: [...agent.capabilities],
      lastHeartbeat: agent.lastHeartbeatAt ?? null,
      checkedAt: agent.lastCheckedAt ?? null,
    },
  }
}

/**
 * Read-only Komari alert action bridge. A Komari node can request a probe
 * check only after an explicit durable mapping has been resolved. The command
 * travels through the existing Workspace SSH transport, so ProxyJump and Vault
 * secret handling are reused automatically.
 */
export async function checkKomariLinkedProbe(options: {
  vaultId?: string
  integrationId: string
  nodeId: string
  mappings: MappingWithIntegration[]
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  now?: number
  validateTarget?: (target: KomariProbeTarget) => Promise<void>
}): Promise<{ target: KomariProbeTarget; result: ShellbeamAgentCommandResult }> {
  const target = resolveKomariProbeTarget(options)
  await options.validateTarget?.(target)
  const result = options.vaultId
    ? await checkShellbeamAgent(target.host, options.resolveAuthSecret, options.now ?? Date.now(), options.vaultId)
    : await checkShellbeamAgent(target.host, options.resolveAuthSecret, options.now ?? Date.now())
  return { target, result }
}

/**
 * Explicitly confirmed Komari → Probe operation bridge. Komari never supplies
 * a command or remote path; only the fixed ShellBeam Probe lifecycle actions
 * are allowed, and runShellbeamAgentOperation creates the OperationJob audit.
 */
export async function runKomariLinkedProbeOperation(options: {
  integrationId: string
  nodeId: string
  mappings: MappingWithIntegration[]
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  action: 'install' | 'upgrade' | 'uninstall'
  vaultId?: string
  installPath?: string
  version?: string
  confirmMessage?: string
  onRecord?: (record: ShellbeamAgentRecord) => void
  /** Optional alert lifecycle context. When supplied, a confirmed operation
   * is linked to the alert's durable audit row after the OperationJob exists. */
  alertState?: KomariAlertState | null
  alertId?: string
  alertActor?: string
  onAlertState?: (state: KomariAlertState) => void
  validateTarget?: (target: KomariProbeTarget) => Promise<void>
}): Promise<{ target: KomariProbeTarget; result: ShellbeamAgentOperationResult | null; alertState?: KomariAlertState }> {
  const target = resolveKomariProbeTarget(options)
  const result = await runShellbeamAgentOperation({
    host: target.host,
    resolveAuthSecret: options.resolveAuthSecret,
    action: options.action,
    vaultId: options.vaultId,
    installPath: options.installPath,
    version: options.version,
    confirmMessage: options.confirmMessage ?? `Confirm ${options.action} for the ShellBeam Probe linked to Komari node ${target.nodeId}?`,
    onRecord: options.onRecord,
    beforeExecute: () => options.validateTarget?.(target) ?? Promise.resolve(),
  })
  if (!result?.job?.jobId || !options.alertState || !options.alertId) return { target, result }
  const linked = await persistKomariAlertOperationLink({
    integrationId: options.integrationId,
    state: options.alertState,
    alertId: options.alertId,
    operationJobId: result.job.jobId,
    actor: options.alertActor ?? 'local-user',
  })
  options.onAlertState?.(linked.state)
  return { target, result, alertState: linked.state }
}
