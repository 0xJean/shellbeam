import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { appendActivity, listActivityLog } from './activity-log'
import { listCommandHistory } from './history'
import { fetchAndAddKnownHost, listKnownHosts, removeKnownHost } from './known-hosts'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('vault-scoped history, activity and known hosts', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue([]) })

  it('sends the vault with every call', async () => {
    await listKnownHosts('vault-a')
    await fetchAndAddKnownHost('vault-a', 'h.example', 22)
    await removeKnownHost('vault-a', 'h.example', 22)
    await listCommandHistory('vault-a', { host: 'h.example' })
    await listActivityLog('vault-a')
    await appendActivity({ vaultId: 'vault-a', event: 'connect', hostName: 'h', hostAddress: 'h.example' })
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['list_known_hosts', { vaultId: 'vault-a' }],
      ['fetch_and_add_known_host', { vaultId: 'vault-a', host: 'h.example', port: 22 }],
      ['remove_known_host', { vaultId: 'vault-a', host: 'h.example', port: 22 }],
      ['list_command_history', { vaultId: 'vault-a', filter: { host: 'h.example' } }],
      ['list_activity_log', { vaultId: 'vault-a' }],
      ['append_activity', { vaultId: 'vault-a', event: 'connect', hostName: 'h', hostAddress: 'h.example' }],
    ])
  })
})
