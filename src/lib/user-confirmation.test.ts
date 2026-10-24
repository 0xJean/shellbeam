import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmUserAction, registerUserConfirmationPresenter } from './user-confirmation'

afterEach(() => vi.restoreAllMocks())

describe('asynchronous user consent', () => {
  it.each([true, false])('awaits a platform Promise resolving %s instead of treating it as consent', async answer => {
    let respond!: (value: boolean) => void
    const decision = new Promise<boolean>(resolve => { respond = resolve })
    vi.spyOn(window, 'confirm').mockReturnValue(decision as unknown as boolean)
    let finished = false
    const pending = confirmUserAction({ message: 'Restart this service?' }).then(value => { finished = true; return value })
    await Promise.resolve()
    expect(finished).toBe(false)
    respond(answer)
    expect(await pending).toBe(answer)
  })

  it.each(['true', {}, 1, undefined])('does not accept truthy or missing platform output %s', async answer => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(answer) as unknown as boolean)
    expect(await confirmUserAction({ message: 'Delete?' })).toBe(false)
  })

  it('rejects unavailable dialogs and stale initiating scope', async () => {
    const native = vi.spyOn(window, 'confirm').mockRejectedValue(new Error('dialog unavailable') as never)
    expect(await confirmUserAction({ message: 'Delete?' })).toBe(false)
    expect(await confirmUserAction({ message: 'Delete?', isCurrent: () => false })).toBe(false)
    expect(native).toHaveBeenCalledOnce()
  })

  it('requires the exact typed destructive token, including asynchronous platform prompts', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(Promise.resolve('delete') as unknown as string)
    expect(await confirmUserAction({ message: 'Type DELETE', token: 'DELETE' })).toBe(false)
    prompt.mockReturnValue(Promise.resolve('DELETE') as unknown as string)
    expect(await confirmUserAction({ message: 'Type DELETE', token: 'DELETE' })).toBe(true)
  })

  it('uses only the registered visible presenter, and unregisters its exact owner', async () => {
    const native = vi.spyOn(window, 'confirm')
    const present = vi.fn(async () => true)
    const unregister = registerUserConfirmationPresenter(present)
    try {
      expect(() => registerUserConfirmationPresenter(async () => true)).toThrow('ALREADY_REGISTERED')
      expect(await confirmUserAction({ message: 'Restart?' })).toBe(true)
      expect(present).toHaveBeenCalledWith({ message: 'Restart?' })
      expect(native).not.toHaveBeenCalled()
    } finally { unregister() }
    native.mockReturnValue(false)
    expect(await confirmUserAction({ message: 'Restart?' })).toBe(false)
  })
})
