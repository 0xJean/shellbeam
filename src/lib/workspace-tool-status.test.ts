import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getWorkspaceToolStatusHostKey, loadWorkspaceToolStatuses, saveWorkspaceToolStatus } from './workspace-tool-status'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host = { id: 'same', vaultId: 'a', name: 'edge', address: '192.0.2.1', port: 22, username: 'ops', group: 'Custom', authType: 'password' as const, tags: [], createdAt: 1, updatedAt: 1 }
const snapshot = (vaultId: string, installed: boolean) => ({ vaultId, hostKey: `vault:${JSON.stringify([vaultId, host.id])}`, hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, toolId: 'nginx', toolName: 'Nginx', status: { installed, checkedAtMs: 100 }, updatedAt: 100 })
beforeEach(() => { vi.mocked(invoke).mockReset() })
describe('vault-scoped tool observations', () => {
  it('queries exact vault/host and rejects cross-vault and legacy rows even if a backend returns them', async () => {
    vi.mocked(invoke).mockResolvedValue([snapshot('a', true), snapshot('b', false), { ...snapshot('a', false), vaultId: undefined, hostKey: host.id }])
    expect(await loadWorkspaceToolStatuses(host)).toEqual({ nginx: { installed: true, checkedAtMs: 100 } })
    expect(invoke).toHaveBeenCalledWith('list_workspace_tool_statuses', { vaultId: 'a', hostId: 'same' })
    expect(await loadWorkspaceToolStatuses({ ...host, vaultId: 'b' })).toEqual({ nginx: { installed: false, checkedAtMs: 100 } })
  })
  it('writes canonical scope and surfaces native persistence failures instead of returning false success', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await saveWorkspaceToolStatus(host, { id: 'nginx', name: 'Nginx' }, { installed: true, checkedAtMs: 100 })
    expect(invoke).toHaveBeenCalledWith('upsert_workspace_tool_status', { payload: expect.objectContaining({ vaultId: 'a', hostId: 'same', hostKey: 'vault:["a","same"]' }) })
    vi.mocked(invoke).mockRejectedValue(new Error('native unavailable'))
    await expect(saveWorkspaceToolStatus(host, { id: 'nginx', name: 'Nginx' }, { installed: true })).rejects.toThrow('native unavailable')
    await expect(loadWorkspaceToolStatuses(host)).rejects.toThrow('native unavailable')
  })
  it('keeps unscoped previews ephemeral and refuses conflicting contextual scope', async () => {
    expect(await loadWorkspaceToolStatuses({ ...host, vaultId: undefined })).toEqual({})
    expect(await saveWorkspaceToolStatus({ ...host, vaultId: undefined }, { id: 'nginx', name: 'Nginx' }, { installed: false })).toBeNull()
    expect(getWorkspaceToolStatusHostKey({ ...host, vaultId: undefined })).toBeNull()
    await expect(loadWorkspaceToolStatuses(host, 'b')).rejects.toThrow('tool_status_vault_mismatch')
    expect(invoke).not.toHaveBeenCalled()
  })
})
