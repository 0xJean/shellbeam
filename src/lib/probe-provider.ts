import type { HostProfile } from './hosts'
import {
  fetchServerMonitorSnapshot,
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
export type ProbeCapability = 'metrics' | 'inventory'
export type ProbeSection = ProbeCapability
export type ProbeTransport = 'direct' | 'proxy-jump'
export type ProbeHealthState = 'online' | 'stale' | 'offline' | 'paused' | 'unsupported' | 'unknown'
export type ProbeConfidence = 'observed' | 'partial' | 'inferred'

export interface ProbeJumpRoute {
  address: string
  port: number
  username: string
}

export interface ProbeHostIdentity {
  hostId: string
  address: string
  port: number
  username: string
  jump?: ProbeJumpRoute
}

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
}

export interface ProbeRequest {
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
  collectMetrics?: (request: ProbeRequest) => Promise<ServerMonitorSnapshot>
  collectInventory?: (request: ProbeRequest) => Promise<WorkspaceInventory>
}

export interface AgentlessProbeOptions {
  metricsTtlMs?: number
  inventoryTtlMs?: number
  dependencies?: AgentlessProbeDependencies
}

export const DEFAULT_AGENTLESS_METRICS_TTL_MS = 2 * 60 * 1000
export const DEFAULT_AGENTLESS_INVENTORY_TTL_MS = 10 * 60 * 1000

export function getProbeHostIdentity(host: HostProfile): ProbeHostIdentity {
  const jumpHost = host.jumpHost?.trim()
  const jump = jumpHost
    ? {
        address: jumpHost,
        port: host.jumpPort || 22,
        username: host.jumpUser?.trim() || host.username || 'root',
      }
    : undefined

  return {
    hostId: host.id || `${host.username}@${host.address}:${host.port || 22}`,
    address: host.address,
    port: host.port || 22,
    username: host.username || 'root',
    ...(jump ? { jump } : {}),
  }
}

export function getProbeTransport(host: HostProfile): ProbeTransport {
  return host.jumpHost?.trim() ? 'proxy-jump' : 'direct'
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
  }
}

function sectionList(request: ProbeRequest): ProbeSection[] {
  const sections: ProbeSection[] = request.sections?.length
    ? [...new Set(request.sections)]
    : ['metrics', 'inventory']
  return sections
}

function healthFromObservations(observations: Array<ProbeObservation<unknown> | null>): ProbeHealthState {
  const available = observations.filter((observation): observation is ProbeObservation<unknown> => Boolean(observation))
  if (available.length === 0) return 'unknown'
  return available.some((observation) => !observation.freshness.expired) ? 'online' : 'stale'
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
      const receivedAt = request.now ?? Date.now()
      const host = getProbeHostIdentity(request.host)
      const transport = getProbeTransport(request.host)
      const sections = sectionList(request)
      const metricsEnabled = sections.includes('metrics')
      const inventoryEnabled = sections.includes('inventory')
      const [metricsResult, inventoryResult] = await Promise.all([
        metricsEnabled
          ? collectMetrics(request).then((data) => ({ status: 'fulfilled' as const, data })).catch((error: unknown) => ({ status: 'rejected' as const, error }))
          : Promise.resolve({ status: 'disabled' as const }),
        inventoryEnabled
          ? collectInventory(request).then((data) => ({ status: 'fulfilled' as const, data })).catch((error: unknown) => ({ status: 'rejected' as const, error }))
          : Promise.resolve({ status: 'disabled' as const }),
      ])

      const errors: ProbeError[] = []
      const metrics = metricsResult.status === 'fulfilled'
        ? createProbeObservation({
            data: metricsResult.data,
            source: ref,
            sampledAt: metricsResult.data.sampledAt,
            receivedAt,
            ttlMs: metricsTtlMs,
            confidence: 'observed',
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

      return {
        schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
        host,
        provider: ref,
        transport,
        health: healthFromObservations([metrics, inventory]),
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
        return {
          schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
          host: getProbeHostIdentity(request.host),
          provider: options.ref,
          transport: getProbeTransport(request.host),
          health: healthFromObservations([result.metrics ?? null, result.inventory ?? null]),
          receivedAt,
          metrics: result.metrics ?? null,
          inventory: result.inventory ?? null,
          errors: [],
        }
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
