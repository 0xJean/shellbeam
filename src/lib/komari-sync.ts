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
import { getProbeProviderRegistry } from './probe-scheduler'
import {
  komariAlertObservationsFromSummary,
  komariAlertObservationsFromProbeSnapshot,
  reconcileKomariAlerts,
  type KomariAlertAuditEntry,
  type KomariAlertState,
} from './komari-alerts'

export interface KomariSyncResult {
  integrationId: string
  syncedAt: number
  clients: KomariClient[]
  mapping: KomariMappingResult
  snapshots: ProbeSnapshot[]
  alerts: KomariAlertSummary | null
  /** Local lifecycle state derived from the aggregate Komari alert summary. */
  alertState: KomariAlertState | null
  alertAudit: KomariAlertAuditEntry[]
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
 * Reconcile cached ProbeProvider observations when the Komari sync TTL is
 * still valid. This lets an expired cross-session observation open or resolve
 * a probe lifecycle alert without contacting the remote Komari endpoint.
 */
export function reconcileKomariProbeAlerts(options: {
  integrationId: string
  snapshots: ProbeSnapshot[]
  alertState?: KomariAlertState | null
  now?: number
  actor?: string
}): { alertState: KomariAlertState; alertAudit: KomariAlertAuditEntry[] } {
  const now = options.now ?? Date.now()
  const observations = options.snapshots.flatMap((snapshot) => komariAlertObservationsFromProbeSnapshot(
    snapshot,
    { integrationId: options.integrationId },
    now,
  ))
  const reconciled = reconcileKomariAlerts(options.alertState?.alerts ?? [], observations, {
    now,
    actor: options.actor ?? 'probe-recovery',
    complete: false,
    baseSummary: options.alertState?.summary ?? null,
  })
  return {
    alertState: {
      schemaVersion: 1,
      alerts: reconciled.alerts,
      audit: [...(options.alertState?.audit ?? []), ...reconciled.audit].slice(-1000),
      summary: reconciled.summary,
    },
    alertAudit: reconciled.audit,
  }
}

/**
 * Read-only sync orchestration. It discovers nodes, resolves host mappings and
 * collects metrics through the same ProbeProvider contract used by SSH.
 * Nothing in this function writes to a remote Komari Server or executes SSH.
 */
export async function syncKomariIntegration(options: {
  integrationId: string
  /** Vault scope for durable ProbeProvider rows. */
  vaultId?: string
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
  alertState?: KomariAlertState | null
  alertActor?: string
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
      alertState: options.alertState ?? null,
      alertAudit: [],
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
  let alertAudit: KomariAlertAuditEntry[] = []
  const provider = createKomariProbeProvider({
    endpoint: options.config.endpoint,
    client: createKomariProbeClient(options.config, options.fetchImpl),
    nodeForHost: (host) => nodeByHostId.get(host.id) ?? null,
    id: options.integrationId,
    metricsTtlMs: ttlMs,
    alertSummary: alerts,
  })
  const probeRegistry = getProbeProviderRegistry().register(provider)
  const snapshots = await mapWithConcurrency(
    mapping.mappings,
    options.maxConcurrency ?? DEFAULT_KOMARI_SYNC_CONCURRENCY,
    async (item) => {
      const host = options.hosts.find((candidate) => candidate.id === item.hostId)
      if (!host) return null
      const scheduled = await probeRegistry.probe({
        host,
        vaultId: options.vaultId,
        resolveAuthSecret: async () => '',
        sections: ['metrics'],
        providerId: provider.ref.id,
        // Komari sync has its own persisted TTL. Force a fresh provider read
        // when a sync is explicitly due while the registry still coalesces
        // overlapping calls for the same integration and host.
        force: true,
        now: syncedAt,
      })
      return scheduled.snapshot
    },
  )
  const normalizedSnapshots = snapshots.filter((snapshot): snapshot is ProbeSnapshot => snapshot !== null)
  const probeAlertObservations = normalizedSnapshots.flatMap((snapshot) => komariAlertObservationsFromProbeSnapshot(
    snapshot,
    { integrationId: options.integrationId },
    syncedAt,
  ))
  const alertObservations = [
    ...(alerts ? komariAlertObservationsFromSummary(alerts, { integrationId: options.integrationId }) : []),
    ...probeAlertObservations,
  ]
  let alertState = options.alertState ?? null
  // Reconcile only after all provider samples are available. This keeps a
  // transient Probe error in the same durable lifecycle as Komari's aggregate
  // alert summary and lets the next healthy sample emit a recovery audit row.
  if (alerts !== null || probeAlertObservations.length > 0) {
    const reconciled = reconcileKomariAlerts(
      options.alertState?.alerts ?? [],
      alertObservations,
      {
        now: syncedAt,
        actor: options.alertActor ?? 'komari-sync',
        // A complete Komari summary may resolve rows absent from this sync,
        // but only when every mapped host produced a sample. Unsupported
        // summaries never prove recovery.
        complete: Boolean(
          alerts
          && alerts.unsupported !== true
          && alerts.load !== null
          && alerts.offline !== null
          && normalizedSnapshots.length >= mapping.mappings.length,
        ),
        baseSummary: alerts ?? options.alertState?.summary ?? null,
      },
    )
    alertAudit = reconciled.audit
    alertState = {
      schemaVersion: 1 as const,
      alerts: reconciled.alerts,
      audit: [...(options.alertState?.audit ?? []), ...reconciled.audit].slice(-1000),
      summary: reconciled.summary,
    }
  }
  return {
    integrationId: options.integrationId,
    syncedAt,
    clients,
    mapping,
    alerts,
    alertState,
    alertAudit,
    snapshots: normalizedSnapshots,
  }
}
