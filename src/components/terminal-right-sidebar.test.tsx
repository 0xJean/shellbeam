import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const historyHook = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-command-history', () => ({ useCommandHistory: (...args: unknown[]) => historyHook(...args) }))
vi.mock('@/components/terminal-widgets', () => ({ FontSizeControl: () => null, TerminalThemeGrid: () => null }))
vi.mock('@/components/snippet-compact-list', () => ({ SnippetCompactList: () => null }))

import { TerminalRightSidebar } from './terminal-right-sidebar'
import { requestTerminalSearchToggle, TERMINAL_SEARCH_TOGGLE_EVENT } from '@/lib/terminal-events'

const props = (patch = {}) => ({
  visible: true, onClose: vi.fn(), hostAddress: '10.0.0.8', snippets: [], onApplySnippet: vi.fn(), onRunSnippet: vi.fn(),
  terminalPrefs: { fontSize: 14, fontFamily: 'Menlo', themeId: 'default' } as never, onTerminalPrefsChange: vi.fn(), onSearchToggle: vi.fn(), searchVisible: false, ...patch,
})

describe('TerminalRightSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
    historyHook.mockReturnValue({ loading: false, refresh: vi.fn(), entries: [
      { id: 'r1', host: '10.0.0.8', command: 'systemctl restart nginx', status: 'success', createdAt: 1, result: { exitCode: 0, stdout: 'ok', stderr: '' } },
      { id: 'r2', host: '10.0.0.8', command: 'docker compose up -d', status: 'failed', createdAt: 2, result: { exitCode: 1, stdout: '', stderr: 'no such file' } },
    ] })
  })

  it('wires the terminal search button', () => {
    const input = props()
    render(<TerminalRightSidebar {...input} />)
    fireEvent.click(screen.getAllByText('Search Terminal')[0])
    expect(input.onSearchToggle).toHaveBeenCalledOnce()
  })

  it('shows run history for this host next to typed commands', () => {
    render(<TerminalRightSidebar {...props({ vaultId: 'vault-a' })} />)
    fireEvent.click(screen.getAllByTitle('History')[0])
    expect(screen.getAllByTestId('history-view-typed')[0]).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getAllByTestId('history-view-runs')[0])
    expect(historyHook).toHaveBeenCalledWith('vault-a', { host: '10.0.0.8' })
    expect(screen.getAllByText('systemctl restart nginx').length).toBeGreaterThan(0)
    expect(screen.getAllByText('docker compose up -d').length).toBeGreaterThan(0)
  })
})

describe('terminal search events', () => {
  it('targets one session', () => {
    const listener = vi.fn()
    window.addEventListener(TERMINAL_SEARCH_TOGGLE_EVENT, listener)
    requestTerminalSearchToggle('s1')
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' })
    window.removeEventListener(TERMINAL_SEARCH_TOGGLE_EVENT, listener)
  })
})
