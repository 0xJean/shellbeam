import { describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { createProbeObservation, type ProbeProvider, type ProbeSnapshot } from './probe-provider'
import { ProbeProviderRegistry } from './probe-scheduler'

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
})
