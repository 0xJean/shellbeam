import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalOpsRuntime } from './local-ops-runtime'
const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), tick: vi.fn(), unlocked: true, create: vi.fn() }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => ({ hosts: [{ id: 'host', name: 'edge' }] }) }))
vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'vault', resolveAuthSecret: vi.fn(), vaultStatusState: { unlocked: mocks.unlocked } }) }))
vi.mock('@/lib/health-check-scheduler', () => ({ createHealthCheckScheduler: (...args: unknown[]) => { mocks.create(...args); return { start: mocks.start, stop: mocks.stop, tick: mocks.tick } } }))
vi.mock('@/lib/local-ops-store', () => ({ loadLocalAlertRules: () => [], loadLocalAlertState: () => ({ alerts: [], audit: [] }), dispatchLocalAlertNotifications: async () => undefined, LOCAL_OPS_CHANGED_EVENT: 'shellbeam:local-ops-changed' }))
beforeEach(() => { vi.clearAllMocks(); mocks.unlocked = true })
describe('LocalOpsRuntime', () => {
  it('owns scheduling without a Workspace panel and stops publication on unmount', async () => {
    const { unmount } = render(<LocalOpsRuntime />)
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ vaultId: 'vault' })
    unmount()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })
  it('does not start remote collection for a locked vault', () => {
    mocks.unlocked = false
    render(<LocalOpsRuntime />)
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
