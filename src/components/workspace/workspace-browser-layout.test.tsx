import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'

const workspaceBrowserAppSpy = vi.fn()

vi.mock('./workspace-browser-app', () => ({
  WorkspaceBrowserApp: ({ sessionId, onCloseRequest }: { sessionId: string; onCloseRequest?: () => void }) => {
    workspaceBrowserAppSpy({ sessionId, onCloseRequest })
    return (
      <div data-testid="workspace-browser-app" data-session-id={sessionId}>
        browser app
      </div>
    )
  },
}))

describe('workspace browser layout', () => {
  // These cover the windowed desktop layout; the list layout is the default.
  beforeEach(() => { localStorage.setItem('shellbeam.workspace.layout', 'desktop') })
  it('returns desktop workspace browser closes back to overview', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceDesktopShell
        sessionId="session-1"
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="browser"
        onSelectApp={onSelectApp}
      />,
    )

    const props = workspaceBrowserAppSpy.mock.calls.at(-1)?.[0] as { onCloseRequest?: () => void } | undefined
    act(() => {
      props?.onCloseRequest?.()
    })

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('renders the desktop browser window inside a flush non-scrolling body', () => {
    render(
      <WorkspaceDesktopShell
        sessionId="session-1"
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="browser"
        onSelectApp={() => {}}
      />,
    )

    const body = screen.getByTestId('workspace-browser-app').parentElement

    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden', 'p-0')
    expect(body).not.toHaveClass('overflow-auto')
  })

  it('sizes desktop windows as floating frames instead of pinning them to the screen bottom', () => {
    render(
      <WorkspaceDesktopShell
        sessionId="session-1"
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="logs"
        onSelectApp={() => {}}
      />,
    )

    const windowFrame = screen.getByTestId('workspace-desktop-window-logs')

    expect(windowFrame).toHaveStyle({ width: 'min(1080px, calc(100% - 11rem))' })
    expect(windowFrame).toHaveStyle({ height: 'min(720px, calc(100% - 7rem))' })
    expect(windowFrame).not.toHaveStyle({ right: '1.5rem' })
    expect(windowFrame).not.toHaveStyle({ bottom: '1rem' })
  })

  it('returns mobile workspace browser closes back to overview', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceMobileShell
        sessionId="session-1"
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="browser"
        onSelectApp={onSelectApp}
      />,
    )

    const props = workspaceBrowserAppSpy.mock.calls.at(-1)?.[0] as { onCloseRequest?: () => void } | undefined
    act(() => {
      props?.onCloseRequest?.()
    })

    expect(onSelectApp).toHaveBeenCalledWith('overview')
  })

  it('renders the mobile browser app inside a full-height non-scrolling content container', () => {
    render(
      <WorkspaceMobileShell
        sessionId="session-1"
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="browser"
        onSelectApp={() => {}}
      />,
    )

    const content = screen.getByTestId('workspace-browser-app').parentElement

    expect(content).toHaveClass('flex-1', 'overflow-hidden')
    expect(content).not.toHaveClass('overflow-auto')
  })
})
