import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { HostProfile } from './hosts'
import { getHostIdentity } from './host-identity'
import { createProbeObservation, type ProbeProvider, type ProbeSnapshot } from './probe-provider'
import { ProbeProviderRegistry, refreshProbeSnapshotFreshness } from './probe-scheduler'
import type { PersistedProbeSnapshotRecord } from './probe-persistence'
import { clearProbeRetrySettings, saveProbeRetrySettings } from './probe-retry-settings'
import { currentProbeCollectionSequence, getProbeCollectionConfigRevision, subscribeProbeCollectionDiagnostics, subscribeProbeCollections, type ProbeCollectionDiagnostic, type ProbeCollectionEvent } from './probe-collection-events'

afterEach(() => clearProbeRetrySettings())

const host = (id: string): HostProfile => ({
  id,
  name: id,
  address: `${id}.example.com`,
  port: 22,
  username: 'root',
  group: '',
  authType: 'privateKey',
  privateKeyRef: 'key',
  secretKeyRef: undefined,
  passwordKeyRef: undefined,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
})

function snapshot(provider: ProbeProvider, target: HostProfile, now: number, health: ProbeSnapshot['health'] = 'online'): ProbeSnapshot {
  const data = {
    hostname: target.name,
    os: 'Linux',
    kernel: '',
    uptimeSeconds: null,
    cpuPercent: 1,
    load1: null,
    load5: null,
    load15: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    memoryPercent: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    diskPercent: null,
    networkRxBytesPerSec: null,
    networkTxBytesPerSec: null,
    latencyMs: 1,
    sampledAt: now,
  }
  return {
    schemaVersion: 1,
    host: getHostIdentity(target),
    provider: provider.ref,
    transport: target.jumpHostId || target.jumpHost?.trim() ? 'proxy-jump' : 'direct',
    health,
    receivedAt: now,
    metrics: createProbeObservation({ data, source: provider.ref, sampledAt: now, receivedAt: now, ttlMs: 1_000 }),
    inventory: null,
    errors: health === 'unknown' ? [{ section: 'metrics', message: 'unavailable' }] : [],
  }
}

function provider(id: string, probe: ProbeProvider['probe']): ProbeProvider {
  return {
    ref: { kind: 'shellbeam-agent', id, capabilities: ['metrics'] },
    probe,
  }
}

describe('ProbeProviderRegistry', () => {
  it('refuses a server provider for an explicitly SSH-only host before reading cached data or collecting', async () => {
    const provider: ProbeProvider = { ref: { kind: 'komari', id: 'server-choice', capabilities: ['metrics'] }, probe: vi.fn() }
    const store = { list: vi.fn(async () => []), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const registry = new ProbeProviderRegistry(1, store).register(provider)
    await expect(registry.probe({ host: { ...host('h'), monitoringMode: 'ssh' }, providerId: provider.ref.id, resolveAuthSecret: async () => '', now: 500 })).rejects.toThrow('HOST_MONITORING_SERVER_REQUIRED')
    expect(provider.probe).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled(); expect(store.remove).not.toHaveBeenCalled()
  })

  it('keeps valid inventory TTL when the row originally indexed an invalid metric observation', async () => {
    const item: ProbeProvider = { ref: { kind: 'komari', id: 'source-a', capabilities: ['metrics', 'inventory'] }, probe: vi.fn() }
    const old = snapshot(item, host('one'), 100)
    old.metrics!.source = { ...item.ref, id: 'foreign-source' }
    old.inventory = createProbeObservation({ data: { scannedAt: 400 } as never, source: item.ref, sampledAt: 400, receivedAt: 450, ttlMs: 1000 })
    const store = { list: vi.fn(async () => [{ vaultId: 'vault-a', providerKind: item.ref.kind, providerId: item.ref.id, hostId: 'one', snapshot: old, sampledAt: 100, receivedAt: 450, expiresAt: 200, updatedAt: 450 }]), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const result = await new ProbeProviderRegistry(1, store).register(item).probe({ host: host('one'), vaultId: 'vault-a', providerId: item.ref.id, sections: ['inventory'], resolveAuthSecret: async () => '', now: 500 })
    expect(item.probe).not.toHaveBeenCalled()
    expect(result.snapshot.metrics).toBeNull()
    expect(result.snapshot.inventory?.freshness).toMatchObject({ sampledAt: 400, expiresAt: 1400, expiryReason: null })
  })
  it('keeps inventory original freshness separate from the primary metrics row and preserves legitimate Komari node identity', async () => {
    const item: ProbeProvider = { ref: { kind: 'komari', id: 'source-a', capabilities: ['metrics', 'inventory'] }, probe: vi.fn() }
    const old = snapshot(item, host('one'), 100)
    old.metrics!.source = { ...item.ref, nodeId: 'remote-node' }
    old.inventory = createProbeObservation({ data: { resource: { arch: 'aarch64' }, scannedAt: 400 } as never, source: { ...item.ref, nodeId: 'remote-node' }, sampledAt: 400, receivedAt: 450, ttlMs: 1000 })
    const store = { list: vi.fn(async () => [{ vaultId: 'vault-a', providerKind: item.ref.kind, providerId: item.ref.id, hostId: 'one', snapshot: old, sampledAt: 100, receivedAt: 450, expiresAt: 200, updatedAt: 450 }]), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const result = await new ProbeProviderRegistry(1, store).register(item).probe({ host: host('one'), vaultId: 'vault-a', providerId: item.ref.id, sections: ['inventory'], resolveAuthSecret: async () => '', now: 500 })
    expect(result.cached).toBe(true)
    expect(item.probe).not.toHaveBeenCalled()
    expect(result.snapshot.inventory?.freshness).toMatchObject({ sampledAt: 400, expiresAt: 1400, expired: false, expiryReason: null })
    expect(result.snapshot.inventory?.source.nodeId).toBe('remote-node')
    expect(result.snapshot.inventory?.data.resource.arch).toBe('aarch64')
  })
  it('hands a released slot to its waiter before a newly arriving request can overtake it', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let active = 0
    let maximum = 0
    const item = provider('handoff', async (request) => {
      active += 1
      maximum = Math.max(maximum, active)
      if (request.host.id === 'first') await firstGate
      else await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return snapshot(item, request.host, 100)
    })
    const registry = new ProbeProviderRegistry(1).register(item)
    const request = (id: string) => ({ host: host(id), providerId: item.ref.id, sections: ['metrics'] as const, resolveAuthSecret: async () => '', now: 100 })
    const first = registry.probe(request('first'))
    await Promise.resolve()
    const waiting = registry.probe(request('waiting'))
    releaseFirst()
    const newcomer = new Promise<unknown>((resolve, reject) => queueMicrotask(() => { void registry.probe(request('new')).then(resolve, reject) }))
    await Promise.all([first, waiting, newcomer])
    expect(maximum).toBe(1)
  })
  it('rejects a foreign Vault before hydration or collection and separates implicit host Vault scopes', async () => {
    const item = provider('scoped', vi.fn(async (request) => snapshot(item, request.host, request.now ?? 0)))
    const store = { list: vi.fn(async () => []), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const target = { ...host('same'), vaultId: 'vault-a' }
    await expect(registry.probe({ host: target, vaultId: 'vault-b', providerId: item.ref.id, resolveAuthSecret: async () => '', now: 100 })).rejects.toThrow('PROBE_VAULT_SCOPE_MISMATCH')
    expect(store.list).not.toHaveBeenCalled()
    expect(item.probe).not.toHaveBeenCalled()
    const request = { host: target, providerId: item.ref.id, sections: ['metrics'] as const, resolveAuthSecret: async () => '', now: 100 }
    await registry.probe(request)
    await registry.probe({ ...request, host: { ...target, vaultId: 'vault-b' } })
    expect(item.probe).toHaveBeenCalledTimes(2)
    expect(store.list.mock.calls).toEqual([[{ vaultId: 'vault-a' }], [{ vaultId: 'vault-b' }]])
  })

  it('returns unknown for missing observation sources and never labels them as the current provider', async () => {
    const item = provider('unknown-source', async (request) => {
      const value = snapshot(item, request.host, request.now ?? 0)
      delete (value.metrics as unknown as { source?: unknown }).source
      return value
    })
    const result = await new ProbeProviderRegistry().register(item).probe({ host: host('one'), providerId: item.ref.id, sections: ['metrics'], resolveAuthSecret: async () => '', maxRetries: 0, now: 100 })
    expect(result.snapshot).toMatchObject({ health: 'unknown', metrics: null })
    expect(result.snapshot.errors).toContainEqual(expect.objectContaining({ code: 'observation_source_invalid' }))
  })

  it('does not hydrate a row whose envelope belongs to a different host or provider', async () => {
    const item = provider('current', vi.fn(async (request) => snapshot(item, request.host, request.now ?? 0)))
    const old = snapshot(item, host('different'), 100)
    const store = { list: vi.fn(async () => [{ vaultId: 'vault-a', providerKind: item.ref.kind, providerId: item.ref.id, hostId: 'one', snapshot: old, sampledAt: 100, receivedAt: 100, expiresAt: 1000, updatedAt: 100 }]), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const result = await new ProbeProviderRegistry(1, store).register(item).probe({ host: host('one'), vaultId: 'vault-a', providerId: item.ref.id, sections: ['metrics'], resolveAuthSecret: async () => '', now: 100 })
    expect(item.probe).toHaveBeenCalledTimes(1)
    expect(result.snapshot.host.hostId).toBe('one')
    expect(result.cached).toBe(false)
  })

  it('rejects a live envelope for another host without caching or persisting it', async () => {
    const item = provider('mismatched', async () => snapshot(item, host('different'), 100))
    const store = { list: vi.fn(async () => []), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    await expect(new ProbeProviderRegistry(1, store).register(item).probe({ host: host('one'), vaultId: 'vault-a', providerId: item.ref.id, sections: ['metrics'], resolveAuthSecret: async () => '', maxRetries: 0, now: 100 })).rejects.toThrow('PROBE_IDENTITY_MISMATCH')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent requests for one host and caches fresh observations', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const item = provider('agent-a', async (request) => {
      calls += 1
      await gate
      return snapshot(item, request.host, request.now ?? 0)
    })
    const registry = new ProbeProviderRegistry(2).register(item)
    const first = registry.probe({ host: host('one'), resolveAuthSecret: async () => '', providerId: 'agent-a', sections: ['metrics'], now: 100 })
    const second = registry.probe({ host: host('one'), resolveAuthSecret: async () => '', providerId: 'agent-a', sections: ['metrics'], now: 100 })
    release()
    const [one, two] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(one.deduplicated).toBe(false)
    expect(two.deduplicated).toBe(true)
    expect((await registry.probe({ host: host('one'), resolveAuthSecret: async () => '', providerId: 'agent-a', sections: ['metrics'], now: 500 })).cached).toBe(true)
    expect(calls).toBe(1)
  })

  it('persists unsupported OS once without retrying or reviving a previous Linux sample', async () => {
    const target = host('changed-os')
    const probe = vi.fn(async () => ({ ...snapshot(item, target, 500, 'unsupported'), metrics: null, inventory: null, errors: [{ section: 'provider' as const, code: 'unsupported_os', message: 'Darwin' }] }))
    const item = provider('os-check', probe)
    const old = snapshot(item, target, 100)
    const store = { list: vi.fn(async () => [{ vaultId: 'vault', providerKind: item.ref.kind, providerId: item.ref.id, hostId: target.id, snapshot: old, sampledAt: 100, receivedAt: 100, expiresAt: 200, updatedAt: 100 }]), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const result = await new ProbeProviderRegistry(1, store).register(item).probe({ host: target, vaultId: 'vault', providerId: item.ref.id, sections: ['metrics'], resolveAuthSecret: async () => '', maxRetries: 3, retryDelayMs: 0, now: 500 })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(result.recovered).toBe(false)
    expect(result.retry).toBeUndefined()
    expect(result.snapshot).toMatchObject({ health: 'unsupported', metrics: null, inventory: null })
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ health: 'unsupported', metrics: null }), 'vault', 500)
  })

  it('retries a transient provider failure with a bounded budget', async () => {
    let calls = 0
    const item = provider('retry-agent', async (request) => {
      calls += 1
      if (calls < 3) throw new Error('temporary network failure')
      return snapshot(item, request.host, request.now ?? 0)
    })
    const registry = new ProbeProviderRegistry(1).register(item)
    const result = await registry.probe({
      host: host('retry-host'),
      resolveAuthSecret: async () => '',
      providerId: item.ref.id,
      sections: ['metrics'],
      maxRetries: 2,
      retryDelayMs: 0,
      now: 100,
    })
    expect(calls).toBe(3)
    expect(result.snapshot.health).toBe('online')
    expect(result.retry).toEqual({ attempts: 2, exhausted: false, error: 'temporary network failure' })
    expect(result.snapshot.telemetry).toMatchObject({
      status: 'success',
      attempts: 2,
      maxRetries: 2,
      retryDelayMs: 0,
      recovered: false,
      exhausted: false,
      sections: ['metrics'],
    })
  })

  it('uses the persisted retry policy when a request does not override it', async () => {
    saveProbeRetrySettings({ maxRetries: 1, retryDelayMs: 0 })
    let calls = 0
    const item = provider('configured-retry-agent', async () => {
      calls += 1
      throw new Error('temporary outage')
    })
    const registry = new ProbeProviderRegistry(1).register(item)
    const result = await registry.probe({
      host: host('configured-retry-host'),
      resolveAuthSecret: async () => '',
      providerId: item.ref.id,
      sections: ['metrics'],
      now: 100,
    }).catch((error) => ({ error }))
    expect(calls).toBe(2)
    expect(result).toMatchObject({ error: expect.any(Error) })
  })

  it('returns stale recovery and records retry exhaustion after bounded failures', async () => {
    let calls = 0
    const item = provider('retry-fallback-agent', async () => {
      calls += 1
      throw new Error('agent remains offline')
    })
    const persisted = snapshot(item, host('retry-fallback-host'), 100)
    const store = {
      list: vi.fn(async () => [{
        vaultId: 'vault-retry', providerKind: item.ref.kind, providerId: item.ref.id,
        hostId: 'retry-fallback-host', snapshot: persisted, sampledAt: 100, receivedAt: 100,
        expiresAt: 200, updatedAt: 100,
      }]),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const result = await registry.probe({
      host: host('retry-fallback-host'),
      resolveAuthSecret: async () => '',
      providerId: item.ref.id,
      vaultId: 'vault-retry',
      sections: ['metrics'],
      maxRetries: 2,
      retryDelayMs: 0,
      now: 500,
    })
    expect(calls).toBe(3)
    expect(result.recovered).toBe(true)
    expect(result.retry).toMatchObject({ attempts: 2, exhausted: true })
    expect(result.snapshot.errors).toContainEqual(expect.objectContaining({ code: 'recovery-retry-exhausted' }))
    expect(result.snapshot.telemetry).toMatchObject({
      status: 'recovered',
      attempts: 2,
      maxRetries: 2,
      recovered: true,
      exhausted: true,
      sections: ['metrics'],
      lastError: 'agent remains offline',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.save).toHaveBeenCalledTimes(1)
    const savedSnapshot = (store.save.mock.calls as unknown as Array<[ProbeSnapshot]>)[0]?.[0]
    expect(savedSnapshot?.telemetry).toMatchObject({ status: 'recovered', exhausted: true })
  })

  it('enforces a shared concurrency limit across hosts', async () => {
    let active = 0
    let maximum = 0
    const item = provider('agent-b', async (request) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return snapshot(item, request.host, request.now ?? 0)
    })
    const registry = new ProbeProviderRegistry(2).register(item)
    await Promise.all(['one', 'two', 'three', 'four'].map((id) => registry.probe({
      host: host(id), resolveAuthSecret: async () => '', providerId: 'agent-b', sections: ['metrics'], force: true, now: 100,
    })))
    expect(maximum).toBe(2)
  })

  it('falls back after a provider reports an unknown observation', async () => {
    const first = provider('first', async (request) => snapshot(first, request.host, request.now ?? 0, 'unknown'))
    const second = provider('second', async (request) => snapshot(second, request.host, request.now ?? 0, 'online'))
    const registry = new ProbeProviderRegistry().register(first).register(second)
    const result = await registry.probeWithFallback({ host: host('one'), resolveAuthSecret: async () => '', sections: ['metrics'], now: 100 }, ['first', 'second'])
    expect(result.snapshot.provider.id).toBe('second')
  })

  it('clears cached observations for a host', async () => {
    const item = provider('agent-c', vi.fn(async (request) => snapshot(item, request.host, request.now ?? 0)))
    const registry = new ProbeProviderRegistry().register(item)
    const request = { host: host('one'), resolveAuthSecret: async () => '', providerId: 'agent-c', sections: ['metrics'] as const, now: 100 }
    await registry.probe(request)
    await registry.probe(request)
    expect(item.probe).toHaveBeenCalledTimes(1)
    registry.clear('one')
    await registry.probe(request)
    expect(item.probe).toHaveBeenCalledTimes(2)
  })

  it('hydrates durable observations, refreshes expiry and recovers stale data on failure', async () => {
    const item = provider('durable-agent', async () => {
      throw new Error('network unavailable')
    })
    const persisted = snapshot(item, host('durable-host'), 100)
    const record: PersistedProbeSnapshotRecord = {
      vaultId: 'vault-a',
      providerKind: item.ref.kind,
      providerId: item.ref.id,
      hostId: 'durable-host',
      snapshot: persisted,
      sampledAt: 100,
      receivedAt: 100,
      expiresAt: 200,
      updatedAt: 100,
    }
    const store = {
      list: vi.fn(async () => [record]),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const result = await registry.probe({
      host: host('durable-host'),
      resolveAuthSecret: async () => '',
      providerId: item.ref.id,
      vaultId: 'vault-a',
      sections: ['metrics'],
      now: 500,
    })
    expect(result.recovered).toBe(true)
    expect(result.snapshot.health).toBe('stale')
    expect(result.snapshot.metrics?.freshness.expired).toBe(true)
    expect(result.snapshot.errors.at(-1)).toMatchObject({ code: 'stale-cache-fallback' })
    expect(store.list).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.save).toHaveBeenCalledTimes(1)
    const savedSnapshot = (store.save.mock.calls as unknown as Array<[ProbeSnapshot]>)[0]?.[0]
    expect(savedSnapshot?.telemetry).toMatchObject({ status: 'recovered', recovered: true })
  })

  it('persists a successful observation and removes host records when cleared', async () => {
    const item = provider('persist-agent', async (request) => snapshot(item, request.host, request.now ?? 0))
    const store = {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    await registry.probe({ host: host('persist-host'), resolveAuthSecret: async () => '', providerId: item.ref.id, sections: ['metrics'], vaultId: 'vault-1', now: 100 })
    // Save is intentionally fire-and-forget so a local database hiccup cannot
    // turn a healthy remote observation into a failed monitor scan.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.save).toHaveBeenCalledTimes(1)
    await registry.clearScoped('vault-1', 'persist-host')
    expect(store.remove).toHaveBeenCalledWith({ vaultId: 'vault-1', hostId: 'persist-host' })
  })

  it('recovers when a provider returns an unknown envelope instead of throwing', async () => {
    let failed = false
    const item = provider('unknown-agent', async (request) => {
      if (failed) {
        return {
          ...snapshot(item, request.host, request.now ?? 0, 'unknown'),
          metrics: null,
          errors: [{ section: 'metrics', code: 'offline', message: 'agent unavailable' }],
        }
      }
      failed = true
      return snapshot(item, request.host, request.now ?? 0, 'online')
    })
    const store = { list: vi.fn(async () => []), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const request = { host: host('unknown-host'), resolveAuthSecret: async () => '', providerId: item.ref.id, vaultId: 'vault-a', sections: ['metrics'] as const, now: 100 }
    await registry.probe(request)
    const result = await registry.probe({ ...request, force: true, now: 200 })
    expect(result.recovered).toBe(true)
    expect(result.snapshot.health).toBe('stale')
    expect(result.snapshot.errors.at(-1)).toMatchObject({ code: 'stale-cache-fallback' })
  })

  it('merges a persisted section when a multi-section probe partially fails', async () => {
    const item = provider('partial-agent', async (request) => ({
      ...snapshot(item, request.host, request.now ?? 0, 'online'),
      inventory: null,
      errors: [{ section: 'inventory', code: 'unsupported', message: 'inventory unavailable' }],
    }))
    const fallback = snapshot(item, host('partial-host'), 100)
    fallback.inventory = {
      data: {} as never,
      source: item.ref,
      freshness: { sampledAt: 100, receivedAt: 100, ttlMs: 1_000, expiresAt: 1_000, expired: false, expiryReason: null },
      confidence: 'partial',
    }
    const store = {
      list: vi.fn(async () => [{ vaultId: 'vault-a', providerKind: item.ref.kind, providerId: item.ref.id, hostId: 'partial-host', snapshot: fallback, sampledAt: 100, receivedAt: 100, expiresAt: 1_000, updatedAt: 100 }]),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const result = await registry.probe({ host: host('partial-host'), resolveAuthSecret: async () => '', providerId: item.ref.id, vaultId: 'vault-a', sections: ['metrics', 'inventory'], force: true, now: 200 })
    expect(result.recovered).toBe(true)
    expect(result.snapshot.metrics).not.toBeNull()
    expect(result.snapshot.inventory).not.toBeNull()
    expect(result.snapshot.health).toBe('stale')
  })

  it('recomputes expired metadata without trusting the persisted flag', () => {
    const item = snapshot({ ref: { kind: 'shellbeam-agent', id: 'x', capabilities: ['metrics'] } } as ProbeProvider, host('h'), 100)
    item.metrics!.freshness.expired = true
    expect(refreshProbeSnapshotFreshness(item, 150).metrics?.freshness.expired).toBe(false)
    expect(refreshProbeSnapshotFreshness(item, 150).metrics?.freshness.expiryReason).toBeNull()
    expect(refreshProbeSnapshotFreshness(item, 1_200).metrics?.freshness.expired).toBe(true)
    expect(refreshProbeSnapshotFreshness(item, 1_200).metrics?.freshness.expiryReason).toBe('ttl-expired')
  })

  it('does not read or write durable rows without a vault scope', async () => {
    const item = provider('scoped-agent', async (request) => snapshot(item, request.host, request.now ?? 0))
    const store = { list: vi.fn(async () => []), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
    const registry = new ProbeProviderRegistry(1, store).register(item)
    await registry.probe({ host: host('scope-host'), resolveAuthSecret: async () => '', providerId: item.ref.id, sections: ['metrics'], now: 100 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.list).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })
})

describe('actual SSH collection lifecycle events', () => {
  let events: ProbeCollectionEvent[]
  let stop: () => void
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
    events = []
    stop = subscribeProbeCollections(event => { events.push(event) })
  })
  afterEach(() => { stop(); vi.unstubAllGlobals() })
  const emptyStore = () => ({ list: vi.fn(async () => [] as PersistedProbeSnapshotRecord[]), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) })
  function sshProvider(collect: ProbeProvider['probe']): ProbeProvider {
    return { ref: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics', 'inventory'] }, probe: vi.fn(collect) }
  }

  it('emits once for shared actual work and never for its deduplicated or cached callers', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const item = sshProvider(async request => { await gate; return snapshot(item, request.host, Date.now()) })
    const target = { ...host('shared'), vaultId: 'vault', privateKeyRef: 'PRIVATE_REFERENCE' }
    const registry = new ProbeProviderRegistry(2, emptyStore()).register(item)
    const request = { host: target, vaultId: 'vault', sections: ['metrics'] as const, maxRetries: 0, resolveAuthSecret: async () => 'PRIVATE_VALUE' }
    const boundary = currentProbeCollectionSequence()
    const one = registry.probe(request)
    const two = registry.probe(request)
    release()
    const results = await Promise.all([one, two])
    expect(results.map(result => result.deduplicated)).toEqual([false, true])
    expect((await registry.probe(request)).cached).toBe(true)
    expect(item.probe).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    expect(currentProbeCollectionSequence()).toBe(boundary + 1)
    expect(events[0].startedSequence).toBe(boundary + 1)
    expect(events[0]).toMatchObject({ vaultId: 'vault', hostId: 'shared', provider: { kind: 'ssh-agentless', id: 'ssh-agentless' }, sections: [{ section: 'metrics', outcome: 'success', reason: 'observed', sampledAt: results[0].snapshot.metrics!.freshness.sampledAt }] })
    expect(events[0].configRevision).toBe(await getProbeCollectionConfigRevision(target))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it('does not coalesce edited host credentials or reuse their old cached observation', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const target = { ...host('edited'), vaultId: 'vault' }
    const edited = { ...target, privateKeyRef: 'replacement-key', updatedAt: 1 }
    const item = sshProvider(async request => {
      if (request.host.privateKeyRef === target.privateKeyRef) { entered(); await gate }
      return snapshot(item, request.host, Date.now())
    })
    const registry = new ProbeProviderRegistry(2, emptyStore()).register(item)
    const request = { host: target, vaultId: 'vault', sections: ['metrics'] as const, maxRetries: 0, resolveAuthSecret: async () => '' }
    const oldWork = registry.probe(request)
    await started
    expect((await registry.probe({ ...request, host: edited })).deduplicated).toBe(false)
    release()
    await oldWork
    // Late old completion may occupy the shared host slot, but it cannot be
    // used as evidence for a request made with the edited configuration.
    expect((await registry.probe({ ...request, host: edited })).cached).toBe(false)
    expect(item.probe).toHaveBeenCalledTimes(3)
    expect(events.map(value => value.configRevision)).toEqual([
      await getProbeCollectionConfigRevision(edited), await getProbeCollectionConfigRevision(target), await getProbeCollectionConfigRevision(edited),
    ])
  })

  it('distinguishes new work across a runtime boundary within the same wall-clock millisecond', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const item = sshProvider(async request => snapshot(item, request.host, now))
    const registry = new ProbeProviderRegistry(1, emptyStore()).register(item)
    const request = { host: host('same-clock'), vaultId: 'vault', sections: ['metrics'] as const, maxRetries: 0, force: true, resolveAuthSecret: async () => '' }
    try {
      await registry.probe(request)
      const boundary = currentProbeCollectionSequence()
      await registry.probe(request)
      expect(events.map(value => value.startedAt)).toEqual([now, now])
      expect(events[0].startedSequence).toBeLessThanOrEqual(boundary)
      expect(events[1].startedSequence).toBeGreaterThan(boundary)
    } finally { clock.mockRestore() }
  })

  it.each(['endpoint', 'jump', 'edited-profile'] as const)('rejects a hydrated SSH %s mismatch as both fresh cache and fallback', async changed => {
    const target = { ...host('route'), vaultId: 'vault', ...(changed === 'jump' ? { jumpHostId: 'current-jump' } : {}) }
    const oldHost = changed === 'endpoint' ? { ...target, address: 'old.example.com' } : changed === 'jump' ? { ...target, jumpHostId: 'old-jump' } : target
    const item = sshProvider(async () => { throw new Error('actual network unavailable') })
    const old = snapshot(item, oldHost, Date.now())
    if (changed === 'edited-profile') target.updatedAt = old.receivedAt + 1
    const store = emptyStore()
    store.list.mockResolvedValue([{ vaultId: 'vault', providerKind: item.ref.kind, providerId: item.ref.id, hostId: target.id, snapshot: old, sampledAt: old.receivedAt, receivedAt: old.receivedAt, expiresAt: old.receivedAt + 1000, updatedAt: old.receivedAt }])
    const registry = new ProbeProviderRegistry(1, store).register(item)
    await expect(registry.probe({ host: target, vaultId: 'vault', sections: ['metrics'], maxRetries: 0, resolveAuthSecret: async () => '' })).rejects.toThrow('actual network unavailable')
    expect(item.probe).toHaveBeenCalledOnce()
    expect(events[0].sections[0].outcome).toBe('failure')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('does not publish an online success with the wrong actual SSH route identity', async () => {
    const item = sshProvider(async request => snapshot(item, { ...request.host, jumpHostId: 'foreign-jump' }, Date.now()))
    await expect(new ProbeProviderRegistry(1, emptyStore()).register(item).probe({ host: host('identity'), vaultId: 'vault', sections: ['metrics'], maxRetries: 0, resolveAuthSecret: async () => '' })).rejects.toThrow('PROBE_IDENTITY_MISMATCH')
    expect(events[0].sections[0]).toMatchObject({ outcome: 'unknown', reason: 'scope-unavailable' })
  })

  it('reports real exhausted failures even when stale durable data is returned, then a new sample recovers', async () => {
    let fail = true
    const item = sshProvider(async request => { if (fail) throw new Error('PRIVATE_REMOTE_OUTPUT'); return snapshot(item, request.host, Date.now()) })
    const target = { ...host('fallback'), vaultId: 'vault', jumpHostId: 'bastion' }
    const old = snapshot(item, target, Date.now() - 5_000)
    const store = emptyStore()
    store.list.mockResolvedValue([{ vaultId: 'vault', providerKind: item.ref.kind, providerId: item.ref.id, hostId: target.id, snapshot: old, sampledAt: old.receivedAt, receivedAt: old.receivedAt, expiresAt: old.receivedAt + 1_000, updatedAt: old.receivedAt }])
    const registry = new ProbeProviderRegistry(1, store).register(item)
    const request = { host: target, vaultId: 'vault', sections: ['metrics'] as const, maxRetries: 1, retryDelayMs: 0, force: true, resolveAuthSecret: async () => '' }
    expect((await registry.probe(request)).recovered).toBe(true)
    expect(events[0]).toMatchObject({ transport: 'proxy-jump', sections: [{ section: 'metrics', outcome: 'failure', sampledAt: null, reason: 'collection-unavailable' }] })
    fail = false
    await registry.probe(request)
    expect(events[1].sections[0]).toMatchObject({ section: 'metrics', outcome: 'success', reason: 'observed' })
    expect(events[1].sections[0].sampledAt).not.toBe(old.receivedAt)
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it.each([
    ['transport unavailable', 'failure', 'collection-unavailable'],
    ['connect vault.example refused', 'failure', 'collection-unavailable'],
    ['connect identity.example refused', 'failure', 'collection-unavailable'],
    ['VAULT_LOCKED', 'unknown', 'scope-unavailable'],
    ['Connection cancelled', 'unknown', 'scope-unavailable'],
    ['PROBE_IDENTITY_MISMATCH', 'unknown', 'scope-unavailable'],
    ['MISSING_CREDENTIAL', 'unknown', 'scope-unavailable'],
    ['{"code":"host_key_unknown","host":"vault.example"}', 'unknown', 'scope-unavailable'],
  ])('classifies an initial uncached %s without inventing a successful fallback', async (message, outcome, reason) => {
    const item = sshProvider(async () => { throw new Error(message) })
    const registry = new ProbeProviderRegistry(1, emptyStore()).register(item)
    await expect(registry.probe({ host: host('no-cache'), vaultId: 'vault', sections: ['metrics'], maxRetries: 0, resolveAuthSecret: async () => '' })).rejects.toThrow(message)
    expect(events).toHaveLength(1)
    expect(events[0].sections).toEqual([{ section: 'metrics', outcome, reason, sampledAt: null }])
  })

  it('separates fresh metrics from an inventory retry exhaustion in the same actual attempt', async () => {
    const item = sshProvider(async request => ({ ...snapshot(item, request.host, Date.now()), inventory: null, errors: [{ section: 'inventory', message: 'inventory collection failed' }] }))
    await new ProbeProviderRegistry(1, emptyStore()).register(item).probe({ host: host('partial'), vaultId: 'vault', sections: ['metrics', 'inventory'], maxRetries: 0, resolveAuthSecret: async () => '' })
    expect(events[0].sections).toEqual([
      expect.objectContaining({ section: 'metrics', outcome: 'success' }),
      { section: 'inventory', outcome: 'failure', sampledAt: null, reason: 'collection-unavailable' },
    ])
  })

  it.each(['paused', 'unsupported', 'stale'] as const)('never restores a provider from %s retained metrics', async health => {
    const item = sshProvider(async request => snapshot(item, request.host, Date.now(), health))
    await new ProbeProviderRegistry(1, emptyStore()).register(item).probe({ host: host('unavailable'), vaultId: 'vault', sections: ['metrics'], maxRetries: 0, resolveAuthSecret: async () => '' })
    expect(events[0].sections[0].outcome).toBe('unknown')
  })

  it('keeps real success and original failure when event hashing fails, with fixed diagnostics only', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const diagnostics: ProbeCollectionDiagnostic[] = []
    const unlisten = subscribeProbeCollectionDiagnostics(value => { diagnostics.push(value) })
    vi.stubGlobal('crypto', { randomUUID: () => 'event', subtle: { digest: async () => { throw new Error('PRIVATE_HASH_ERROR') } } })
    const successful = sshProvider(async request => snapshot(successful, request.host, Date.now()))
    const failed = sshProvider(async () => { throw new Error('ORIGINAL_COLLECTION_FAILURE') })
    const request = { host: host('hash-failed'), vaultId: 'vault', sections: ['metrics'] as const, maxRetries: 0, resolveAuthSecret: async () => '' }
    try {
      expect((await new ProbeProviderRegistry(1, emptyStore()).register(successful).probe(request)).snapshot.health).toBe('online')
      await expect(new ProbeProviderRegistry(1, emptyStore()).register(failed).probe(request)).rejects.toThrow('ORIGINAL_COLLECTION_FAILURE')
      expect(diagnostics.map(value => value.code)).toEqual(['publication-unavailable', 'publication-unavailable'])
      expect(diagnostics.every(value => value.vaultId === 'vault' && value.hostId === 'hash-failed' && Number.isSafeInteger(value.startedAt) && value.startedAt <= Date.now() && Number.isSafeInteger(value.startedSequence) && value.startedSequence > 0)).toBe(true)
      expect(warning.mock.calls.flat().join(' ')).not.toContain('PRIVATE')
      expect(events).toEqual([])
    } finally { unlisten(); warning.mockRestore() }
  })

  it('does not let one broken event listener block the other consumers or change a real collection result', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = subscribeProbeCollections(() => { throw new Error('PRIVATE_LISTENER_ERROR') })
    const delivered = vi.fn()
    const healthy = subscribeProbeCollections(delivered)
    const diagnostics: ProbeCollectionDiagnostic[] = []
    const unlisten = subscribeProbeCollectionDiagnostics(value => { diagnostics.push(value) })
    const item = sshProvider(async request => snapshot(item, request.host, Date.now()))
    try {
      expect((await new ProbeProviderRegistry(1, emptyStore()).register(item).probe({ host: host('listeners'), vaultId: 'vault', sections: ['metrics'], maxRetries: 0, resolveAuthSecret: async () => '' })).snapshot.health).toBe('online')
      expect(delivered).toHaveBeenCalledOnce()
      expect(diagnostics[0].startedSequence).toBe(events[0].startedSequence)
      expect(warning).toHaveBeenCalledWith('probe_collection_listener_failed')
      expect(warning.mock.calls.flat().join(' ')).not.toContain('PRIVATE')
    } finally { broken(); healthy(); unlisten(); warning.mockRestore() }
  })
})
