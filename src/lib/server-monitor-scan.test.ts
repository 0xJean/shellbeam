import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanServerMonitorHosts } from './server-monitor-scan'
import { clearServerMonitorStates, getServerMonitorStates } from './server-monitor-state'
import { getServerMonitorHostKey, saveServerMonitorResult } from './server-monitor'
import type { HostProfile } from './hosts'
import type { ProbeSnapshot } from './probe-provider'
import { UnsupportedProbeError } from './unified-probe'
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('./probe-scheduler', () => ({ getProbeProviderRegistry: () => ({ probe }) }))
vi.mock('./server-monitor', async (original) => ({ ...(await original<typeof import('./server-monitor')>()), saveServerMonitorResult: vi.fn(async () => undefined) }))
const host: HostProfile = { id: 'non-linux', name: 'Darwin', address: 'target', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1 }
afterEach(() => { clearServerMonitorStates(); vi.clearAllMocks() })
describe('monitor unsupported collection', () => {
  it('persists and displays unsupported without fabricating a zero-valued history sample', async () => {
    const snapshot: ProbeSnapshot = { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: 22, username: 'ops' }, provider: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] }, health: 'unsupported', transport: 'direct', receivedAt: Date.now(), metrics: null, inventory: null, errors: [{ section: 'metrics', code: 'unsupported_os', message: 'Darwin' }] }
    probe.mockResolvedValueOnce({ snapshot })
    const result = await scanServerMonitorHosts({ hosts: [host], vaultId: 'vault', resolveAuthSecret: async () => '' })
    expect(result.scannedHosts).toEqual([{ ...host, vaultId: 'vault' }])
    expect(getServerMonitorStates()[getServerMonitorHostKey({ ...host, vaultId: 'vault' })]).toMatchObject({ latest: { status: 'unsupported', snapshot: null }, history: [] })
    expect(saveServerMonitorResult).toHaveBeenCalledWith({ latest: expect.objectContaining({ status: 'unsupported', snapshot: null }) })
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('rejects a profile from another Vault before collection or audit persistence', async () => {
    await expect(scanServerMonitorHosts({ hosts: [{ ...host, vaultId: 'A' }], vaultId: 'B', resolveAuthSecret: async () => '' })).rejects.toThrow('HOST_VAULT_SCOPE_MISMATCH')
    expect(probe).not.toHaveBeenCalled()
    expect(saveServerMonitorResult).not.toHaveBeenCalled()
    expect(getServerMonitorStates()).toEqual({})
  })
  it('also classifies a directly rejected collection as unsupported rather than offline', async () => {
    probe.mockRejectedValueOnce(new UnsupportedProbeError('FreeBSD'))
    await scanServerMonitorHosts({ hosts: [host], resolveAuthSecret: async () => '' })
    expect(getServerMonitorStates()[host.id].latest?.status).toBe('unsupported')
    expect(getServerMonitorStates()[host.id].history).toEqual([])
  })
})
