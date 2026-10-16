import type { HostProfile } from './hosts'
import {
  createAgentlessSshProbeProvider,
  type ProbeCapability,
  type ProbeProvider,
  type ProbeRequest,
  type ProbeSection,
  type ProbeSnapshot,
} from './probe-provider'

export const DEFAULT_PROBE_SCHEDULER_CONCURRENCY = 3

export interface ProbeScheduleRequest extends ProbeRequest {
  /** Provider id or kind. Defaults to the agentless SSH provider. */
  providerId?: string
  /** Bypass the observation TTL while still deduplicating concurrent work. */
  force?: boolean
}

export interface ProbeScheduleResult {
  snapshot: ProbeSnapshot
  cached: boolean
  deduplicated: boolean
}

interface CachedProbe {
  snapshot: ProbeSnapshot
}

interface Waiter {
  resolve: () => void
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

function cacheKey(provider: ProbeProvider, host: HostProfile, sections: ProbeSection[]) {
  return `${providerKey(provider)}:${host.id}:${sections.slice().sort().join(',')}`
}

/**
 * A small process-wide registry that makes provider selection, TTL handling and
 * remote concurrency shared by monitor, Workspace and Komari callers. It does
 * not persist secrets or observations; the existing persistence layers remain
 * responsible for durable cache records.
 */
export class ProbeProviderRegistry {
  private readonly providers = new Map<string, ProbeProvider>()
  private readonly cache = new Map<string, CachedProbe>()
  private readonly inFlight = new Map<string, Promise<ProbeSnapshot>>()
  private readonly waiters: Waiter[] = []
  private active = 0
  private readonly concurrency: number

  constructor(concurrency = DEFAULT_PROBE_SCHEDULER_CONCURRENCY) {
    this.concurrency = concurrency
  }

  register(provider: ProbeProvider) {
    this.providers.set(providerKey(provider), provider)
    this.providers.set(provider.ref.id, provider)
    this.providers.set(provider.ref.kind, provider)
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
    const sections = requestSections(request)
    const provider = this.get(request.providerId ?? 'ssh-agentless')
    if (!provider) throw new Error(`probe_provider_unavailable:${request.providerId ?? 'ssh-agentless'}`)
    const now = request.now ?? Date.now()
    const key = cacheKey(provider, request.host, sections)
    const cached = this.cache.get(key)
    if (!request.force && cached && observationFresh(cached.snapshot, sections, now)) {
      return { snapshot: cached.snapshot, cached: true, deduplicated: false }
    }
    const existing = this.inFlight.get(key)
    if (existing) {
      return { snapshot: await existing, cached: false, deduplicated: true }
    }
    const providerRequest: ProbeRequest = { ...request, sections }
    const work = (async () => {
      await this.acquire()
      try {
        const snapshot = await provider.probe(providerRequest)
        this.cache.set(key, { snapshot })
        return snapshot
      } finally {
        this.release()
      }
    })()
    this.inFlight.set(key, work)
    try {
      return { snapshot: await work, cached: false, deduplicated: false }
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
        if (result.snapshot.health === 'online' || result.snapshot.health === 'stale') return result
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
