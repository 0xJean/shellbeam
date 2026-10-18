import { parseHostKeyError, type HostKeyInfo } from '@/components/host-key-confirm-dialog'
import { appendActivity } from '@/lib/activity-log'
import { t } from '@/lib/i18n'
import {
    closeInteractiveSession,
    createInteractiveSession,
    createLocalTerminal,
    listInteractiveSessions,
    sendInteractiveInput,
    listenToInteractiveProgressEvents,
    listenToInteractiveOutputEvents,
    listenToInteractiveStatusEvents,
    type InteractiveOutputChunk,
    type InteractiveSessionInfo,
} from '@/lib/interactive-session'
import type { PaneEvent, PaneId, ReconnectSettings, SessionTab } from '@/lib/types'
import {
  type SessionWorkspaceMode,
  type SessionWorkspaceState,
  type WorkspaceAppId,
} from '@/lib/workspace'
import type { BrowserSource, BrowserStateEventPayload } from '@/lib/browser'
import {
  closeBrowserWindow,
  isLoopbackBrowserUrl,
  listenToAllBrowserStateEvents,
  listenToBrowserWindowClosedEvents,
  loadBrowserSource,
  openBrowserWindow,
  prepareBrowserPortForward,
  restoreBrowserUrlFromLocalForward,
  startBrowserHttpProxy,
  startBrowserSocksProxy,
  stopBrowserHttpProxy,
  stopBrowserPortForward,
  stopBrowserSocksProxy,
} from '@/lib/browser'
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
  normalizeSessionBrowserState,
  goSessionBrowserBackState,
  goSessionBrowserForwardState,
  reloadSessionBrowserState,
  removeSessionBrowserState,
  setSessionBrowserAddressInputState,
  setSessionBrowserErrorState,
  setSessionBrowserLoadingState,
  setSessionBrowserNavigationState,
  setSessionBrowserPresentationState,
  setSessionBrowserRouteModeState,
  setSessionBrowserTransportStatusState,
  setSessionBrowserTransportState,
  stripSessionBrowserRuntimeState,
  syncSessionBrowserUrlState,
  type BrowserPresentation,
  type BrowserRouteMode,
  type SessionBrowserState,
  resolveBrowserRouteMode,
  openSessionBrowserSourceState,
  submitSessionBrowserAddressState,
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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useHosts } from './hosts-context'
import { useVault } from './vault-context'

const INTERACTIVE_OUTPUT_MAX_CHUNKS = 500
const INTERACTIVE_OUTPUT_MAX_CHARS = 1 << 20
const ACTIVE_INTERACTIVE_SESSION_KEY = 'shellbeam.activeInteractiveSessionId'
const LEFT_INTERACTIVE_SESSION_KEY = 'shellbeam.leftInteractiveSessionId'
const RIGHT_INTERACTIVE_SESSION_KEY = 'shellbeam.rightInteractiveSessionId'
const RECONNECT_SETTINGS_KEY = 'shellbeam.reconnectSettings'
const BROWSER_ROUTE_MODE_KEY = 'shellbeam.browserRouteModeByTarget'
const BROWSER_SESSION_STATE_KEY = 'shellbeam.browserStateByTarget'
const INPUT_BATCH_DELAY_MS = 2
const BROWSER_EVENT_DEDUPE_WINDOW_MS = 400

interface BrowserEventMarker {
  signature: string
  seenAt: number
}

function buildBrowserStateEventSignature(payload: BrowserStateEventPayload) {
  return JSON.stringify([
    payload.url ?? null,
    payload.title ?? null,
    payload.isLoading ?? null,
    payload.error ?? null,
    payload.canGoBack ?? null,
    payload.canGoForward ?? null,
  ])
}

function browserUrlsMatch(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    const urlA = new URL(a)
    const urlB = new URL(b)
    return (
      urlA.origin === urlB.origin
      && urlA.pathname.replace(/\/+$/, '') === urlB.pathname.replace(/\/+$/, '')
      && urlA.search === urlB.search
      && urlA.hash === urlB.hash
    )
  } catch {
    return false
  }
}

function shouldIgnoreSettledBrowserLoadEvent(
  state: SessionBrowserState | undefined,
  payload: BrowserStateEventPayload,
  tabId?: string,
) {
  if (payload.isLoading !== true || typeof payload.url !== 'string' || !payload.url || !state) {
    return false
  }

  const targetTab = tabId
    ? state.tabs.find((tab) => tab.id === tabId)
    : getActiveSessionBrowserTab(state)
  if (!targetTab || targetTab.isLoading || targetTab.source?.kind !== 'url') {
    return false
  }

  return (
    browserUrlsMatch(targetTab.currentUrl, payload.url)
    || browserUrlsMatch(targetTab.source.url, payload.url)
  )
}

function trimInteractiveOutputChunks(chunks: InteractiveOutputChunk[]) {
  let totalChars = 0
  const retained: InteractiveOutputChunk[] = []

  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i]
    const chunkChars = chunk.data.length
    if (retained.length >= INTERACTIVE_OUTPUT_MAX_CHUNKS) break
    if (totalChars + chunkChars > INTERACTIVE_OUTPUT_MAX_CHARS) {
      if (retained.length === 0) {
        retained.unshift({
          ...chunk,
          data: chunk.data.slice(-INTERACTIVE_OUTPUT_MAX_CHARS),
        })
      }
      break
    }
    totalChars += chunkChars
    retained.unshift(chunk)
  }

  return retained
}

function readStoredBrowserRouteModes(): Record<string, BrowserRouteMode> {
  try {
    const saved = localStorage.getItem(BROWSER_ROUTE_MODE_KEY)
    return saved ? JSON.parse(saved) as Record<string, BrowserRouteMode> : {}
  } catch {
    return {}
  }
}

function readStoredBrowserSessionStates(): Record<string, SessionBrowserState> {
  try {
    const saved = localStorage.getItem(BROWSER_SESSION_STATE_KEY)
    if (!saved) return {}
    const parsed = JSON.parse(saved) as Record<string, SessionBrowserState>
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, stripSessionBrowserRuntimeState(normalizeSessionBrowserState(value))]),
    )
  } catch {
    return {}
  }
}

interface SessionsContextValue {
  interactiveSessions: InteractiveSessionInfo[]
  interactiveChunksBySession: Record<string, InteractiveOutputChunk[]>
  pcSessionTabs: SessionTab[]
  workspaceBySession: Record<string, SessionWorkspaceState>
  browserBySession: Record<string, SessionBrowserState>
  workspaceAuthBySession: Record<string, string>
  pcActiveSessionId: string | null
  setPcActiveSessionId: (id: string | null) => void
  setSessionMode: (sessionId: string, mode: SessionWorkspaceMode) => void
  setSessionWorkspaceApp: (sessionId: string, app: WorkspaceAppId) => void
  openSessionBrowserUrl: (sessionId: string, url: string, presentation?: BrowserPresentation) => void
  openSessionBrowserHtml: (sessionId: string, html: string, options?: { baseUrl?: string; title?: string; presentation?: BrowserPresentation }) => void
  openSessionBrowserMarkdown: (sessionId: string, markdown: string, options?: { baseUrl?: string; title?: string; presentation?: BrowserPresentation }) => void
  createSessionBrowserTab: (sessionId: string) => void
  duplicateSessionBrowserTab: (sessionId: string, tabId?: string) => void
  activateSessionBrowserTab: (sessionId: string, tabId: string) => void
  closeSessionBrowserTab: (sessionId: string, tabId: string) => void
  closeOtherSessionBrowserTabs: (sessionId: string, tabId: string) => void
  closeSessionBrowserTabsToRight: (sessionId: string, tabId: string) => void
  restoreLastClosedSessionBrowserTab: (sessionId: string) => void
  toggleSessionBrowserTabPinned: (sessionId: string, tabId: string) => void
  reorderSessionBrowserTab: (sessionId: string, tabId: string, targetTabId: string, position: 'before' | 'after') => void
  setSessionBrowserPresentation: (sessionId: string, presentation: BrowserPresentation) => void
  setSessionBrowserRouteMode: (sessionId: string, routeMode: BrowserRouteMode) => void
  setSessionBrowserAddressInput: (sessionId: string, addressInput: string) => void
  submitSessionBrowserAddress: (sessionId: string, presentation?: BrowserPresentation) => void
  reloadSessionBrowser: (sessionId: string) => void
  goSessionBrowserBack: (sessionId: string) => void
  goSessionBrowserForward: (sessionId: string) => void
  syncSessionBrowserUrl: (sessionId: string, url: string, tabId?: string) => void
  setSessionBrowserLoading: (sessionId: string, isLoading: boolean, tabId?: string) => void
  setSessionBrowserError: (sessionId: string, error: string | null, tabId?: string) => void
  setSessionBrowserNavigation: (sessionId: string, values: { canGoBack?: boolean; canGoForward?: boolean; title?: string | null }, tabId?: string) => void
  closeSessionBrowser: (sessionId: string) => void
  rebuildSessionBrowserTransport: (sessionId: string) => void
  pcChunkEmitterRef: React.MutableRefObject<Record<string, (chunks: InteractiveOutputChunk[]) => void>>
  leftPaneSessionId: string | null
  setLeftPaneSessionId: (id: string | null) => void
  rightPaneSessionId: string | null
  setRightPaneSessionId: (id: string | null) => void
  handleConnectHost: (hostId: string) => Promise<void>
  openHostWorkspace: (hostId: string, app: WorkspaceAppId) => Promise<void>
  handleOpenLocalTerminal: () => Promise<void>
  handleCloseSessionTab: (sessionId: string) => void
  sendRaw: (sessionId: string, data: string) => void
  refreshInteractiveSessions: () => Promise<void>
  initializeInteractiveSessionState: (sessionId: string, options?: { hostId?: string | null; connectionKind?: 'host' | 'local' | null }) => void
  cleanupClosedSession: (sessionId: string) => Promise<void>
  interactiveInputBySession: Record<string, string>
  setInteractiveInputBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>
  interactiveHistoryBySession: Record<string, string[]>
  setInteractiveHistoryBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>
  interactiveHistoryCursorBySession: Record<string, number | null>
  setInteractiveHistoryCursorBySession: React.Dispatch<React.SetStateAction<Record<string, number | null>>>
  setInteractiveChunksBySession: React.Dispatch<React.SetStateAction<Record<string, InteractiveOutputChunk[]>>>
  setInteractiveSessions: React.Dispatch<React.SetStateAction<InteractiveSessionInfo[]>>
  interactiveSessionsRef: React.MutableRefObject<InteractiveSessionInfo[]>
  reconnectSettings: ReconnectSettings
  setReconnectSettings: React.Dispatch<React.SetStateAction<ReconnectSettings>>
  paneEvents: Record<PaneId, PaneEvent[]>
  setPaneEvents: React.Dispatch<React.SetStateAction<Record<PaneId, PaneEvent[]>>>
  appendPaneEvent: (pane: PaneId, level: PaneEvent['level'], message: string, sessionId?: string | null) => void
  leftPaneSessionIdRef: React.MutableRefObject<string | null>
  rightPaneSessionIdRef: React.MutableRefObject<string | null>
  closedSessionCleanupRef: React.MutableRefObject<Set<string>>
  pendingHostKey: HostKeyInfo | null
  acceptPendingHostKey: () => void
  rejectPendingHostKey: () => void
  reconnectingSessionIds: Set<string>
  manualReconnect: (sessionId: string) => void
  retrySessionConnection: (sessionId: string) => void
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useSessions() {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used within SessionsProvider')
  return ctx
}

export function SessionsProvider({ children, setOutput }: { children: ReactNode; setOutput: (msg: string) => void }) {
  const { activeVaultId } = useVault()
  const activeVaultIdRef = useRef(activeVaultId)
  activeVaultIdRef.current = activeVaultId
  const { hosts, defaultUsername, keepAliveIntervalSecs, setSelectedHostId } = useHosts()

  const [interactiveSessions, setInteractiveSessions] = useState<InteractiveSessionInfo[]>([])
  const [interactiveChunksBySession, setInteractiveChunksBySession] = useState<Record<string, InteractiveOutputChunk[]>>({})
  const interactiveNextSeqRef = useRef<Record<string, number>>({})
  const [interactiveInputBySession, setInteractiveInputBySession] = useState<Record<string, string>>({})
  const [interactiveHistoryBySession, setInteractiveHistoryBySession] = useState<Record<string, string[]>>({})
  const [interactiveHistoryCursorBySession, setInteractiveHistoryCursorBySession] = useState<Record<string, number | null>>({})

  const [pcSessionTabs, setPcSessionTabs] = useState<SessionTab[]>([])
  const [workspaceBySession, setWorkspaceBySession] = useState<Record<string, SessionWorkspaceState>>({})
  const [browserBySession, setBrowserBySession] = useState<Record<string, SessionBrowserState>>({})
  const [workspaceAuthBySession, setWorkspaceAuthBySession] = useState<Record<string, string>>({})
  const [pcActiveSessionId, setPcActiveSessionId] = useState<string | null>(null)
  const [leftPaneSessionId, setLeftPaneSessionId] = useState<string | null>(null)
  const [rightPaneSessionId, setRightPaneSessionId] = useState<string | null>(null)

  const [reconnectSettings, setReconnectSettings] = useState<ReconnectSettings>({ enabled: true, maxRetries: 5, intervalMs: 3000 })
  const [reconnectingSessionIds, setReconnectingSessionIds] = useState<Set<string>>(new Set())
  const [paneEvents, setPaneEvents] = useState<Record<PaneId, PaneEvent[]>>({ left: [], right: [] })
  const [pendingHostKey, setPendingHostKey] = useState<HostKeyInfo | null>(null)
  const pendingHostKeyResolveRef = useRef<((accept: boolean) => void) | null>(null)

  const interactiveSessionsRef = useRef<InteractiveSessionInfo[]>([])
  const closedSessionCleanupRef = useRef<Set<string>>(new Set())
  const sessionStatusCacheRef = useRef<Record<string, string>>({})
  const pcChunkEmitterRef = useRef<Record<string, (chunks: InteractiveOutputChunk[]) => void>>({})
  const pcSessionTabsRef = useRef<SessionTab[]>([])
  const leftPaneSessionIdRef = useRef<string | null>(null)
  const rightPaneSessionIdRef = useRef<string | null>(null)
  const reconnectingRef = useRef<Set<string>>(new Set())
  const reconnectSettingsRef = useRef(reconnectSettings)
  const sendRawBufferRef = useRef<Record<string, string>>({})
  const sendRawTimerRef = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({})
  const attemptReconnectRef = useRef<(sessionId: string, hostId: string, pane: PaneId, rs: ReconnectSettings) => Promise<void>>(async () => {})
  const managedBrowserSourceRevisionRef = useRef<Record<string, number>>({})
  const managedBrowserOpenRef = useRef<Set<string>>(new Set())
  const browserTransportRef = useRef<Record<string, { originalUrl: string; resolvedUrl: string; localPort: number }>>({})
  const browserProxyRef = useRef<Record<string, { proxyUrl: string }>>({})
  const browserTransportRecoveryAttemptsRef = useRef<Record<string, number>>({})
  const browserEventMarkersRef = useRef<Record<string, BrowserEventMarker>>({})
  const workspaceBySessionRef = useRef<Record<string, SessionWorkspaceState>>(workspaceBySession)
  const browserBySessionRef = useRef<Record<string, SessionBrowserState>>(browserBySession)
  const browserRouteModePrefsRef = useRef<Record<string, BrowserRouteMode>>(readStoredBrowserRouteModes())
  const browserSessionStatePrefsRef = useRef<Record<string, SessionBrowserState>>(readStoredBrowserSessionStates())

  useEffect(() => { reconnectSettingsRef.current = reconnectSettings }, [reconnectSettings])
  useEffect(() => { interactiveSessionsRef.current = interactiveSessions }, [interactiveSessions])
  useEffect(() => { pcSessionTabsRef.current = pcSessionTabs }, [pcSessionTabs])
  useEffect(() => { workspaceBySessionRef.current = workspaceBySession }, [workspaceBySession])
  useEffect(() => { browserBySessionRef.current = browserBySession }, [browserBySession])
  useEffect(() => {
    leftPaneSessionIdRef.current = leftPaneSessionId
    rightPaneSessionIdRef.current = rightPaneSessionId
  }, [leftPaneSessionId, rightPaneSessionId])

  useEffect(() => {
    if (leftPaneSessionId) localStorage.setItem(ACTIVE_INTERACTIVE_SESSION_KEY, leftPaneSessionId)
    else localStorage.removeItem(ACTIVE_INTERACTIVE_SESSION_KEY)
    if (leftPaneSessionId) localStorage.setItem(LEFT_INTERACTIVE_SESSION_KEY, leftPaneSessionId)
    else localStorage.removeItem(LEFT_INTERACTIVE_SESSION_KEY)
  }, [leftPaneSessionId])

  useEffect(() => {
    if (rightPaneSessionId) localStorage.setItem(RIGHT_INTERACTIVE_SESSION_KEY, rightPaneSessionId)
    else localStorage.removeItem(RIGHT_INTERACTIVE_SESSION_KEY)
  }, [rightPaneSessionId])

  useEffect(() => {
    localStorage.setItem(RECONNECT_SETTINGS_KEY, JSON.stringify(reconnectSettings))
  }, [reconnectSettings])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECONNECT_SETTINGS_KEY)
      if (saved) setReconnectSettings(JSON.parse(saved) as ReconnectSettings)
    } catch { /* ignore corrupted data */ }
  }, [])

  useEffect(() => {
    for (const [sessionId, browserState] of Object.entries(browserBySession)) {
      const session = interactiveSessions.find((item) => item.sessionId === sessionId)
      const connectionKind = session?.hostId ? 'host' : 'local'
      persistBrowserSessionState({
        browserState,
        hostId: session?.hostId,
        connectionKind,
      })
    }
  }, [browserBySession, interactiveSessions])

  function getBrowserRoutePrefKey(params: { hostId?: string | null; connectionKind?: 'host' | 'local' | null }) {
    if (params.connectionKind === 'local') return 'local'
    if (params.hostId) return `host:${params.hostId}`
    return null
  }

  function getStoredBrowserRouteMode(params: { hostId?: string | null; connectionKind?: 'host' | 'local' | null }) {
    const key = getBrowserRoutePrefKey(params)
    if (!key) return 'auto' as const
    return browserRouteModePrefsRef.current[key] ?? 'auto'
  }

  function getStoredBrowserSessionState(params: { hostId?: string | null; connectionKind?: 'host' | 'local' | null }) {
    const key = getBrowserRoutePrefKey(params)
    if (!key) return null
    return browserSessionStatePrefsRef.current[key] ?? null
  }

  function getManagedBrowserId(sessionId: string, state: SessionBrowserState) {
    return `${sessionId}::${state.activeTabId ?? 'tab'}`
  }

  function getTabIdFromBrowserId(sessionId: string, browserId: string) {
    const prefix = `${sessionId}::`
    return browserId.startsWith(prefix) ? browserId.slice(prefix.length) : undefined
  }

  function clearManagedBrowserRuntimeEntry(browserId: string) {
    managedBrowserOpenRef.current.delete(browserId)
    delete managedBrowserSourceRevisionRef.current[browserId]
    delete browserTransportRef.current[browserId]
    delete browserEventMarkersRef.current[browserId]
  }

  function clearManagedBrowserRuntime(sessionId: string) {
    delete browserProxyRef.current[sessionId]
    delete browserTransportRecoveryAttemptsRef.current[sessionId]

    for (const key of Object.keys(managedBrowserSourceRevisionRef.current)) {
      if (key === sessionId || key.startsWith(`${sessionId}::`)) {
        delete managedBrowserSourceRevisionRef.current[key]
      }
    }
    for (const key of Object.keys(browserTransportRef.current)) {
      if (key === sessionId || key.startsWith(`${sessionId}::`)) {
        delete browserTransportRef.current[key]
      }
    }
    for (const key of Object.keys(browserEventMarkersRef.current)) {
      if (key === sessionId || key.startsWith(`${sessionId}::`)) {
        delete browserEventMarkersRef.current[key]
      }
    }
    for (const browserId of [...managedBrowserOpenRef.current]) {
      if (browserId === sessionId || browserId.startsWith(`${sessionId}::`)) {
        managedBrowserOpenRef.current.delete(browserId)
      }
    }
  }

  function getManagedBrowserIdsForSession(sessionId: string, state?: SessionBrowserState | null) {
    const ids = new Set<string>()
    if (state) {
      ids.add(getManagedBrowserId(sessionId, state))
      for (const tab of state.tabs) {
        ids.add(`${sessionId}::${tab.id}`)
      }
    }
    for (const browserId of Object.keys(browserTransportRef.current)) {
      if (browserId === sessionId || browserId.startsWith(`${sessionId}::`)) ids.add(browserId)
    }
    for (const browserId of Object.keys(managedBrowserSourceRevisionRef.current)) {
      if (browserId === sessionId || browserId.startsWith(`${sessionId}::`)) ids.add(browserId)
    }
    for (const browserId of managedBrowserOpenRef.current) {
      if (browserId === sessionId || browserId.startsWith(`${sessionId}::`)) ids.add(browserId)
    }
    return [...ids]
  }

  function stopManagedBrowserPortForwards(sessionId: string, state?: SessionBrowserState | null) {
    for (const browserId of getManagedBrowserIdsForSession(sessionId, state)) {
      void stopBrowserPortForward(browserId).catch(() => {})
    }
  }

  function closeManagedBrowserWindows(sessionId: string, state?: SessionBrowserState | null) {
    for (const browserId of getManagedBrowserIdsForSession(sessionId, state)) {
      void closeBrowserWindow(browserId, sessionId).catch(() => {})
    }
  }

  function persistBrowserRouteMode(params: {
    sessionId: string
    routeMode: BrowserRouteMode
    hostId?: string | null
    connectionKind?: 'host' | 'local' | null
  }) {
    const prefKey = getBrowserRoutePrefKey(params)
    if (!prefKey) return
    if (params.routeMode === 'auto') delete browserRouteModePrefsRef.current[prefKey]
    else browserRouteModePrefsRef.current[prefKey] = params.routeMode
    localStorage.setItem(BROWSER_ROUTE_MODE_KEY, JSON.stringify(browserRouteModePrefsRef.current))
  }

  function persistBrowserSessionState(params: {
    browserState: SessionBrowserState
    hostId?: string | null
    connectionKind?: 'host' | 'local' | null
  }) {
    const prefKey = getBrowserRoutePrefKey(params)
    if (!prefKey) return
    const sanitized = stripSessionBrowserRuntimeState(params.browserState)
    const hasUsefulState = sanitized.tabs.some((tab) => tab.source || tab.addressInput.trim())
    if (!hasUsefulState && sanitized.presentation === 'closed') {
      delete browserSessionStatePrefsRef.current[prefKey]
    } else {
      browserSessionStatePrefsRef.current[prefKey] = sanitized
    }
    localStorage.setItem(BROWSER_SESSION_STATE_KEY, JSON.stringify(browserSessionStatePrefsRef.current))
  }

  function acceptPendingHostKey() {
    pendingHostKeyResolveRef.current?.(true)
    pendingHostKeyResolveRef.current = null
    setPendingHostKey(null)
  }

  function rejectPendingHostKey() {
    pendingHostKeyResolveRef.current?.(false)
    pendingHostKeyResolveRef.current = null
    setPendingHostKey(null)
  }

  async function connectWithHostKeyPrompt(params: Parameters<typeof createInteractiveSession>[0]): Promise<Awaited<ReturnType<typeof createInteractiveSession>>> {
    let next = params
    for (let hop = 0; hop < 3; hop += 1) {
      try { return await createInteractiveSession(next) } catch (error) {
        const hkInfo = parseHostKeyError(error instanceof Error ? error.message : String(error))
        if (!hkInfo || hkInfo.code !== 'host_key_unknown') throw error
        const accepted = await new Promise<boolean>((resolve) => {
          pendingHostKeyResolveRef.current = resolve
          setPendingHostKey(hkInfo)
        })
        if (!accepted) throw new Error('Connection cancelled: host key not accepted')
        next = { ...params, acceptedHostKey: { host: hkInfo.host, port: hkInfo.port, fingerprint: hkInfo.fingerprint } }
      }
    }
    throw new Error('Host key verification did not settle')
  }

  async function prepareBrowserPortForwardWithHostKeyPrompt(params: Parameters<typeof prepareBrowserPortForward>[0]) {
    let next = params
    for (let hop = 0; hop < 3; hop += 1) {
      try { return await prepareBrowserPortForward(next) } catch (error) {
        const hkInfo = parseHostKeyError(error instanceof Error ? error.message : String(error))
        if (!hkInfo || hkInfo.code !== 'host_key_unknown') throw error
        const accepted = await new Promise<boolean>((resolve) => {
          pendingHostKeyResolveRef.current = resolve
          setPendingHostKey(hkInfo)
        })
        if (!accepted) throw new Error('Connection cancelled: host key not accepted')
        next = { ...params, acceptedHostKey: { host: hkInfo.host, port: hkInfo.port, fingerprint: hkInfo.fingerprint } }
      }
    }
    throw new Error('Host key verification did not settle')
  }

  function appendPaneEvent(pane: PaneId, level: PaneEvent['level'], message: string, sessionId: string | null = null) {
    const entry: PaneEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      pane, sessionId, timestamp: Date.now(), level, message,
    }
    setPaneEvents((prev) => ({ ...prev, [pane]: [...prev[pane], entry].slice(-80) }))
  }

  async function attemptReconnect(sessionId: string, hostId: string, pane: PaneId, rs: ReconnectSettings) {
    let reconnected = false
    const sourceVaultId = interactiveSessionsRef.current.find((session) => session.sessionId === sessionId)?.vaultId ?? activeVaultId
    setPcSessionTabs((prev) => prev.map((t) => t.sessionId === sessionId ? { ...t, status: 'reconnecting' } : t))
    for (let attempt = 1; attempt <= rs.maxRetries; attempt++) {
      await new Promise<void>((r) => window.setTimeout(r, rs.intervalMs))
      if (sourceVaultId !== activeVaultIdRef.current) break
      const host = hosts.find((h) => h.id === hostId && (!h.vaultId || h.vaultId === sourceVaultId))
      if (!host) break
      try {
        const previousWorkspaceState = workspaceBySessionRef.current[sessionId]
        const previousBrowserState = browserBySessionRef.current[sessionId]
        const secret = undefined
        const newSession = await createInteractiveSession({
          vaultId: sourceVaultId, hostId: host.id, host: host.address, port: host.port || 22,
          username: host.username || defaultUsername, authType: host.authType,
          password: host.authType === 'password' ? secret : undefined,
          privateKey: host.authType === 'privateKey' ? secret : undefined,
          keepAliveIntervalSecs,
          jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser,
          acceptHostKey: false,
        })
        setInteractiveSessions((prev) => [...prev, newSession])
        initializeInteractiveSessionState(newSession.sessionId, { hostId, connectionKind: 'host' })
        if (previousWorkspaceState) {
          setWorkspaceBySession((prev) => {
            const next = { ...prev, [newSession.sessionId]: previousWorkspaceState }
            delete next[sessionId]
            return next
          })
        }
        if (previousBrowserState) {
          setBrowserBySession((prev) => {
            const next = { ...prev }
            next[newSession.sessionId] = normalizeSessionBrowserState({
              ...previousBrowserState,
              tabs: previousBrowserState.tabs.map((tab) => ({
                ...tab,
                resolvedUrl: null,
                resolvedLocalPort: null,
                proxyUrl: null,
                error: null,
                isLoading: tab.source ? true : false,
              })),
              closedTabs: previousBrowserState.closedTabs.map((tab) => ({
                ...tab,
                resolvedUrl: null,
                resolvedLocalPort: null,
                proxyUrl: null,
                error: null,
                isLoading: false,
              })),
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: null,
              error: null,
              isLoading: previousBrowserState.source ? true : false,
            })
            delete next[sessionId]
            return next
          })
        }
        if (pane === 'left') setLeftPaneSessionId(newSession.sessionId)
        else setRightPaneSessionId(newSession.sessionId)
        setPcSessionTabs((prev) => prev.map((t) =>
          t.sessionId === sessionId ? { ...t, sessionId: newSession.sessionId, status: 'connected' } : t,
        ))
        setWorkspaceAuthBySession((prev) => {
          const next = { ...prev, [newSession.sessionId]: secret ?? '' }
          delete next[sessionId]
          return next
        })
        setPcActiveSessionId((prev) => prev === sessionId ? newSession.sessionId : prev)
        appendPaneEvent(pane, 'info', `Reconnected to ${host.username || defaultUsername}@${host.address}`, newSession.sessionId)
        void appendActivity({
          event: 'reconnect', hostId: host.id, hostName: host.name, hostAddress: host.address,
          username: host.username || defaultUsername, authType: host.authType,
        })
        reconnected = true
        break
      } catch {
        if (attempt < rs.maxRetries) {
          appendPaneEvent(pane, 'warn', `Reconnect attempt ${attempt}/${rs.maxRetries} failed, retrying...`, sessionId)
        }
      }
    }
    reconnectingRef.current.delete(sessionId)
    setReconnectingSessionIds((prev) => { const n = new Set(prev); n.delete(sessionId); return n })
    if (!reconnected) {
      appendPaneEvent(pane, 'error', `Auto-reconnect failed after ${rs.maxRetries} attempt(s). Click "Reconnect" to try again.`, sessionId)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === sessionId ? { ...t, status: 'closed' } : t))
    } else {
      closedSessionCleanupRef.current.delete(sessionId)
      void cleanupClosedSession(sessionId)
    }
  }
  attemptReconnectRef.current = attemptReconnect

  function manualReconnect(sessionId: string) {
    if (reconnectingRef.current.has(sessionId)) return
    const info = interactiveSessionsRef.current.find((s) => s.sessionId === sessionId)
    const pane = paneForSession(sessionId)
    if (!info?.hostId || !pane) return
    reconnectingRef.current.add(sessionId)
    setReconnectingSessionIds((prev) => new Set(prev).add(sessionId))
    closedSessionCleanupRef.current.add(sessionId)
    const rs = reconnectSettingsRef.current
    void attemptReconnect(sessionId, info.hostId, pane, { ...rs, maxRetries: Math.max(rs.maxRetries, 3) })
  }

  function paneForSession(sessionId: string): PaneId | null {
    if (leftPaneSessionIdRef.current === sessionId) return 'left'
    if (rightPaneSessionIdRef.current === sessionId) return 'right'
    return null
  }

  useEffect(() => {
    let disposed = false
    let unlistenOutput: (() => void) | null = null
    let unlistenProgress: (() => void) | null = null
    let unlistenStatus: (() => void) | null = null

    const attach = async () => {
      const outputListener = await listenToInteractiveOutputEvents(({ sessionId, chunks }) => {
        if (!chunks.length) return
        interactiveNextSeqRef.current[sessionId] = chunks[chunks.length - 1]?.seq ?? interactiveNextSeqRef.current[sessionId] ?? 0
        const emitter = pcChunkEmitterRef.current[sessionId]
        if (emitter) {
          emitter(chunks)
        } else {
          setInteractiveChunksBySession((prev) => ({
            ...prev,
            [sessionId]: trimInteractiveOutputChunks([...(prev[sessionId] ?? []), ...chunks]),
          }))
        }
      })
      if (disposed) outputListener()
      else unlistenOutput = outputListener

      const progressListener = await listenToInteractiveProgressEvents(({ sessionId, stage }) => {
        setPcSessionTabs((prev) => prev.map((tab) => (
          tab.sessionId === sessionId ? { ...tab, connectionStage: stage } : tab
        )))
      })
      if (disposed) progressListener()
      else unlistenProgress = progressListener

      const statusListener = await listenToInteractiveStatusEvents(({ sessionId, status }) => {
        const previousStatus = sessionStatusCacheRef.current[sessionId]
        sessionStatusCacheRef.current[sessionId] = status
        setInteractiveSessions((prev) =>
          prev.map((session) => (session.sessionId === sessionId ? { ...session, status } : session)),
        )

        if (!status.startsWith('closed')) {
          setPcSessionTabs((prev) => prev.map((tab) => (
            tab.sessionId === sessionId && tab.status !== 'error'
              ? { ...tab, status: 'connected', connectionStage: undefined }
              : tab
          )))
          if (previousStatus?.startsWith('closed')) {
            const browserState = browserBySessionRef.current[sessionId]
            const session = interactiveSessionsRef.current.find((item) => item.sessionId === sessionId)
            const hasRemoteSession = Boolean(session?.hostId)
            const effectiveRouteMode = resolveBrowserRouteMode(browserState?.routeMode ?? 'auto', hasRemoteSession)
            if (browserState?.presentation !== 'closed' && browserState?.source?.kind === 'url' && effectiveRouteMode === 'remote') {
              rebuildSessionBrowserTransport(sessionId)
            }
          }
          return
        }

        if (closedSessionCleanupRef.current.has(sessionId)) return
        closedSessionCleanupRef.current.add(sessionId)

        const pane = paneForSession(sessionId)
        const info = interactiveSessionsRef.current.find((session) => session.sessionId === sessionId)
        const tab = pcSessionTabsRef.current.find((entry) => entry.sessionId === sessionId)
        const rs = reconnectSettingsRef.current

        setPcSessionTabs((prev) => prev.map((entry) => (
          entry.sessionId === sessionId ? { ...entry, status: 'closed' } : entry
        )))

        if (tab && tab.hostAddress !== 'local') {
          void appendActivity({
            event: 'disconnect',
            hostId: info?.hostId ?? undefined,
            hostName: tab.hostName,
            hostAddress: tab.hostAddress,
            username: info?.username ?? undefined,
          })
        }

        if (pane && rs.enabled && rs.maxRetries > 0 && info?.hostId && !reconnectingRef.current.has(sessionId)) {
          reconnectingRef.current.add(sessionId)
          setReconnectingSessionIds((prev) => new Set(prev).add(sessionId))
          appendPaneEvent(pane, 'warn', 'Session disconnected. Reconnecting...', sessionId)
          void attemptReconnectRef.current(sessionId, info.hostId, pane, rs)
        }
      })
      if (disposed) statusListener()
      else unlistenStatus = statusListener
    }

    void attach()
    return () => {
      disposed = true
      unlistenOutput?.()
      unlistenProgress?.()
      unlistenStatus?.()
    }
  }, [])

  function initializeInteractiveSessionState(
    sessionId: string,
    options?: { hostId?: string | null; connectionKind?: 'host' | 'local' | null },
  ) {
    const routeMode = getStoredBrowserRouteMode(options ?? {})
    const restoredBrowserState = getStoredBrowserSessionState(options ?? {})
    setInteractiveChunksBySession((prev) => ({ ...prev, [sessionId]: [] }))
    interactiveNextSeqRef.current[sessionId] = 0
    setInteractiveInputBySession((prev) => ({ ...prev, [sessionId]: '' }))
    setInteractiveHistoryBySession((prev) => ({ ...prev, [sessionId]: [] }))
    setInteractiveHistoryCursorBySession((prev) => ({ ...prev, [sessionId]: null }))
    setWorkspaceBySession((prev) =>
      setSessionWorkspaceAppState(setSessionWorkspaceModeState(prev, sessionId, 'terminal'), sessionId, 'overview'),
    )
    setBrowserBySession((prev) => ({
      ...prev,
      [sessionId]: normalizeSessionBrowserState(restoredBrowserState
        ? { ...restoredBrowserState, routeMode }
        : { ...getInitialSessionBrowserState(), routeMode }),
    }))
  }

  const setSessionMode = useCallback((sessionId: string, mode: SessionWorkspaceMode) => {
    setWorkspaceBySession((prev) => {
      const next = setSessionWorkspaceModeState(prev, sessionId, mode)
      setPcSessionTabs((tabs) => syncSessionTabWorkspace(tabs, next))
      return next
    })
  }, [])

  const setSessionWorkspaceApp = useCallback((sessionId: string, app: WorkspaceAppId) => {
    setWorkspaceBySession((prev) => {
      const next = setSessionWorkspaceAppState(prev, sessionId, app)
      setPcSessionTabs((tabs) => syncSessionTabWorkspace(tabs, next))
      return next
    })
  }, [])

  const openSessionBrowserSource = useCallback((sessionId: string, source: BrowserSource, presentation: BrowserPresentation = 'embedded') => {
    setBrowserBySession((prev) => openSessionBrowserSourceState(prev, sessionId, source, presentation))
  }, [])

  const openSessionBrowserUrl = useCallback((sessionId: string, url: string, presentation: BrowserPresentation = 'embedded') => {
    openSessionBrowserSource(sessionId, { kind: 'url', url }, presentation)
  }, [openSessionBrowserSource])

  const openSessionBrowserHtml = useCallback((
    sessionId: string,
    html: string,
    options?: { baseUrl?: string; title?: string; presentation?: BrowserPresentation },
  ) => {
    openSessionBrowserSource(sessionId, {
      kind: 'html',
      html,
      baseUrl: options?.baseUrl,
      title: options?.title,
    }, options?.presentation ?? 'embedded')
  }, [openSessionBrowserSource])

  const openSessionBrowserMarkdown = useCallback((
    sessionId: string,
    markdown: string,
    options?: { baseUrl?: string; title?: string; presentation?: BrowserPresentation },
  ) => {
    openSessionBrowserSource(sessionId, {
      kind: 'markdown',
      markdown,
      baseUrl: options?.baseUrl,
      title: options?.title,
    }, options?.presentation ?? 'embedded')
  }, [openSessionBrowserSource])

  const createSessionBrowserTab = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => createSessionBrowserTabState(prev, sessionId))
  }, [])

  const duplicateSessionBrowserTab = useCallback((sessionId: string, tabId?: string) => {
    setBrowserBySession((prev) => duplicateSessionBrowserTabState(prev, sessionId, tabId))
  }, [])

  const activateSessionBrowserTab = useCallback((sessionId: string, tabId: string) => {
    setBrowserBySession((prev) => activateSessionBrowserTabState(prev, sessionId, tabId))
  }, [])

  const closeSessionBrowserTab = useCallback((sessionId: string, tabId: string) => {
    setBrowserBySession((prev) => closeSessionBrowserTabState(prev, sessionId, tabId))
  }, [])

  const closeOtherSessionBrowserTabs = useCallback((sessionId: string, tabId: string) => {
    setBrowserBySession((prev) => closeOtherSessionBrowserTabsState(prev, sessionId, tabId))
  }, [])

  const closeSessionBrowserTabsToRight = useCallback((sessionId: string, tabId: string) => {
    setBrowserBySession((prev) => closeSessionBrowserTabsToRightState(prev, sessionId, tabId))
  }, [])

  const restoreLastClosedSessionBrowserTab = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => restoreLastClosedSessionBrowserTabState(prev, sessionId))
  }, [])

  const toggleSessionBrowserTabPinned = useCallback((sessionId: string, tabId: string) => {
    setBrowserBySession((prev) => toggleSessionBrowserTabPinnedState(prev, sessionId, tabId))
  }, [])

  const reorderSessionBrowserTab = useCallback((
    sessionId: string,
    tabId: string,
    targetTabId: string,
    position: 'before' | 'after',
  ) => {
    setBrowserBySession((prev) => reorderSessionBrowserTabState(prev, sessionId, tabId, targetTabId, position))
  }, [])

  const setSessionBrowserPresentation = useCallback((sessionId: string, presentation: BrowserPresentation) => {
    setBrowserBySession((prev) => setSessionBrowserPresentationState(prev, sessionId, presentation))
  }, [])

  const setSessionBrowserRouteMode = useCallback((sessionId: string, routeMode: BrowserRouteMode) => {
    const session = interactiveSessionsRef.current.find((item) => item.sessionId === sessionId)
    persistBrowserRouteMode({
      sessionId,
      routeMode,
      hostId: session?.hostId,
      connectionKind: session?.hostId ? 'host' : 'local',
    })
    setBrowserBySession((prev) => setSessionBrowserRouteModeState(prev, sessionId, routeMode))
  }, [])

  const setSessionBrowserAddressInput = useCallback((sessionId: string, addressInput: string) => {
    setBrowserBySession((prev) => setSessionBrowserAddressInputState(prev, sessionId, addressInput))
  }, [])

  const submitSessionBrowserAddress = useCallback((sessionId: string, presentation: BrowserPresentation = 'embedded') => {
    setBrowserBySession((prev) => submitSessionBrowserAddressState(prev, sessionId, presentation))
  }, [])

  const reloadSessionBrowser = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => reloadSessionBrowserState(prev, sessionId))
  }, [])

  const goSessionBrowserBack = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => goSessionBrowserBackState(prev, sessionId))
  }, [])

  const goSessionBrowserForward = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => goSessionBrowserForwardState(prev, sessionId))
  }, [])

  const syncSessionBrowserUrl = useCallback((sessionId: string, url: string, tabId?: string) => {
    setBrowserBySession((prev) => syncSessionBrowserUrlState(prev, sessionId, url, tabId))
  }, [])

  const setSessionBrowserLoading = useCallback((sessionId: string, isLoading: boolean, tabId?: string) => {
    setBrowserBySession((prev) => setSessionBrowserLoadingState(prev, sessionId, isLoading, tabId))
  }, [])

  const setSessionBrowserError = useCallback((sessionId: string, error: string | null, tabId?: string) => {
    setBrowserBySession((prev) => setSessionBrowserErrorState(prev, sessionId, error, tabId))
  }, [])

  const setSessionBrowserNavigation = useCallback((
    sessionId: string,
    values: { canGoBack?: boolean; canGoForward?: boolean; title?: string | null },
    tabId?: string,
  ) => {
    setBrowserBySession((prev) => setSessionBrowserNavigationState(prev, sessionId, values, tabId))
  }, [])

  const closeSessionBrowser = useCallback((sessionId: string) => {
    setBrowserBySession((prev) => closeSessionBrowserState(prev, sessionId))
  }, [])

  const rebuildSessionBrowserTransport = useCallback((sessionId: string) => {
    const state = browserBySessionRef.current[sessionId]
    if (!state || state.presentation === 'closed' || state.source?.kind !== 'url') return

    const session = interactiveSessionsRef.current.find((item) => item.sessionId === sessionId)
    const hasRemoteSession = Boolean(session?.hostId)
    const effectiveRouteMode = resolveBrowserRouteMode(state.routeMode, hasRemoteSession)
    if (effectiveRouteMode !== 'remote') return

    const host = session?.hostId ? hosts.find((item) => item.id === session.hostId) : undefined
    setOutput(t('browser.feedback.transportRecovering', {
      host: host?.name ?? host?.address ?? sessionId,
    }))

    stopManagedBrowserPortForwards(sessionId, state)
    void stopBrowserHttpProxy(sessionId).catch(() => {})
    void stopBrowserSocksProxy(sessionId).catch(() => {})
    clearManagedBrowserRuntime(sessionId)

    setBrowserBySession((prev) => setSessionBrowserTransportStatusState(
      reloadSessionBrowserState(
        setSessionBrowserTransportState(prev, sessionId, {
          resolvedUrl: null,
          resolvedLocalPort: null,
          proxyUrl: null,
        }),
        sessionId,
      ),
      sessionId,
      'recovering',
    ))
  }, [hosts, setOutput])

  useEffect(() => {
    let disposed = false
    let cleanupState: (() => void) | undefined
    let cleanupClosed: (() => void) | undefined

    void listenToAllBrowserStateEvents((payload: BrowserStateEventPayload) => {
      if (disposed || !payload.sessionId) return
      const tabId = payload.browserId ? getTabIdFromBrowserId(payload.sessionId, payload.browserId) : undefined
      const browserEventKey = payload.browserId ?? `${payload.sessionId}:${tabId ?? 'active'}`
      const currentState = browserBySessionRef.current[payload.sessionId]
      if (shouldIgnoreSettledBrowserLoadEvent(currentState, payload, tabId)) {
        console.log('[Browser:Event]', 'ignored settled duplicate:', JSON.stringify({ sessionId: payload.sessionId, browserId: payload.browserId, url: payload.url, isLoading: payload.isLoading }))
        return
      }
      const signature = buildBrowserStateEventSignature(payload)
      const now = performance.now()
      const previous = browserEventMarkersRef.current[browserEventKey]
      if (previous && previous.signature === signature && now - previous.seenAt < BROWSER_EVENT_DEDUPE_WINDOW_MS) {
        console.log('[Browser:Event]', 'deduped:', JSON.stringify({ sessionId: payload.sessionId, browserId: payload.browserId, url: payload.url, isLoading: payload.isLoading }))
        return
      }
      browserEventMarkersRef.current[browserEventKey] = { signature, seenAt: now }
      console.log('[Browser:Event]', 'received:', JSON.stringify({ sessionId: payload.sessionId, url: payload.url, isLoading: payload.isLoading, title: payload.title?.slice(0, 30), error: payload.error, canGoBack: payload.canGoBack, canGoForward: payload.canGoForward }))
      if (typeof payload.url === 'string' && payload.url) {
        const transport = browserTransportRef.current[payload.browserId] ?? browserTransportRef.current[payload.sessionId]
        const nextUrl = transport
          ? restoreBrowserUrlFromLocalForward(payload.url, transport.originalUrl, transport.localPort)
          : payload.url
        syncSessionBrowserUrl(payload.sessionId, nextUrl, tabId)
      }
      if (typeof payload.isLoading === 'boolean') {
        setSessionBrowserLoading(payload.sessionId, payload.isLoading, tabId)
      }
      if (
        typeof payload.title === 'string'
        || payload.title === null
        || typeof payload.canGoBack === 'boolean'
        || typeof payload.canGoForward === 'boolean'
      ) {
        setSessionBrowserNavigation(payload.sessionId, {
          title: payload.title,
          canGoBack: payload.canGoBack,
          canGoForward: payload.canGoForward,
        }, tabId)
      }
      if (typeof payload.error === 'string') {
        setSessionBrowserError(payload.sessionId, payload.error, tabId)
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else cleanupState = unlisten
    })

    void listenToBrowserWindowClosedEvents((payload) => {
      if (disposed) return
      console.log('[Browser:Event]', 'window-closed:', payload.browserId)
      const currentState = browserBySessionRef.current[payload.sessionId]
      // Only react to close events for standalone window browsers.
      // Embedded webviews are lifecycle-managed by the React component —
      // their close calls are initiated by the component cleanup, not by the user.
      if (currentState?.presentation === 'window') {
        clearManagedBrowserRuntimeEntry(payload.browserId)
        void stopBrowserPortForward(payload.browserId).catch(() => {})
        void stopBrowserHttpProxy(payload.sessionId).catch(() => {})
        void stopBrowserSocksProxy(payload.sessionId).catch(() => {})
        const latestState = browserBySessionRef.current[payload.sessionId]
        const currentBrowserId = latestState ? getManagedBrowserId(payload.sessionId, latestState) : null
        if (currentBrowserId === payload.browserId) {
          setBrowserBySession((prev) => closeSessionBrowserState(prev, payload.sessionId))
        }
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else cleanupClosed = unlisten
    })

    return () => {
      disposed = true
      cleanupState?.()
      cleanupClosed?.()
    }
  }, [
    setSessionBrowserError,
    setSessionBrowserLoading,
    setSessionBrowserNavigation,
    syncSessionBrowserUrl,
  ])

  // Compute a sync key from only the fields that should trigger the browser sync effect.
  // Transport fields (resolvedUrl, resolvedLocalPort, proxyUrl) are excluded so that calling
  // setBrowserBySession inside the effect doesn't re-trigger it and cause an infinite loop.
  const browserSyncTriggerRef = useRef<string>('')
  const browserSyncRevisionRef = useRef(0)
  const browserSyncRevision = useMemo(() => {
    const key = Object.entries(browserBySession)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, s]) => {
        const activeTab = getActiveSessionBrowserTab(s)
        return `${id}:${s.presentation}:${s.routeMode}:${s.activeTabId}:${activeTab?.sourceRevision ?? -1}`
      })
      .join('|')
    if (key !== browserSyncTriggerRef.current) {
      browserSyncTriggerRef.current = key
      browserSyncRevisionRef.current += 1
    }
    return browserSyncRevisionRef.current
  }, [browserBySession])

  useEffect(() => {
    const syncBrowserWindow = async (sessionId: string) => {
      const state = browserBySessionRef.current[sessionId]
      if (!state) return
      const browserId = getManagedBrowserId(sessionId, state)
      const syncStartedAt = performance.now()
      const session = interactiveSessionsRef.current.find((item) => item.sessionId === sessionId)
      const host = session?.hostId ? hosts.find((item) => item.id === session.hostId) : undefined
      const authSecret = workspaceAuthBySession[sessionId]
      const hasRemoteSession = Boolean(session?.hostId)
      const effectiveRouteMode = resolveBrowserRouteMode(state.routeMode, hasRemoteSession)
      const authType = host?.authType
      const canReuseInteractiveTransport = hasRemoteSession && !!host && !!authType
      console.log('[Browser:Sync]', 'start', sessionId, 'presentation=', state.presentation, 'sourceRev=', state.sourceRevision, 'source=', state.source?.kind, 'proxyUrl=', state.proxyUrl)
      const vaultMismatch = Boolean(session?.vaultId && session.vaultId !== activeVaultId)
      try {
        if (vaultMismatch) throw new Error(t('workspace.sessionVaultMismatch'))
        let proxyUrl: string | undefined
        const needsProxy = effectiveRouteMode === 'remote' && state.presentation !== 'closed' && state.source?.kind === 'url' && !isLoopbackBrowserUrl(state.source.url)
        console.log('[Browser:Sync]', 'proxy check', sessionId, 'routeMode=', state.routeMode, 'effectiveRoute=', effectiveRouteMode, 'needsProxy=', needsProxy, 'hasSSH=', hasRemoteSession, 'hasHost=', !!host, 'authType=', authType ?? '(none)', 'hasSecret=', !!authSecret, 'reuseInteractive=', canReuseInteractiveTransport)
        if (effectiveRouteMode === 'remote' && state.presentation !== 'closed' && state.source?.kind === 'url' && (!host || !authType || (!authSecret && !canReuseInteractiveTransport))) {
          throw new Error('Remote browsing needs an active SSH session or stored credentials')
        }
        if (needsProxy) {
          if (!browserProxyRef.current[sessionId]) {
            const proxyStartedAt = performance.now()
            const hasJumpHost = Boolean(host!.jumpHostId || host!.jumpHost?.trim())
            const proxyKind = hasJumpHost ? 'socks' : 'http'
            console.log('[Browser:Sync]', `starting ${proxyKind.toUpperCase()} proxy`, sessionId)
            const proxyPort = hasJumpHost
              ? await startBrowserSocksProxy({
                sessionId,
                hostId: host!.id,
                vaultId: host!.vaultId ?? activeVaultId ?? undefined,
                host: host!.address,
                port: host!.port || 22,
                username: host!.username || defaultUsername,
                authType: authType!,
                password: authType === 'password' ? authSecret : undefined,
                privateKey: authType === 'privateKey' ? authSecret : undefined,
                jumpHost: host!.jumpHost,
                jumpPort: host!.jumpPort,
                jumpUser: host!.jumpUser,
              })
              : await startBrowserHttpProxy({
                sessionId,
                hostId: host!.id,
                vaultId: host!.vaultId ?? activeVaultId ?? undefined,
                host: host!.address,
                port: host!.port || 22,
                username: host!.username || defaultUsername,
                authType: authType!,
                password: authType === 'password' ? authSecret : undefined,
                privateKey: authType === 'privateKey' ? authSecret : undefined,
                jumpHost: host!.jumpHost,
                jumpPort: host!.jumpPort,
                jumpUser: host!.jumpUser,
              })
            console.log(
              '[Browser:Sync]',
              `${proxyKind.toUpperCase()} proxy started on port`,
              proxyPort,
              sessionId,
              'elapsedMs=',
              Math.round(performance.now() - proxyStartedAt),
            )
            browserProxyRef.current[sessionId] = {
              proxyUrl: `${hasJumpHost ? 'socks5' : 'http'}://127.0.0.1:${proxyPort}`,
            }
          }
          proxyUrl = browserProxyRef.current[sessionId]?.proxyUrl
        } else if (browserProxyRef.current[sessionId]) {
          console.log('[Browser:Sync]', 'stopping remote proxy', sessionId)
          await stopBrowserHttpProxy(sessionId).catch(() => {})
          await stopBrowserSocksProxy(sessionId).catch(() => {})
          delete browserProxyRef.current[sessionId]
        }

        if (!managedBrowserOpenRef.current.has(browserId) && state.presentation === 'window') {
          console.log('[Browser:Sync]', 'opening browser window', sessionId, 'proxyUrl=', proxyUrl)
          await openBrowserWindow({ browserId, sessionId, proxyUrl })
          managedBrowserOpenRef.current.add(browserId)
        }

        if (state.source && managedBrowserSourceRevisionRef.current[browserId] !== state.sourceRevision) {
          console.log('[Browser:Sync]', 'source changed', sessionId, 'rev=', state.sourceRevision, 'lastRev=', managedBrowserSourceRevisionRef.current[browserId])
          let sourceToLoad = state.source

          if (state.source.kind === 'url' && effectiveRouteMode === 'remote' && isLoopbackBrowserUrl(state.source.url)) {
            if (!host || !authType || (!authSecret && !canReuseInteractiveTransport)) {
              throw new Error('Remote browser preview needs an active SSH session or stored credentials')
            }

            const forwardStartedAt = performance.now()
            console.log('[Browser:Sync]', 'preparing port forward for loopback URL', sessionId, state.source.url)
            const prepared = await prepareBrowserPortForwardWithHostKeyPrompt({
              browserId,
              sessionId,
              hostId: host.id,
              vaultId: host.vaultId ?? activeVaultId ?? undefined,
              host: host.address,
              port: host.port || 22,
              username: host.username || defaultUsername,
              authType: authType!,
              password: authType === 'password' ? authSecret : undefined,
              privateKey: authType === 'privateKey' ? authSecret : undefined,
              jumpHost: host.jumpHost,
              jumpPort: host.jumpPort,
              jumpUser: host.jumpUser,
              targetUrl: state.source.url,
            })
            console.log('[Browser:Sync]', 'port forward ready', sessionId, 'localPort=', prepared.localPort, 'elapsedMs=', Math.round(performance.now() - forwardStartedAt))

            browserTransportRef.current[browserId] = {
              originalUrl: state.source.url,
              resolvedUrl: prepared.resolvedUrl,
              localPort: prepared.localPort,
            }
            setBrowserBySession((prev) => setSessionBrowserTransportState(prev, sessionId, {
              resolvedUrl: prepared.resolvedUrl,
              resolvedLocalPort: prepared.localPort,
              proxyUrl: null,
            }))
            sourceToLoad = { ...state.source, url: prepared.resolvedUrl }
          } else {
            console.log('[Browser:Sync]', 'setting transport state', sessionId, 'proxyUrl=', proxyUrl ?? '(none)')
            delete browserTransportRef.current[browserId]
            setBrowserBySession((prev) => setSessionBrowserTransportState(prev, sessionId, {
              resolvedUrl: null,
              resolvedLocalPort: null,
              proxyUrl: proxyUrl ?? null,
            }))
            stopManagedBrowserPortForwards(sessionId, state)
          }

          if (state.presentation === 'window') {
            console.log('[Browser:Sync]', 'loading source in window', sessionId)
            await loadBrowserSource({
              browserId,
              sessionId,
              source: sourceToLoad,
            })
          } else {
            console.log('[Browser:Sync]', 'embedded mode, source loading handled by EmbeddedBrowserWebview', sessionId)
          }
          managedBrowserSourceRevisionRef.current[browserId] = state.sourceRevision
        } else {
          console.log('[Browser:Sync]', 'no source change', sessionId)
        }
        delete browserTransportRecoveryAttemptsRef.current[sessionId]
        setBrowserBySession((prev) => setSessionBrowserTransportStatusState(prev, sessionId, 'idle'))
        console.log('[Browser:Sync]', 'complete', sessionId, 'elapsedMs=', Math.round(performance.now() - syncStartedAt))
      } catch (error) {
        console.error('[Browser:Sync]', 'ERROR in syncBrowserWindow', sessionId, error)
        const canAttemptTransportRecovery = !vaultMismatch && effectiveRouteMode === 'remote'
          && state.presentation !== 'closed'
          && state.source?.kind === 'url'
        const recoveryAttempts = browserTransportRecoveryAttemptsRef.current[sessionId] ?? 0
        if (canAttemptTransportRecovery && recoveryAttempts < 1) {
          console.log('[Browser:Sync]', 'attempting transport recovery', sessionId, 'attempt=', recoveryAttempts + 1)
          setOutput(t('browser.feedback.transportRecovering', {
            host: host?.name ?? host?.address ?? sessionId,
          }))
          stopManagedBrowserPortForwards(sessionId, state)
          void stopBrowserHttpProxy(sessionId).catch(() => {})
          void stopBrowserSocksProxy(sessionId).catch(() => {})
          clearManagedBrowserRuntime(sessionId)
          browserTransportRecoveryAttemptsRef.current[sessionId] = recoveryAttempts + 1
          setBrowserBySession((prev) => setSessionBrowserTransportStatusState(
            reloadSessionBrowserState(
              setSessionBrowserTransportState(prev, sessionId, {
                resolvedUrl: null,
                resolvedLocalPort: null,
                proxyUrl: null,
              }),
              sessionId,
            ),
            sessionId,
            'recovering',
          ))
          return
        }
        setBrowserBySession((prev) => setSessionBrowserTransportStatusState(
          setSessionBrowserErrorState(
            prev,
            sessionId,
            error instanceof Error ? error.message : String(error),
          ),
          sessionId,
          canAttemptTransportRecovery ? 'failed' : 'idle',
        ))
      }
    }

    const currentBrowserBySession = browserBySessionRef.current
    for (const [sessionId, state] of Object.entries(currentBrowserBySession)) {
      if (state.presentation === 'closed') continue
      void syncBrowserWindow(sessionId)
    }

    for (const browserId of managedBrowserOpenRef.current) {
      const ownerSessionId = browserId.includes('::') ? browserId.slice(0, browserId.indexOf('::')) : browserId
      const ownerState = currentBrowserBySession[ownerSessionId]
      const expectedBrowserId = ownerState ? getManagedBrowserId(ownerSessionId, ownerState) : null
      const shouldKeepWindow = ownerState?.presentation === 'window' && browserId === expectedBrowserId
      if (shouldKeepWindow) continue

      void closeBrowserWindow(browserId, ownerSessionId).catch(() => {})
      void stopBrowserPortForward(browserId).catch(() => {})

      if (!ownerState || ownerState.presentation === 'closed') {
        void stopBrowserHttpProxy(ownerSessionId).catch(() => {})
        void stopBrowserSocksProxy(ownerSessionId).catch(() => {})
        clearManagedBrowserRuntime(ownerSessionId)
        continue
      }

      clearManagedBrowserRuntimeEntry(browserId)
    }
  }, [activeVaultId, browserSyncRevision, defaultUsername, hosts, workspaceAuthBySession])

  async function refreshInteractiveSessions() {
    const sessions = await listInteractiveSessions()
    setInteractiveSessions(sessions)
    setLeftPaneSessionId((cur) => {
      const persisted = localStorage.getItem(LEFT_INTERACTIVE_SESSION_KEY)
      if (persisted && sessions.some((s) => s.sessionId === persisted)) return persisted
      if (cur && sessions.some((s) => s.sessionId === cur)) return cur
      const legacy = localStorage.getItem(ACTIVE_INTERACTIVE_SESSION_KEY)
      if (legacy && sessions.some((s) => s.sessionId === legacy)) return legacy
      return sessions[0]?.sessionId ?? null
    })
    setRightPaneSessionId((cur) => {
      const persisted = localStorage.getItem(RIGHT_INTERACTIVE_SESSION_KEY)
      if (persisted && sessions.some((s) => s.sessionId === persisted)) return persisted
      if (cur && sessions.some((s) => s.sessionId === cur)) return cur
      return null
    })
  }

  useEffect(() => { void refreshInteractiveSessions() }, [])

  useEffect(() => {
    return () => {
      for (const timer of Object.values(sendRawTimerRef.current)) {
        if (timer) clearTimeout(timer)
      }
      for (const session of interactiveSessionsRef.current) {
        void closeInteractiveSession(session.sessionId)
      }
    }
  }, [])

  const flushRaw = useCallback((sessionId: string) => {
    const timer = sendRawTimerRef.current[sessionId]
    if (timer) {
      clearTimeout(timer)
      delete sendRawTimerRef.current[sessionId]
    }
    const buffered = sendRawBufferRef.current[sessionId]
    if (!buffered) return
    delete sendRawBufferRef.current[sessionId]
    void sendInteractiveInput(sessionId, buffered).catch(() => {})
  }, [])

  async function cleanupClosedSession(sessionId: string) {
    flushRaw(sessionId)
    try { await closeInteractiveSession(sessionId) } catch { /* may already be removed */ } finally {
      closeManagedBrowserWindows(sessionId, browserBySessionRef.current[sessionId])
      stopManagedBrowserPortForwards(sessionId, browserBySessionRef.current[sessionId])
      void stopBrowserHttpProxy(sessionId).catch(() => {})
      void stopBrowserSocksProxy(sessionId).catch(() => {})
      clearManagedBrowserRuntime(sessionId)
      delete sendRawBufferRef.current[sessionId]
      const timer = sendRawTimerRef.current[sessionId]
      if (timer) clearTimeout(timer)
      delete sendRawTimerRef.current[sessionId]
      closedSessionCleanupRef.current.delete(sessionId)
      setInteractiveSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
      setInteractiveChunksBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      delete interactiveNextSeqRef.current[sessionId]
      setInteractiveInputBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setInteractiveHistoryBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setInteractiveHistoryCursorBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setWorkspaceBySession((prev) => removeSessionWorkspaceState(prev, sessionId))
      setBrowserBySession((prev) => removeSessionBrowserState(prev, sessionId))
      setWorkspaceAuthBySession((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      setLeftPaneSessionId((prev) => {
        if (prev !== sessionId) return prev
        const rest = interactiveSessionsRef.current.filter((s) => s.sessionId !== sessionId)
        return rest[0]?.sessionId ?? null
      })
      setRightPaneSessionId((prev) => (prev === sessionId ? null : prev))
    }
  }

  async function openHostConnection(hostId: string, placeholderId?: string, workspaceApp?: WorkspaceAppId) {
    const host = hosts.find((h) => h.id === hostId)
    if (!host) return
    setSelectedHostId(hostId)
    const targetSessionId = placeholderId ?? `pending-${Date.now()}`
    const newTab: SessionTab = {
      sessionId: targetSessionId,
      hostId: host.id,
      connectionKind: 'host',
      connectionStage: 'resolve_host',
      hostName: host.name,
      hostAddress: host.address,
      status: 'connecting',
      errorMessage: undefined,
      mode: workspaceApp ? 'workspace' : 'terminal',
      workspaceApp: workspaceApp ?? 'overview',
    }
    if (placeholderId) {
      setPcSessionTabs((prev) => prev.map((tab) => (
        tab.sessionId === placeholderId ? { ...tab, ...newTab } : tab
      )))
    } else {
      setPcSessionTabs((prev) => [...prev, newTab])
    }
    setPcActiveSessionId(targetSessionId)
    try {
      const resolvedSecret = undefined
      const session = await connectWithHostKeyPrompt({
        vaultId: activeVaultId, hostId: host.id, host: host.address, port: host.port || 22,
        username: host.username || defaultUsername, authType: host.authType,
        password: host.authType === 'password' ? resolvedSecret : undefined,
        privateKey: host.authType === 'privateKey' ? resolvedSecret : undefined,
        keepAliveIntervalSecs,
        jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser,
      })
      setInteractiveSessions((prev) => [...prev, session])
      setLeftPaneSessionId(session.sessionId)
      appendPaneEvent('left', 'info', `Connected: ${host.username || defaultUsername}@${host.address}`, session.sessionId)
      initializeInteractiveSessionState(session.sessionId, { hostId: host.id, connectionKind: 'host' })
      if (workspaceApp) setWorkspaceBySession((previous) => setSessionWorkspaceAppState(setSessionWorkspaceModeState(previous, session.sessionId, 'workspace'), session.sessionId, workspaceApp))
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === targetSessionId ? {
        ...t,
        sessionId: session.sessionId,
        hostId: host.id,
        connectionKind: 'host',
        connectionStage: undefined,
        status: 'connected',
        errorMessage: undefined,
        mode: workspaceApp ? 'workspace' : 'terminal',
        workspaceApp: workspaceApp ?? 'overview',
      } : t))
      setWorkspaceAuthBySession((prev) => ({ ...prev, [session.sessionId]: resolvedSecret ?? '' }))
      setPcActiveSessionId(session.sessionId)
      await refreshInteractiveSessions()
      void appendActivity({
        event: 'connect', hostId: host.id, hostName: host.name, hostAddress: host.address,
        username: host.username || defaultUsername, authType: host.authType,
      })
    } catch (error) {
      const msg = String(error instanceof Error ? error.message : error)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === targetSessionId ? { ...t, status: 'error', errorMessage: msg, connectionStage: undefined } : t))
      const emitter = pcChunkEmitterRef.current[targetSessionId]
      if (emitter) {
        emitter([{ seq: 0, stream: 'stderr', data: `\r\n\x1b[1;31m✖ Connection failed:\x1b[0m ${msg}\r\n\r\n\x1b[90mClose this tab and try again after resolving the issue.\x1b[0m\r\n`, timestamp: Date.now() }])
      }
      appendPaneEvent('left', 'error', `Connection failed: ${msg}`, null)
      void appendActivity({
        event: 'auth_fail', hostId: host.id, hostName: host.name, hostAddress: host.address,
        username: host.username || defaultUsername, authType: host.authType, detail: msg,
      })
    }
  }

  async function handleConnectHost(hostId: string) {
    await openHostConnection(hostId)
  }

  async function openHostWorkspace(hostId: string, app: WorkspaceAppId) {
    const host = hosts.find((profile) => profile.id === hostId)
    if (!host) return
    const existing = interactiveSessionsRef.current.find((session) => session.hostId === hostId && session.vaultId === activeVaultId && session.status === 'running')
    if (!existing) { await openHostConnection(hostId, undefined, app); return }
    setPcSessionTabs((previous) => previous.some((tab) => tab.sessionId === existing.sessionId) ? previous : [...previous, {
      sessionId: existing.sessionId,
      hostId,
      connectionKind: 'host',
      hostName: host.name,
      hostAddress: host.address,
      status: 'connected',
      mode: 'workspace',
      workspaceApp: app,
    }])
    setSelectedHostId(hostId)
    setPcActiveSessionId(existing.sessionId)
    if (rightPaneSessionIdRef.current === existing.sessionId) setRightPaneSessionId(null)
    setLeftPaneSessionId(existing.sessionId)
    setSessionMode(existing.sessionId, 'workspace')
    setSessionWorkspaceApp(existing.sessionId, app)
  }

  async function openLocalConnection(placeholderId?: string) {
    const targetSessionId = placeholderId ?? `pending-${Date.now()}`
    const newTab: SessionTab = {
      sessionId: targetSessionId,
      connectionKind: 'local',
      connectionStage: 'detect_shell',
      hostName: t('common.local'),
      hostAddress: 'local',
      status: 'connecting',
      errorMessage: undefined,
      mode: 'terminal',
      workspaceApp: 'overview',
    }
    if (placeholderId) {
      setPcSessionTabs((prev) => prev.map((tab) => (
        tab.sessionId === placeholderId ? { ...tab, ...newTab } : tab
      )))
    } else {
      setPcSessionTabs((prev) => [...prev, newTab])
    }
    setPcActiveSessionId(targetSessionId)
    try {
      const session = await createLocalTerminal()
      setInteractiveSessions((prev) => [...prev, session])
      setLeftPaneSessionId(session.sessionId)
      initializeInteractiveSessionState(session.sessionId, { connectionKind: 'local' })
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === targetSessionId ? {
        ...t,
        sessionId: session.sessionId,
        connectionKind: 'local',
        connectionStage: undefined,
        status: 'connected',
        errorMessage: undefined,
        mode: 'terminal',
        workspaceApp: 'overview',
      } : t))
      setPcActiveSessionId(session.sessionId)
      await refreshInteractiveSessions()
      void appendActivity({ event: 'local_terminal', hostName: t('common.local'), hostAddress: 'local' })
    } catch (error) {
      const msg = String(error instanceof Error ? error.message : error)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === targetSessionId ? { ...t, status: 'error', errorMessage: msg, connectionStage: undefined } : t))
      appendPaneEvent('left', 'error', `Local terminal failed: ${msg}`, null)
    }
  }

  async function handleOpenLocalTerminal() {
    await openLocalConnection()
  }

  function retrySessionConnection(sessionId: string) {
    const tab = pcSessionTabsRef.current.find((entry) => entry.sessionId === sessionId)
    if (!tab) return
    if (tab.connectionKind === 'local' || tab.hostAddress === 'local') {
      void openLocalConnection(sessionId)
      return
    }
    if (tab.hostId) {
      void openHostConnection(tab.hostId, sessionId)
    }
  }

  function handleCloseSessionTab(sessionId: string) {
    flushRaw(sessionId)
    const wasActive = pcActiveSessionId === sessionId
    const wasRightPane = rightPaneSessionIdRef.current === sessionId
    const remainingTabs = pcSessionTabsRef.current.filter((t) => t.sessionId !== sessionId)
    const nextActiveSessionId = wasActive
      ? (wasRightPane
        ? remainingTabs[0]?.sessionId ?? null
        : rightPaneSessionIdRef.current && rightPaneSessionIdRef.current !== sessionId
          ? rightPaneSessionIdRef.current
          : remainingTabs[0]?.sessionId ?? null)
      : pcActiveSessionId

    closeManagedBrowserWindows(sessionId, browserBySessionRef.current[sessionId])
    stopManagedBrowserPortForwards(sessionId, browserBySessionRef.current[sessionId])
    void stopBrowserHttpProxy(sessionId).catch(() => {})
    void stopBrowserSocksProxy(sessionId).catch(() => {})
    clearManagedBrowserRuntime(sessionId)
    setPcSessionTabs((prev) => prev.filter((t) => t.sessionId !== sessionId))
    setWorkspaceBySession((prev) => removeSessionWorkspaceState(prev, sessionId))
    setBrowserBySession((prev) => removeSessionBrowserState(prev, sessionId))
    setWorkspaceAuthBySession((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (wasRightPane || rightPaneSessionIdRef.current === nextActiveSessionId) {
      setRightPaneSessionId(null)
    }
    if (wasActive) setPcActiveSessionId(nextActiveSessionId)
    const session = interactiveSessions.find((s) => s.sessionId === sessionId)
    if (session) void closeInteractiveSession(sessionId).then(() => refreshInteractiveSessions())
  }

  const sendRaw = useCallback((sessionId: string, data: string) => {
    if (!data || sessionId.startsWith('pending-')) return

    sendRawBufferRef.current[sessionId] = (sendRawBufferRef.current[sessionId] ?? '') + data
    const shouldFlushImmediately = data.length > 1 || [3, 4, 9, 10, 13, 27].includes(data.charCodeAt(0))

    if (shouldFlushImmediately) {
      flushRaw(sessionId)
      return
    }

    if (sendRawTimerRef.current[sessionId]) return
    sendRawTimerRef.current[sessionId] = setTimeout(() => {
      flushRaw(sessionId)
    }, INPUT_BATCH_DELAY_MS)
  }, [flushRaw])

  return (
    <SessionsContext.Provider value={{
      interactiveSessions, interactiveChunksBySession, pcSessionTabs, workspaceBySession, browserBySession, workspaceAuthBySession, pcActiveSessionId,
      setPcActiveSessionId, setSessionMode, setSessionWorkspaceApp,
      openSessionBrowserUrl, openSessionBrowserHtml, openSessionBrowserMarkdown,
      createSessionBrowserTab, duplicateSessionBrowserTab, activateSessionBrowserTab, closeSessionBrowserTab, closeOtherSessionBrowserTabs, closeSessionBrowserTabsToRight,
      restoreLastClosedSessionBrowserTab, toggleSessionBrowserTabPinned, reorderSessionBrowserTab,
      setSessionBrowserPresentation, setSessionBrowserRouteMode, setSessionBrowserAddressInput, submitSessionBrowserAddress,
      reloadSessionBrowser, goSessionBrowserBack, goSessionBrowserForward,
      syncSessionBrowserUrl, setSessionBrowserLoading, setSessionBrowserError, setSessionBrowserNavigation, closeSessionBrowser, rebuildSessionBrowserTransport,
      pcChunkEmitterRef, leftPaneSessionId, setLeftPaneSessionId,
      rightPaneSessionId, setRightPaneSessionId,
      handleConnectHost, openHostWorkspace, handleOpenLocalTerminal, handleCloseSessionTab, sendRaw, refreshInteractiveSessions,
      initializeInteractiveSessionState, cleanupClosedSession,
      interactiveInputBySession, setInteractiveInputBySession,
      interactiveHistoryBySession, setInteractiveHistoryBySession,
      interactiveHistoryCursorBySession, setInteractiveHistoryCursorBySession,
      setInteractiveChunksBySession, setInteractiveSessions, interactiveSessionsRef,
      reconnectSettings, setReconnectSettings, paneEvents, setPaneEvents, appendPaneEvent,
      leftPaneSessionIdRef, rightPaneSessionIdRef, closedSessionCleanupRef,
      pendingHostKey, acceptPendingHostKey, rejectPendingHostKey,
      reconnectingSessionIds, manualReconnect, retrySessionConnection,
    }}>
      {children}
    </SessionsContext.Provider>
  )
}
