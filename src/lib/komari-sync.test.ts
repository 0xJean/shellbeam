import { describe, expect, it, vi } from 'vitest'
import { syncKomariIntegration } from './komari-sync'
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
  })
})
