import { describe, expect, it } from 'vitest'
import type { SessionTab } from '@/lib/types'
import { getInitialWorkspaceSessionState } from '@/lib/workspace'
import {
  activateSessionBrowserTabState,
  closeSessionBrowserState,
  closeSessionBrowserTabState,
  closeOtherSessionBrowserTabsState,
  closeSessionBrowserTabsToRightState,
  createSessionBrowserTabState,
  duplicateSessionBrowserTabState,
  getActiveSessionBrowserTab,
  getInitialSessionBrowserState,
  openSessionBrowserSourceState,
  reloadSessionBrowserState,
  removeSessionBrowserState,
  setSessionBrowserAddressInputState,
  setSessionBrowserErrorState,
  setSessionBrowserLoadingState,
  setSessionBrowserPresentationState,
  setSessionBrowserRouteModeState,
  setSessionBrowserTransportStatusState,
  setSessionBrowserTransportState,
  submitSessionBrowserAddressState,
  syncSessionBrowserUrlState,
  reorderSessionBrowserTabState,
  restoreLastClosedSessionBrowserTabState,
  toggleSessionBrowserTabPinnedState,
} from './session-browser-state'
import {
  removeSessionWorkspaceState,
  setSessionWorkspaceAppState,
  setSessionWorkspaceModeState,
  syncSessionTabWorkspace,
} from './session-workspace-state'

describe('sessions workspace helpers', () => {
  const baseTab: SessionTab = {
    sessionId: 'session-1',
    hostName: 'Prod',
    hostAddress: '10.0.0.8',
    status: 'connected',
  }

  it('initializes a new session in terminal mode with overview selected', () => {
    expect(getInitialWorkspaceSessionState()).toEqual({
      mode: 'terminal',
      activeApp: 'overview',
    })
  })

  it('switches a session between terminal and workspace without affecting other sessions', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
      'session-2': getInitialWorkspaceSessionState(),
    }

    expect(setSessionWorkspaceModeState(state, 'session-1', 'workspace')).toEqual({
      'session-1': { mode: 'workspace', activeApp: 'overview' },
      'session-2': { mode: 'terminal', activeApp: 'overview' },
    })
  })

  it('remembers the active workspace app per session', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
    }

    expect(setSessionWorkspaceAppState(state, 'session-1', 'logs')).toEqual({
      'session-1': { mode: 'terminal', activeApp: 'logs' },
    })
  })

  it('removes workspace state when a session is closed', () => {
    const state = {
      'session-1': getInitialWorkspaceSessionState(),
      'session-2': getInitialWorkspaceSessionState(),
    }

    expect(removeSessionWorkspaceState(state, 'session-1')).toEqual({
      'session-2': { mode: 'terminal', activeApp: 'overview' },
    })
  })

  it('mirrors workspace state into session tabs', () => {
    const state = {
      'session-1': { mode: 'workspace' as const, activeApp: 'logs' as const },
    }

    expect(syncSessionTabWorkspace([baseTab], state)).toEqual([
      { ...baseTab, mode: 'workspace', workspaceApp: 'logs' },
    ])
  })

  it('normalizes legacy files workspace app ids when syncing tabs', () => {
    const state = {
      'session-1': { mode: 'workspace' as const, activeApp: 'files' as never },
    }

    expect(syncSessionTabWorkspace([baseTab], state)).toEqual([
      { ...baseTab, mode: 'workspace', workspaceApp: 'fileTransfer' },
    ])
  })
})

describe('session browser helpers', () => {
  it('initializes closed browser state', () => {
    expect(getInitialSessionBrowserState()).toMatchObject({
      presentation: 'closed',
      routeMode: 'auto',
      closedTabs: [],
      source: null,
      addressInput: '',
      currentUrl: null,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      title: '',
      error: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      history: [],
      historyIndex: -1,
      sourceRevision: 0,
    })
    expect(getInitialSessionBrowserState().tabs).toHaveLength(1)
  })

  it('opens a url browser source into history', () => {
    const next = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    expect(next['session-1']).toMatchObject({
      presentation: 'embedded',
      addressInput: 'https://example.com',
      currentUrl: 'https://example.com',
      isLoading: true,
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
    })
    expect(next['session-1'].history).toEqual([{ kind: 'url', url: 'https://example.com' }])
  })

  it('normalizes and submits address input', () => {
    const withInput = setSessionBrowserAddressInputState({}, 'session-1', 'localhost:3000')
    const next = submitSessionBrowserAddressState(withInput, 'session-1', 'embedded')
    expect(next['session-1']).toMatchObject({
      presentation: 'embedded',
      addressInput: 'http://localhost:3000',
      currentUrl: 'http://localhost:3000',
    })
  })

  it('moves to an existing history entry when native navigation reports a prior url', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const visited = syncSessionBrowserUrlState(opened, 'session-1', 'https://example.com/docs')
    const navigatedBack = syncSessionBrowserUrlState(visited, 'session-1', 'https://example.com')
    expect(navigatedBack['session-1'].currentUrl).toBe('https://example.com')
    expect(navigatedBack['session-1'].historyIndex).toBe(0)
    expect(navigatedBack['session-1'].canGoBack).toBe(false)
    expect(navigatedBack['session-1'].canGoForward).toBe(true)
  })

  it('keeps preview metadata when native navigation reports the initial data url for html sources', () => {
    const opened = openSessionBrowserSourceState(
      {},
      'session-1',
      { kind: 'html', html: '<h1>Hello</h1>', title: 'Hello', baseUrl: 'https://preview.example/' },
      'embedded',
    )

    const synced = syncSessionBrowserUrlState(
      opened,
      'session-1',
      'data:text/html;charset=utf-8,%3Ch1%3EHello%3C%2Fh1%3E',
    )

    expect(synced['session-1']).toMatchObject({
      addressInput: 'https://preview.example/',
      currentUrl: 'https://preview.example/',
      title: 'Hello',
      isLoading: false,
    })
  })

  it('ignores rewritten local forwarded urls when syncing native navigation', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'http://localhost:3000' }, 'window')
    const withResolved = {
      ...opened,
      'session-1': {
        ...opened['session-1'],
        resolvedUrl: 'http://127.0.0.1:49123',
        resolvedLocalPort: 49123,
      },
    }

    const synced = syncSessionBrowserUrlState(withResolved, 'session-1', 'http://127.0.0.1:49123')
    expect(synced['session-1']).toMatchObject({
      currentUrl: 'http://localhost:3000',
      addressInput: 'http://localhost:3000',
      isLoading: false,
    })
  })

  it('reloads and closes without dropping browser state', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'html', html: '<h1>Hello</h1>', title: 'Hello' }, 'window')
    const reloaded = reloadSessionBrowserState(opened, 'session-1')
    expect(reloaded['session-1'].isLoading).toBe(true)
    const closed = closeSessionBrowserState(reloaded, 'session-1')
    expect(closed['session-1']).toMatchObject({
      presentation: 'closed',
      isLoading: false,
      title: 'Hello',
    })
  })

  it('removes browser state when the session closes', () => {
    const state = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'window')
    expect(removeSessionBrowserState(state, 'session-1')).toEqual({})
  })

  it('treats urls with and without trailing slashes as matching when syncing navigation', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://www.google.com' }, 'embedded')
    const synced = syncSessionBrowserUrlState(opened, 'session-1', 'https://www.google.com/')
    expect(synced['session-1']).toMatchObject({
      currentUrl: 'https://www.google.com',
      isLoading: false,
    })
    // Should not create a duplicate history entry
    expect(synced['session-1'].history).toHaveLength(1)
  })

  it('updates browser presentation explicitly', () => {
    const state = setSessionBrowserPresentationState({}, 'session-1', 'window')
    expect(state['session-1'].presentation).toBe('window')
  })

  it('returns the same state reference when browser presentation is already closed', () => {
    const state = { 'session-1': getInitialSessionBrowserState() }
    const next = setSessionBrowserPresentationState(state, 'session-1', 'closed')
    expect(next).toBe(state)
  })

  it('switches browser route mode and reloads url sources', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const next = setSessionBrowserRouteModeState(opened, 'session-1', 'local')
    expect(next['session-1']).toMatchObject({
      routeMode: 'local',
      isLoading: true,
      resolvedUrl: null,
      proxyUrl: null,
    })
    expect(next['session-1'].sourceRevision).toBe(opened['session-1'].sourceRevision + 1)
  })

  it('clears browser transport state when null is provided explicitly', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const withTransport = setSessionBrowserTransportState(opened, 'session-1', {
      resolvedUrl: 'http://127.0.0.1:49123',
      resolvedLocalPort: 49123,
      proxyUrl: 'socks5://127.0.0.1:9001',
    })

    const cleared = setSessionBrowserTransportState(withTransport, 'session-1', {
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
    })

    expect(cleared['session-1']).toMatchObject({
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
    })
  })

  it('returns the same state reference when browser loading does not change', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const next = setSessionBrowserLoadingState(opened, 'session-1', true)
    expect(next).toBe(opened)
  })

  it('returns the same state reference when browser transport values are unchanged', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const withTransport = setSessionBrowserTransportState(opened, 'session-1', {
      resolvedUrl: 'http://127.0.0.1:49123',
      resolvedLocalPort: 49123,
      proxyUrl: 'socks5://127.0.0.1:9001',
    })

    const next = setSessionBrowserTransportState(withTransport, 'session-1', {
      resolvedUrl: 'http://127.0.0.1:49123',
      resolvedLocalPort: 49123,
      proxyUrl: 'socks5://127.0.0.1:9001',
    })

    expect(next).toBe(withTransport)
  })

  it('updates browser transport health status explicitly', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const recovering = setSessionBrowserTransportStatusState(opened, 'session-1', 'recovering')
    expect(recovering['session-1'].transportStatus).toBe('recovering')

    const failed = setSessionBrowserTransportStatusState(recovering, 'session-1', 'failed')
    expect(failed['session-1'].transportStatus).toBe('failed')
  })

  it('returns the same state reference when closing an already closed browser', () => {
    const state = { 'session-1': getInitialSessionBrowserState() }
    const next = closeSessionBrowserState(state, 'session-1')
    expect(next).toBe(state)
  })

  it('creates, activates and closes browser tabs while keeping session-local state isolated', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com' }, 'embedded')
    const withSecondTab = createSessionBrowserTabState(opened, 'session-1')
    const secondTabId = withSecondTab['session-1'].activeTabId!
    expect(withSecondTab['session-1'].tabs).toHaveLength(2)
    expect(withSecondTab['session-1'].source).toBeNull()

    const openedSecondTab = openSessionBrowserSourceState(withSecondTab, 'session-1', { kind: 'url', url: 'https://openai.com' }, 'embedded')
    const firstTabId = opened['session-1'].activeTabId!
    const reactivated = activateSessionBrowserTabState(openedSecondTab, 'session-1', firstTabId)

    expect(getActiveSessionBrowserTab(reactivated['session-1'])?.currentUrl).toBe('https://example.com')
    expect(reactivated['session-1'].tabs.find((tab) => tab.id === secondTabId)?.currentUrl).toBe('https://openai.com')

    const closedActive = closeSessionBrowserTabState(reactivated, 'session-1', firstTabId)
    expect(closedActive['session-1'].tabs).toHaveLength(1)
    expect(getActiveSessionBrowserTab(closedActive['session-1'])?.currentUrl).toBe('https://openai.com')
    expect(closedActive['session-1'].closedTabs).toHaveLength(1)
    expect(closedActive['session-1'].closedTabs[0]?.currentUrl).toBe('https://example.com')
  })

  it('closes other tabs and tabs to the right relative to a selected tab', () => {
    const first = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://one.test' }, 'embedded')
    const withSecond = openSessionBrowserSourceState(createSessionBrowserTabState(first, 'session-1'), 'session-1', { kind: 'url', url: 'https://two.test' }, 'embedded')
    const withThird = openSessionBrowserSourceState(createSessionBrowserTabState(withSecond, 'session-1'), 'session-1', { kind: 'url', url: 'https://three.test' }, 'embedded')

    const secondTabId = withThird['session-1'].tabs[1]!.id
    const trimmedRight = closeSessionBrowserTabsToRightState(withThird, 'session-1', secondTabId)
    expect(trimmedRight['session-1'].tabs.map((tab) => tab.currentUrl)).toEqual(['https://one.test', 'https://two.test'])

    const closedOthers = closeOtherSessionBrowserTabsState(withThird, 'session-1', secondTabId)
    expect(closedOthers['session-1'].tabs).toHaveLength(1)
    expect(getActiveSessionBrowserTab(closedOthers['session-1'])?.currentUrl).toBe('https://two.test')
  })

  it('pins tabs ahead of regular tabs and preserves pin state across close/open flows', () => {
    const first = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://one.test' }, 'embedded')
    const withSecond = openSessionBrowserSourceState(createSessionBrowserTabState(first, 'session-1'), 'session-1', { kind: 'url', url: 'https://two.test' }, 'embedded')
    const withThird = openSessionBrowserSourceState(createSessionBrowserTabState(withSecond, 'session-1'), 'session-1', { kind: 'url', url: 'https://three.test' }, 'embedded')

    const thirdTabId = withThird['session-1'].tabs[2]!.id
    const pinned = toggleSessionBrowserTabPinnedState(withThird, 'session-1', thirdTabId)
    expect(pinned['session-1'].tabs.map((tab) => ({ url: tab.currentUrl, pinned: tab.pinned }))).toEqual([
      { url: 'https://three.test', pinned: true },
      { url: 'https://one.test', pinned: false },
      { url: 'https://two.test', pinned: false },
    ])

    const unpinned = toggleSessionBrowserTabPinnedState(pinned, 'session-1', thirdTabId)
    expect(unpinned['session-1'].tabs.map((tab) => ({ url: tab.currentUrl, pinned: tab.pinned }))).toEqual([
      { url: 'https://three.test', pinned: false },
      { url: 'https://one.test', pinned: false },
      { url: 'https://two.test', pinned: false },
    ])
  })

  it('reorders tabs within the same pin group only', () => {
    const first = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://one.test' }, 'embedded')
    const withSecond = openSessionBrowserSourceState(createSessionBrowserTabState(first, 'session-1'), 'session-1', { kind: 'url', url: 'https://two.test' }, 'embedded')
    const withThird = openSessionBrowserSourceState(createSessionBrowserTabState(withSecond, 'session-1'), 'session-1', { kind: 'url', url: 'https://three.test' }, 'embedded')
    const secondTabId = withThird['session-1'].tabs[1]!.id
    const thirdTabId = withThird['session-1'].tabs[2]!.id

    const reordered = reorderSessionBrowserTabState(withThird, 'session-1', thirdTabId, secondTabId, 'before')
    expect(reordered['session-1'].tabs.map((tab) => tab.currentUrl)).toEqual([
      'https://one.test',
      'https://three.test',
      'https://two.test',
    ])

    const pinned = toggleSessionBrowserTabPinnedState(reordered, 'session-1', thirdTabId)
    const blocked = reorderSessionBrowserTabState(pinned, 'session-1', thirdTabId, secondTabId, 'after')
    expect(blocked).toBe(pinned)
  })

  it('duplicates the selected tab and restores the most recently closed tab', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://example.com/docs' }, 'embedded')
    const duplicated = duplicateSessionBrowserTabState(opened, 'session-1')

    expect(duplicated['session-1'].tabs).toHaveLength(2)
    expect(getActiveSessionBrowserTab(duplicated['session-1'])?.currentUrl).toBe('https://example.com/docs')

    const [originalTab, duplicateTab] = duplicated['session-1'].tabs
    expect(originalTab?.id).not.toBe(duplicateTab?.id)

    const closedDuplicate = closeSessionBrowserTabState(duplicated, 'session-1', duplicateTab!.id)
    expect(closedDuplicate['session-1'].closedTabs[0]?.currentUrl).toBe('https://example.com/docs')

    const restored = restoreLastClosedSessionBrowserTabState(closedDuplicate, 'session-1')
    expect(restored['session-1'].tabs).toHaveLength(2)
    expect(restored['session-1'].closedTabs).toHaveLength(0)
    expect(getActiveSessionBrowserTab(restored['session-1'])?.currentUrl).toBe('https://example.com/docs')
  })

  it('applies browser loading and errors to a specific background tab without mutating the active tab', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://one.example' }, 'embedded')
    const withSecondTab = createSessionBrowserTabState(opened, 'session-1')
    const secondTabId = withSecondTab['session-1'].activeTabId!
    const openedSecondTab = openSessionBrowserSourceState(withSecondTab, 'session-1', { kind: 'url', url: 'https://two.example' }, 'embedded')
    const firstTabId = opened['session-1'].activeTabId!
    const activatedFirstTab = activateSessionBrowserTabState(openedSecondTab, 'session-1', firstTabId)
    const loadedSecondTab = setSessionBrowserLoadingState(activatedFirstTab, 'session-1', true, secondTabId)
    const failedSecondTab = setSessionBrowserErrorState(loadedSecondTab, 'session-1', 'proxy failed', secondTabId)

    expect(failedSecondTab['session-1'].activeTabId).toBe(firstTabId)
    expect(failedSecondTab['session-1'].tabs.find((tab) => tab.id === secondTabId)).toMatchObject({
      isLoading: false,
      error: 'proxy failed',
    })
    expect(failedSecondTab['session-1'].tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      error: null,
    })
  })

  it('syncs browser navigation to a specific background tab by tab id', () => {
    const opened = openSessionBrowserSourceState({}, 'session-1', { kind: 'url', url: 'https://one.example' }, 'embedded')
    const withSecondTab = createSessionBrowserTabState(opened, 'session-1')
    const secondTabId = withSecondTab['session-1'].activeTabId!
    const openedSecondTab = openSessionBrowserSourceState(withSecondTab, 'session-1', { kind: 'url', url: 'https://two.example' }, 'embedded')
    const firstTabId = opened['session-1'].activeTabId!
    const activatedFirstTab = activateSessionBrowserTabState(openedSecondTab, 'session-1', firstTabId)
    const synced = syncSessionBrowserUrlState(activatedFirstTab, 'session-1', 'https://two.example/docs', secondTabId)

    expect(synced['session-1'].activeTabId).toBe(firstTabId)
    expect(synced['session-1'].tabs.find((tab) => tab.id === secondTabId)).toMatchObject({
      currentUrl: 'https://two.example/docs',
      addressInput: 'https://two.example/docs',
      isLoading: false,
    })
    expect(synced['session-1'].tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      currentUrl: 'https://one.example',
    })
  })
})
