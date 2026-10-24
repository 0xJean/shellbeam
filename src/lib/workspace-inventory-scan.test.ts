import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanWorkspaceInventoryHosts } from './workspace-inventory-scan'
import { clearWorkspaceInventoryStates, getWorkspaceInventoryStates } from './workspace-inventory-state'
import { getWorkspaceInventoryHostKey, loadWorkspaceInventoryPersistedCache, saveWorkspaceInventoryCacheEntry, saveWorkspaceInventoryHostStateSnapshot } from './workspace-inventory'
import type { HostProfile } from './hosts'
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('./probe-scheduler', () => ({ getProbeProviderRegistry: () => ({ probe }) }))
vi.mock('./workspace-inventory', async (original) => ({ ...(await original<typeof import('./workspace-inventory')>()), loadWorkspaceInventoryPersistedCache: vi.fn(async () => ({})), saveWorkspaceInventoryCacheEntry: vi.fn(), saveWorkspaceInventoryHostStateSnapshot: vi.fn(async () => undefined) }))
const host: HostProfile = { id: 'non-linux', name: 'Darwin', address: 'target', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1, vaultId: 'A' }
afterEach(() => { clearWorkspaceInventoryStates(); vi.clearAllMocks() })
describe('inventory collection scope and platform', () => {
  it('keeps non-Linux inventory unsupported, without persisting a fictitious empty inventory', async () => {
    probe.mockResolvedValueOnce({ snapshot: { health: 'unsupported', inventory: null, errors: [{ section: 'inventory', code: 'unsupported_os', message: 'Darwin' }] } })
    await scanWorkspaceInventoryHosts({ hosts: [host], vaultId: 'A', resolveAuthSecret: async () => '' })
    expect(getWorkspaceInventoryStates()[getWorkspaceInventoryHostKey(host)]).toMatchObject({ status: 'unsupported', error: 'Darwin' })
    expect(saveWorkspaceInventoryCacheEntry).not.toHaveBeenCalled()
    expect(saveWorkspaceInventoryHostStateSnapshot).toHaveBeenCalledWith(host, 'unsupported', expect.any(Number), 'Darwin')
  })
  it('rejects a conflicting Vault before reading caches or making any remote call', async () => {
    await expect(scanWorkspaceInventoryHosts({ hosts: [host], vaultId: 'B', resolveAuthSecret: async () => '' })).rejects.toThrow('HOST_VAULT_SCOPE_MISMATCH')
    expect(loadWorkspaceInventoryPersistedCache).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(getWorkspaceInventoryStates()).toEqual({})
  })
})
