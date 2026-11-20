import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostForm } from './host-form'
import * as keysLib from '@/lib/keys'

vi.mock('@/lib/ssh', () => ({ sshAgentAvailable: () => true }))
vi.mock('@/lib/sessions', () => ({ testSshConnection: vi.fn() }))
vi.mock('@/lib/server-quick-connect', () => ({
  connectShellbeamServer: vi.fn(),
  formatServerConnectError: (err: unknown) => String(err),
}))
vi.mock('./monitoring-mode-field', () => ({
  MonitoringModeField: () => <div data-testid="monitoring-mode-field" />,
}))

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('HostForm credentials UX', () => {
  it('warns and blocks saving when a public key (.pub) is pasted instead of a private key', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onSaveToVault = vi.fn().mockResolvedValue(undefined)

    render(
      <HostForm
        vaultUnlocked
        onSaveToVault={onSaveToVault}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('host-auth-private-key'))
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '217.216.37.253' } })
    fireEvent.change(screen.getByTestId('host-private-key'), {
      target: { value: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC test@mac' },
    })

    expect(screen.getByTestId('host-public-key-warning')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('host-save'))
    await waitFor(() => expect(onSaveToVault).not.toHaveBeenCalled())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('picks a local SSH private key file and pre-fills the customizable Vault credential name', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onSaveToVault = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(keysLib, 'pickPrivateKeyFile').mockResolvedValue({
      content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n',
      fileName: 'id_rsa_prod',
    })

    render(
      <HostForm
        vaultUnlocked
        onSaveToVault={onSaveToVault}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('host-auth-private-key'))
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '217.216.37.253' } })
    fireEvent.click(screen.getByTestId('host-pick-private-key'))

    await waitFor(() => {
      expect(screen.getByTestId('host-private-key')).toHaveValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n',
      )
    })
    expect(screen.getByTestId('host-secret-name')).toHaveValue('id_rsa_prod')

    // User can further customize the Vault credential name
    fireEvent.change(screen.getByTestId('host-secret-name'), { target: { value: 'my-custom-prod-key' } })
    fireEvent.click(screen.getByTestId('host-save'))

    await waitFor(() => {
      expect(onSaveToVault).toHaveBeenCalledWith(
        'my-custom-prod-key',
        '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n',
      )
    })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'privateKey',
        privateKeyRef: 'my-custom-prod-key',
      }),
      expect.anything(),
    )
  })

  it('allows customizing Vault credential name when entering a password manually', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onSaveToVault = vi.fn().mockResolvedValue(undefined)

    render(
      <HostForm
        vaultUnlocked
        onSaveToVault={onSaveToVault}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('host-auth-password'))
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '217.216.37.253' } })
    fireEvent.change(screen.getByTestId('host-password'), { target: { value: 's3cr3t-pass' } })
    fireEvent.change(screen.getByTestId('host-secret-name'), { target: { value: 'prod-root-pwd' } })
    fireEvent.click(screen.getByTestId('host-save'))

    await waitFor(() => {
      expect(onSaveToVault).toHaveBeenCalledWith('prod-root-pwd', 's3cr3t-pass')
    })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'password',
        passwordKeyRef: 'prod-root-pwd',
      }),
      expect.anything(),
    )
  })
})
