import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OPEN_KNOWN_HOSTS_REQUEST_EVENT } from '@/lib/navigation-request'
import { SessionConnectPlaceholder } from './session-connect-placeholder'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))

const stageStates = () => Array.from(document.querySelectorAll('[data-stage-state]')).map((node) => node.getAttribute('data-stage-state'))

describe('session connect placeholder', () => {
  it('shows live stage progress and cancels the connection', () => {
    const onCancel = vi.fn()
    render(<SessionConnectPlaceholder hostName="prod-web-01" hostAddress="10.0.0.5" status="connecting" stage="secure_session" onCancel={onCancel} />)
    expect(stageStates()).toEqual(['done', 'done', 'done', 'current', 'pending', 'pending'])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('marks the failed stage derived from the backend error and copies the error', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onRetry = vi.fn()
    render(<SessionConnectPlaceholder hostName="prod-web-01" hostAddress="10.0.0.5" status="error" errorMessage="SSH target auth_failed" onRetry={onRetry} />)
    expect(screen.getByTestId('session-connection-failed-stage')).toHaveAttribute('data-stage', 'authenticate')
    expect(stageStates()).toEqual(['done', 'done', 'done', 'done', 'failed', 'pending'])
    expect(screen.getByText('The server rejected the credentials')).toBeInTheDocument()
    expect(screen.getByTestId('session-connection-error')).toHaveTextContent('SSH target auth_failed')
    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }))
    expect(writeText).toHaveBeenCalledWith('SSH target auth_failed')
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /terminalConnect.retry/ }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows no stage marker when the error does not identify one', () => {
    render(<SessionConnectPlaceholder hostName="prod" hostAddress="10.0.0.5" status="error" errorMessage="VAULT_LOCKED" />)
    expect(screen.queryByTestId('session-connection-failed-stage')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-connection-error')).toHaveTextContent('VAULT_LOCKED')
  })

  it('offers Known Hosts when the host key changed', () => {
    const listener = vi.fn()
    window.addEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, listener)
    const error = JSON.stringify({ code: 'host_key_mismatch', host: '10.0.0.5', port: 22, fingerprint: 'new', keyType: 'Ed25519', routeStage: 'target' })
    render(<SessionConnectPlaceholder hostName="prod" hostAddress="10.0.0.5" status="error" errorMessage={error} />)
    expect(screen.getByTestId('session-connection-failed-stage')).toHaveAttribute('data-stage', 'verify_host')
    fireEvent.click(screen.getByRole('button', { name: 'View known hosts' }))
    expect(listener).toHaveBeenCalled()
    window.removeEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, listener)
  })
})
