import { COLLECTION_LIMITS } from './collection-limits'
import { fetchUnifiedProbe, UnsupportedProbeError, isUnsupportedProbeError } from './unified-probe'
import { getHostIdentity, type HostIdentity, type JumpHostIdentity } from './host-identity'
import type { HostProfile } from './hosts'
import type { KomariAlertSummary } from './komari'
import {
  fetchServerMonitorSnapshot,
  isUsableServerMonitorSnapshot,
  type ServerMonitorSnapshot,
} from './server-monitor'
import {
  fetchWorkspaceInventory,
  type WorkspaceInventory,
} from './workspace-inventory'

/**
 * The provider contract shared by server monitor, Workspace and MCP.
 *
 * Providers own how an observation is collected. Consumers should only rely on
 * the source, freshness and confidence metadata returned with the observation.
 * In particular, a missing value must remain unknown instead of being treated
 * as zero or healthy.
 */
export const PROBE_PROVIDER_SCHEMA_VERSION = 1

export type ProbeProviderKind = 'ssh-agentless' | 'komari' | 'shellbeam-agent'
export type ProbeCapability = 'metrics' | 'inventory' | 'heartbeat' | 'services' | 'processes' | 'logs'
export type ProbeSection = ProbeCapability
export type ProbeTransport = 'direct' | 'proxy-jump'
export type ProbeHealthState = 'online' | 'stale' | 'offline' | 'paused' | 'unsupported' | 'unknown'
export type ProbeConfidence = 'observed' | 'partial' | 'inferred'
export type ProbeCollectionStatus = 'success' | 'recovered' | 'failed'

export type ProbeJumpRoute = JumpHostIdentity
export type ProbeHostIdentity = HostIdentity

export interface ProbeProviderRef {
  kind: ProbeProviderKind
  id: string
  endpoint?: string
  nodeId?: string
  capabilities: ProbeCapability[]
}

export interface ProbeFreshness {
  sampledAt: number
  receivedAt: number
  ttlMs: number
  expiresAt: number
  expired: boolean
}

export interface ProbeObservation<T> {
  data: T
  source: ProbeProviderRef
  freshness: ProbeFreshness
  confidence: ProbeConfidence
}

export interface ProbeError {
  section: ProbeSection | 'provider'
  message: string
  code?: string
}

export interface ProbeAgentLifecycle {
  status: string
  version?: string | null
  nodeId?: string | null
  capabilities: string[]
  lastHeartbeat?: number | null
  checkedAt?: number | null
}

/**
 * Scheduler-owned collection telemetry.  This is deliberately part of the
 * snapshot envelope so the host list, Workspace and MCP can explain how the
 * latest observation was obtained after a restart.  It contains no command
 * output or credentials.
 */
export interface ProbeProviderTelemetry {
  status: ProbeCollectionStatus
  startedAt: number
  completedAt: number
  durationMs: number
  /** Number of retries after the initial provider attempt. */
  attempts: number
  maxRetries: number
  retryDelayMs: number
  recovered: boolean
  exhausted: boolean
  sections: ProbeSection[]
  lastError?: string
  lastErrorCode?: string
}

export interface ProbeSnapshot {
  schemaVersion: number
  host: ProbeHostIdentity
  provider: ProbeProviderRef
  transport: ProbeTransport
  health: ProbeHealthState
  receivedAt: number
  metrics: ProbeObservation<ServerMonitorSnapshot> | null
  inventory: ProbeObservation<WorkspaceInventory> | null
  errors: ProbeError[]
  /** Latest scheduler collection outcome, persisted with the observation. */
  telemetry?: ProbeProviderTelemetry | null
  /** Optional provider-level alert summary associated with this observation. */
  alerts?: KomariAlertSummary | null
  /** Optional lifecycle metadata; it does not prove SSH reachability. */
  agent?: ProbeAgentLifecycle | null
}

export interface ProbeRequest {
  vaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  sections?: readonly ProbeSection[]
  now?: number
}

export interface ProbeProvider {
  readonly ref: ProbeProviderRef
  probe(request: ProbeRequest): Promise<ProbeSnapshot>
}

export interface AgentlessProbeDependencies {
  collect?: typeof fetchUnifiedProbe
  collectMetrics?: (request: ProbeRequest) => Promise<ServerMonitorSnapshot>
  collectInventory?: (request: ProbeRequest) => Promise<WorkspaceInventory>
}

export interface AgentlessProbeOptions {
  metricsTtlMs?: number
  inventoryTtlMs?: number
  dependencies?: AgentlessProbeDependencies
}

export const DEFAULT_AGENTLESS_METRICS_TTL_MS = COLLECTION_LIMITS.cadence.metricsTtlMs
export const DEFAULT_AGENTLESS_INVENTORY_TTL_MS = COLLECTION_LIMITS.cadence.inventoryTtlMs

export function getProbeHostIdentity(host: HostProfile, profiles: readonly HostProfile[] = []): ProbeHostIdentity { return getHostIdentity(host, profiles) }

export function getProbeTransport(host: HostProfile): ProbeTransport {
  return host.jumpHostId || host.jumpHost?.trim() ? 'proxy-jump' : 'direct'
}

function createFreshness(sampledAt: number, receivedAt: number, ttlMs: number): ProbeFreshness {
  const expiresAt = sampledAt + Math.max(0, ttlMs)
  return {
    sampledAt,
    receivedAt,
    ttlMs,
    expiresAt,
    expired: receivedAt > expiresAt,
  }
}

export function createProbeObservation<T>(options: {
  data: T
  source: ProbeProviderRef
  sampledAt: number
  receivedAt: number
  ttlMs: number
  confidence?: ProbeConfidence
}): ProbeObservation<T> {
  return {
    data: options.data,
    source: options.source,
    freshness: createFreshness(options.sampledAt, options.receivedAt, options.ttlMs),
    confidence: options.confidence ?? 'observed',
  }
}

function errorFromUnknown(error: unknown): ProbeError {
  return {
    section: 'provider',
    message: error instanceof Error ? error.message : String(error),
    ...(isUnsupportedProbeError(error) ? { code: 'unsupported_os' } : {}),
  }
}

function sectionList(request: ProbeRequest): ProbeSection[] {
  const sections: ProbeSection[] = request.sections?.length
    ? [...new Set(request.sections)]
    : ['metrics', 'inventory']
  return sections
}

function healthFromObservations(observations: Array<ProbeObservation<unknown> | null>): ProbeHealthState {
  const available = observations.filter((observation): observation is ProbeObservation<unknown> => Boolean(observation && observation.freshness.sampledAt <= observation.freshness.receivedAt))
  if (available.length === 0) return 'unknown'
  return available.some((observation) => !observation.freshness.expired) ? 'online' : 'stale'
}

/** A persisted/delegated value without its original provider is not an
 * observation. In particular, never stamp the current provider onto an old
 * payload and thereby turn an unidentified value into healthy data. */
export function validateProbeSnapshotSources(snapshot: ProbeSnapshot): ProbeSnapshot {
  const errors: ProbeError[] = []
  const validate = <T>(observation: ProbeObservation<T> | null, section: 'metrics' | 'inventory') => {
    if (!observation) return null
    const source = observation.source
    const freshness = observation.freshness
    if (source?.kind !== snapshot.provider.kind || source?.id !== snapshot.provider.id
      || !source?.id?.trim() || !freshness
      || ![freshness.sampledAt, freshness.receivedAt, freshness.expiresAt, freshness.ttlMs].every(Number.isFinite)
      || freshness.sampledAt < 0 || freshness.sampledAt > freshness.receivedAt
      || freshness.ttlMs < 0 || freshness.expiresAt < freshness.sampledAt) {
      errors.push({ section, code: 'observation_source_invalid', message: 'Observation source or original freshness is unavailable' })
      return null
    }
    return observation
  }
  const metrics = validate(snapshot.metrics, 'metrics')
  const inventory = validate(snapshot.inventory, 'inventory')
  return {
    ...snapshot, metrics, inventory,
    health: !metrics && !inventory && (snapshot.health === 'online' || snapshot.health === 'stale') ? 'unknown' : snapshot.health,
    errors: [...snapshot.errors, ...errors],
  }
}

/**
 * The built-in provider. It is deliberately an adapter around the existing
 * read-only SSH collectors so current monitor and Workspace behaviour remains
 * unchanged while they migrate to this contract.
 */
export function createAgentlessSshProbeProvider(options: AgentlessProbeOptions = {}): ProbeProvider {
  const metricsTtlMs = options.metricsTtlMs ?? DEFAULT_AGENTLESS_METRICS_TTL_MS
  const inventoryTtlMs = options.inventoryTtlMs ?? DEFAULT_AGENTLESS_INVENTORY_TTL_MS
  const collectMetrics = options.dependencies?.collectMetrics
    ?? ((request: ProbeRequest) => fetchServerMonitorSnapshot(request))
  const collectInventory = options.dependencies?.collectInventory
    ?? ((request: ProbeRequest) => fetchWorkspaceInventory(request))
  const ref: ProbeProviderRef = {
    kind: 'ssh-agentless',
    id: 'ssh-agentless',
    capabilities: ['metrics', 'inventory'],
  }

  return {
    ref,
    async probe(request) {
      let receivedAt = request.now ?? Date.now()
      const host = getProbeHostIdentity(request.host)
      const transport = getProbeTransport(request.host)
      const sections = sectionList(request)
      const metricsEnabled = sections.includes('metrics')
      const inventoryEnabled = sections.includes('inventory')
      // The default implementation has one script, one remote command and one
      // read-only audit job even when both observations are requested.
      let shared: Awaited<ReturnType<typeof fetchUnifiedProbe>> | undefined
      let sharedError: unknown
      const useShared = !options.dependencies?.collectMetrics && !options.dependencies?.collectInventory
      if (useShared && (metricsEnabled || inventoryEnabled)) {
        try { shared = await (options.dependencies?.collect ?? fetchUnifiedProbe)({ ...request, section: metricsEnabled && inventoryEnabled ? 'all' : metricsEnabled ? 'metrics' : 'inventory' }) }
        catch (error) { sharedError = error }
      }
      const sharedMetrics = () => shared && isUsableServerMonitorSnapshot(shared.metrics) ? Promise.resolve(shared.metrics) : Promise.reject(sharedError ?? new Error('PROBE_METRICS_UNAVAILABLE'))
      const sharedInventory = () => shared ? Promise.resolve(shared.inventory) : Promise.reject(sharedError ?? new Error('PROBE_COLLECTION_FAILED'))
      const [metricsResult, inventoryResult] = await Promise.all([
        metricsEnabled
          ? (useShared ? sharedMetrics() : collectMetrics(request)).then((data) => ({ status: 'fulfilled' as const, data })).catch((error: unknown) => ({ status: 'rejected' as const, error }))
          : Promise.resolve({ status: 'disabled' as const }),
        inventoryEnabled
          ? (useShared ? sharedInventory() : collectInventory(request)).then((data) => ({ status: 'fulfilled' as const, data })).catch((error: unknown) => ({ status: 'rejected' as const, error }))
          : Promise.resolve({ status: 'disabled' as const }),
      ])

      if (request.now === undefined) receivedAt = Date.now()
      const errors: ProbeError[] = []
      const metrics = metricsResult.status === 'fulfilled'
        ? createProbeObservation({
            data: metricsResult.data,
            source: ref,
            sampledAt: metricsResult.data.sampledAt,
            receivedAt,
            ttlMs: metricsTtlMs,
            confidence: Object.values(metricsResult.data).some((value) => value === null) ? 'partial' : 'observed',
          })
        : null
      if (metricsResult.status === 'rejected') {
        errors.push({ ...errorFromUnknown(metricsResult.error), section: 'metrics' })
      }

      const inventory = inventoryResult.status === 'fulfilled'
        ? createProbeObservation({
            data: inventoryResult.data,
            source: ref,
            sampledAt: inventoryResult.data.scannedAt,
            receivedAt,
            ttlMs: inventoryTtlMs,
            confidence: 'partial',
          })
        : null
      if (inventoryResult.status === 'rejected') {
        errors.push({ ...errorFromUnknown(inventoryResult.error), section: 'inventory' })
      }

      const unsupportedError = [metricsResult, inventoryResult].flatMap((result) => result.status === 'rejected' && result.error instanceof UnsupportedProbeError ? [result.error] : [])[0]
      const unsupported = !metrics && !inventory && errors.some((error) => error.code === 'unsupported_os')
      return {
        schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
        host: { ...(shared?.hostIdentity ?? unsupportedError?.hostIdentity ?? host), ...((shared?.verifiedHostKeys ?? unsupportedError?.verifiedHostKeys) ? { verifiedHostKeys: shared?.verifiedHostKeys ?? unsupportedError?.verifiedHostKeys } : {}) },
        provider: ref,
        transport,
        health: unsupported ? 'unsupported' : healthFromObservations([metrics, inventory]),
        receivedAt,
        metrics,
        inventory,
        errors,
      }
    },
  }
}

/**
 * A small adapter for future Komari or ShellBeam-agent implementations. The
 * remote API client can return the canonical observations without coupling the
 * rest of the app to its wire format.
 */
export function createDelegatingProbeProvider(options: {
  ref: ProbeProviderRef
  collect: (request: ProbeRequest) => Promise<Pick<ProbeSnapshot, 'metrics' | 'inventory'>>
}): ProbeProvider {
  return {
    ref: options.ref,
    async probe(request) {
      const receivedAt = request.now ?? Date.now()
      try {
        const result = await options.collect(request)
        return validateProbeSnapshotSources({
          schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
          host: getProbeHostIdentity(request.host),
          provider: options.ref,
          transport: getProbeTransport(request.host),
          health: healthFromObservations([result.metrics ?? null, result.inventory ?? null]),
          receivedAt,
          metrics: result.metrics ?? null,
          inventory: result.inventory ?? null,
          errors: [],
        })
      } catch (error) {
        return {
          schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
          host: getProbeHostIdentity(request.host),
          provider: options.ref,
          transport: getProbeTransport(request.host),
          health: 'unknown',
          receivedAt,
          metrics: null,
          inventory: null,
          errors: [errorFromUnknown(error)],
        }
      }
    },
  }
}
