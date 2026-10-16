import type { HostProfile } from './hosts'
import {
  createKomariProbeClient,
  getKomariAlertSummary,
  listKomariClients,
  type KomariAlertSummary,
  type KomariConnectionConfig,
  type KomariFetch,
  type KomariClient,
} from './komari'
import { mapKomariNodesToHosts, type KomariMappingResult } from './komari-mapping'
import { createKomariProbeProvider } from './komari-probe-provider'
import type { ProbeSnapshot } from './probe-provider'

export interface KomariSyncResult {
  integrationId: string
  syncedAt: number
  clients: KomariClient[]
  mapping: KomariMappingResult
  snapshots: ProbeSnapshot[]
  alerts: KomariAlertSummary | null
  skipped?: boolean
  skipReason?: 'ttl'
}

export const DEFAULT_KOMARI_SYNC_TTL_MS = 60 * 1000
export const DEFAULT_KOMARI_SYNC_CONCURRENCY = 4

const emptyMapping = (): KomariMappingResult => ({
  mappings: [],
  unmappedHosts: [],
  unmappedNodes: [],
  conflicts: [],
})

/** Return true when the persisted sync is still inside its freshness window. */
export function isKomariSyncFresh(
  lastSyncedAt: number | null | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_KOMARI_SYNC_TTL_MS,
): boolean {
  if (!Number.isFinite(lastSyncedAt) || lastSyncedAt === null || lastSyncedAt === undefined) return false
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  return now >= lastSyncedAt && now - lastSyncedAt < ttlMs
}

async function mapWithConcurrency<T, R>(
  values: T[],
  requestedLimit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return []
  const limit = Math.max(1, Math.min(values.length, Math.floor(requestedLimit) || DEFAULT_KOMARI_SYNC_CONCURRENCY))
  const result = new Array<R>(values.length)
  let nextIndex = 0
  const run = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      result[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()))
  return result
}

/**
 * Read-only sync orchestration. It discovers nodes, resolves host mappings and
 * collects metrics through the same ProbeProvider contract used by SSH.
 * Nothing in this function writes to a remote Komari Server or executes SSH.
 */
export async function syncKomariIntegration(options: {
  integrationId: string
  config: KomariConnectionConfig
  hosts: HostProfile[]
  explicitMappings?: Record<string, string>
  now?: number
  fetchImpl?: KomariFetch
  lastSyncedAt?: number | null
  ttlMs?: number
  force?: boolean
  maxConcurrency?: number
  includeAlerts?: boolean
}): Promise<KomariSyncResult> {
  const syncedAt = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_KOMARI_SYNC_TTL_MS
  if (!options.force && isKomariSyncFresh(options.lastSyncedAt, syncedAt, ttlMs)) {
    return {
      integrationId: options.integrationId,
      syncedAt: options.lastSyncedAt as number,
      clients: [],
      mapping: emptyMapping(),
      snapshots: [],
      alerts: null,
      skipped: true,
      skipReason: 'ttl',
    }
  }
  const clients = await listKomariClients(options.config, options.fetchImpl)
  const mapping = mapKomariNodesToHosts({
    hosts: options.hosts,
    nodes: clients,
    explicit: options.explicitMappings,
    now: syncedAt,
  })
  const nodeByHostId = new Map(mapping.mappings.map((item) => [
    item.hostId,
    clients.find((client) => client.uuid === item.nodeId) ?? null,
  ]))
  const alerts = options.includeAlerts === false
    ? null
    : await getKomariAlertSummary(options.config, options.fetchImpl, syncedAt)
  const provider = createKomariProbeProvider({
    endpoint: options.config.endpoint,
    client: createKomariProbeClient(options.config, options.fetchImpl),
    nodeForHost: (host) => nodeByHostId.get(host.id) ?? null,
    id: options.integrationId,
    metricsTtlMs: ttlMs,
    alertSummary: alerts,
  })
  const snapshots = await mapWithConcurrency(
    mapping.mappings,
    options.maxConcurrency ?? DEFAULT_KOMARI_SYNC_CONCURRENCY,
    async (item) => {
      const host = options.hosts.find((candidate) => candidate.id === item.hostId)
      if (!host) return null
      return provider.probe({
        host,
        resolveAuthSecret: async () => '',
        sections: ['metrics'],
        now: syncedAt,
      })
    },
  )
  return {
    integrationId: options.integrationId,
    syncedAt,
    clients,
    mapping,
    alerts,
    snapshots: snapshots.filter((snapshot): snapshot is ProbeSnapshot => snapshot !== null),
  }
}
