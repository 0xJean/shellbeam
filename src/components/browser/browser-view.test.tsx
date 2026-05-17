import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserView } from './browser-view'
import type { BrowserTabState } from '@/contexts/session-browser-state'
import { normalizeSessionBrowserState } from '@/contexts/session-browser-state'

const useSessions = vi.fn()
const browserChromeSpy = vi.fn()
const embeddedBrowserWebviewSpy = vi.fn()
const reloadBrowserWindowSpy = vi.hoisted(() => vi.fn(async () => {}))
const goBackBrowserWindowSpy = vi.hoisted(() => vi.fn(async () => {}))
const goForwardBrowserWindowSpy = vi.hoisted(() => vi.fn(async () => {}))

function makeBrowserTab(overrides: Partial<BrowserTabState>): BrowserTabState {
  return {
    id: overrides.id ?? 'tab',
    pinned: overrides.pinned ?? false,
    source: overrides.source ?? null,
    addressInput: overrides.addressInput ?? '',
    currentUrl: overrides.currentUrl ?? null,
    resolvedUrl: overrides.resolvedUrl ?? null,
    resolvedLocalPort: overrides.resolvedLocalPort ?? null,
    proxyUrl: overrides.proxyUrl ?? null,
    transportStatus: overrides.transportStatus ?? 'idle',
    title: overrides.title ?? '',
    error: overrides.error ?? null,
    isLoading: overrides.isLoading ?? false,
    canGoBack: overrides.canGoBack ?? false,
    canGoForward: overrides.canGoForward ?? false,
    history: overrides.history ?? [],
    historyIndex: overrides.historyIndex ?? -1,
    sourceRevision: overrides.sourceRevision ?? 0,
  }
}

vi.mock('@/contexts/sessions-context', () => ({
  useSessions: () => useSessions(),
}))

vi.mock('@/lib/i18n', () => ({
  useT: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

vi.mock('./browser-chrome', () => ({
  BrowserChrome: (props: unknown) => {
    browserChromeSpy(props)
    return <div data-testid="browser-chrome" />
  },
}))

vi.mock('./embedded-browser-webview', () => ({
  EmbeddedBrowserWebview: (props: unknown) => {
    embeddedBrowserWebviewSpy(props)
    return <div data-testid="embedded-browser-webview" />
  },
}))

vi.mock('@/lib/browser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/browser')>('@/lib/browser')
  return {
    ...actual,
    reloadBrowserWindow: reloadBrowserWindowSpy,
    goBackBrowserWindow: goBackBrowserWindowSpy,
    goForwardBrowserWindow: goForwardBrowserWindowSpy,
  }
})

describe('browser view', () => {
  beforeEach(() => {
    useSessions.mockReset()
    browserChromeSpy.mockReset()
    embeddedBrowserWebviewSpy.mockReset()
    reloadBrowserWindowSpy.mockClear()
    goBackBrowserWindowSpy.mockClear()
    goForwardBrowserWindowSpy.mockClear()
  })

  it('shows a transport failure panel instead of staying on preparing state', () => {
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'remote',
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          error: 'proxy failed',
          transportStatus: 'failed',
          isLoading: false,
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    render(<BrowserView sessionId="session-1" />)

    expect(screen.getByText('browser.transport.failedTitle')).toBeInTheDocument()
    expect(screen.getByText('proxy failed')).toBeInTheDocument()
    expect(screen.queryByText('browser.transport.preparingTitle')).not.toBeInTheDocument()
  })

  it('allows rebuilding the remote transport from the failure panel', () => {
    const rebuildSessionBrowserTransport = vi.fn()
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'remote',
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          error: 'proxy failed',
          transportStatus: 'failed',
          isLoading: false,
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport,
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    render(<BrowserView sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'browser.transport.rebuild' }))

    expect(rebuildSessionBrowserTransport).toHaveBeenCalledWith('session-1')
  })

  it('shows a rebuilding state while transport recovery is in progress', () => {
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'remote',
          source: { kind: 'url', url: 'https://example.com' },
          addressInput: 'https://example.com',
          currentUrl: 'https://example.com',
          error: null,
          transportStatus: 'recovering',
          isLoading: true,
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    render(<BrowserView sessionId="session-1" />)

    expect(screen.getByText('browser.transport.recoveringTitle')).toBeInTheDocument()
    expect(screen.queryByText('browser.transport.failedTitle')).not.toBeInTheDocument()
  })

  it('mounts the embedded browser with a tab-scoped browser id', () => {
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'local',
          activeTabId: 'tab-2',
          tabs: [
            makeBrowserTab({ id: 'tab-1', source: { kind: 'url', url: 'https://one.example' }, addressInput: 'https://one.example', currentUrl: 'https://one.example', title: 'one' }),
            makeBrowserTab({ id: 'tab-2', source: { kind: 'url', url: 'https://two.example' }, addressInput: 'https://two.example', currentUrl: 'https://two.example', title: 'two' }),
          ],
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    render(<BrowserView sessionId="session-1" />)

    expect(embeddedBrowserWebviewSpy).toHaveBeenCalledWith(expect.objectContaining({
      browserId: 'session-1::tab-2',
      sessionId: 'session-1',
    }))
  })

  it('targets native browser controls at the active tab instance', () => {
    const reloadSessionBrowser = vi.fn()
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'local',
          activeTabId: 'tab-9',
          tabs: [
            makeBrowserTab({ id: 'tab-9', source: { kind: 'url', url: 'https://two.example' }, addressInput: 'https://two.example', currentUrl: 'https://two.example', title: 'two' }),
          ],
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser,
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    render(<BrowserView sessionId="session-1" />)

    const chromeProps = browserChromeSpy.mock.calls.at(-1)?.[0] as { onReload?: () => void } | undefined
    chromeProps?.onReload?.()

    expect(reloadSessionBrowser).toHaveBeenCalledWith('session-1')
    expect(reloadBrowserWindowSpy).toHaveBeenCalledWith({
      browserId: 'session-1::tab-9',
      sessionId: 'session-1',
    })
  })

  it('updates embedded transport props when switching from server mode back to local mode', () => {
    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'remote',
          activeTabId: 'tab-9',
          tabs: [
            makeBrowserTab({
              id: 'tab-9',
              source: { kind: 'url', url: 'https://www.baidu.com' },
              addressInput: 'https://www.baidu.com',
              currentUrl: 'https://www.baidu.com',
              proxyUrl: 'http://127.0.0.1:9011',
              title: 'www.baidu.com',
              sourceRevision: 1,
            }),
          ],
          source: { kind: 'url', url: 'https://www.baidu.com' },
          addressInput: 'https://www.baidu.com',
          currentUrl: 'https://www.baidu.com',
          proxyUrl: 'http://127.0.0.1:9011',
          title: 'www.baidu.com',
          sourceRevision: 1,
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    const { rerender } = render(<BrowserView sessionId="session-1" />)

    expect(embeddedBrowserWebviewSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      browserId: 'session-1::tab-9',
      proxyUrl: 'http://127.0.0.1:9011',
      source: { kind: 'url', url: 'https://www.baidu.com' },
      sourceRevision: 1,
    }))

    useSessions.mockReturnValue({
      browserBySession: {
        'session-1': normalizeSessionBrowserState({
          presentation: 'embedded',
          routeMode: 'local',
          activeTabId: 'tab-9',
          tabs: [
            makeBrowserTab({
              id: 'tab-9',
              source: { kind: 'url', url: 'https://www.baidu.com' },
              addressInput: 'https://www.baidu.com',
              currentUrl: 'https://www.baidu.com',
              proxyUrl: null,
              resolvedUrl: null,
              title: 'www.baidu.com',
              sourceRevision: 2,
            }),
          ],
          source: { kind: 'url', url: 'https://www.baidu.com' },
          addressInput: 'https://www.baidu.com',
          currentUrl: 'https://www.baidu.com',
          proxyUrl: null,
          resolvedUrl: null,
          title: 'www.baidu.com',
          sourceRevision: 2,
        }),
      },
      interactiveSessions: [{ sessionId: 'session-1', hostId: 'host-1', status: 'running' }],
      rebuildSessionBrowserTransport: vi.fn(),
      setSessionBrowserLoading: vi.fn(),
      createSessionBrowserTab: vi.fn(),
      duplicateSessionBrowserTab: vi.fn(),
      activateSessionBrowserTab: vi.fn(),
      closeSessionBrowserTab: vi.fn(),
      closeOtherSessionBrowserTabs: vi.fn(),
      closeSessionBrowserTabsToRight: vi.fn(),
      restoreLastClosedSessionBrowserTab: vi.fn(),
      toggleSessionBrowserTabPinned: vi.fn(),
      reorderSessionBrowserTab: vi.fn(),
      setSessionBrowserRouteMode: vi.fn(),
      setSessionBrowserAddressInput: vi.fn(),
      submitSessionBrowserAddress: vi.fn(),
      reloadSessionBrowser: vi.fn(),
      setSessionBrowserError: vi.fn(),
      goSessionBrowserBack: vi.fn(),
      goSessionBrowserForward: vi.fn(),
      closeSessionBrowser: vi.fn(),
      syncSessionBrowserUrl: vi.fn(),
      setSessionBrowserNavigation: vi.fn(),
    })

    rerender(<BrowserView sessionId="session-1" />)

    expect(embeddedBrowserWebviewSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      browserId: 'session-1::tab-9',
      proxyUrl: null,
      source: { kind: 'url', url: 'https://www.baidu.com' },
      sourceRevision: 2,
    }))
  })
})
