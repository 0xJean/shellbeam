import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { SessionTab } from '@/lib/types'
import { TERMINAL_AI_TOGGLE_EVENT } from '@/lib/terminal-events'
import { MobileSessionHeader } from './mobile-session-header'

vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/workspace-inventory-state', () => ({ useWorkspaceInventoryStates: () => ({}) }))

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })
afterEach(cleanup)

const tabs: SessionTab[] = [
  { sessionId: 's1', hostName: 'prod-web-01', hostAddress: '47.242.18.6', hostId: 'h1', status: 'connected' },
  { sessionId: 's2', hostName: 'db-master', hostAddress: '10.0.3.12', status: 'reconnecting' },
  { sessionId: 's3', hostName: 'Local', hostAddress: '', connectionKind: 'local', status: 'connected' },
]
const host = { id: 'h1', name: 'prod-web-01', address: '47.242.18.6', username: 'root', group: 'Production', createdAt: 1, updatedAt: 2 } as HostProfile

function setup(overrides: Partial<Parameters<typeof MobileSessionHeader>[0]> = {}) {
  const props = {
    sessionTabs: tabs, activeSessionId: 's1', hosts: [host],
    onSelectSession: vi.fn(), onCloseSession: vi.fn(), onNewConnection: vi.fn(), onOpenLocalTerminal: vi.fn(), onConnectHost: vi.fn(),
    ...overrides,
  }
  render(<MobileSessionHeader {...props} />)
  return props
}

describe('MobileSessionHeader', () => {
  it('shows the active session pill with its position and opens the session sheet', () => {
    const props = setup()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch session' }))
    const sheet = screen.getByRole('dialog', { name: 'Switch session' })
    expect(within(sheet).getByText('Sessions · 3')).toBeInTheDocument()
    expect(within(sheet).getByText('Current')).toBeInTheDocument()
    expect(within(sheet).getByText('root@47.242.18.6')).toBeInTheDocument()
    expect(within(sheet).getByText('Reconnecting…')).toBeInTheDocument()
    expect(within(sheet).getByText('This device')).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close session db-master' }))
    expect(props.onCloseSession).toHaveBeenCalledWith('s2')
    fireEvent.click(within(sheet).getByText('db-master'))
    expect(props.onSelectSession).toHaveBeenCalledWith('s2')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('requests the AI assistant for the active session and opens the drawer', () => {
    const onOpenDrawer = vi.fn(); const onBack = vi.fn()
    const listener = vi.fn()
    window.addEventListener(TERMINAL_AI_TOGGLE_EVENT, listener)
    setup({ onOpenDrawer, onBack })
    fireEvent.click(screen.getByRole('button', { name: 'AI assistant' }))
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' })
    fireEvent.click(screen.getByRole('button', { name: 'Terminal tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onOpenDrawer).toHaveBeenCalled(); expect(onBack).toHaveBeenCalled()
    window.removeEventListener(TERMINAL_AI_TOGGLE_EVENT, listener)
  })

  it('renders the no-session state with quick connect to recent hosts', () => {
    const props = setup({ sessionTabs: [], activeSessionId: null })
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    expect(screen.getByText('Quick connect · last 1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('prod-web-01'))
    expect(props.onConnectHost).toHaveBeenCalledWith('h1')
  })
})
