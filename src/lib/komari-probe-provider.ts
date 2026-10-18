import type { ServerMonitorSnapshot } from './server-monitor'
import type { HostProfile } from './hosts'
import {
  createProbeObservation,
  getProbeHostIdentity,
  getProbeTransport,
  PROBE_PROVIDER_SCHEMA_VERSION,
  type ProbeProvider,
  type ProbeRequest,
  type ProbeSnapshot,
  type ProbeObservation,
} from './probe-provider'
import {
  komariRecordToServerMonitorSnapshot,
  komariRecordSampleTime,
  type KomariAlertSummary,
  type KomariClient,
  type KomariMetricRecord,
} from './komari'

export interface KomariProbeClient {
  fetchRecentRecords(nodeId: string): Promise<KomariMetricRecord[]>
  fetchHistoryRecords?(nodeId: string): Promise<KomariMetricRecord[]>
}

export interface KomariProbeProviderOptions {
  endpoint: string
  client: KomariProbeClient
  nodeForHost: (host: HostProfile) => KomariClient | null
  id?: string
  metricsTtlMs?: number
  alertSummary?: KomariAlertSummary | null
  onHistory?: (observations: ProbeObservation<ServerMonitorSnapshot>[], request: ProbeRequest) => unknown
  onHistoryError?: (error: unknown, request: ProbeRequest) => void
}

export const DEFAULT_KOMARI_METRICS_TTL_MS = 2 * 60 * 1000

function providerError(error: unknown) {
  return {
    section: 'metrics' as const,
    message: error instanceof Error ? error.message : String(error),
    ...((error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
      ? { code: error.code }
      : {}),
  }
}

export function createKomariProbeProvider(options: KomariProbeProviderOptions): ProbeProvider {
  const ref = {
    kind: 'komari' as const,
    id: options.id ?? 'komari',
    endpoint: options.endpoint,
    capabilities: ['metrics' as const],
  }
  const ttlMs = options.metricsTtlMs ?? DEFAULT_KOMARI_METRICS_TTL_MS

  return {
    ref,
    async probe(request: ProbeRequest): Promise<ProbeSnapshot> {
      let receivedAt = request.now ?? Date.now()
      const base = {
        schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
        host: getProbeHostIdentity(request.host),
        provider: ref,
        transport: getProbeTransport(request.host),
        receivedAt,
        metrics: null,
        inventory: null,
        ...(options.alertSummary ? { alerts: options.alertSummary } : {}),
      } satisfies Omit<ProbeSnapshot, 'health' | 'errors'>
      if (request.sections && !request.sections.includes('metrics')) {
        return { ...base, health: 'unknown', errors: [] }
      }

      const node = options.nodeForHost(request.host)
      if (!node) {
        return {
          ...base,
          health: 'unknown',
          errors: [{ section: 'metrics', message: 'Komari node is not mapped', code: 'unmapped' }],
        }
      }

      try {
        const records = await options.client.fetchRecentRecords(node.uuid)
        let historical: KomariMetricRecord[] = []
        if (options.client.fetchHistoryRecords) {
          try { historical = await options.client.fetchHistoryRecords(node.uuid) }
          catch (error) { options.onHistoryError?.(error, request) }
        }
        // A report may be collected while either request is in flight. Compare
        // its original sample time with reception, not the sync's start time.
        // An explicit request.now remains a fixed clock for deterministic callers.
        receivedAt = request.now ?? Date.now()
        base.receivedAt = receivedAt
        const source = { ...ref, nodeId: node.uuid }
        const byTime = new Map<number, ProbeObservation<ServerMonitorSnapshot>>()
        let invalidSampleTime = false
        // Recent reports win same-timestamp duplicates, and ordering from a
        // server/mirror never allows an older row to become the latest.
        for (const item of [...historical, ...records]) {
          const sampledAt = komariRecordSampleTime(item)
          if (sampledAt === null || sampledAt > receivedAt) {
            invalidSampleTime = true
            continue
          }
          const data = komariRecordToServerMonitorSnapshot(item, node, receivedAt)
          if ([data.cpuPercent, data.memoryPercent, data.diskPercent, data.uptimeSeconds, data.load1, data.networkRxBytesPerSec, data.networkTxBytesPerSec].every((value) => value === null)) continue
          byTime.set(sampledAt, createProbeObservation({ data, source, sampledAt, receivedAt, ttlMs, confidence: 'partial' }))
        }
        const observations = [...byTime.values()].sort((left, right) => left.freshness.sampledAt - right.freshness.sampledAt)
        const metrics = observations[observations.length - 1]
        if (!metrics) return {
          ...base,
          provider: source,
          health: 'unknown',
          errors: [{ section: 'metrics', message: invalidSampleTime ? 'Komari reports have missing or future sample times' : 'Komari returned no dated metric observations', code: invalidSampleTime ? 'invalid-sample-time' : 'empty' }],
        }
        await options.onHistory?.(observations, request)
        return {
          ...base,
          provider: source,
          health: metrics.freshness.expired ? 'stale' : 'online',
          metrics,
          errors: [],
        }
      } catch (error) {
        base.receivedAt = request.now ?? Date.now()
        return { ...base, health: 'unknown', errors: [providerError(error)] }
      }
    },
  }
}
