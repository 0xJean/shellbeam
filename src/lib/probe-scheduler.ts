import { hasSshConnection } from './hosts'
import { COLLECTION_LIMITS, collectionConcurrency } from './collection-limits'
import type { HostProfile } from './hosts'
import {
  createAgentlessSshProbeProvider,
  refreshProbeFreshness,
  validateProbeSnapshotSources,
  type ProbeCapability,
  type ProbeProvider,
  type ProbeObservation,
  type ProbeRequest,
  type ProbeSection,
  type ProbeSnapshot,
  type ProbeProviderTelemetry,
} from './probe-provider'
import {
  deletePersistedProbeSnapshots,
  listPersistedProbeSnapshots,
  upsertPersistedProbeSnapshot,
  type PersistedProbeSnapshotRecord,
} from './probe-persistence'
import {
  DEFAULT_PROBE_RECOVERY_MAX_RETRIES,
  DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS,
  MAX_PROBE_RECOVERY_RETRY_DELAY_MS,
} from './probe-scheduler-constants'
import { loadProbeRetrySettings, type ProbeRetrySettings } from './probe-retry-settings'
import { beginProbeCollectionSequence, emitProbeCollection, emitProbeCollectionDiagnostic, getProbeCollectionConfigRevision, probeCollectionConfigurationKey, type ProbeCollectionEvent, type ProbeCollectionSection } from './probe-collection-events'

export const DEFAULT_PROBE_SCHEDULER_CONCURRENCY = COLLECTION_LIMITS.scheduler.concurrency
/** Additional attempts made before returning a stale durable observation. */
export { DEFAULT_PROBE_RECOVERY_MAX_RETRIES, DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS, MAX_PROBE_RECOVERY_RETRY_DELAY_MS }

export interface ProbeScheduleRequest extends ProbeRequest {
  /** Vault scope for durable cache records. Requests without it remain
   * process-local to avoid leaking observations across vaults. */
  vaultId?: string
  /** Provider id or kind. Defaults to the agentless SSH provider. */
  providerId?: string
  /** Bypass the observation TTL while still deduplicating concurrent work. */
  force?: boolean
  /** Number of attempts after the initial provider collection. */
  maxRetries?: number
  /** Initial delay between recovery attempts. Exponential backoff is applied. */
  retryDelayMs?: number
}

export interface ProbeRetryStatus {
  /** Number of retries actually attempted; the initial call is not counted. */
  attempts: number
  /** Whether the provider was still failing after the retry budget. */
  exhausted: boolean
  error?: string
}

export interface ProbeScheduleResult {
  snapshot: ProbeSnapshot
  cached: boolean
  deduplicated: boolean
  /** True when a stale durable observation was returned after collection failed. */
  recovered?: boolean
  retry?: ProbeRetryStatus
}

export interface ProbeSnapshotPersistence {
  list(query?: { vaultId?: string; providerKind?: string; providerId?: string; hostId?: string }): Promise<PersistedProbeSnapshotRecord[]>
  save(snapshot: ProbeSnapshot, vaultId: string, updatedAt?: number): Promise<void>
  remove(query?: { vaultId?: string; providerKind?: string; providerId?: string; hostId?: string }): Promise<void>
}

interface CachedProbe {
  snapshot: ProbeSnapshot
  configurationKey?: string
  collectedAt?: number
}

interface Waiter {
  resolve: () => void
}

interface ProbeWorkResult {
  snapshot: ProbeSnapshot
  recovered: boolean
  retry?: ProbeRetryStatus
}

function collectionTelemetry(options: {
  status: ProbeProviderTelemetry['status']
  startedAt: number
  completedAt?: number
  attempts: number
  maxRetries: number
  retryDelayMs: number
  recovered: boolean
  exhausted: boolean
  sections: ProbeSection[]
  lastError?: string
  lastErrorCode?: string
}): ProbeProviderTelemetry {
  const completedAt = options.completedAt ?? Date.now()
  return {
    status: options.status,
    startedAt: options.startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - options.startedAt),
    attempts: options.attempts,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    recovered: options.recovered,
    exhausted: options.exhausted,
    sections: options.sections,
    ...(options.lastError ? { lastError: options.lastError } : {}),
    ...(options.lastErrorCode ? { lastErrorCode: options.lastErrorCode } : {}),
  }
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
  if (snapshot.health === 'unsupported') return false
  if (snapshot.errors.length === 0) return false
  return sections.some((section) => (
    (section === 'metrics' || section === 'inventory') && snapshot[section] === null && fallback[section] !== null
  ))
}

function probeNeedsRetry(snapshot: ProbeSnapshot, sections: ProbeSection[]) {
  if (snapshot.health === 'unsupported') return false
  if (snapshot.errors.length === 0) return false
  return sections.some((section) => (
    (section === 'metrics' || section === 'inventory') && snapshot[section] === null
  ))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function retryDelayMs(request: ProbeScheduleRequest, attempt: number, settings: ProbeRetrySettings) {
  const configured = request.retryDelayMs ?? settings.retryDelayMs
  const base = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS
  return Math.min(MAX_PROBE_RECOVERY_RETRY_DELAY_MS, base * (2 ** Math.max(0, attempt - 1)))
}

function maxRetries(request: ProbeScheduleRequest, settings: ProbeRetrySettings) {
  const configured = request.maxRetries ?? settings.maxRetries
  return Math.max(0, Math.min(COLLECTION_LIMITS.scheduler.maxRetries, Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_PROBE_RECOVERY_MAX_RETRIES))
}

function retryError(attempts: number, error: unknown) {
  const suffix = error ? `: ${errorMessage(error)}` : ''
  return {
    section: 'provider' as const,
    code: 'recovery-retry-exhausted',
    message: `Probe recovery failed after ${attempts} retr${attempts === 1 ? 'y' : 'ies'}${suffix}`,
  }
}

function mergeRecoveredProbeSnapshot(
  current: ProbeSnapshot,
  fallback: ProbeSnapshot,
  sections: ProbeSection[],
  error: unknown,
  now: number,
  retry?: ProbeRetryStatus,
) {
  const recovered = markProbeSnapshotRecovered(fallback, error, now)
  const retryMarker = retry?.exhausted ? retryError(retry.attempts, retry.error) : null
  return {
    ...recovered,
    ...current,
    metrics: sections.includes('metrics') ? (current.metrics ?? recovered.metrics) : current.metrics,
    inventory: sections.includes('inventory') ? (current.inventory ?? recovered.inventory) : current.inventory,
    // Preserve the provider error while retaining the stale-cache marker.
    errors: [
      ...current.errors,
      ...(retryMarker ? [retryMarker] : []),
      ...recovered.errors.filter((entry) => entry.code === 'stale-cache-fallback'),
    ],
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
      freshness: refreshProbeFreshness(observation.freshness, now),
    }
  }
  snapshot = validateProbeSnapshotSources(snapshot, now)
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

function matchesSshRoute(snapshot: ProbeSnapshot, host: HostProfile) {
  if (snapshot.host.address !== host.address || snapshot.host.port !== (host.port || 22) || snapshot.host.username !== (host.username || 'root')) return false
  const jump = snapshot.host.jump
  if (host.jumpHostId) return snapshot.transport === 'proxy-jump' && jump?.hostId === host.jumpHostId
  if (host.jumpHost?.trim()) return snapshot.transport === 'proxy-jump' && !jump?.hostId
    && jump?.address === host.jumpHost.trim() && jump.port === (host.jumpPort || 22) && jump.username === (host.jumpUser?.trim() || host.username || 'root')
  return snapshot.transport === 'direct' && !jump
}

function collectionScopeUnavailable(snapshot: ProbeSnapshot | undefined, error: unknown, section: ProbeCollectionSection) {
  if (error instanceof Error && error.name === 'AbortError') return true
  const entries = snapshot?.errors.filter(entry => entry.section === 'provider' || entry.section === section) ?? []
  const messages = [errorMessage(error), ...entries.flatMap(entry => [entry.code ?? '', entry.message])]
  // Names such as vault.example or identity.example can occur in a genuine
  // network failure. Only native codes and explicit control-state phrases
  // establish that no availability conclusion can be drawn.
  const controlCode = /(?:^|[\s:"{,(])(?:VAULT_(?:LOCKED|NOT_INITIALIZED|UNAVAILABLE|SCOPE_MISMATCH)|PROBE_(?:IDENTITY|VAULT_SCOPE)_MISMATCH|WORKSPACE_VAULT_SCOPE_MISMATCH|HOST_VAULT_SCOPE_MISMATCH|HOST_NOT_FOUND|JUMP_HOST_NOT_FOUND|MISSING_CREDENTIAL|UNSUPPORTED_AUTH_TYPE|OBSERVATION_SOURCE_INVALID|HOST_KEY_(?:UNKNOWN|MISMATCH))(?:$|[\s:"},)])/i
  return messages.some(message => controlCode.test(message)
    || /^(?:cancelled|canceled|aborted|operation_cancelled|request_cancelled)$/i.test(message)
    || /\bvault (?:is |was )?(?:locked|not initialized)\b/i.test(message)
    || /\bSSH (?:target|jump) credential_unavailable\b/.test(message)
    || /^(?:connection|probe|operation|request|collection) (?:was )?(?:cancelled|canceled|aborted)[.!]?$/i.test(message))
}

function completedCollectionSections(sections: ProbeSection[], snapshot: ProbeSnapshot | undefined, error: unknown, exhausted: boolean, completedAt: number): ProbeCollectionEvent['sections'] {
  return sections.filter((section): section is ProbeCollectionSection => section === 'metrics' || section === 'inventory').map(section => {
    const observation = snapshot?.[section]
    const sampledAt = observation?.freshness.sampledAt ?? null
    if (snapshot?.health === 'unsupported' || snapshot?.errors.some(entry => (entry.section === 'provider' || entry.section === section) && /unsupported/i.test(entry.code ?? ''))) return { section, outcome: 'unknown', sampledAt, reason: 'unsupported' }
    if (snapshot?.health === 'paused') return { section, outcome: 'unknown', sampledAt, reason: 'paused' }
    if (collectionScopeUnavailable(snapshot, error, section)) return { section, outcome: 'unknown', sampledAt, reason: 'scope-unavailable' }
    const sectionErrors = snapshot?.errors.filter(entry => entry.section === section || entry.section === 'provider') ?? []
    const fresh = observation && snapshot?.health === 'online' && !snapshot.telemetry?.recovered
      && observation.freshness.sampledAt <= completedAt && completedAt <= Math.min(observation.freshness.expiresAt, observation.freshness.sampledAt + observation.freshness.ttlMs)
      && !sectionErrors.some(entry => entry.code === 'stale-cache-fallback')
    if (fresh && sectionErrors.length === 0) return { section, outcome: 'success', sampledAt, reason: 'observed' }
    if (exhausted && !observation) return { section, outcome: 'failure', sampledAt: null, reason: 'collection-unavailable' }
    return { section, outcome: 'unknown', sampledAt, reason: 'observation-unavailable' }
  })
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

  /** A local source reassignment invalidates latest observations, never history. */
  invalidateProvider(vaultId: string, providerId: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${vaultId}:komari:${providerId}:`)) this.cache.delete(key)
    }
    this.hydratedRecords = this.hydratedRecords.filter((record) => record.vaultId !== vaultId || record.providerId !== providerId || record.providerKind !== 'komari')
  }

  async clearScoped(vaultId: string, hostId?: string) {
    const normalizedVaultId = vaultId.trim()
    if (!normalizedVaultId) return
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${normalizedVaultId}:`) && (!hostId || key.includes(`:${hostId}:`))) this.cache.delete(key)
    }
    this.hydratedRecords = this.hydratedRecords.filter((record) => record.vaultId !== normalizedVaultId || Boolean(hostId && record.hostId !== hostId))
    await this.persistence.remove({ vaultId: normalizedVaultId, ...(hostId ? { hostId } : {}) }).catch(() => undefined)
  }

  private async hydrate(vaultId: string) {
    if (!this.hydrations.has(vaultId)) {
      const hydration = this.persistence.list({ vaultId }).then((records) => {
        this.hydratedRecords = [...this.hydratedRecords.filter((record) => record.vaultId !== vaultId), ...records.filter((record) => record.vaultId === vaultId)]
        for (const provider of new Set(this.providers.values())) this.applyHydratedRecords(provider, vaultId)
      }).catch(() => undefined)
      this.hydrations.set(vaultId, hydration)
    }
    await this.hydrations.get(vaultId)
  }

  private applyHydratedRecords(provider: ProbeProvider, vaultId?: string) {
    for (const record of this.hydratedRecords) {
      if (record.providerId !== provider.ref.id || record.providerKind !== provider.ref.kind || (vaultId && record.vaultId !== vaultId)) continue
      if (record.snapshot?.host?.hostId !== record.hostId
        || record.snapshot?.provider?.id !== record.providerId
        || record.snapshot?.provider?.kind !== record.providerKind) continue
      const host = { id: record.hostId } as HostProfile
      // The row carries the durable expiry used by the storage transaction.
      // Copy it into the envelope before checking freshness so an older
      // in-memory TTL cannot make a persisted observation appear fresh.
      const original = validateProbeSnapshotSources(record.snapshot)
      const rowIndexesMetrics = Boolean(record.snapshot.metrics)
      const snapshot = {
        ...original,
        metrics: original.metrics
          ? { ...original.metrics, freshness: { ...original.metrics.freshness, expiresAt: Math.min(original.metrics.freshness.expiresAt, record.expiresAt) } }
          : null,
        // The row indexes the primary observation. Inventory collected at a
        // different time must retain its own original timestamp and TTL.
        inventory: original.inventory
          ? { ...original.inventory, freshness: { ...original.inventory.freshness, expiresAt: rowIndexesMetrics ? original.inventory.freshness.expiresAt : Math.min(original.inventory.freshness.expiresAt, record.expiresAt) } }
          : null,
      }
      if (snapshot.metrics) this.cache.set(cacheKey(provider, host, ['metrics'], record.vaultId), { snapshot, collectedAt: record.updatedAt })
      if (snapshot.inventory) this.cache.set(cacheKey(provider, host, ['inventory'], record.vaultId), { snapshot, collectedAt: record.updatedAt })
      if (snapshot.metrics && snapshot.inventory) this.cache.set(cacheKey(provider, host, ['inventory', 'metrics'], record.vaultId), { snapshot, collectedAt: record.updatedAt })
    }
  }

  private async acquire() {
    const limit = collectionConcurrency(this.concurrency)
    if (this.active < limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ resolve }))
    // release hands this waiter its existing slot, with no transient free
    // capacity in which a newly arriving request could overtake it.
  }

  private release() {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve()
    else this.active = Math.max(0, this.active - 1)
  }

  async probe(request: ProbeScheduleRequest): Promise<ProbeScheduleResult> {
    if (request.vaultId && request.host.vaultId && request.vaultId !== request.host.vaultId) throw new Error('PROBE_VAULT_SCOPE_MISMATCH')
    const vaultId = request.vaultId?.trim() || request.host.vaultId?.trim() || undefined
    // Snapshot the configuration before any asynchronous hydration. A newer
    // host edit must neither join this work nor reuse its recovery candidate.
    const configuration = { ...request.host, vaultId }
    const configurationKey = probeCollectionConfigurationKey(configuration)
    const provider = this.get(request.providerId ?? 'ssh-agentless')
    if (!provider) throw new Error(`probe_provider_unavailable:${request.providerId ?? 'ssh-agentless'}`)
    if (request.host.monitoringMode === 'ssh' && provider.ref.kind !== 'ssh-agentless') throw new Error('HOST_MONITORING_SERVER_REQUIRED')
    if (vaultId) await this.hydrate(vaultId)
    const sections = requestSections(request)
    if (provider.ref.kind === 'ssh-agentless' && !hasSshConnection(request.host)) throw new Error('HOST_CONNECTION_REQUIRED')
    const now = request.now ?? Date.now()
    const key = cacheKey(provider, request.host, sections, vaultId)
    const readCached = () => {
      const candidate = this.cache.get(key)
      if (!candidate || candidate.configurationKey !== undefined && candidate.configurationKey !== configurationKey) return undefined
      if (provider.ref.kind === 'ssh-agentless' && !matchesSshRoute(candidate.snapshot, configuration)) return undefined
      if (provider.ref.kind === 'ssh-agentless' && candidate.configurationKey === undefined && configuration.updatedAt > (candidate.collectedAt ?? 0)) return undefined
      return candidate
    }
    const cached = readCached()
    if (cached) {
      cached.snapshot = refreshProbeSnapshotFreshness(cached.snapshot, now)
      this.cache.set(key, cached)
    }
    if (!request.force && cached && observationFresh(cached.snapshot, sections, now)) {
      return { snapshot: cached.snapshot, cached: true, deduplicated: false }
    }
    const workKey = JSON.stringify([key, configurationKey])
    const existing = this.inFlight.get(workKey)
    if (existing) {
      const result = await existing
      return { snapshot: result.snapshot, cached: false, deduplicated: true, recovered: result.recovered, retry: result.retry }
    }
    const providerRequest: ProbeRequest = { ...request, host: configuration, vaultId, sections }
    const startedAt = Date.now()
    const startedSequence = beginProbeCollectionSequence()
    let actualSnapshot: ProbeSnapshot | undefined
    let actualError: unknown
    let actualExhausted = false
    const collection = (async () => {
      await this.acquire()
      try {
        const retrySettings = loadProbeRetrySettings()
        const retryBudget = maxRetries(request, retrySettings)
        const configuredRetryDelayMs = retryDelayMs(request, 1, retrySettings)
        let snapshot: ProbeSnapshot | undefined
        let lastError: unknown
        let lastErrorCode: string | undefined
        let attempts = 0
        let failed = false
        for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
          try {
            const collected = await provider.probe(providerRequest)
            if (collected.host?.hostId !== request.host.id || collected.provider?.id !== provider.ref.id || collected.provider?.kind !== provider.ref.kind) throw new Error('PROBE_IDENTITY_MISMATCH')
            if (provider.ref.kind === 'ssh-agentless' && !matchesSshRoute(collected, configuration)) throw new Error('PROBE_IDENTITY_MISMATCH')
            snapshot = refreshProbeSnapshotFreshness(collected, request.now ?? Date.now())
            actualSnapshot = snapshot
            actualError = undefined
            failed = probeNeedsRetry(snapshot, sections)
            if (!failed) break
            const latestError = snapshot.errors.find((entry) => entry.section === 'provider' || sections.includes(entry.section as ProbeSection))
            lastError = latestError?.message
            lastErrorCode = latestError?.code
          } catch (error) {
            actualSnapshot = undefined
            actualError = error
            lastError = error
            failed = true
          }
          if (attempt >= retryBudget) break
          attempts += 1
          const delay = retryDelayMs(request, attempts, retrySettings)
          if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
        }
        actualExhausted = failed
        if (!snapshot) throw lastError ?? new Error('probe_provider_failed')
        const retry = attempts > 0 || failed
          ? { attempts, exhausted: failed, ...(lastError ? { error: errorMessage(lastError) } : {}) }
          : undefined
        const fallback = readCached()
        if (fallback && probeCollectionFailed(snapshot, fallback.snapshot, sections)) {
          const recoveredTelemetry = collectionTelemetry({
            status: 'recovered',
            startedAt,
            attempts,
            maxRetries: retryBudget,
            retryDelayMs: configuredRetryDelayMs,
            recovered: true,
            exhausted: Boolean(retry?.exhausted),
            sections,
            ...(retry?.error ? { lastError: retry.error } : {}),
            ...(lastErrorCode ? { lastErrorCode } : {}),
          })
          const recoveredSnapshot = mergeRecoveredProbeSnapshot(
            snapshot,
            fallback.snapshot,
            sections,
            snapshot.errors[0]?.message ?? lastError ?? 'provider returned no observation',
            now,
            retry,
          )
          // Preserve the last successful observation while retaining the
          // latest failure/recovery telemetry for the next session.  The
          // sampled data remains stale; this write never replaces it with an
          // incomplete provider envelope.
          const recoveredSnapshotWithTelemetry = { ...recoveredSnapshot, telemetry: recoveredTelemetry }
          this.cache.set(key, { snapshot: recoveredSnapshotWithTelemetry, configurationKey })
          if (vaultId) void this.persistence.save(recoveredSnapshotWithTelemetry, vaultId, now).catch(() => undefined)
          return {
            snapshot: recoveredSnapshotWithTelemetry,
            recovered: true,
            retry,
          }
        }
        if (retry?.exhausted) {
          snapshot = {
            ...snapshot,
            errors: [...snapshot.errors, retryError(retry.attempts, retry.error)],
          }
        }
        const telemetry = collectionTelemetry({
          status: retry?.exhausted ? 'failed' : 'success',
          startedAt,
          attempts,
          maxRetries: retryBudget,
          retryDelayMs: configuredRetryDelayMs,
          recovered: false,
          exhausted: Boolean(retry?.exhausted),
          sections,
          ...(retry?.error ? { lastError: retry.error } : {}),
          ...(lastErrorCode ? { lastErrorCode } : {}),
        })
        snapshot = { ...snapshot, telemetry }
        this.cache.set(key, { snapshot, configurationKey })
        // A failed envelope must not replace the durable recovery candidate;
        // stale recovery writes happen in the fallback branch above and keep
        // the last successful observation intact.
        if (vaultId && !retry?.exhausted) void this.persistence.save(snapshot, vaultId, now).catch(() => undefined)
        return { snapshot, recovered: false, retry }
      } catch (error) {
        actualError = error
        actualExhausted = true
        const fallback = readCached()
        if (!fallback) throw error
        const retrySettings = loadProbeRetrySettings()
        const retry = { attempts: maxRetries(request, retrySettings), exhausted: true, error: errorMessage(error) }
        const recovered = markProbeSnapshotRecovered(fallback.snapshot, error, now)
        const errors = [...recovered.errors]
        const staleIndex = errors.findIndex((entry) => entry.code === 'stale-cache-fallback')
        const marker = retryError(retry.attempts, retry.error)
        if (staleIndex >= 0) errors.splice(staleIndex, 0, marker)
        else errors.push(marker)
        const recoveredSnapshot = {
          ...recovered,
          errors,
          telemetry: collectionTelemetry({
            status: 'recovered',
            startedAt,
            attempts: retry.attempts,
            maxRetries: maxRetries(request, retrySettings),
            retryDelayMs: retryDelayMs(request, 1, retrySettings),
            recovered: true,
            exhausted: true,
            sections,
            lastError: retry.error,
          }),
        }
        this.cache.set(key, { snapshot: recoveredSnapshot, configurationKey })
        if (vaultId) void this.persistence.save(recoveredSnapshot, vaultId, now).catch(() => undefined)
        return {
          snapshot: recoveredSnapshot,
          recovered: true,
          retry,
        }
      } finally {
        this.release()
      }
    })()
    // Attach once to the shared work. Cache reads and coalesced callers never
    // emit another collection or mistake recovered observations for success.
    const publish = async () => {
      if (!vaultId || provider.ref.kind !== 'ssh-agentless') return
      const completedAt = Date.now()
      const outcomes = completedCollectionSections(sections, actualSnapshot, actualError, actualExhausted, completedAt)
      if (!outcomes.length) return
      emitProbeCollection({
        eventId: crypto.randomUUID(), vaultId, hostId: configuration.id,
        configRevision: await getProbeCollectionConfigRevision(configuration),
        provider: { kind: provider.ref.kind, id: provider.ref.id },
        transport: configuration.jumpHostId || configuration.jumpHost?.trim() ? 'proxy-jump' : 'direct',
        startedAt, startedSequence, completedAt, sections: outcomes,
      })
    }
    const publishSafely = () => publish().catch(() => {
      emitProbeCollectionDiagnostic({ code: 'publication-unavailable', vaultId: vaultId!, hostId: configuration.id, startedAt, startedSequence })
    })
    const work = collection.then(async result => { await publishSafely(); return result }, async error => { await publishSafely(); throw error })
    this.inFlight.set(workKey, work)
    try {
      const result = await work
      return { snapshot: result.snapshot, cached: false, deduplicated: false, recovered: result.recovered, retry: result.retry }
    } finally {
      if (this.inFlight.get(workKey) === work) this.inFlight.delete(workKey)
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
