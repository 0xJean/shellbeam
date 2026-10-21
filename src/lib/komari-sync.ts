import { appendProviderMetricHistory, observationToMetricHistoryPoint, type ProviderMetricHistoryPoint } from './provider-history'
import type { HostProfile } from './hosts'
import {
  createKomariProbeClient,
  getKomariAlertSummary,
  getKomariHistoryRecords,
  listKomariClients,
  type KomariAlertSummary,
  type KomariConnectionConfig,
  type KomariFetch,
  type KomariClient,
} from './komari'
import { mapKomariNodesToHosts, type KomariMappingResult } from './komari-mapping'
import { createKomariProbeProvider } from './komari-probe-provider'
import type { ProbeSnapshot } from './probe-provider'
import { ProbeProviderRegistry, refreshProbeSnapshotFreshness } from './probe-scheduler'
import {
  komariAlertObservationsFromSummary,
  komariAlertObservationsFromProbeSnapshot,
  reconcileKomariAlerts,
  type KomariAlertAuditEntry,
  type KomariAlertState,
  type KomariProbeBaseline,
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
  history?: ProviderMetricHistoryPoint[]
  historyErrors?: string[]
  historyImportedCount?: number
  skipped?: boolean
  skipReason?: 'ttl'
}

export const DEFAULT_KOMARI_SYNC_TTL_MS = 60 * 1000
export const DEFAULT_KOMARI_SYNC_CONCURRENCY = 4

const lastHistoryFetch = new Map<string, number>()

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

function probeAlertInput(integrationId: string, snapshots: ProbeSnapshot[], previous: Pick<KomariAlertState, 'probeBaselines'> | null | undefined, now: number) {
  const key = (row: Pick<KomariProbeBaseline, 'integrationId' | 'endpoint' | 'nodeId' | 'hostId'>) => JSON.stringify([row.integrationId, row.endpoint ?? '', row.nodeId, row.hostId])
  const baselines = new Map((previous?.probeBaselines ?? []).map((row) => [key(row), row]))
  const observations = snapshots.flatMap((snapshot) => {
    const identity = { integrationId, ...(snapshot.provider.endpoint ? { endpoint: snapshot.provider.endpoint } : {}), nodeId: snapshot.provider.nodeId ?? '', hostId: snapshot.host.hostId }
    const baseline = baselines.get(key(identity))
    const observations = komariAlertObservationsFromProbeSnapshot(snapshot, { integrationId }, now, baseline?.lastHealthySampledAt)
    const metric = snapshot.metrics
    if (identity.nodeId && identity.hostId && metric && snapshot.health === 'online'
      && !metric.freshness.expired && now <= metric.freshness.expiresAt
      && Number.isFinite(metric.freshness.sampledAt) && metric.freshness.sampledAt > 0 && metric.freshness.sampledAt <= now
      && !snapshot.errors.some((error) => error.section === 'metrics' || error.section === 'provider')) {
      baselines.set(key(identity), { ...identity, lastHealthySampledAt: Math.max(baseline?.lastHealthySampledAt ?? 0, metric.freshness.sampledAt) })
    }
    return observations
  })
  return { observations, probeBaselines: [...baselines.values()].slice(-500) }
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
  const snapshots = options.snapshots.filter((snapshot) => snapshot.provider.kind === 'komari' && snapshot.provider.id === options.integrationId).map((snapshot) => refreshProbeSnapshotFreshness(snapshot, now))
  const { observations, probeBaselines } = probeAlertInput(options.integrationId, snapshots, options.alertState, now)
  // Preserve configuration statistics separately from observed incidents.
  // A cached zero-valued rule count never proves a recovery.
  const aggregateSummary = snapshots.find((snapshot) => snapshot.alerts !== null && snapshot.alerts !== undefined)?.alerts
  if (aggregateSummary) {
    observations.push(...komariAlertObservationsFromSummary(aggregateSummary, { integrationId: options.integrationId }))
  }
  const reconciled = reconcileKomariAlerts(options.alertState?.alerts ?? [], observations, {
    now,
    actor: options.actor ?? 'probe-recovery',
    complete: false,
    baseSummary: aggregateSummary ?? options.alertState?.summary ?? null,
  })
  return {
    alertState: {
      schemaVersion: 1,
      probeBaselines,
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
  /** Fixed evaluation clock for deterministic imports/tests. Live requests use
   * their actual reception time rather than the beginning of the sync. */
  now?: number
  fetchImpl?: KomariFetch
  lastSyncedAt?: number | null
  ttlMs?: number
  force?: boolean
  maxConcurrency?: number
  includeAlerts?: boolean
  alertState?: KomariAlertState | null
  /** Existing cache is historical first-report evidence, never recovery evidence. */
  previousSnapshots?: ProbeSnapshot[]
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
  const history: ProviderMetricHistoryPoint[] = []
  const historyErrors: string[] = []
  let historyImportedCount = 0
  const recentClient = createKomariProbeClient(options.config, options.fetchImpl)
  const provider = createKomariProbeProvider({
    endpoint: options.config.endpoint,
    client: {
      ...recentClient,
      fetchHistoryRecords: async (nodeId) => {
        const key = `${options.vaultId ?? 'ephemeral'}:${options.integrationId}:${nodeId}`
        const lastFetched = lastHistoryFetch.get(key)
        if (!options.force && lastFetched !== undefined && syncedAt >= lastFetched && syncedAt - lastFetched < 300_000) return []
        const records = await getKomariHistoryRecords(options.config, nodeId, { hours: 24 }, options.fetchImpl)
        lastHistoryFetch.set(key, syncedAt)
        if (lastHistoryFetch.size > 1000) lastHistoryFetch.delete(lastHistoryFetch.keys().next().value as string)
        return records
      },
    },
    onHistory: async (observations, request) => {
      const points = observations.map((observation) => observationToMetricHistoryPoint(observation, request.host.id))
      // Keep one bounded preview in the sync result; import each host before
      // releasing its concurrency slot instead of accumulating a whole fleet.
      history.push(...points.slice(0, Math.max(0, 10000 - history.length)))
      if (options.vaultId) {
        try { await appendProviderMetricHistory(options.vaultId, points); historyImportedCount += points.length }
        catch { historyErrors.push('history-persistence-failed') }
      }
    },
    onHistoryError: (error) => historyErrors.push(error && typeof error === 'object' && 'code' in error ? String(error.code).slice(0, 80) : 'history-unavailable'),
    nodeForHost: (host) => nodeByHostId.get(host.id) ?? null,
    id: options.integrationId,
    metricsTtlMs: ttlMs,
    alertSummary: alerts,
  })
  // The integration's mapping revision is checked when the whole sync commits.
  // Do not publish intermediate host snapshots through the process-wide cache:
  // a user may rebind a node while this remote request is still in flight.
  const probeRegistry = new ProbeProviderRegistry(DEFAULT_KOMARI_SYNC_CONCURRENCY, {
    list: async () => [], save: async () => undefined, remove: async () => undefined,
  }).register(provider)
  const snapshots = await mapWithConcurrency(
    mapping.mappings,
    options.maxConcurrency ?? DEFAULT_KOMARI_SYNC_CONCURRENCY,
    async (item) => {
      const host = options.hosts.find((candidate) => candidate.id === item.hostId)
      if (!host || !nodeByHostId.get(item.hostId)) return null
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
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      return scheduled.snapshot
    },
  )
  const normalizedSnapshots = snapshots.filter((snapshot): snapshot is ProbeSnapshot => snapshot !== null)
  const completedAt = options.now ?? Date.now()
  const historical = { probeBaselines: options.alertState?.probeBaselines }
  for (const previous of options.previousSnapshots ?? []) {
    if (previous.provider.kind !== 'komari' || previous.provider.id !== options.integrationId
      || previous.provider.endpoint !== options.config.endpoint || previous.receivedAt > completedAt
      || !mapping.mappings.some((row) => row.nodeId === previous.provider.nodeId && row.hostId === previous.host.hostId)) continue
    // Validate the original observation at its reception time. It may now be
    // expired, but it still proves this same mapping once reported successfully.
    const captured = refreshProbeSnapshotFreshness(previous, previous.receivedAt)
    historical.probeBaselines = probeAlertInput(options.integrationId, [captured], historical, previous.receivedAt).probeBaselines
  }
  const { observations: probeAlertObservations, probeBaselines } = probeAlertInput(options.integrationId, normalizedSnapshots, historical, completedAt)
  const alertObservations = [
    ...(alerts ? komariAlertObservationsFromSummary(alerts, { integrationId: options.integrationId }) : []),
    ...probeAlertObservations,
  ]
  let alertState = options.alertState ?? null
  // Reconcile only after all provider samples are available. This keeps a
  // transient Probe error in the same durable lifecycle as Komari's aggregate
  // alert summary and lets the next healthy sample emit a recovery audit row.
  if (alerts !== null || normalizedSnapshots.length > 0) {
    const reconciled = reconcileKomariAlerts(
      options.alertState?.alerts ?? [],
      alertObservations,
      {
        now: completedAt,
        actor: options.alertActor ?? 'komari-sync',
        // Rule collections cannot prove event absence or recovery. Probe rows
        // resolve only through their dated healthy observation.
        complete: false,
        baseSummary: alerts ?? options.alertState?.summary ?? null,
      },
    )
    alertAudit = reconciled.audit
    alertState = {
      schemaVersion: 1 as const,
      probeBaselines,
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
    history,
    historyErrors,
    historyImportedCount,
  }
}
