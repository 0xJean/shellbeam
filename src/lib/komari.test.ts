import { describe, expect, it, vi } from 'vitest'
import {
  KomariApiError,
  getKomariRecentRecords,
  getKomariAlertSummary,
  komariRecordToServerMonitorSnapshot,
  listKomariClients,
  normalizeKomariEndpoint,
  requestKomari,
} from './komari'

function response(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Komari API adapter', () => {
  it('normalizes safe HTTP endpoints and rejects embedded credentials', () => {
    expect(normalizeKomariEndpoint(' https://komari.example/ ')).toBe('https://komari.example')
    expect(normalizeKomariEndpoint('https://komari.example/base/?ignored=1#hash')).toBe('https://komari.example/base')
    expect(() => normalizeKomariEndpoint('ssh://komari.example')).toThrow('HTTP or HTTPS')
    expect(() => normalizeKomariEndpoint('https://user:pass@komari.example')).toThrow('credentials')
  })

  it('sends a bearer token without exposing it in API errors', async () => {
    const token = 'secret-token'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({ message: `invalid ${token}` }, { status: 403 }),
    )

    await expect(requestKomari({ endpoint: 'https://komari.example', token }, { path: '/api/nodes' }, fetchImpl))
      .rejects.toMatchObject({ code: 'permission', status: 403, message: 'invalid [redacted]' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://komari.example/api/nodes',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const init = fetchImpl.mock.calls[0]?.[1]
    expect((init?.headers as Headers).get('Authorization')).toBe(`Bearer ${token}`)
  })

  it('normalizes raw and wrapped client lists', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { uuid: 'node-1', name: 'prod', ipv4: '10.0.0.5', kernel_version: 'Linux 6.8' },
      { id: 'node-2', hostname: 'staging' },
      { name: 'missing uuid' },
    ] }))
    const clients = await listKomariClients({ endpoint: 'https://komari.example' }, fetchImpl)
    expect(clients).toEqual([
      expect.objectContaining({ uuid: 'node-1', ipv4: '10.0.0.5', kernel: 'Linux 6.8' }),
      expect.objectContaining({ uuid: 'node-2', hostname: 'staging' }),
    ])
  })

  it('falls back to public node discovery when the admin list is unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith('/api/admin/client/list')) return response({ message: 'forbidden' }, { status: 403 })
      return response({ nodes: [{ uuid: 'public-node', name: 'public' }] })
    })
    const clients = await listKomariClients({ endpoint: 'https://komari.example' }, fetchImpl)
    expect(clients[0]?.uuid).toBe('public-node')
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      'https://komari.example/api/admin/client/list',
      'https://komari.example/api/nodes',
    ])
  })

  it('loads recent records using an encoded node id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ data: { time: 1710000000, cpu: 12 } }))
    const records = await getKomariRecentRecords({ endpoint: 'https://komari.example' }, 'node/a', fetchImpl)
    expect(records).toEqual([{ time: 1710000000, cpu: 12 }])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://komari.example/api/recent/node%2Fa')
  })

  it('summarizes load and offline notifications without retaining event payloads', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/notification/load/')) {
        return response({ data: [{ id: 'load-1' }, { id: 'load-2' }] })
      }
      return response({ total: 3, items: [{ id: 'offline-1' }, { id: 'offline-2' }, { id: 'offline-3' }] })
    })
    await expect(getKomariAlertSummary({ endpoint: 'https://komari.example' }, fetchImpl, 2000))
      .resolves.toEqual({ load: 2, offline: 3, total: 5, active: null, updatedAt: 2000 })
  })

  it('keeps an active alert count when the server includes one', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => (
      response(String(input).endsWith('/load/') ? { active: 2, total: 4 } : { activeCount: 1, total: 2 })
    ))
    await expect(getKomariAlertSummary({ endpoint: 'https://komari.example' }, fetchImpl, 2000))
      .resolves.toMatchObject({ load: 4, offline: 2, total: 6, active: 3 })
  })

  it('marks alert summaries unsupported when both notification endpoints are unavailable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response({ message: 'forbidden' }, { status: 403 }))
    await expect(getKomariAlertSummary({ endpoint: 'https://komari.example' }, fetchImpl, 2000))
      .resolves.toMatchObject({ load: null, offline: null, total: null, unsupported: true, errorCode: 'permission' })
  })

  it('converts a partial record without manufacturing missing values', () => {
    const snapshot = komariRecordToServerMonitorSnapshot({
      time: '2026-10-16T00:00:00.000Z',
      cpu: 41,
      ram: { used: 40, total: 100 },
      load: { load1: 1.2 },
      net: { in: 10, out: 20 },
    }, { uuid: 'node-1', name: 'prod', hostname: 'prod', ipv4: null, ipv6: null, os: 'Linux', kernel: '6.8', version: null, raw: {} })
    expect(snapshot.hostname).toBe('prod')
    expect(snapshot.cpuPercent).toBe(41)
    expect(snapshot.memoryPercent).toBe(40)
    expect(snapshot.load1).toBe(1.2)
    expect(snapshot.load5).toBeNull()
    expect(snapshot.networkRxBytesPerSec).toBe(10)
    expect(snapshot.sampledAt).toBe(Date.parse('2026-10-16T00:00:00.000Z'))
  })

  it('supports Komari flat record fields used by the public API', () => {
    const snapshot = komariRecordToServerMonitorSnapshot({
      time: 1_710_000_000,
      cpu: 15,
      ram: 4_000,
      ram_total: 10_000,
      disk: 20_000,
      disk_total: 100_000,
      load: 0.5,
      net_in: 12,
      net_out: 34,
    })
    expect(snapshot.memoryUsedBytes).toBe(4_000)
    expect(snapshot.memoryTotalBytes).toBe(10_000)
    expect(snapshot.memoryPercent).toBe(40)
    expect(snapshot.diskUsedBytes).toBe(20_000)
    expect(snapshot.diskTotalBytes).toBe(100_000)
    expect(snapshot.diskPercent).toBe(20)
    expect(snapshot.load1).toBe(0.5)
    expect(snapshot.networkRxBytesPerSec).toBe(12)
    expect(snapshot.networkTxBytesPerSec).toBe(34)
  })

  it('classifies HTTP errors for callers to surface actionable state', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response({ message: 'gone' }, { status: 404 }))
    await expect(requestKomari({ endpoint: 'https://komari.example' }, { path: '/api/nodes' }, fetchImpl))
      .rejects.toBeInstanceOf(KomariApiError)
    await expect(requestKomari({ endpoint: 'https://komari.example' }, { path: '/api/nodes' }, fetchImpl))
      .rejects.toMatchObject({ code: 'endpoint-version' })
  })
})
