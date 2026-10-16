import type { HostProfile } from './hosts'
import {
  createAgentlessSshProbeProvider,
  type ProbeCapability,
  type ProbeProvider,
  type ProbeObservation,
  type ProbeRequest,
  type ProbeSection,
  type ProbeSnapshot,
} from './probe-provider'
import {
  deletePersistedProbeSnapshots,
  listPersistedProbeSnapshots,
  upsertPersistedProbeSnapshot,
  type PersistedProbeSnapshotRecord,
} from './probe-persistence'

export const DEFAULT_PROBE_SCHEDULER_CONCURRENCY = 3

export interface ProbeScheduleRequest extends ProbeRequest {
  /** Vault scope for durable cache records. Requests without it remain
   * process-local to avoid leaking observations across vaults. */
  vaultId?: string
  /** Provider id or kind. Defaults to the agentless SSH provider. */
  providerId?: string
  /** Bypass the observation TTL while still deduplicating concurrent work. */
  force?: boolean
}

export interface ProbeScheduleResult {
  snapshot: ProbeSnapshot
  cached: boolean
  deduplicated: boolean
  /** True when a stale durable observation was returned after collection failed. */
  recovered?: boolean
}

export interface ProbeSnapshotPersistence {
  list(query?: { vaultId?: string; providerKind?: string; providerId?: string; hostId?: string }): Promise<PersistedProbeSnapshotRecord[]>
  save(snapshot: ProbeSnapshot, vaultId: string, updatedAt?: number): Promise<void>
  remove(query?: { vaultId?: string; providerKind?: string; providerId?: string; hostId?: string }): Promise<void>
}

interface CachedProbe {
  snapshot: ProbeSnapshot
}

interface Waiter {
  resolve: () => void
}

interface ProbeWorkResult {
  snapshot: ProbeSnapshot
  recovered: boolean
}

function providerKey(provider: ProbeProvider) {
  return `${provider.ref.kind}:${provider.ref.id}`
}

function requestSections(request: ProbeScheduleRequest): ProbeSection[] {
  return [...new Set(request.sections?.length ? request.sections : ['metrics', 'inventory'])] as ProbeSection[]
}

function observationFresh(snapshot: ProbeSnapshot, sections: ProbeSection[], now: number) {
  return sections.every((section) => {
    const observation = section === 'metrics' || section === 'inventory' ? snapshot[section] : null
    return observation !== null
      && !observation.freshness.expired
      && now <= observation.freshness.expiresAt
  })
}

function probeCollectionFailed(snapshot: ProbeSnapshot, fallback: ProbeSnapshot, sections: ProbeSection[]) {
  if (snapshot.errors.length === 0) return false
  return sections.some((section) => (
    (section === 'metrics' || section === 'inventory') && snapshot[section] === null && fallback[section] !== null
  ))
}

function mergeRecoveredProbeSnapshot(
  current: ProbeSnapshot,
  fallback: ProbeSnapshot,
  sections: ProbeSection[],
  error: unknown,
  now: number,
) {
  const recovered = markProbeSnapshotRecovered(fallback, error, now)
  return {
    ...recovered,
    ...current,
    metrics: sections.includes('metrics') ? (current.metrics ?? recovered.metrics) : current.metrics,
    inventory: sections.includes('inventory') ? (current.inventory ?? recovered.inventory) : current.inventory,
    // Preserve the provider error while retaining the stale-cache marker.
    errors: [...current.errors, ...recovered.errors.filter((entry) => entry.code === 'stale-cache-fallback')],
    health: 'stale' as const,
  }
}

/** Recompute expiry on hydration. Persisted `expired` is a point-in-time
 * value and must never be trusted after an application restart. */
export function refreshProbeSnapshotFreshness(snapshot: ProbeSnapshot, now = Date.now()): ProbeSnapshot {
  const refresh = <T>(observation: ProbeObservation<T> | null): ProbeObservation<T> | null => {
    if (!observation) return null
    return {
      ...observation,
      freshness: {
        ...observation.freshness,
        expired: now > observation.freshness.expiresAt,
      },
    }
  }
  const metrics = refresh(snapshot.metrics)
  const inventory = refresh(snapshot.inventory)
  const expired = [metrics, inventory].filter(Boolean).some((observation) => observation!.freshness.expired)
  const health = expired && (snapshot.health === 'online' || snapshot.health === 'stale')
    ? 'stale' as const
    : snapshot.health
  return { ...snapshot, metrics, inventory, health }
}

export function markProbeSnapshotRecovered(snapshot: ProbeSnapshot, error: unknown, now = Date.now()): ProbeSnapshot {
  const refreshed = refreshProbeSnapshotFreshness(snapshot, now)
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...refreshed,
    health: refreshed.metrics || refreshed.inventory ? 'stale' : 'unknown',
    errors: [
      ...refreshed.errors,
      { section: 'provider', code: 'stale-cache-fallback', message: `Fresh probe failed; using persisted observation: ${message}` },
    ],
  }
}

function cacheKey(provider: ProbeProvider, host: HostProfile, sections: ProbeSection[], vaultId?: string) {
  return `${vaultId || '-'}:${providerKey(provider)}:${host.id}:${sections.slice().sort().join(',')}`
}

/**
 * A small process-wide registry that makes provider selection, TTL handling,
 * remote concurrency and durable observation recovery shared by monitor,
 * Workspace, Komari and MCP callers. Vault scope is required before a row is
 * loaded or written; secrets never enter a ProbeSnapshot.
 */
export class ProbeProviderRegistry {
  private readonly providers = new Map<string, ProbeProvider>()
  private readonly cache = new Map<string, CachedProbe>()
  private readonly inFlight = new Map<string, Promise<ProbeWorkResult>>()
  private readonly waiters: Waiter[] = []
  private active = 0
  private readonly concurrency: number
  private readonly persistence: ProbeSnapshotPersistence
  private readonly hydrations = new Map<string, Promise<void>>()
  private hydratedRecords: PersistedProbeSnapshotRecord[] = []

  constructor(
    concurrency = DEFAULT_PROBE_SCHEDULER_CONCURRENCY,
    persistence: ProbeSnapshotPersistence = {
      list: listPersistedProbeSnapshots,
      save: upsertPersistedProbeSnapshot,
      remove: deletePersistedProbeSnapshots,
    },
  ) {
    this.concurrency = concurrency
    this.persistence = persistence
  }

  register(provider: ProbeProvider) {
    this.providers.set(providerKey(provider), provider)
    this.providers.set(provider.ref.id, provider)
    this.providers.set(provider.ref.kind, provider)
    // A Komari/ShellBeam provider can be registered after the default SSH
    // provider has hydrated. Apply its durable rows as soon as it appears.
    this.applyHydratedRecords(provider)
    return this
  }

  get(providerId: string) {
    return this.providers.get(providerId) ?? this.providers.get(`ssh-agentless:${providerId}`)
  }

  clear(hostId?: string) {
    if (!hostId) {
      this.cache.clear()
      return
    }
    for (const key of this.cache.keys()) {
      if (key.includes(`:${hostId}:`)) this.cache.delete(key)
    }
    // Durable records are scoped to a vault. Callers should use clearScoped
    // when they intend to remove persisted rows; clearing an in-memory host
    // cache without a scope must never delete another vault's record.
  }

  async clearScoped(vaultId: string, hostId?: string) {
    const normalizedVaultId = vaultId.trim()
    if (!normalizedVaultId) return
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${normalizedVaultId}:`) && (!hostId || key.includes(`:${hostId}:`))) this.cache.delete(key)
    }
    await this.persistence.remove({ vaultId: normalizedVaultId, ...(hostId ? { hostId } : {}) }).catch(() => undefined)
  }

  private async hydrate(vaultId: string) {
    if (!this.hydrations.has(vaultId)) {
      const hydration = this.persistence.list({ vaultId }).then((records) => {
        this.hydratedRecords = records
        for (const provider of new Set(this.providers.values())) this.applyHydratedRecords(provider, vaultId)
      }).catch(() => undefined)
      this.hydrations.set(vaultId, hydration)
    }
    await this.hydrations.get(vaultId)
  }

  private applyHydratedRecords(provider: ProbeProvider, vaultId?: string) {
    for (const record of this.hydratedRecords) {
      if (record.providerId !== provider.ref.id || record.providerKind !== provider.ref.kind || (vaultId && record.vaultId !== vaultId)) continue
      const host = { id: record.hostId } as HostProfile
      // The row carries the durable expiry used by the storage transaction.
      // Copy it into the envelope before checking freshness so an older
      // in-memory TTL cannot make a persisted observation appear fresh.
      const snapshot = {
        ...record.snapshot,
        metrics: record.snapshot.metrics
          ? { ...record.snapshot.metrics, freshness: { ...record.snapshot.metrics.freshness, sampledAt: record.sampledAt, expiresAt: record.expiresAt } }
          : null,
        inventory: record.snapshot.inventory
          ? { ...record.snapshot.inventory, freshness: { ...record.snapshot.inventory.freshness, sampledAt: record.sampledAt, expiresAt: record.expiresAt } }
          : null,
      }
      if (snapshot.metrics) this.cache.set(cacheKey(provider, host, ['metrics'], record.vaultId), { snapshot })
      if (snapshot.inventory) this.cache.set(cacheKey(provider, host, ['inventory'], record.vaultId), { snapshot })
      if (snapshot.metrics && snapshot.inventory) this.cache.set(cacheKey(provider, host, ['inventory', 'metrics'], record.vaultId), { snapshot })
    }
  }

  private async acquire() {
    const limit = Math.max(1, Math.floor(this.concurrency) || DEFAULT_PROBE_SCHEDULER_CONCURRENCY)
    if (this.active < limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ resolve }))
    this.active += 1
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    this.waiters.shift()?.resolve()
  }

  async probe(request: ProbeScheduleRequest): Promise<ProbeScheduleResult> {
    const vaultId = request.vaultId?.trim() || undefined
    if (vaultId) await this.hydrate(vaultId)
    const sections = requestSections(request)
    const provider = this.get(request.providerId ?? 'ssh-agentless')
    if (!provider) throw new Error(`probe_provider_unavailable:${request.providerId ?? 'ssh-agentless'}`)
    const now = request.now ?? Date.now()
    const key = cacheKey(provider, request.host, sections, vaultId)
    const cached = this.cache.get(key)
    if (cached) {
      cached.snapshot = refreshProbeSnapshotFreshness(cached.snapshot, now)
      this.cache.set(key, cached)
    }
    if (!request.force && cached && observationFresh(cached.snapshot, sections, now)) {
      return { snapshot: cached.snapshot, cached: true, deduplicated: false }
    }
    const existing = this.inFlight.get(key)
    if (existing) {
      const result = await existing
      return { snapshot: result.snapshot, cached: false, deduplicated: true, recovered: result.recovered }
    }
    const providerRequest: ProbeRequest = { ...request, sections }
    const work = (async () => {
      await this.acquire()
      try {
        const snapshot = await provider.probe(providerRequest)
        const fallback = this.cache.get(key)
        if (fallback && probeCollectionFailed(snapshot, fallback.snapshot, sections)) {
          return { snapshot: mergeRecoveredProbeSnapshot(snapshot, fallback.snapshot, sections, snapshot.errors[0]?.message ?? 'provider returned no observation', now), recovered: true }
        }
        this.cache.set(key, { snapshot })
        if (vaultId) void this.persistence.save(snapshot, vaultId, now).catch(() => undefined)
        return { snapshot, recovered: false }
      } catch (error) {
        const fallback = this.cache.get(key)
        if (!fallback) throw error
        return { snapshot: markProbeSnapshotRecovered(fallback.snapshot, error, now), recovered: true }
      } finally {
        this.release()
      }
    })()
    this.inFlight.set(key, work)
    try {
      const result = await work
      return { snapshot: result.snapshot, cached: false, deduplicated: false, recovered: result.recovered }
    } finally {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key)
    }
  }

  async probeWithFallback(
    request: ProbeScheduleRequest,
    providerIds: string[],
  ): Promise<ProbeScheduleResult> {
    let last: ProbeScheduleResult | undefined
    for (const providerId of providerIds) {
      try {
        const result = await this.probe({ ...request, providerId })
        last = result
        // A stale durable recovery is useful continuity, but a later provider
        // may still have a fresh observation. Keep trying until an online
        // provider succeeds, then return the stale result only as a last resort.
        if (result.snapshot.health === 'online') return result
      } catch {
        // A provider can be unavailable without preventing a later fallback.
      }
    }
    if (last) return last
    throw new Error('probe_provider_unavailable')
  }
}

const defaultRegistry = new ProbeProviderRegistry()
defaultRegistry.register(createAgentlessSshProbeProvider())

export function getProbeProviderRegistry() {
  return defaultRegistry
}

export function providerSupports(provider: ProbeProvider, capability: ProbeCapability) {
  return provider.ref.capabilities.includes(capability)
}
