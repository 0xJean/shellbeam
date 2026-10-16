import { describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { createProbeObservation, type ProbeProvider, type ProbeSnapshot } from './probe-provider'
import { ProbeProviderRegistry, refreshProbeSnapshotFreshness } from './probe-scheduler'
import type { PersistedProbeSnapshotRecord } from './probe-persistence'

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
    host: { hostId: target.id, address: target.address, port: 22, username: 'root' },
    provider: provider.ref,
    transport: 'direct',
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
    expect(store.save).not.toHaveBeenCalled()
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
      freshness: { sampledAt: 100, receivedAt: 100, ttlMs: 1_000, expiresAt: 1_000, expired: false },
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
    expect(refreshProbeSnapshotFreshness(item, 1_200).metrics?.freshness.expired).toBe(true)
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
