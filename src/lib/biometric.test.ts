import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const plugin = vi.hoisted(() => ({
  checkStatus: vi.fn(),
  authenticate: vi.fn(),
  setData: vi.fn(),
  getData: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@choochmeque/tauri-plugin-biometry-api', () => plugin)

import { checkBiometricStatus, isBiometricEnabled, retrieveMasterPassword, storeMasterPassword } from './biometric'

const ENABLED = 'shellbeam.biometricEnabled'

describe('macOS biometric store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    plugin.checkStatus.mockResolvedValue({ isAvailable: true, biometryType: 2 })
  })

  it('reports unavailable on a build without the keychain entitlement', async () => {
    invoke.mockRejectedValue('keychainError: missing keychain entitlement (-34018)')
    localStorage.setItem(ENABLED, 'true')
    const status = await checkBiometricStatus()
    expect(status.available).toBe(false)
    expect(status.error).toContain('-34018')
    expect(isBiometricEnabled()).toBe(false)
  })

  it('does not claim Touch ID when the system says it is unavailable', async () => {
    invoke.mockResolvedValue(false)
    plugin.checkStatus.mockResolvedValue({ isAvailable: false, biometryType: 0 })
    expect((await checkBiometricStatus()).available).toBe(false)
  })

  it('makes an enrolment from the old file store enrol again', async () => {
    invoke.mockResolvedValue(false)
    localStorage.setItem(ENABLED, 'true')
    expect((await checkBiometricStatus()).available).toBe(true)
    expect(isBiometricEnabled()).toBe(false)
  })

  it('keeps a live enrolment', async () => {
    invoke.mockResolvedValue(true)
    localStorage.setItem(ENABLED, 'true')
    await checkBiometricStatus()
    expect(isBiometricEnabled()).toBe(true)
  })

  it('leaves the gate to the Keychain instead of a separate frontend check', async () => {
    invoke.mockResolvedValue('secret')
    await expect(retrieveMasterPassword('why')).resolves.toBe('secret')
    expect(invoke).toHaveBeenCalledWith('biometric_retrieve_password', { reason: 'why' })
    await storeMasterPassword('secret')
    expect(plugin.authenticate).not.toHaveBeenCalled()
    expect(plugin.setData).not.toHaveBeenCalled()
  })
})
