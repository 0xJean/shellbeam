import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionTerminalView } from './session-terminal-view'

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
  t: (key: string) => key,
}))

vi.mock('@/lib/terminal-themes', () => ({
  getThemeById: () => ({
    theme: {
      background: '#000000',
      foreground: '#00ff41',
    },
  }),
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
  it('renders workspace toggle alongside ai and sidebar controls in the toolbar', () => {
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
        onToggleRightSidebar={() => {}}
        rightSidebarOpen={false}
      />,
    )

    expect(screen.getByRole('button', { name: 'workspace.mode.terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.mode.workspace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ai/i })).toBeInTheDocument()
    expect(screen.getByTitle('rightSidebar.terminal')).toBeInTheDocument()
  })
})
