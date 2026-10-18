import { describe, expect, it, vi } from 'vitest'
import {
  createAgentlessSshProbeProvider,
  createDelegatingProbeProvider,
  createProbeObservation,
  getProbeHostIdentity,
  getProbeTransport,
  refreshProbeFreshness,
  validateProbeSnapshotSources,
  type ProbeSnapshot,
  type ProbeRequest,
} from './probe-provider'
import { UnsupportedProbeError } from './unified-probe'

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 2222,
  username: 'ops',
  group: 'Production',
  authType: 'password' as const,
  tags: [],
  jumpHost: 'bastion.internal',
  jumpPort: 2200,
  jumpUser: 'jump',
  createdAt: 0,
  updatedAt: 0,
}

const request: ProbeRequest = {
  host,
  resolveAuthSecret: async () => 'secret',
  now: 1_000,
}

describe('ProbeProvider contract', () => {
  it('normalizes host identity and keeps ProxyJump route metadata', () => {
    expect(getProbeHostIdentity(host)).toEqual({
      hostId: 'host-1',
      address: '10.0.0.15',
      port: 2222,
      username: 'ops',
      jump: { address: 'bastion.internal', port: 2200, username: 'jump' },
    })
    expect(getProbeTransport(host)).toBe('proxy-jump')
  })

  it('retains a referenced jump route even without cached display metadata', () => {
    const referenced = { ...host, jumpHostId: 'jump-profile', jumpHost: undefined }
    expect(getProbeTransport(referenced)).toBe('proxy-jump')
    expect(getProbeHostIdentity(referenced).jump?.hostId).toBe('jump-profile')
  })

  it('preserves a definite non-Linux result without invented metrics or offline state', async () => {
    const identity = { ...getProbeHostIdentity(host), jump: { hostId: 'jump', address: 'edited-bastion', port: 2200, username: 'current' } }
    const collect = vi.fn(async () => { throw new UnsupportedProbeError('Darwin', identity) })
    const snapshot = await createAgentlessSshProbeProvider({ dependencies: { collect } }).probe(request)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(snapshot).toMatchObject({ health: 'unsupported', metrics: null, inventory: null, host: identity })
    expect(snapshot.errors).toHaveLength(2)
    expect(snapshot.errors.every((error) => error.code === 'unsupported_os')).toBe(true)
  })

  it('marks observation freshness from the remote sample timestamp', () => {
    const observation = createProbeObservation({
      data: { value: 1 },
      source: { kind: 'komari', id: 'komari', capabilities: ['metrics'] },
      sampledAt: 500,
      receivedAt: 1_000,
      ttlMs: 600,
    })

    expect(observation.freshness).toEqual({
      sampledAt: 500,
      receivedAt: 1_000,
      ttlMs: 600,
      expiresAt: 1_100,
      expired: false, expiryReason: null,
    })
  })

  it('derives expiry reason from the sample TTL and removes legacy stale flags at its boundary', () => {
    const legacy = { sampledAt: 500, receivedAt: 600, ttlMs: 100, expiresAt: 10_000, expired: true }
    expect(refreshProbeFreshness(legacy, 600)).toMatchObject({ expiresAt: 600, expired: false, expiryReason: null })
    expect(refreshProbeFreshness(legacy, 601)).toMatchObject({ sampledAt: 500, receivedAt: 600, expiresAt: 600, expired: true, expiryReason: 'ttl-expired' })
  })

  it('rejects future observations without presenting them as expired data', () => {
    const source = { kind: 'ssh-agentless' as const, id: 'ssh-agentless', capabilities: ['metrics' as const] }
    const snapshot = { schemaVersion: 1, host: getProbeHostIdentity(host), provider: source, transport: 'direct', health: 'online', receivedAt: 1000, errors: [], inventory: null,
      metrics: createProbeObservation({ data: {} as never, source, sampledAt: 900, receivedAt: 1000, ttlMs: 100 }),
    } as ProbeSnapshot
    expect(validateProbeSnapshotSources(snapshot, 800)).toMatchObject({ metrics: null, health: 'unknown', errors: [{ section: 'metrics', code: 'observation_source_invalid' }] })
  })

  it('collects metrics and inventory together while preserving partial failures', async () => {
    const provider = createAgentlessSshProbeProvider({
      dependencies: {
        collectMetrics: async () => ({
          hostname: 'prod',
          os: 'Linux',
          kernel: 'Linux 6.8',
          uptimeSeconds: 5,
          cpuPercent: 10,
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
          latencyMs: 20,
          sampledAt: 900,
        }),
        collectInventory: async () => {
          throw new Error('inventory permission denied')
        },
      },
    })

    const snapshot = await provider.probe(request)
    expect(snapshot.health).toBe('online')
    expect(snapshot.transport).toBe('proxy-jump')
    expect(snapshot.metrics?.data.hostname).toBe('prod')
    expect(snapshot.inventory).toBeNull()
    expect(snapshot.errors).toEqual([
      { section: 'inventory', message: 'inventory permission denied' },
    ])
  })

  it('reports stale when the only available observation has expired', async () => {
    const provider = createAgentlessSshProbeProvider({
      metricsTtlMs: 100,
      dependencies: {
        collectMetrics: async () => ({
          hostname: 'prod', os: 'Linux', kernel: 'Linux 6.8', uptimeSeconds: 5,
          cpuPercent: 10, load1: null, load5: null, load15: null,
          memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null,
          diskUsedBytes: null, diskTotalBytes: null, diskPercent: null,
          networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: 20,
          sampledAt: 0,
        }),
      },
    })

    const snapshot = await provider.probe({ ...request, now: 1_000, sections: ['metrics'] })
    expect(snapshot.health).toBe('stale')
    expect(snapshot.metrics?.freshness.expired).toBe(true)
  })

  it('only invokes the requested collection section', async () => {
    let metricsCalls = 0
    let inventoryCalls = 0
    const provider = createAgentlessSshProbeProvider({
      dependencies: {
        collectMetrics: async () => {
          metricsCalls += 1
          throw new Error('metrics should not run')
        },
        collectInventory: async () => {
          inventoryCalls += 1
          return {
            resource: {
              hostname: 'prod', os: 'Linux', kernel: 'Linux 6.8', uptime: '',
              cpuPercent: null, memoryPercent: null, memoryText: '', diskPercent: null,
              diskText: '', network: '',
            },
            tools: [], services: [], containers: [], pm2: [], projects: [], scannedAt: 900,
          }
        },
      },
    })

    const snapshot = await provider.probe({ ...request, sections: ['inventory'] })
    expect(metricsCalls).toBe(0)
    expect(inventoryCalls).toBe(1)
    expect(snapshot.metrics).toBeNull()
    expect(snapshot.inventory?.data.resource.hostname).toBe('prod')
  })

  it('turns a Komari-compatible collector failure into an unknown snapshot', async () => {
    const provider = createDelegatingProbeProvider({
      ref: { kind: 'komari', id: 'komari-prod', endpoint: 'https://komari.example', capabilities: ['metrics'] },
      collect: async () => {
        throw new Error('Komari API unavailable')
      },
    })

    const snapshot = await provider.probe(request)
    expect(snapshot.health).toBe('unknown')
    expect(snapshot.provider.kind).toBe('komari')
    expect(snapshot.errors).toEqual([{ section: 'provider', message: 'Komari API unavailable' }])
  })
})
