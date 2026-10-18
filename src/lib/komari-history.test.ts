import { describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/komari-http-contracts.json'
import { getKomariHistoryRecords, getKomariRecentRecords, getKomariServerVersion, listKomariClients } from './komari'
import { createKomariProbeProvider } from './komari-probe-provider'
import { mapKomariNodesToHosts } from './komari-mapping'
import { observationToMetricHistoryPoint } from './provider-history'
import type { ProbeObservation } from './probe-provider'
import type { ServerMonitorSnapshot } from './server-monitor'
const host = { id: 'host-1', name: 'fixture-host', address: '192.0.2.10', port: 22, username: 'ops', authType: 'password' as const, tags: [], group: 'Production', createdAt: 1, updatedAt: 1 }
const config = { endpoint: 'https://komari.example', token: 'never-persist-this-token' }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('Versioned official Komari HTTP contract and history', () => {
  it('accepts supported versions and identifies pre-API-key versions', async () => {
    for (const [fixture, supported] of [[fixtures.version103, true], [fixtures.version160, true], [fixtures.oldVersion, false]] as const) {
      expect((await getKomariServerVersion(config, vi.fn(async () => response(fixture)))).apiKeySupported).toBe(supported)
    }
  })
  it('preserves unordered flat historical records and nested live records with original timestamps', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => response(String(input).includes('/api/admin/client/list') ? fixtures.nodes : String(input).includes('/api/records/load') ? fixtures.history : fixtures.recent))
    const nodes = await listKomariClients(config, fetchImpl)
    expect(mapKomariNodesToHosts({ hosts: [host], nodes }).mappings[0]).toMatchObject({ hostId: host.id, nodeId: 'node-fixture' })
    const recent = await getKomariRecentRecords(config, nodes[0].uuid, fetchImpl)
    const historical = await getKomariHistoryRecords(config, nodes[0].uuid, { hours: 24 }, fetchImpl)
    const history: ProbeObservation<ServerMonitorSnapshot>[] = []
    const provider = createKomariProbeProvider({ endpoint: config.endpoint, id: 'integration-1', nodeForHost: () => nodes[0], client: { fetchRecentRecords: async () => recent, fetchHistoryRecords: async () => historical }, onHistory: (points) => history.push(...points) })
    const snapshot = await provider.probe({ host, resolveAuthSecret: async () => '', now: Date.parse('2026-10-17T08:30:30Z') })
    expect(snapshot.health).toBe('online')
    expect(snapshot.metrics?.data).toMatchObject({ cpuPercent: 25, memoryPercent: 50, diskPercent: 20, networkRxBytesPerSec: 1024, networkTxBytesPerSec: 2048 })
    expect(history).toHaveLength(3)
    expect(history.map((point) => point.data.sampledAt)).toEqual([...history].map((point) => point.data.sampledAt).sort())
    expect(history[0].data.memoryPercent).toBeNull()
    const points = history.map((point) => observationToMetricHistoryPoint(point, host.id))
    expect(points[0]).toMatchObject({ providerId: 'integration-1', hostId: host.id, nodeId: 'node-fixture' })
    expect(JSON.stringify(points)).not.toContain(config.token)
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toContain('https://komari.example/api/records/load?uuid=node-fixture&load_type=all&hours=24')
  })
  it('keeps denied, future, undated and all-missing data unknown', async () => {
    await expect(getKomariHistoryRecords(config, 'hidden', {}, vi.fn(async () => response(fixtures.permission, 403)))).rejects.toMatchObject({ code: 'permission' })
    const node = { uuid: 'node-fixture', name: 'fixture-host', hostname: null, ipv4: null, ipv6: null, os: null, kernel: null, version: null, raw: {} }
    const provider = createKomariProbeProvider({ endpoint: config.endpoint, nodeForHost: () => node, client: { fetchRecentRecords: async () => [{ cpu: 5 }, { time: '2099-01-01', cpu: 20 }, ...fixtures.partial.data] } })
    expect((await provider.probe({ host, resolveAuthSecret: async () => '', now: Date.parse('2026-10-17T08:31:10Z') })).health).toBe('unknown')
  })
})
