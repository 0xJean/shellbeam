import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const vault = vi.hoisted(() => ({
  activeVaultId: 'personal',
  vaults: [{ id: 'personal', name: 'Personal', createdAt: 1, isDefault: true }, { id: 'client', name: 'Client A', createdAt: 2, isDefault: false }],
  vaultStatusState: { unlocked: true } as { unlocked: boolean } | null,
  vaultBusy: false,
  securityEvents: [{ id: 'e1', timestamp: 1, level: 'warn', message: 'Unlock failed' }, { id: 'e2', timestamp: 2, level: 'info', message: 'Vault unlocked' }],
  setActiveVaultId: vi.fn(), refreshVaults: vi.fn(async () => {}), handleLock: vi.fn(async () => {}), handleClearSecurityEvents: vi.fn(),
}))
const api = vi.hoisted(() => ({ createVault: vi.fn(), updateVault: vi.fn(), deleteVault: vi.fn(), confirm: vi.fn() }))

vi.mock('@/contexts/vault-context', () => ({ useVault: () => vault }))
vi.mock('@/lib/vaults', () => ({ DEFAULT_VAULT_ID: 'personal', createVault: api.createVault, updateVault: api.updateVault, deleteVault: api.deleteVault }))
vi.mock('@/lib/user-confirmation', () => ({ confirmUserAction: api.confirm }))

import { SecuritySettingsSection } from './security-settings-section'

describe('SecuritySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem('shellbeam.locale', 'en')
    vault.vaultStatusState = { unlocked: true }
  })

  it('locks the vault now', () => {
    render(<SecuritySettingsSection />)
    fireEvent.click(screen.getByTestId('security-lock-now'))
    expect(vault.handleLock).toHaveBeenCalledOnce()
  })

  it('creates a vault and switches to it', async () => {
    api.createVault.mockResolvedValue({ id: 'new', name: 'Lab', createdAt: 3, isDefault: false })
    render(<SecuritySettingsSection />)
    fireEvent.click(screen.getByTestId('security-vault-create'))
    fireEvent.change(screen.getByPlaceholderText('Vault name'), { target: { value: ' Lab ' } })
    fireEvent.click(screen.getByTestId('security-vault-create-save'))
    await waitFor(() => expect(vault.setActiveVaultId).toHaveBeenCalledWith('new'))
    expect(api.createVault).toHaveBeenCalledWith('Lab')
    expect(vault.refreshVaults).toHaveBeenCalled()
  })

  it('switches and renames vaults', async () => {
    api.updateVault.mockResolvedValue({})
    render(<SecuritySettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    expect(vault.setActiveVaultId).toHaveBeenCalledWith('client')
    fireEvent.click(screen.getByRole('button', { name: 'Rename · Client A' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename' }), { target: { value: 'Client B' } })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Rename' }).closest('form')!)
    await waitFor(() => expect(api.updateVault).toHaveBeenCalledWith('client', 'Client B'))
  })

  it('deletes a vault only after a high-risk confirmation and never offers the default', async () => {
    render(<SecuritySettingsSection />)
    expect(screen.queryByTestId('security-vault-delete-personal')).not.toBeInTheDocument()
    api.confirm.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByTestId('security-vault-delete-client'))
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high', message: expect.stringContaining('Client A') })))
    expect(api.confirm.mock.calls[0][0].message).toMatch(/hosts, credentials, snippets, port forwards, monitoring history, known hosts and command history.*cannot be undone/)
    expect(api.deleteVault).not.toHaveBeenCalled()
    localStorage.setItem('shellbeam.certificates.client', '[]')
    localStorage.setItem('shellbeam.certificates.personal', '[]')
    api.confirm.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByTestId('security-vault-delete-client'))
    await waitFor(() => expect(api.deleteVault).toHaveBeenCalledWith('client'))
    await waitFor(() => expect(localStorage.getItem('shellbeam.certificates.client')).toBeNull())
    expect(localStorage.getItem('shellbeam.certificates.personal')).toBe('[]')
  })

  it('disables deletion while the vault is locked', () => {
    vault.vaultStatusState = { unlocked: false }
    render(<SecuritySettingsSection />)
    expect(screen.getByTestId('security-vault-delete-client')).toBeDisabled()
    expect(screen.getByTestId('security-lock-now')).toBeDisabled()
  })

  it('shows security events newest first and clears them', () => {
    render(<SecuritySettingsSection />)
    const events = screen.getAllByTestId('security-event')
    expect(events[0]).toHaveTextContent('Vault unlocked')
    expect(events[1]).toHaveAttribute('data-level', 'warn')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(vault.handleClearSecurityEvents).toHaveBeenCalledOnce()
  })
})
