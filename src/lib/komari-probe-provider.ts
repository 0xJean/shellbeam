import type { HostProfile } from './hosts'
import {
  createProbeObservation,
  getProbeHostIdentity,
  getProbeTransport,
  PROBE_PROVIDER_SCHEMA_VERSION,
  type ProbeProvider,
  type ProbeRequest,
  type ProbeSnapshot,
} from './probe-provider'
import {
  komariRecordToServerMonitorSnapshot,
  type KomariClient,
  type KomariMetricRecord,
} from './komari'

export interface KomariProbeClient {
  fetchRecentRecords(nodeId: string): Promise<KomariMetricRecord[]>
}

export interface KomariProbeProviderOptions {
  endpoint: string
  client: KomariProbeClient
  nodeForHost: (host: HostProfile) => KomariClient | null
  id?: string
  metricsTtlMs?: number
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
      const receivedAt = request.now ?? Date.now()
      const base = {
        schemaVersion: PROBE_PROVIDER_SCHEMA_VERSION,
        host: getProbeHostIdentity(request.host),
        provider: ref,
        transport: getProbeTransport(request.host),
        receivedAt,
        metrics: null,
        inventory: null,
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
        const record = records[records.length - 1]
        if (!record) {
          return {
            ...base,
            health: 'unknown',
            errors: [{ section: 'metrics', message: 'Komari returned no recent metrics', code: 'empty' }],
          }
        }
        const snapshot = komariRecordToServerMonitorSnapshot(record, node, receivedAt)
        const source = { ...ref, nodeId: node.uuid }
        const metrics = createProbeObservation({
          data: snapshot,
          source,
          sampledAt: snapshot.sampledAt,
          receivedAt,
          ttlMs,
          confidence: 'partial',
        })
        return {
          ...base,
          provider: source,
          health: metrics.freshness.expired ? 'stale' : 'online',
          metrics,
          errors: [],
        }
      } catch (error) {
        return { ...base, health: 'unknown', errors: [providerError(error)] }
      }
    },
  }
}
