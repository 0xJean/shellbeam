import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultsDashboardPanel } from './vaults-dashboard-panel'
import { registerUserConfirmationPresenter, type UserConfirmationRequest } from '@/lib/user-confirmation'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const vaults = [{ id: 'personal', name: 'Personal', createdAt: 1, isDefault: true }, { id: 'team', name: 'Team', createdAt: 2, isDefault: false }]
function props() { return { activeVaultId: 'personal', vaults, vaultStatusState: { initialized: true, unlocked: true, secretCount: 0 }, vaultKeys: [], vaultBusy: false,
  autoLockMinutes: 15, lastActivityAt: 1, securityEvents: [], onSwitchVault: vi.fn(), onInitialize: vi.fn(async () => {}), onUnlock: vi.fn(async () => {}), onLock: vi.fn(async () => {}),
  onAutoLockMinutesChange: vi.fn(), onRefresh: vi.fn(async () => {}), onRefreshVaults: vi.fn(async () => {}), onSaveSecret: vi.fn(async () => {}), onLoadSecret: vi.fn(async () => {}), onDeleteSecret: vi.fn(async () => {}), onClearSecurityEvents: vi.fn(), onError: vi.fn() } }
let unregister: (() => void) | undefined
beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en'); vi.restoreAllMocks()
  vi.mocked(invoke).mockReset().mockImplementation(async command => {
    if (command === 'vault_status') return { initialized: true, unlocked: true, secretCount: 0 }
    if (command === 'mcp_list_project_deployments') return { projects: [], total: 0, observedAt: 1 }
    if (command === 'delete_vault') return
    return []
  })
})
afterEach(() => { unregister?.(); unregister = undefined; vi.restoreAllMocks() })
const deletions = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'delete_vault')
function openDelete() { fireEvent.click(screen.getByRole('button', { name: 'Personal' })); fireEvent.click(screen.getByRole('button', { name: 'Delete Team' })) }

describe('Vault deletion asynchronous consent', () => {
  it.each([true, false])('waits for native confirmation resolving %s before deleting the explicitly named target', async answer => {
    const pending = deferred<boolean>()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(pending.promise as unknown as boolean)
    const input = props()
    render(<VaultsDashboardPanel {...input} />)
    openDelete()
    expect(confirm).toHaveBeenCalledWith('Delete vault "Team"? All data will be lost.')
    expect(deletions()).toEqual([])
    expect(input.onRefreshVaults).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(answer) })
    if (answer) await waitFor(() => expect(deletions()).toEqual([['delete_vault', { vaultId: 'team' }]]))
    else expect(deletions()).toEqual([])
    expect(input.onRefreshVaults).toHaveBeenCalledTimes(answer ? 1 : 0)
    expect(input.onSwitchVault).not.toHaveBeenCalled()
  })

  it.each(['true', 1, {}])('rejects non-boolean native consent %j without deleting any Vault', async answer => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(answer) as unknown as boolean)
    const input = props()
    render(<VaultsDashboardPanel {...input} />)
    openDelete()
    await act(async () => {})
    expect(deletions()).toEqual([])
    expect(input.onRefreshVaults).not.toHaveBeenCalled()
  })

  it.each(['active-vault', 'lock', 'target-removed', 'target-renamed', 'unmount'] as const)('drops late consent after %s changes while preserving initiating and target scope', async change => {
    const pending = deferred<boolean>()
    let request: UserConfirmationRequest | undefined
    unregister = registerUserConfirmationPresenter(async value => { request = value; return pending.promise })
    const input = props()
    const mounted = render(<VaultsDashboardPanel {...input} />)
    openDelete()
    // Deleting Team legitimately begins from Personal; the app presenter
    // scopes consent to the active Vault while the target remains explicit.
    expect(request).toMatchObject({ vaultId: 'personal', risk: 'high', message: 'Delete vault "Team"? All data will be lost.' })
    expect(request!.isCurrent?.()).toBe(true)
    if (change === 'active-vault') mounted.rerender(<VaultsDashboardPanel {...input} activeVaultId="team" />)
    if (change === 'lock') mounted.rerender(<VaultsDashboardPanel {...input} vaultStatusState={{ ...input.vaultStatusState, unlocked: false }} />)
    if (change === 'target-removed') mounted.rerender(<VaultsDashboardPanel {...input} vaults={[vaults[0]]} />)
    if (change === 'target-renamed') mounted.rerender(<VaultsDashboardPanel {...input} vaults={[vaults[0], { ...vaults[1], name: 'Renamed' }]} />)
    if (change === 'unmount') mounted.unmount()
    expect(request!.isCurrent?.()).toBe(false)
    await act(async () => { pending.resolve(true) })
    expect(deletions()).toEqual([])
    expect(input.onRefreshVaults).not.toHaveBeenCalled()
  })

  it('switches away after deleting the active nondefault Vault only after consent and native deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(true) as unknown as boolean)
    const input = props()
    render(<VaultsDashboardPanel {...input} activeVaultId="team" />)
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))
    expect(screen.queryByRole('button', { name: 'Delete Personal' })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Team' })) })
    expect(deletions()).toEqual([['delete_vault', { vaultId: 'team' }]])
    expect(input.onSwitchVault).toHaveBeenCalledWith('personal')
  })
})
