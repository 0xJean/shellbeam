import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CLOSE_SESSION_REQUEST_EVENT } from '@/lib/navigation-request'
import { SessionConnectionLostOverlay } from './session-connection-lost-overlay'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
let progress: Record<string, unknown> = {}
vi.mock('@/contexts/sessions-context', () => ({ useOptionalSessions: () => ({ reconnectProgress: progress }) }))

describe('session connection lost overlay', () => {
  it('shows the live reconnect attempt', () => {
    progress = { s1: { attempt: 2, maxRetries: 5, intervalMs: 3000 } }
    render(<SessionConnectionLostOverlay sessionId="s1" hostName="prod" backdrop="#000000" isDisconnected isReconnecting onReconnect={vi.fn()} />)
    expect(screen.getByText('terminal.reconnecting')).toBeInTheDocument()
    expect(screen.getByText('prod · attempt 2 / 5 · every 3s')).toBeInTheDocument()
  })

  it('reconnects or asks the shell to close the tab after auto-reconnect failed', () => {
    progress = { s1: { attempt: 5, maxRetries: 5, intervalMs: 3000, failedAt: new Date(2026, 0, 1, 10, 42).getTime() } }
    const onReconnect = vi.fn()
    const listener = vi.fn()
    window.addEventListener(CLOSE_SESSION_REQUEST_EVENT, listener)
    render(<SessionConnectionLostOverlay sessionId="s1" hostName="prod" backdrop="#000000" isDisconnected onReconnect={onReconnect} />)
    expect(screen.getByText(/auto-reconnect failed after 5 attempts/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /terminal.reconnect/ }))
    expect(onReconnect).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' })
    window.removeEventListener(CLOSE_SESSION_REQUEST_EVENT, listener)
  })

  it('renders nothing while connected', () => {
    progress = {}
    const { container } = render(<SessionConnectionLostOverlay sessionId="s1" hostName="prod" backdrop="#000000" isDisconnected={false} onReconnect={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
