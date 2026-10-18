import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellbeamAgentRuntime } from './shellbeam-agent-runtime'
import { listShellbeamAgents, type ShellbeamAgentRecord } from '@/lib/shellbeam-agent'
import { createShellbeamAgentScheduler } from '@/lib/shellbeam-agent-scheduler'
import type { HostProfile } from '@/lib/hosts'
const scope = vi.hoisted(() => ({ vaultId: 'vault-a', hosts: [] as HostProfile[], resolve: vi.fn(async () => 'secret') }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: scope.hosts }) }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: scope.vaultId, resolveAuthSecret: scope.resolve, vaultStatusState: { unlocked: true } }) }))
vi.mock('@/lib/shellbeam-agent', () => ({ listShellbeamAgents: vi.fn(), SHELLBEAM_AGENT_STATE_CHANGED_EVENT: 'agent-changed' }))
vi.mock('@/lib/shellbeam-agent-scheduler', () => ({ createShellbeamAgentScheduler: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const host = (vaultId: string) => ({ vaultId, id: 'same-id', name: 'edge', address: '192.0.2.1', port: 22, username: 'ops', authType: 'password', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile)
const record = (vaultId: string) => ({ vaultId, hostId: 'same-id', status: 'installed', health: 'online' } as ShellbeamAgentRecord)
describe('Agent runtime vault hydration gate', () => {
  it('cannot start a new-vault scan using old records or old host objects during a vault switch', async () => {
    scope.vaultId = 'vault-a'; scope.hosts = [host('vault-a')]
    let resolveB!: (records: ShellbeamAgentRecord[]) => void
    vi.mocked(listShellbeamAgents).mockImplementation(async ({ vaultId } = {}) => vaultId === 'vault-a' ? [record('vault-a')] : new Promise((resolve) => { resolveB = resolve }))
    const stopA = vi.fn(); vi.mocked(createShellbeamAgentScheduler).mockReturnValue({ start: vi.fn(), stop: stopA, isRunning: () => true, scanNow: vi.fn() })
    const view = render(<ShellbeamAgentRuntime />)
    await waitFor(() => expect(createShellbeamAgentScheduler).toHaveBeenCalledTimes(1))
    scope.vaultId = 'vault-b'; view.rerender(<ShellbeamAgentRuntime />)
    expect(stopA).toHaveBeenCalledTimes(1)
    expect(createShellbeamAgentScheduler).toHaveBeenCalledTimes(1)
    await act(async () => { resolveB([record('vault-a'), record('vault-b')]) })
    expect(createShellbeamAgentScheduler).toHaveBeenCalledTimes(1)
    scope.hosts = [host('vault-a'), host('vault-b')]; view.rerender(<ShellbeamAgentRuntime />)
    await waitFor(() => expect(createShellbeamAgentScheduler).toHaveBeenCalledTimes(2))
    expect(vi.mocked(createShellbeamAgentScheduler).mock.calls[1][0]).toMatchObject({ vaultId: 'vault-b', hosts: [host('vault-b')], previousRecords: [record('vault-b')] })
  })
})
