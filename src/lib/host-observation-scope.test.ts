import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getHostObservationKey, scopeObservationHosts } from './host-observation-scope'
import { getServerMonitorHostKey, type ServerMonitorLatest } from './server-monitor'
import { getWorkspaceInventoryHostKey, loadWorkspaceInventoryCache, loadWorkspaceInventoryPersistedCache, saveWorkspaceInventoryCacheEntry, clearWorkspaceInventoryMemoryCache, parseWorkspaceInventory, loadWorkspaceInventoryHostStateSnapshots } from './workspace-inventory'
import { clearServerMonitorStates, getServerMonitorStateForHost, getServerMonitorStates, mergeServerMonitorStates } from './server-monitor-state'
import { loadPersistedServerMonitorStates } from './server-monitor-scan'
import type { HostProfile } from './hosts'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
const base: HostProfile = { id: 'same-host', name: 'host', address: 'same-address', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1 }
const a = { ...base, vaultId: 'vault-A' }
const b = { ...base, vaultId: 'vault-B' }
afterEach(() => { clearWorkspaceInventoryMemoryCache(); clearServerMonitorStates(); localStorage.clear(); vi.clearAllMocks() })
describe('Vault-scoped host observations', () => {
  it('uses the same canonical key for monitor and inventory, including escaped IDs', () => {
    const host = { ...a, id: 'host:1"', vaultId: 'vault:ops' }
    expect(getServerMonitorHostKey(host)).toBe('vault:["vault:ops","host:1\\""]')
    expect(getWorkspaceInventoryHostKey(host)).toBe(getServerMonitorHostKey(host))
    expect(getHostObservationKey(a)).not.toBe(getHostObservationKey(b))
    expect(getHostObservationKey(a)).not.toBe(base.id)
  })
  it('rejects conflicting active Vault scope before any native lookup or collection', () => {
    expect(() => scopeObservationHosts([a], 'vault-B')).toThrow('HOST_VAULT_SCOPE_MISMATCH')
    expect(scopeObservationHosts([base], 'vault-B')).toEqual([b])
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps separate local caches across restarts and never claims an old unscoped row', async () => {
    await saveWorkspaceInventoryCacheEntry(base, parseWorkspaceInventory('__SB_HOSTNAME=old-unscoped'))
    await saveWorkspaceInventoryCacheEntry(a, parseWorkspaceInventory('__SB_HOSTNAME=from-A'))
    clearWorkspaceInventoryMemoryCache()
    expect(loadWorkspaceInventoryCache([b])).toEqual({})
    await saveWorkspaceInventoryCacheEntry(b, parseWorkspaceInventory('__SB_HOSTNAME=from-B'))
    clearWorkspaceInventoryMemoryCache()
    expect(loadWorkspaceInventoryCache([a])[getHostObservationKey(a)].inventory.resource.hostname).toBe('from-A')
    expect(loadWorkspaceInventoryCache([b])[getHostObservationKey(b)].inventory.resource.hostname).toBe('from-B')
    expect(invoke).toHaveBeenCalledWith('upsert_workspace_inventory_snapshot', { payload: expect.objectContaining({ hostKey: getHostObservationKey(b), hostId: base.id }) })
  })
  it('restores only the requested Vault from native inventory and host state rows', async () => {
    const row = (host: HostProfile, name: string) => ({ hostKey: getHostObservationKey(host), hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, inventory: parseWorkspaceInventory(`__SB_HOSTNAME=${name}`), updatedAt: 100 })
    vi.mocked(invoke).mockImplementation(async (command) => command === 'list_workspace_inventory_snapshots' ? [row(a, 'from-A'), row(b, 'from-B'), row(base, 'legacy')] : [a, b, base].map((host) => ({ ...row(host, ''), hostGroup: '', tags: [], authType: 'password', status: 'unsupported' })))
    const cache = await loadWorkspaceInventoryPersistedCache([b])
    expect(Object.keys(cache)).toEqual([getHostObservationKey(b)])
    expect(cache[getHostObservationKey(b)].inventory.resource.hostname).toBe('from-B')
    const states = await loadWorkspaceInventoryHostStateSnapshots([b])
    expect(Object.keys(states)).toEqual([getHostObservationKey(b)])
    expect(states[getHostObservationKey(b)].status).toBe('unsupported')
    expect(invoke).toHaveBeenCalledWith('list_workspace_inventory_snapshots', { vaultIds: ['vault-B'] })
  })
  it('does not reuse another Vault in memory or restore its latest/history under the same host ID', async () => {
    const row = (host: HostProfile): ServerMonitorLatest => ({ hostKey: getHostObservationKey(host), hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, status: 'unsupported', snapshot: null, lastAttemptAt: 100, lastSuccessAt: null, updatedAt: 100 })
    mergeServerMonitorStates({ [getHostObservationKey(a)]: { latest: row(a), history: [] } })
    expect(getServerMonitorStateForHost(b)).toBeUndefined()
    vi.mocked(invoke).mockImplementation(async (command) => command === 'list_server_monitor_latest' ? [row(a), row(b), row(base)] : [])
    await loadPersistedServerMonitorStates([b])
    expect(Object.keys(getServerMonitorStates())).toEqual([getHostObservationKey(b)])
    expect(invoke).toHaveBeenCalledWith('list_server_monitor_latest', { vaultIds: ['vault-B'] })
    expect(invoke).toHaveBeenCalledWith('list_server_monitor_history', { query: expect.objectContaining({ hostKey: getHostObservationKey(b) }) })
  })
})
