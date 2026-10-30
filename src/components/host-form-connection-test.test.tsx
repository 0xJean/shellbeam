import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import { HostForm } from './host-form'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

function renderForm() {
  return render(<I18nProvider><HostForm vaultUnlocked vaultKeys={['ops-key']} onLoadVaultSecret={async () => 'stored-secret'} onSubmit={vi.fn()} onCancel={vi.fn()} /></I18nProvider>)
}

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.mocked(invoke).mockReset() })
afterEach(() => { cleanup(); localStorage.clear() })

describe('host form connection test', () => {
  it('tests the unsaved values and drops the result once they change', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'test_ssh_connection' ? { connected: true, durationMs: 42 } : [])
    renderForm()
    expect(screen.getByTestId('host-test-connection')).toBeDisabled()
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '10.0.0.5' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByTestId('host-test-connection'))
    await waitFor(() => expect(screen.getByTestId('host-test-result')).toHaveAttribute('data-status', 'ok'))
    expect(screen.getByTestId('host-test-result')).toHaveTextContent('42 ms')
    expect(invoke).toHaveBeenCalledWith('test_ssh_connection', { payload: expect.objectContaining({ host: '10.0.0.5', port: 22, authType: 'password', password: 'pw' }) })
    expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty('payload.hostId')
    fireEvent.change(screen.getByTestId('host-port'), { target: { value: '2222' } })
    expect(screen.queryByTestId('host-test-result')).not.toBeInTheDocument()
  })

  it('explains authentication failures', async () => {
    vi.mocked(invoke).mockResolvedValue({ connected: false, durationMs: 10, errorType: 'auth', message: 'Permission denied' })
    renderForm()
    fireEvent.change(screen.getByTestId('host-address'), { target: { value: '10.0.0.5' } })
    fireEvent.click(screen.getByTestId('host-test-connection'))
    await waitFor(() => expect(screen.getByTestId('host-test-result')).toHaveAttribute('data-status', 'failed'))
    expect(screen.getByTestId('host-test-result')).toHaveTextContent('Authentication failed')
    expect(screen.getByTestId('host-test-result')).toHaveTextContent('Permission denied')
  })
})
