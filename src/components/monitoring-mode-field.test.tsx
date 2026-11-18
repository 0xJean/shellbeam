import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostForm } from './host-form'
import { listKomariIntegrations, upsertKomariIntegration } from '@/lib/komari-config'
import { verifyKomariConnection } from '@/lib/komari'
import { requestUserDecision } from '@/lib/user-confirmation'

vi.mock('@/lib/user-confirmation', () => ({ requestUserDecision: vi.fn() }))
vi.mock('@/lib/komari-config', async (original) => ({
  ...await original<typeof import('@/lib/komari-config')>(),
  listKomariIntegrations: vi.fn(async () => []),
  upsertKomariIntegration: vi.fn(),
  deleteKomariIntegration: vi.fn(),
}))
vi.mock('@/lib/komari', async (original) => ({
  ...await original<typeof import('@/lib/komari')>(),
  verifyKomariConnection: vi.fn(async () => []),
}))
vi.mock('@/hooks/use-probe-install-readiness', async (original) => ({
  ...await original<typeof import('@/hooks/use-probe-install-readiness')>(),
  useProbeInstallReadiness: () => ({ readiness: null, record: null, reload: vi.fn() }),
}))

describe('unified host probe option in HostForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem('shellbeam.locale', 'en')
    vi.mocked(listKomariIntegrations).mockResolvedValue([])
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('defaults to native SSH monitoring and switches to probe monitoring immediately without confirmation popups', async () => {
    const save = vi.fn(async () => {})
    render(<HostForm vaultId="v" vaultUnlocked onSubmit={save} onCancel={() => {}} initial={{ authType: 'privateKey', privateKeyRef: 'keep' }} />)

    const ssh = screen.getByTestId('monitoring-mode-ssh')
    const serverToggle = screen.getByTestId('monitoring-mode-server')
    expect(ssh).toBeChecked()
    expect(serverToggle).not.toBeChecked()

    fireEvent.click(serverToggle)
    expect(serverToggle).toBeChecked()
    expect(ssh).not.toBeChecked()
    expect(requestUserDecision).not.toHaveBeenCalled()
  })

  it('expands inline ShellBeam Server setup when no server exists and connects on Save before launching probe install', async () => {
    const save = vi.fn(async () => {})
    const saveVaultSecret = vi.fn(async () => {})
    vi.mocked(upsertKomariIntegration).mockResolvedValue({
      id: 'srv-1',
      vaultId: 'v',
      name: 'monitor.example.com',
      endpoint: 'https://monitor.example.com',
      credentialRef: 'komari.srv-1.api-key',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    vi.mocked(verifyKomariConnection).mockResolvedValue([])

    render(
      <HostForm
        vaultId="v"
        vaultUnlocked
        onSaveToVault={saveVaultSecret}
        onSubmit={save}
        onCancel={() => {}}
        initial={{ authType: 'privateKey', privateKeyRef: 'keep' }}
      />,
    )

    fireEvent.click(screen.getByTestId('monitoring-mode-server'))
    expect(await screen.findByTestId('inline-server-connect')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('inline-server-mode-key'))
    fireEvent.change(screen.getByTestId('inline-server-endpoint'), { target: { value: 'https://monitor.example.com' } })
    fireEvent.change(screen.getByTestId('inline-server-api-key'), { target: { value: 'secret-api-token' } })
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '10.0.0.8' } })
    fireEvent.change(screen.getByTestId('host-username'), { target: { value: 'root' } })

    fireEvent.click(screen.getByTestId('host-save'))

    await waitFor(() => expect(verifyKomariConnection).toHaveBeenCalledWith({
      endpoint: 'https://monitor.example.com',
      token: 'secret-api-token',
    }))
    expect(saveVaultSecret).toHaveBeenCalledWith(expect.stringMatching(/^komari\..+\.api-key$/), 'secret-api-token')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ monitoringMode: 'server', address: '10.0.0.8' }), { installProbe: true })
  })

  it('shows existing connected server and allows saving with or without auto-installing the probe', async () => {
    vi.mocked(listKomariIntegrations).mockResolvedValue([{
      id: 'srv-existing',
      vaultId: 'v',
      name: 'My Ops Server',
      endpoint: 'https://ops.example.com',
      credentialRef: 'komari.srv-existing.api-key',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }])
    const save = vi.fn(async () => {})
    render(<HostForm vaultId="v" vaultUnlocked onSubmit={save} onCancel={() => {}} initial={{ monitoringMode: 'server', authType: 'privateKey', privateKeyRef: 'keep' }} />)

    expect(await screen.findByText('My Ops Server')).toBeInTheDocument()
    const option = screen.getByTestId('host-form-install-probe')
    expect(option.querySelector('input')).toBeChecked()

    fireEvent.change(screen.getByTestId('host-address'), { target: { value: 'new.test' } })
    fireEvent.change(screen.getByTestId('host-username'), { target: { value: 'root' } })
    fireEvent.click(screen.getByTestId('host-save'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ monitoringMode: 'server' }), { installProbe: true }))

    fireEvent.click(option.querySelector('input')!)
    fireEvent.click(screen.getByTestId('host-save'))
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.anything(), { installProbe: false }))
  })

  it('never offers the installer while the host stays on native SSH monitoring', () => {
    render(<HostForm vaultId="v" vaultUnlocked onSubmit={vi.fn()} onCancel={() => {}} />)
    expect(screen.queryByTestId('host-form-install-probe')).not.toBeInTheDocument()
  })
})
