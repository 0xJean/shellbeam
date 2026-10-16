import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KOMARI_SYNC_CONCURRENCY,
  isKomariSyncFresh,
  syncKomariIntegration,
} from './komari-sync'
import type { HostProfile } from './hosts'

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
}

describe('Komari sync orchestration', () => {
  it('discovers, maps and probes metrics through the shared provider contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: '10.0.0.1' }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ time: 1_710_000_000, cpu: 33 }]), { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example', token: 'secret' },
      hosts: [host],
      now: 2_000,
      fetchImpl,
    })
    expect(result.mapping.mappings).toHaveLength(1)
    expect(result.snapshots[0]).toMatchObject({ provider: { kind: 'komari', nodeId: 'node-1' }, health: 'online' })
    expect(result.snapshots[0]?.metrics?.data.cpuPercent).toBe(33)
    expect(result.alerts).toEqual({ load: 1, offline: 1, total: 2, active: null, updatedAt: 2_000 })
    expect(result.snapshots[0]?.alerts).toEqual(result.alerts)
  })

  it('skips a fresh persisted sync and allows an explicit refresh', async () => {
    expect(isKomariSyncFresh(1_000, 1_500, 1_000)).toBe(true)
    expect(isKomariSyncFresh(1_000, 2_000, 1_000)).toBe(false)
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example' },
      hosts: [host],
      now: 1_500,
      lastSyncedAt: 1_000,
      ttlMs: 1_000,
      fetchImpl,
    })
    expect(result).toMatchObject({ skipped: true, skipReason: 'ttl', syncedAt: 1_000 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caps concurrent recent-metric requests while preserving all snapshots', async () => {
    const hosts = Array.from({ length: DEFAULT_KOMARI_SYNC_CONCURRENCY + 2 }, (_, index) => ({
      ...host,
      id: `host-${index}`,
      name: `prod-${index}`,
      address: `10.0.0.${index + 1}`,
    }))
    let active = 0
    let peak = 0
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify(hosts.map((item, index) => ({ uuid: `node-${index}`, name: item.name, ipv4: item.address }))), { status: 200 })
      }
      if (url.includes('/api/admin/notification/')) return new Response('[]', { status: 200 })
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return new Response(JSON.stringify([{ time: 1_710_000_000, cpu: 33 }]), { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example' },
      hosts,
      now: 2_000,
      fetchImpl,
      maxConcurrency: 2,
    })
    expect(result.snapshots).toHaveLength(hosts.length)
    expect(peak).toBeLessThanOrEqual(2)
  })
})
