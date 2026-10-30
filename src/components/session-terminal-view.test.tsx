import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionTerminalView } from './session-terminal-view'

vi.mock('@/contexts/vault-context', () => ({ useVault: () => ({ activeVaultId: 'personal' }) }))

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string) => key,
}))

vi.mock('@/lib/terminal-themes', () => ({
  DEFAULT_TERMINAL_PREFS: {
    fontSize: 14,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    themeId: 'hacker-green',
  },
  useResolvedTerminalTheme: () => ({ background: '#000000', foreground: '#00ff41' }),
}))

vi.mock('./ai-command-bar', () => ({
  AICommandBar: () => <div data-testid="ai-command-bar" />,
}))

vi.mock('./mobile-terminal-toolbar', () => ({
  MobileTerminalToolbar: () => <div data-testid="mobile-terminal-toolbar" />,
}))

vi.mock('./suggest-bar', () => ({
  SuggestBar: () => <div data-testid="suggest-bar" />,
}))

vi.mock('./terminal-search-bar', () => ({
  TerminalSearchBar: () => <div data-testid="terminal-search-bar" />,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    buffer = {
      active: {
        length: 0,
        getLine: () => null,
      },
    }

    options: Record<string, unknown> = {}

    loadAddon() {}
    open() {}
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
    dispose() {}
    onData() { return { dispose() {} } }
    onBinary() { return { dispose() {} } }
    onResize() { return { dispose() {} } }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {},
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
})

describe('session terminal view', () => {
  it('renders workspace toggle without duplicate browser shortcuts in the toolbar', () => {
    render(
      <SessionTerminalView
        sessionId="session-1"
        session={{
          sessionId: 'session-1',
          status: 'running',
          username: 'root',
        } as never}
        hostName="OpenClaw-KK"
        hostAddress="164.68.124.173"
        chunkEmitterRef={{ current: {} }}
        onSendRaw={() => {}}
        workspaceMode="workspace"
        onWorkspaceModeChange={() => {}}
        onOpenBrowser={() => {}}
        onToggleRightSidebar={() => {}}
        rightSidebarOpen={false}
      />,
    )

    expect(screen.getByRole('button', { name: 'workspace.mode.terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.mode.workspace' })).toBeInTheDocument()
    expect(screen.queryByTitle('terminal.openBrowser')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^ai$/i })).not.toBeInTheDocument()
    expect(screen.getByTitle('rightSidebar.terminal')).toBeInTheDocument()
  })

  it('normalizes localhost preview urls before opening them', () => {
    const openLink = vi.fn()
    const chunkEmitterRef = { current: {} as Record<string, (chunks: Array<{ data: string }>) => void> }

    render(
      <SessionTerminalView
        sessionId="session-4"
        session={{
          sessionId: 'session-4',
          status: 'running',
          username: 'root',
        } as never}
        hostName="OpenClaw-KK"
        hostAddress="164.68.124.173"
        chunkEmitterRef={chunkEmitterRef}
        onSendRaw={() => {}}
        onOpenLinkInBrowser={openLink}
      />,
    )

    act(() => {
      chunkEmitterRef.current['session-4']?.([{ data: 'Preview at localhost:3000/dashboard\n' } as never])
    })

    fireEvent.click(screen.getByTitle('terminal.openLatestLink'))
    expect(openLink).toHaveBeenCalledWith('http://localhost:3000/dashboard')
  })

  it('normalizes LAN preview urls before opening them', () => {
    const openLink = vi.fn()
    const chunkEmitterRef = { current: {} as Record<string, (chunks: Array<{ data: string }>) => void> }

    render(
      <SessionTerminalView
        sessionId="session-5"
        session={{
          sessionId: 'session-5',
          status: 'running',
          username: 'root',
        } as never}
        hostName="OpenClaw-KK"
        hostAddress="164.68.124.173"
        chunkEmitterRef={chunkEmitterRef}
        onSendRaw={() => {}}
        onOpenLinkInBrowser={openLink}
      />,
    )

    act(() => {
      chunkEmitterRef.current['session-5']?.([{ data: 'Service at 192.168.1.20:8080/app\n' } as never])
    })

    fireEvent.click(screen.getByTitle('terminal.openLatestLink'))
    expect(openLink).toHaveBeenCalledWith('http://192.168.1.20:8080/app')
  })

  it('normalizes host port preview urls before opening them', () => {
    const openLink = vi.fn()
    const chunkEmitterRef = { current: {} as Record<string, (chunks: Array<{ data: string }>) => void> }

    render(
      <SessionTerminalView
        sessionId="session-6"
        session={{
          sessionId: 'session-6',
          status: 'running',
          username: 'root',
        } as never}
        hostName="OpenClaw-KK"
        hostAddress="164.68.124.173"
        chunkEmitterRef={chunkEmitterRef}
        onSendRaw={() => {}}
        onOpenLinkInBrowser={openLink}
      />,
    )

    act(() => {
      chunkEmitterRef.current['session-6']?.([{ data: 'Dev UI on preview-host.local:5173\n' } as never])
    })

    fireEvent.click(screen.getByTitle('terminal.openLatestLink'))
    expect(openLink).toHaveBeenCalledWith('http://preview-host.local:5173')
  })
  it('shows an open-link action when a terminal url is detected', () => {
    const openLink = vi.fn()
    const chunkEmitterRef = { current: {} as Record<string, (chunks: Array<{ data: string }>) => void> }

    render(
      <SessionTerminalView
        sessionId="session-2"
        session={{
          sessionId: 'session-2',
          status: 'running',
          username: 'root',
        } as never}
        hostName="OpenClaw-KK"
        hostAddress="164.68.124.173"
        chunkEmitterRef={chunkEmitterRef}
        onSendRaw={() => {}}
        onOpenLinkInBrowser={openLink}
      />,
    )

    act(() => {
      chunkEmitterRef.current['session-2']?.([{ data: 'Visit https://example.com/docs for help\n' } as never])
    })

    fireEvent.click(screen.getByTitle('terminal.openLatestLink'))
    expect(openLink).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('shows the terminal style tip once and opens the appearance tab from it', () => {
    localStorage.removeItem('shellbeam.terminalStyleTipSeen')
    const requested: string[] = []
    const listener = (event: Event) => requested.push((event as CustomEvent<{ tab: string }>).detail.tab)
    window.addEventListener('shellbeam:terminal-sidebar-tab', listener)
    const props = {
      sessionId: 'session-tip', session: { sessionId: 'session-tip', status: 'running', username: 'root' } as never,
      hostName: 'web', hostAddress: '10.0.0.5', chunkEmitterRef: { current: {} }, onSendRaw: () => {},
    }
    const view = render(<SessionTerminalView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'terminal.styleTip.action' }))
    expect(requested).toEqual(['appearance'])
    expect(screen.queryByTestId('terminal-style-tip')).not.toBeInTheDocument()
    view.unmount()
    render(<SessionTerminalView {...props} />)
    expect(screen.queryByTestId('terminal-style-tip')).not.toBeInTheDocument()
    window.removeEventListener('shellbeam:terminal-sidebar-tab', listener)
  })
})

