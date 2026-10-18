import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { SessionsProvider, useSessions } from './sessions-context'
import type { InteractiveSessionInfo, InteractiveStatusEventPayload } from '@/lib/interactive-session'

const listenToInteractiveOutputEventsMock = vi.hoisted(() => vi.fn(async (handler: unknown) => { void handler; return () => {} }))
const listenToInteractiveProgressEventsMock = vi.hoisted(() => vi.fn(async (handler: unknown) => { void handler; return () => {} }))
const interactiveStatusHandlers = vi.hoisted(() => [] as Array<(payload: InteractiveStatusEventPayload) => void>)
const listenToInteractiveStatusEventsMock = vi.hoisted(() => vi.fn(async (handler: (payload: InteractiveStatusEventPayload) => void) => {
  interactiveStatusHandlers.push(handler)
  return () => {
    const index = interactiveStatusHandlers.indexOf(handler)
    if (index >= 0) interactiveStatusHandlers.splice(index, 1)
  }
}))
const listInteractiveSessionsMock = vi.hoisted(() => vi.fn(async () => [] as InteractiveSessionInfo[]))
const createInteractiveSessionMock = vi.hoisted(() => vi.fn())
const createLocalTerminalMock = vi.hoisted(() => vi.fn())
const closeInteractiveSessionMock = vi.hoisted(() => vi.fn(async () => {}))
const sendInteractiveInputMock = vi.hoisted(() => vi.fn(async () => {}))

const prepareBrowserPortForwardMock = vi.hoisted(() => vi.fn(async ({ targetUrl }: { browserId: string; targetUrl: string }) => {
  const port = targetUrl.includes(':4000') ? 49124 : 49123
  return { localPort: port, resolvedUrl: `http://127.0.0.1:${port}` }
}))
const startBrowserHttpProxyMock = vi.hoisted(() => vi.fn(async () => 9011))
const startBrowserSocksProxyMock = vi.hoisted(() => vi.fn(async () => 9022))
const stopBrowserPortForwardMock = vi.hoisted(() => vi.fn(async () => {}))
const stopBrowserHttpProxyMock = vi.hoisted(() => vi.fn(async () => {}))
const stopBrowserSocksProxyMock = vi.hoisted(() => vi.fn(async () => {}))
const browserStateHandlers = vi.hoisted(() => [] as Array<(payload: { browserId: string; sessionId: string; url?: string | null; isLoading?: boolean; title?: string | null; error?: string | null; canGoBack?: boolean; canGoForward?: boolean }) => void>)
const listenToAllBrowserStateEventsMock = vi.hoisted(() => vi.fn(async (handler: (payload: { browserId: string; sessionId: string; url?: string | null; isLoading?: boolean; title?: string | null; error?: string | null; canGoBack?: boolean; canGoForward?: boolean }) => void) => {
  browserStateHandlers.push(handler)
  return () => {
    const index = browserStateHandlers.indexOf(handler)
    if (index >= 0) browserStateHandlers.splice(index, 1)
  }
}))
const browserWindowClosedHandlers = vi.hoisted(() => [] as Array<(payload: { browserId: string; sessionId: string }) => void>)
const listenToBrowserWindowClosedEventsMock = vi.hoisted(() => vi.fn(async (handler: (payload: { browserId: string; sessionId: string }) => void) => {
  browserWindowClosedHandlers.push(handler)
  return () => {
    const index = browserWindowClosedHandlers.indexOf(handler)
    if (index >= 0) browserWindowClosedHandlers.splice(index, 1)
  }
}))
const openBrowserWindowMock = vi.hoisted(() => vi.fn(async () => {}))
const loadBrowserSourceMock = vi.hoisted(() => vi.fn(async () => {}))
const closeBrowserWindowMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/components/host-key-confirm-dialog', () => ({
  parseHostKeyError: () => null,
}))

vi.mock('@/lib/activity-log', () => ({
  appendActivity: vi.fn(async () => {}),
}))

vi.mock('@/lib/i18n', () => ({
  t: (key: string, params?: Record<string, string>) => params?.host ? `${key}:${params.host}` : key,
}))

vi.mock('@/lib/interactive-session', () => ({
  createInteractiveSession: createInteractiveSessionMock,
  createLocalTerminal: createLocalTerminalMock,
  listInteractiveSessions: listInteractiveSessionsMock,
  closeInteractiveSession: closeInteractiveSessionMock,
  sendInteractiveInput: sendInteractiveInputMock,
  listenToInteractiveOutputEvents: listenToInteractiveOutputEventsMock,
  listenToInteractiveProgressEvents: listenToInteractiveProgressEventsMock,
  listenToInteractiveStatusEvents: listenToInteractiveStatusEventsMock,
}))

vi.mock('@/lib/browser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/browser')>('@/lib/browser')
  return {
    ...actual,
    prepareBrowserPortForward: prepareBrowserPortForwardMock,
    startBrowserHttpProxy: startBrowserHttpProxyMock,
    startBrowserSocksProxy: startBrowserSocksProxyMock,
    stopBrowserPortForward: stopBrowserPortForwardMock,
    stopBrowserHttpProxy: stopBrowserHttpProxyMock,
    stopBrowserSocksProxy: stopBrowserSocksProxyMock,
    listenToAllBrowserStateEvents: listenToAllBrowserStateEventsMock,
    listenToBrowserWindowClosedEvents: listenToBrowserWindowClosedEventsMock,
    openBrowserWindow: openBrowserWindowMock,
    loadBrowserSource: loadBrowserSourceMock,
    closeBrowserWindow: closeBrowserWindowMock,
  }
})

const useHostsMock = vi.fn()
const useVaultMock = vi.fn()

vi.mock('./hosts-context', () => ({
  useHosts: () => useHostsMock(),
}))

vi.mock('./vault-context', () => ({
  useVault: () => useVaultMock(),
}))

let sessionsApi: ReturnType<typeof useSessions> | null = null

function SessionsProbe() {
  const value = useSessions()
  useEffect(() => { sessionsApi = value }, [value])
  return null
}

function renderSessionsProvider() {
  sessionsApi = null
  render(
    <SessionsProvider setOutput={() => {}}>
      <SessionsProbe />
    </SessionsProvider>,
  )
}

describe('sessions context integration', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsApi = null
    interactiveStatusHandlers.length = 0
    browserStateHandlers.length = 0
    browserWindowClosedHandlers.length = 0
    listenToInteractiveOutputEventsMock.mockClear()
    listenToInteractiveProgressEventsMock.mockClear()
    listenToInteractiveStatusEventsMock.mockClear()
    listInteractiveSessionsMock.mockReset().mockResolvedValue([])
    createInteractiveSessionMock.mockReset()
    prepareBrowserPortForwardMock.mockClear()
    startBrowserHttpProxyMock.mockClear()
    startBrowserSocksProxyMock.mockClear()
    stopBrowserPortForwardMock.mockClear()
    stopBrowserHttpProxyMock.mockClear()
    stopBrowserSocksProxyMock.mockClear()
    listenToAllBrowserStateEventsMock.mockClear()
    listenToBrowserWindowClosedEventsMock.mockClear()
    openBrowserWindowMock.mockClear()
    loadBrowserSourceMock.mockClear()
    closeBrowserWindowMock.mockClear()

    useVaultMock.mockReturnValue({
      resolveAuthSecret: vi.fn(async () => 'secret'),
    })
    useHostsMock.mockReturnValue({
      hosts: [{
        id: 'host-1',
        name: 'Prod',
        address: '10.0.0.8',
        port: 22,
        username: 'root',
        authType: 'privateKey',
      }],
      defaultUsername: 'root',
      keepAliveIntervalSecs: 30,
      setSelectedHostId: vi.fn(),
    })
  })

  it('opens a host operation in its existing same-Vault session and promotes the right pane without duplicating it', async () => {
    useVaultMock.mockReturnValue({ activeVaultId: 'vault-a', resolveAuthSecret: vi.fn() })
    renderSessionsProvider()
    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    await act(async () => {
      sessionsApi!.setInteractiveSessions([{ sessionId: 'existing', hostId: 'host-1', vaultId: 'vault-a', host: '10.0.0.8', username: 'root', createdAt: 1, lastActiveAt: 1, status: 'running' }])
      sessionsApi!.setRightPaneSessionId('existing')
    })
    await act(async () => { await sessionsApi!.openHostWorkspace('host-1', 'logs') })
    expect(sessionsApi!.workspaceBySession.existing).toEqual({ mode: 'workspace', activeApp: 'logs' })
    expect(sessionsApi!.leftPaneSessionId).toBe('existing')
    expect(sessionsApi!.rightPaneSessionId).toBeNull()
    expect(sessionsApi!.pcActiveSessionId).toBe('existing')
    expect(sessionsApi!.pcSessionTabs).toEqual([expect.objectContaining({ sessionId: 'existing', hostId: 'host-1', mode: 'workspace', workspaceApp: 'logs', status: 'connected' })])
    await act(async () => { await sessionsApi!.openHostWorkspace('host-1', 'fileSystem') })
    expect(sessionsApi!.pcSessionTabs).toHaveLength(1)
    expect(sessionsApi!.pcSessionTabs[0].workspaceApp).toBe('fileSystem')
    expect(createInteractiveSessionMock).not.toHaveBeenCalled()
  })

  it('creates a saved host session for an operation instead of reusing a foreign-Vault session with the same host ID', async () => {
    const resolveAuthSecret = vi.fn()
    useVaultMock.mockReturnValue({ activeVaultId: 'vault-b', resolveAuthSecret })
    renderSessionsProvider()
    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const created: InteractiveSessionInfo = { sessionId: 'new-session', hostId: 'host-1', vaultId: 'vault-b', host: '10.0.0.8', username: 'root', createdAt: 2, lastActiveAt: 2, status: 'running' }
    createInteractiveSessionMock.mockResolvedValueOnce(created)
    listInteractiveSessionsMock.mockResolvedValue([created])
    await act(async () => {
      sessionsApi!.setInteractiveSessions([{ ...created, sessionId: 'foreign-session', vaultId: 'vault-a' }])
    })
    await act(async () => { await sessionsApi!.openHostWorkspace('host-1', 'services') })
    expect(createInteractiveSessionMock).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault-b', hostId: 'host-1', password: undefined, privateKey: undefined }))
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(sessionsApi!.workspaceBySession['new-session']).toEqual({ mode: 'workspace', activeApp: 'services' })
    expect(sessionsApi!.pcSessionTabs.find((tab) => tab.sessionId === 'new-session')).toMatchObject({ mode: 'workspace', workspaceApp: 'services', status: 'connected' })
    expect(sessionsApi!.leftPaneSessionId).toBe('new-session')
  })

  it('blocks a foreign Vault session from routing through an identically named current host', async () => {
    useVaultMock.mockReturnValue({ activeVaultId: 'vault-b', resolveAuthSecret: vi.fn() })
    renderSessionsProvider()
    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>
    await act(async () => {
      api.initializeInteractiveSessionState('vault-a-session', { hostId: 'host-1', connectionKind: 'host' })
      api.setInteractiveSessions([{ sessionId: 'vault-a-session', vaultId: 'vault-a', hostId: 'host-1', host: 'old-host', username: 'ops', createdAt: 0, lastActiveAt: 0, status: 'running' }])
    })
    await act(async () => { api.openSessionBrowserUrl('vault-a-session', 'https://example.com', 'embedded') })
    await waitFor(() => expect(sessionsApi?.browserBySession['vault-a-session']?.error).toContain('Vault'))
    expect(startBrowserHttpProxyMock).not.toHaveBeenCalled()
    expect(startBrowserSocksProxyMock).not.toHaveBeenCalled()
    expect(prepareBrowserPortForwardMock).not.toHaveBeenCalled()
  })

  it('bounds automatic browser recovery when proxy setup repeatedly fails', async () => {
    startBrowserHttpProxyMock.mockRejectedValueOnce(new Error('proxy failed')).mockRejectedValueOnce(new Error('proxy still failed'))
    renderSessionsProvider()
    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>
    await act(async () => {
      api.initializeInteractiveSessionState('failing-session', { hostId: 'host-1', connectionKind: 'host' })
      api.setInteractiveSessions([{ sessionId: 'failing-session', hostId: 'host-1', host: '10.0.0.8', username: 'ops', createdAt: 0, lastActiveAt: 0, status: 'running' }])
    })
    await act(async () => { api.openSessionBrowserUrl('failing-session', 'https://example.com', 'embedded') })
    await waitFor(() => expect(sessionsApi?.browserBySession['failing-session']?.transportStatus).toBe('failed'))
    expect(startBrowserHttpProxyMock).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect an old Vault session using current Vault host credentials', async () => {
    createInteractiveSessionMock.mockClear()
    useVaultMock.mockReturnValue({ activeVaultId: 'vault-b', resolveAuthSecret: vi.fn() })
    renderSessionsProvider()
    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>
    await act(async () => {
      api.initializeInteractiveSessionState('vault-a-session', { hostId: 'host-1', connectionKind: 'host' })
      api.setInteractiveSessions([{ sessionId: 'vault-a-session', vaultId: 'vault-a', hostId: 'host-1', host: 'old-host', username: 'ops', createdAt: 0, lastActiveAt: 0, status: 'closed' }])
      api.setLeftPaneSessionId('vault-a-session')
      api.setReconnectSettings({ enabled: false, maxRetries: 1, intervalMs: 1 })
    })
    await act(async () => { sessionsApi?.manualReconnect('vault-a-session') })
    await waitFor(() => expect(sessionsApi?.reconnectingSessionIds.has('vault-a-session')).toBe(false))
    expect(createInteractiveSessionMock).not.toHaveBeenCalled()
  })

  it('allocates remote loopback transports per browser tab id', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        hostId: 'host-1',
        connectionKind: 'host',
      })
      api.setInteractiveSessions([{
        sessionId: 'session-1',
        hostId: 'host-1',
        host: '10.0.0.8',
        username: 'root',
        createdAt: 0,
        lastActiveAt: 0,
        status: 'running',
      }])
    })

    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'http://localhost:3000', 'embedded')
    })

    await waitFor(() => expect(prepareBrowserPortForwardMock).toHaveBeenCalledTimes(1))
    const firstBrowserId = prepareBrowserPortForwardMock.mock.calls[0]![0].browserId as string

    await act(async () => {
      api.createSessionBrowserTab('session-1')
    })
    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'http://localhost:4000', 'embedded')
    })

    await waitFor(() => expect(prepareBrowserPortForwardMock).toHaveBeenCalledTimes(2))
    const secondBrowserId = prepareBrowserPortForwardMock.mock.calls[1]![0].browserId as string

    expect(firstBrowserId).toMatch(/^session-1::/)
    expect(secondBrowserId).toMatch(/^session-1::/)
    expect(secondBrowserId).not.toBe(firstBrowserId)
  })

  it('rebuilds the active remote browser route after interactive status recovers from closed', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        hostId: 'host-1',
        connectionKind: 'host',
      })
      api.setInteractiveSessions([{
        sessionId: 'session-1',
        hostId: 'host-1',
        host: '10.0.0.8',
        username: 'root',
        createdAt: 0,
        lastActiveAt: 0,
        status: 'running',
      }])
    })

    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'https://example.com', 'embedded')
    })

    await waitFor(() => expect(startBrowserHttpProxyMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      interactiveStatusHandlers.forEach((handler) => handler({ sessionId: 'session-1', status: 'closed' }))
    })
    await act(async () => {
      interactiveStatusHandlers.forEach((handler) => handler({ sessionId: 'session-1', status: 'running' }))
    })

    await waitFor(() => expect(startBrowserHttpProxyMock).toHaveBeenCalledTimes(2))
    expect(stopBrowserHttpProxyMock).toHaveBeenCalled()
  })

  it('ignores duplicate started events after the same url has already settled', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToAllBrowserStateEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        connectionKind: 'local',
      })
    })

    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'https://www.baidu.com', 'embedded')
    })

    const emitBrowserState = (payload: { browserId: string; sessionId: string; url?: string | null; isLoading?: boolean; title?: string | null; error?: string | null; canGoBack?: boolean; canGoForward?: boolean }) => {
      for (const handler of browserStateHandlers) handler(payload)
    }

    await act(async () => {
      emitBrowserState({
        browserId: '',
        sessionId: 'session-1',
        url: 'https://www.baidu.com/',
        isLoading: false,
      })
    })

    expect(sessionsApi?.browserBySession['session-1']?.isLoading).toBe(false)

    await act(async () => {
      emitBrowserState({
        browserId: '',
        sessionId: 'session-1',
        url: 'https://www.baidu.com/',
        isLoading: true,
      })
    })

    expect(sessionsApi?.browserBySession['session-1']?.isLoading).toBe(false)
  })

  it('restores an inactive embedded remote browser after reconnect while another session is active', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        hostId: 'host-1',
        connectionKind: 'host',
      })
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-2', {
        hostId: 'host-1',
        connectionKind: 'host',
      })
      api.setInteractiveSessions([
        {
          sessionId: 'session-1',
          hostId: 'host-1',
          host: '10.0.0.8',
          username: 'root',
          createdAt: 0,
          lastActiveAt: 0,
          status: 'running',
        },
        {
          sessionId: 'session-2',
          hostId: 'host-1',
          host: '10.0.0.9',
          username: 'root',
          createdAt: 1,
          lastActiveAt: 1,
          status: 'running',
        },
      ])
      api.setPcActiveSessionId('session-1')
    })

    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'https://example.com/docs', 'embedded')
    })

    await waitFor(() => expect(startBrowserHttpProxyMock).toHaveBeenCalledTimes(1))

    const beforeReconnect = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']
    expect(beforeReconnect?.presentation).toBe('embedded')
    expect(beforeReconnect?.source).toEqual({ kind: 'url', url: 'https://example.com/docs' })
    expect(beforeReconnect?.transportStatus).toBe('idle')
    expect(beforeReconnect?.proxyUrl).toBe('http://127.0.0.1:9011')
    const previousRevision = beforeReconnect?.sourceRevision ?? 0

    await act(async () => {
      api.setPcActiveSessionId('session-2')
    })

    await act(async () => {
      interactiveStatusHandlers.forEach((handler) => handler({ sessionId: 'session-1', status: 'closed' }))
    })
    await act(async () => {
      interactiveStatusHandlers.forEach((handler) => handler({ sessionId: 'session-1', status: 'running' }))
    })

    await waitFor(() => expect(startBrowserHttpProxyMock).toHaveBeenCalledTimes(2))

    await waitFor(() => {
      const latestApi = sessionsApi as ReturnType<typeof useSessions>
      const restored = latestApi.browserBySession['session-1']
      expect(latestApi.pcActiveSessionId).toBe('session-2')
      expect(restored?.presentation).toBe('embedded')
      expect(restored?.source).toEqual({ kind: 'url', url: 'https://example.com/docs' })
      expect(restored?.transportStatus).toBe('idle')
      expect(restored?.error).toBeNull()
      expect(restored?.proxyUrl).toBe('http://127.0.0.1:9011')
      expect(restored?.sourceRevision).toBeGreaterThan(previousRevision)
      expect(latestApi.browserBySession['session-2']?.presentation).toBe('closed')
    })

    await act(async () => {
      api.setPcActiveSessionId('session-1')
    })

    expect((sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.source).toEqual({
      kind: 'url',
      url: 'https://example.com/docs',
    })
  })

  it('promotes the split-pane partner and clears the right pane when closing the active session', async () => {
    const session1: InteractiveSessionInfo = {
      sessionId: 'session-1',
      hostId: 'host-1',
      host: '10.0.0.8',
      username: 'root',
      createdAt: 1,
      lastActiveAt: 1,
      status: 'running',
    }
    const session2: InteractiveSessionInfo = {
      sessionId: 'session-2',
      hostId: 'host-1',
      host: '10.0.0.8',
      username: 'root',
      createdAt: 2,
      lastActiveAt: 2,
      status: 'running',
    }

    createInteractiveSessionMock
      .mockResolvedValueOnce(session1)
      .mockResolvedValueOnce(session2)
    listInteractiveSessionsMock
      .mockResolvedValueOnce([session1])
      .mockResolvedValueOnce([session1, session2])
      .mockResolvedValueOnce([session1])

    renderSessionsProvider()

    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      await api.handleConnectHost('host-1')
      await api.handleConnectHost('host-1')
    })

    await waitFor(() => expect((sessionsApi as ReturnType<typeof useSessions>).pcSessionTabs).toHaveLength(2))

    await act(async () => {
      const latestApi = sessionsApi as ReturnType<typeof useSessions>
      latestApi.setPcActiveSessionId('session-2')
      latestApi.setRightPaneSessionId('session-1')
    })

    await act(async () => {
      ;(sessionsApi as ReturnType<typeof useSessions>).handleCloseSessionTab('session-2')
    })

    await waitFor(() => {
      const latestApi = sessionsApi as ReturnType<typeof useSessions>
      expect(latestApi.pcActiveSessionId).toBe('session-1')
      expect(latestApi.rightPaneSessionId).toBeNull()
      expect(latestApi.pcSessionTabs.map((tab) => tab.sessionId)).toEqual(['session-1'])
    })
  })

  it('reopens standalone browser windows per active tab and closes stale windows on tab switch', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToInteractiveStatusEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        connectionKind: 'local',
      })
      api.setInteractiveSessions([{
        sessionId: 'session-1',
        host: 'local',
        username: 'local',
        createdAt: 0,
        lastActiveAt: 0,
        status: 'running',
      }])
    })

    await act(async () => {
      api.openSessionBrowserUrl('session-1', 'https://example.com/one', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(1))
    const firstTabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.activeTabId
    const openWindowCalls = openBrowserWindowMock.mock.calls as unknown[][]
    const loadSourceCalls = loadBrowserSourceMock.mock.calls as unknown[][]
    const firstOpenWindowCall = openWindowCalls[0]?.[0] as { browserId: string; sessionId: string } | undefined
    const firstLoadSourceCall = loadSourceCalls[0]?.[0] as { browserId: string; sessionId: string; source: { kind: string; url?: string } } | undefined
    expect(firstTabId).toBeTruthy()
    expect(firstOpenWindowCall).toMatchObject({
      browserId: `session-1::${firstTabId}`,
      sessionId: 'session-1',
    })
    expect(firstLoadSourceCall).toMatchObject({
      browserId: `session-1::${firstTabId}`,
      sessionId: 'session-1',
      source: { kind: 'url', url: 'https://example.com/one' },
    })

    await act(async () => {
      api.createSessionBrowserTab('session-1')
      api.openSessionBrowserUrl('session-1', 'https://example.com/two', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(2))
    const secondTabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.activeTabId
    const secondOpenWindowCall = openWindowCalls[1]?.[0] as { browserId: string; sessionId: string } | undefined
    const secondLoadSourceCall = loadSourceCalls.at(-1)?.[0] as { browserId: string; sessionId: string; source: { kind: string; url?: string } } | undefined
    expect(secondTabId).toBeTruthy()
    expect(secondTabId).not.toBe(firstTabId)
    expect(secondOpenWindowCall).toMatchObject({
      browserId: `session-1::${secondTabId}`,
      sessionId: 'session-1',
    })
    expect(closeBrowserWindowMock).toHaveBeenCalledWith(`session-1::${firstTabId}`, 'session-1')
    expect(secondLoadSourceCall).toMatchObject({
      browserId: `session-1::${secondTabId}`,
      sessionId: 'session-1',
      source: { kind: 'url', url: 'https://example.com/two' },
    })

    await act(async () => {
      api.activateSessionBrowserTab('session-1', firstTabId!)
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(3))
    const thirdOpenWindowCall = openWindowCalls[2]?.[0] as { browserId: string; sessionId: string } | undefined
    const thirdLoadSourceCall = loadSourceCalls.at(-1)?.[0] as { browserId: string; sessionId: string; source: { kind: string; url?: string } } | undefined
    expect(thirdOpenWindowCall).toMatchObject({
      browserId: `session-1::${firstTabId}`,
      sessionId: 'session-1',
    })
    expect(closeBrowserWindowMock).toHaveBeenCalledWith(`session-1::${secondTabId}`, 'session-1')
    expect(thirdLoadSourceCall).toMatchObject({
      browserId: `session-1::${firstTabId}`,
      sessionId: 'session-1',
      source: { kind: 'url', url: 'https://example.com/one' },
    })
  })

  it('ignores stale standalone window close events after switching tabs', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToBrowserWindowClosedEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        connectionKind: 'local',
      })
      api.setInteractiveSessions([{
        sessionId: 'session-1',
        host: 'local',
        username: 'local',
        createdAt: 0,
        lastActiveAt: 0,
        status: 'running',
      }])
      api.openSessionBrowserUrl('session-1', 'https://example.com/one', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(1))
    const firstTabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.activeTabId

    await act(async () => {
      api.createSessionBrowserTab('session-1')
      api.openSessionBrowserUrl('session-1', 'https://example.com/two', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(2))
    const latestState = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']
    const secondTabId = latestState?.activeTabId
    expect(firstTabId).toBeTruthy()
    expect(secondTabId).toBeTruthy()
    expect(secondTabId).not.toBe(firstTabId)

    await act(async () => {
      browserWindowClosedHandlers.forEach((handler) => handler({
        browserId: `session-1::${firstTabId}`,
        sessionId: 'session-1',
      }))
    })

    await waitFor(() => {
      const current = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']
      expect(current?.presentation).toBe('window')
      expect(current?.activeTabId).toBe(secondTabId)
      expect(current?.source).toEqual({ kind: 'url', url: 'https://example.com/two' })
    })

    await act(async () => {
      browserWindowClosedHandlers.forEach((handler) => handler({
        browserId: `session-1::${secondTabId}`,
        sessionId: 'session-1',
      }))
    })

    await waitFor(() => {
      const current = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']
      expect(current?.presentation).toBe('closed')
    })
  })

  it('keeps standalone browser windows isolated across multiple sessions', async () => {
    renderSessionsProvider()

    await waitFor(() => expect(listenToBrowserWindowClosedEventsMock).toHaveBeenCalled())
    const api = sessionsApi as ReturnType<typeof useSessions>

    await act(async () => {
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-1', {
        connectionKind: 'local',
      })
      ;(api.initializeInteractiveSessionState as unknown as (sessionId: string, options?: unknown) => void)('session-2', {
        connectionKind: 'local',
      })
      api.setInteractiveSessions([
        {
          sessionId: 'session-1',
          host: 'local',
          username: 'local',
          createdAt: 0,
          lastActiveAt: 0,
          status: 'running',
        },
        {
          sessionId: 'session-2',
          host: 'local',
          username: 'local',
          createdAt: 1,
          lastActiveAt: 1,
          status: 'running',
        },
      ])
      api.openSessionBrowserUrl('session-1', 'https://example.com/a', 'window')
      api.openSessionBrowserUrl('session-2', 'https://example.com/b', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(2))
    const session1FirstTabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.activeTabId
    const session2TabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-2']?.activeTabId
    expect(session1FirstTabId).toBeTruthy()
    expect(session2TabId).toBeTruthy()

    await act(async () => {
      api.createSessionBrowserTab('session-1')
      api.openSessionBrowserUrl('session-1', 'https://example.com/a-2', 'window')
    })

    await waitFor(() => expect(openBrowserWindowMock).toHaveBeenCalledTimes(3))
    const session1SecondTabId = (sessionsApi as ReturnType<typeof useSessions>).browserBySession['session-1']?.activeTabId
    expect(session1SecondTabId).toBeTruthy()
    expect(session1SecondTabId).not.toBe(session1FirstTabId)

    expect(closeBrowserWindowMock).toHaveBeenCalledWith(`session-1::${session1FirstTabId}`, 'session-1')
    expect(closeBrowserWindowMock).not.toHaveBeenCalledWith(`session-2::${session2TabId}`, 'session-2')

    const latestApi = sessionsApi as ReturnType<typeof useSessions>
    expect(latestApi.browserBySession['session-1']?.presentation).toBe('window')
    expect(latestApi.browserBySession['session-2']?.presentation).toBe('window')
    expect(latestApi.browserBySession['session-2']?.activeTabId).toBe(session2TabId)
    expect(latestApi.browserBySession['session-2']?.source).toEqual({ kind: 'url', url: 'https://example.com/b' })
  })
})
