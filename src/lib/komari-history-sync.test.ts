import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { syncKomariIntegration } from './komari-sync'
import fixtures from './fixtures/komari-http-contracts.json'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
describe('Komari history sync imports', () => {
  it('persists all original samples separately for each vault, provider, host and node', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'list_probe_snapshots' ? [] : undefined)
    const host = { id: 'history-edge', name: 'fixture-host', address: '192.0.2.10', port: 22, username: 'ops', authType: 'password' as const, tags: [], group: 'Production', createdAt: 1, updatedAt: 1 }
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      const body = url.includes('/api/admin/client/list') ? fixtures.nodes : url.includes('/api/records/load') ? fixtures.history : url.includes('/api/recent/') ? fixtures.recent : []
      return new Response(JSON.stringify(body), { status: 200 })
    })
    for (const vaultId of ['history-vault-a', 'history-vault-b']) {
      const result = await syncKomariIntegration({ integrationId: 'history-integration', vaultId, config: { endpoint: 'https://komari.example', token: 'secret-never-saved' }, hosts: [host], fetchImpl, includeAlerts: false, now: Date.parse('2026-10-17T08:30:30Z') })
      expect(result.historyImportedCount).toBe(3)
      expect(result.snapshots[0].metrics?.data.sampledAt).toBe(Date.parse('2026-10-17T08:30:00Z'))
    }
    const writes = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'append_provider_metric_history').map(([, args]) => (args as { payload: { vaultId: string; points: Array<{ sampledAt: number }> } }).payload)
    expect([...new Set(writes.map((payload) => payload.vaultId))]).toEqual(['history-vault-a', 'history-vault-b'])
    // Canonical snapshot persistence may append the latest point again; its
    // native key deduplicates that write without dropping the backfilled rows.
    for (const vaultId of ['history-vault-a', 'history-vault-b']) {
      const samples = new Set(writes.filter((payload) => payload.vaultId === vaultId).flatMap((payload) => payload.points.map((point) => point.sampledAt)))
      expect(samples.size).toBe(3)
    }
    expect(writes[0].points[0]).toMatchObject({ hostId: host.id, providerId: 'history-integration', nodeId: 'node-fixture' })
    expect(JSON.stringify(writes)).not.toContain('secret-never-saved')
  })
})
