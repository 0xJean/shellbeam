import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultGateDialog } from './vault-gate-dialog'
import { claimVaultSetup, useVaultSetupSubmit } from '@/lib/vault-setup-handoff'
import { checkBiometricStatus, hasMasterPassword, isBiometricEnabled } from '@/lib/biometric'

vi.mock('@/contexts/vault-context', () => ({
  useVault: () => ({ vaults: [{ id: 'personal', name: 'Personal', createdAt: 0, isDefault: true }], activeVaultId: 'personal', vaultAutoLockMinutes: 10 }),
}))
vi.mock('@/lib/biometric', () => ({
  biometryLabel: () => 'Touch ID',
  checkBiometricStatus: vi.fn(async () => ({ available: false, type: 'none' })),
  hasMasterPassword: vi.fn(async () => false),
  isBiometricEnabled: vi.fn(() => false),
  removeMasterPassword: vi.fn(async () => {}),
  retrieveMasterPassword: vi.fn(),
  storeMasterPassword: vi.fn(async () => {}),
}))

const LOCKED = { initialized: true, unlocked: false, secretCount: 5 }
const EMPTY = { initialized: false, unlocked: false, secretCount: 0 }

beforeEach(() => { localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en') })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('VaultGateDialog', () => {
  it('shows the locked vault with its name, secret count and auto-lock window, and unlocks with the password', async () => {
    const onSubmit = vi.fn(async () => {})
    render(<VaultGateDialog open vaultStatus={LOCKED} onSubmit={onSubmit} />)
    expect(screen.getByText('Vault locked')).toBeInTheDocument()
    expect(screen.getByText('“Personal” · 5 secrets')).toBeInTheDocument()
    expect(screen.getByText('Locks automatically after 10 min of inactivity')).toBeInTheDocument()
    expect(screen.getByTestId('vault-password-form')).toHaveAttribute('data-mode', 'unlock')
    expect(screen.queryByText('Use Touch ID')).toBeNull()
    expect(screen.getByTestId('vault-submit')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Enter master password'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByTestId('vault-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('secret-pass'))
  })
  it('offers Touch ID only when biometric unlock is set up', async () => {
    vi.mocked(checkBiometricStatus).mockResolvedValue({ available: true, type: 'touchId' })
    vi.mocked(isBiometricEnabled).mockReturnValue(true)
    render(<VaultGateDialog open vaultStatus={LOCKED} onSubmit={vi.fn(async () => {})} />)
    // No stored password yet, so the automatic biometric attempt falls back to the password form.
    expect(await screen.findByRole('button', { name: 'Retry Touch ID' })).toHaveTextContent('Use Touch ID')
  })
  it('after a lock in the session, covers the app and waits for an unlock click before Touch ID', async () => {
    vi.mocked(checkBiometricStatus).mockResolvedValue({ available: true, type: 'touchId' })
    vi.mocked(isBiometricEnabled).mockReturnValue(true)
    render(<VaultGateDialog open held vaultStatus={LOCKED} onSubmit={vi.fn(async () => {})} />)
    const unlock = await screen.findByTestId('vault-held-unlock')
    expect(screen.getByText('Vault locked')).toBeInTheDocument()
    expect(screen.queryByTestId('vault-password-form')).toBeNull()
    await waitFor(() => expect(checkBiometricStatus).toHaveBeenCalled())
    expect(hasMasterPassword).not.toHaveBeenCalled()
    fireEvent.click(unlock)
    await waitFor(() => expect(hasMasterPassword).toHaveBeenCalled())
  })
  it('after a lock without Touch ID, the unlock click opens the password form', async () => {
    vi.mocked(isBiometricEnabled).mockReturnValue(false)
    render(<VaultGateDialog open held vaultStatus={LOCKED} onSubmit={vi.fn(async () => {})} />)
    fireEvent.click(await screen.findByTestId('vault-held-unlock'))
    expect(screen.getByTestId('vault-password-form')).toHaveAttribute('data-mode', 'unlock')
  })
  it('holds back the initialize form while the welcome flow creates the vault, and lends it the submit handler', () => {
    const release = claimVaultSetup()
    const onSubmit = vi.fn(async () => {})
    const { rerender } = render(<VaultGateDialog open vaultStatus={EMPTY} onSubmit={onSubmit} />)
    expect(screen.queryByTestId('vault-password-form')).toBeNull()
    expect(renderHook(useVaultSetupSubmit).result.current).toBe(onSubmit)
    rerender(<VaultGateDialog open vaultStatus={LOCKED} onSubmit={onSubmit} />)
    expect(screen.getByTestId('vault-password-form')).toHaveAttribute('data-mode', 'unlock')
    expect(renderHook(useVaultSetupSubmit).result.current).toBeNull()
    release()
  })
  it('shows the initialize form once the welcome flow is gone', () => {
    render(<VaultGateDialog open vaultStatus={EMPTY} onSubmit={vi.fn(async () => {})} />)
    expect(screen.getByTestId('vault-password-form')).toHaveAttribute('data-mode', 'initialize')
  })
})
