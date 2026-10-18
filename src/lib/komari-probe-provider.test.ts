import { describe, expect, it, vi } from 'vitest'
import { createKomariProbeProvider } from './komari-probe-provider'
import type { ProbeRequest } from './probe-provider'

const request: ProbeRequest = {
  host: {
    id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
    jumpHost: 'bastion', jumpPort: 2200, jumpUser: 'jump',
  },
  resolveAuthSecret: async () => 'secret',
  now: 2_000,
}

describe('Komari ProbeProvider', () => {
  it('returns metrics-only observations and preserves ProxyJump metadata', async () => {
    const provider = createKomariProbeProvider({
      endpoint: 'https://komari.example',
      nodeForHost: () => ({ uuid: 'node-1', name: 'prod', hostname: 'prod', ipv4: '10.0.0.1', ipv6: null, os: 'Linux', kernel: '6.8', version: null, raw: {} }),
      client: { fetchRecentRecords: async () => [{ time: 1.9, cpu: 25 }] },
    })
    const snapshot = await provider.probe(request)
    expect(snapshot.provider).toMatchObject({ kind: 'komari', endpoint: 'https://komari.example', nodeId: 'node-1', capabilities: ['metrics'] })
    expect(snapshot.transport).toBe('proxy-jump')
    expect(snapshot.health).toBe('online')
    expect(snapshot.metrics?.data.cpuPercent).toBe(25)
    expect(snapshot.inventory).toBeNull()
  })

  it('reports unmapped and API failures without throwing', async () => {
    const provider = createKomariProbeProvider({
      endpoint: 'https://komari.example',
      nodeForHost: () => null,
      client: { fetchRecentRecords: async () => [] },
    })
    const unmapped = await provider.probe(request)
    expect(unmapped.health).toBe('unknown')
    expect(unmapped.errors[0]).toMatchObject({ code: 'unmapped' })

    const failed = createKomariProbeProvider({
      endpoint: 'https://komari.example',
      nodeForHost: () => ({ uuid: 'node-1', name: 'prod', hostname: 'prod', ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }),
      client: { fetchRecentRecords: async () => { throw Object.assign(new Error('forbidden'), { code: 'permission' }) } },
    })
    const failure = await failed.probe(request)
    expect(failure.health).toBe('unknown')
    expect(failure.errors[0]).toMatchObject({ code: 'permission', section: 'metrics' })
  })

  it('excludes even slightly future reports from the latest observation and imported history', async () => {
    const now = Date.parse('2026-10-17T08:30:00Z')
    const onHistory = vi.fn()
    const provider = createKomariProbeProvider({
      endpoint: 'https://komari.example',
      nodeForHost: () => ({ uuid: 'node-1', name: 'prod', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }),
      client: { fetchRecentRecords: async () => [{ time: now - 1000, cpu: 25 }, { time: now + 1, cpu: 99 }, { time: now + 240000, cpu: 100 }] },
      onHistory,
    })
    const snapshot = await provider.probe({ ...request, now })
    expect(snapshot.health).toBe('online')
    expect(snapshot.metrics?.data.cpuPercent).toBe(25)
    expect(snapshot.metrics?.freshness.sampledAt).toBe(now - 1000)
    expect(onHistory.mock.calls[0]?.[0]).toHaveLength(1)
  })

  it('keeps only future or undated reports unknown without inventing an observation', async () => {
    const now = Date.parse('2026-10-17T08:30:00Z')
    const onHistory = vi.fn()
    const provider = createKomariProbeProvider({
      endpoint: 'https://komari.example',
      nodeForHost: () => ({ uuid: 'node-1', name: 'prod', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }),
      client: { fetchRecentRecords: async () => [{ time: now + 1, cpu: 25 }, { cpu: 50 }] },
      onHistory,
    })
    const snapshot = await provider.probe({ ...request, now })
    expect(snapshot).toMatchObject({ health: 'unknown', metrics: null, errors: [{ section: 'metrics', code: 'invalid-sample-time' }] })
    expect(onHistory).not.toHaveBeenCalled()
  })

  it('uses response completion time so a sample generated during a request is valid', async () => {
    let now = Date.parse('2026-10-17T08:30:00Z')
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const provider = createKomariProbeProvider({
        endpoint: 'https://komari.example',
        nodeForHost: () => ({ uuid: 'node-1', name: 'prod', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }),
        client: { fetchRecentRecords: async () => { now += 2000; return [{ time: now, cpu: 25 }] } },
      })
      const snapshot = await provider.probe({ ...request, now: undefined })
      expect(snapshot).toMatchObject({ health: 'online', receivedAt: now })
      expect(snapshot.metrics?.freshness).toMatchObject({ sampledAt: now, receivedAt: now, expired: false })
    } finally { clock.mockRestore() }
  })
})
