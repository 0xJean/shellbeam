import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeychainTab } from './keychain-tab'
import { registerUserConfirmationPresenter, type UserConfirmationRequest } from '@/lib/user-confirmation'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const key = 'ssh.test.privateKey'
function props() { return { vaultKeys: [key], vaultUnlocked: true, vaultBusy: false, activeVaultId: 'vault-a', onRefresh: vi.fn(async () => {}), onDeleteSecret: vi.fn(async () => {}), onError: vi.fn() } }
let unregister: (() => void) | undefined
beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.restoreAllMocks() })
afterEach(() => { unregister?.(); unregister = undefined; vi.restoreAllMocks() })

describe('keychain asynchronous deletion consent', () => {
  it.each([true, false])('waits for the actual native confirmation result %s before deleting a key', async answer => {
    const pending = deferred<boolean>()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(pending.promise as unknown as boolean)
    const input = props()
    render(<KeychainTab {...input} />)
    fireEvent.click(screen.getByRole('button', { name: `Delete ${key}` }))
    expect(confirm).toHaveBeenCalledWith(`Delete key "${key}"?`)
    expect(input.onDeleteSecret).not.toHaveBeenCalled()
    expect(input.onRefresh).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(answer) })
    if (answer) await waitFor(() => expect(input.onDeleteSecret).toHaveBeenCalledWith(key))
    else expect(input.onDeleteSecret).not.toHaveBeenCalled()
    expect(input.onRefresh).toHaveBeenCalledTimes(answer ? 1 : 0)
  })

  it.each(['true', 1, undefined])('does not delete for a truthy or missing native result %j', async answer => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(answer) as unknown as boolean)
    const input = props()
    render(<KeychainTab {...input} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Delete ${key}` })) })
    expect(input.onDeleteSecret).not.toHaveBeenCalled()
    expect(input.onRefresh).not.toHaveBeenCalled()
  })

  it.each(['vault', 'lock', 'key-removed', 'unmount'] as const)('rejects late accepted consent after %s changes', async change => {
    const pending = deferred<boolean>()
    let request: UserConfirmationRequest | undefined
    unregister = registerUserConfirmationPresenter(async value => { request = value; return pending.promise })
    const input = props()
    const mounted = render(<KeychainTab {...input} />)
    fireEvent.click(screen.getByRole('button', { name: `Delete ${key}` }))
    expect(request).toMatchObject({ vaultId: 'vault-a', risk: 'high' })
    expect(request!.isCurrent?.()).toBe(true)
    if (change === 'vault') mounted.rerender(<KeychainTab {...input} activeVaultId="vault-b" />)
    if (change === 'lock') mounted.rerender(<KeychainTab {...input} vaultUnlocked={false} />)
    if (change === 'key-removed') mounted.rerender(<KeychainTab {...input} vaultKeys={[]} />)
    if (change === 'unmount') mounted.unmount()
    expect(request!.isCurrent?.()).toBe(false)
    await act(async () => { pending.resolve(true) })
    expect(input.onDeleteSecret).not.toHaveBeenCalled()
    expect(input.onRefresh).not.toHaveBeenCalled()
  })
})
