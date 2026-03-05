import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  closeInteractiveSession,
  createInteractiveSession,
  createLocalTerminal,
  listInteractiveSessions,
  pollInteractiveOutput,
  sendInteractiveInput,
  type InteractiveOutputChunk,
  type InteractiveSessionInfo,
} from '@/lib/interactive-session'
import type { SessionTab, ReconnectSettings, PaneId, PaneEvent } from '@/lib/types'
import { t } from '@/lib/i18n'
import { appendActivity } from '@/lib/activity-log'
import { useVault } from './vault-context'
import { useHosts } from './hosts-context'
import { parseHostKeyError, type HostKeyInfo } from '@/components/host-key-confirm-dialog'

const INTERACTIVE_OUTPUT_MAX_CHUNKS = 500
const ACTIVE_INTERACTIVE_SESSION_KEY = 'shellbeam.activeInteractiveSessionId'
const LEFT_INTERACTIVE_SESSION_KEY = 'shellbeam.leftInteractiveSessionId'
const RIGHT_INTERACTIVE_SESSION_KEY = 'shellbeam.rightInteractiveSessionId'
const RECONNECT_SETTINGS_KEY = 'shellbeam.reconnectSettings'

interface SessionsContextValue {
  interactiveSessions: InteractiveSessionInfo[]
  interactiveChunksBySession: Record<string, InteractiveOutputChunk[]>
  pcSessionTabs: SessionTab[]
  pcActiveSessionId: string | null
  setPcActiveSessionId: (id: string | null) => void
  pcChunkEmitterRef: React.MutableRefObject<Record<string, (chunks: InteractiveOutputChunk[]) => void>>
  leftPaneSessionId: string | null
  setLeftPaneSessionId: (id: string | null) => void
  rightPaneSessionId: string | null
  setRightPaneSessionId: (id: string | null) => void
  handleConnectHost: (hostId: string) => Promise<void>
  handleOpenLocalTerminal: () => Promise<void>
  handleCloseSessionTab: (sessionId: string) => void
  sendRaw: (sessionId: string, data: string) => void
  refreshInteractiveSessions: () => Promise<void>
  initializeInteractiveSessionState: (sessionId: string) => void
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
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

export function useSessions() {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used within SessionsProvider')
  return ctx
}

export function SessionsProvider({ children, setOutput: _setOutput }: { children: ReactNode; setOutput: (msg: string) => void }) {
  const { resolveAuthSecret } = useVault()
  const { hosts, defaultUsername, keepAliveIntervalSecs, setSelectedHostId } = useHosts()

  const [interactiveSessions, setInteractiveSessions] = useState<InteractiveSessionInfo[]>([])
  const [interactiveChunksBySession, setInteractiveChunksBySession] = useState<Record<string, InteractiveOutputChunk[]>>({})
  const interactiveNextSeqRef = useRef<Record<string, number>>({})
  const [interactiveInputBySession, setInteractiveInputBySession] = useState<Record<string, string>>({})
  const [interactiveHistoryBySession, setInteractiveHistoryBySession] = useState<Record<string, string[]>>({})
  const [interactiveHistoryCursorBySession, setInteractiveHistoryCursorBySession] = useState<Record<string, number | null>>({})

  const [pcSessionTabs, setPcSessionTabs] = useState<SessionTab[]>([])
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
  const leftPaneSessionIdRef = useRef<string | null>(null)
  const rightPaneSessionIdRef = useRef<string | null>(null)
  const reconnectingRef = useRef<Set<string>>(new Set())
  const reconnectSettingsRef = useRef(reconnectSettings)

  useEffect(() => { reconnectSettingsRef.current = reconnectSettings }, [reconnectSettings])
  useEffect(() => { interactiveSessionsRef.current = interactiveSessions }, [interactiveSessions])
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

  async function connectWithHostKeyPrompt(params: Parameters<typeof createInteractiveSession>[0]): Promise<ReturnType<typeof createInteractiveSession>> {
    try {
      return await createInteractiveSession(params)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const hkInfo = parseHostKeyError(msg)
      if (hkInfo && hkInfo.code === 'host_key_unknown') {
        const accepted = await new Promise<boolean>((resolve) => {
          pendingHostKeyResolveRef.current = resolve
          setPendingHostKey(hkInfo)
        })
        if (accepted) {
          return await createInteractiveSession({ ...params, acceptHostKey: true })
        }
        throw new Error('Connection cancelled: host key not accepted')
      }
      throw error
    }
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
    setPcSessionTabs((prev) => prev.map((t) => t.sessionId === sessionId ? { ...t, status: 'reconnecting' } : t))
    for (let attempt = 1; attempt <= rs.maxRetries; attempt++) {
      await new Promise<void>((r) => window.setTimeout(r, rs.intervalMs))
      const host = hosts.find((h) => h.id === hostId)
      if (!host) break
      try {
        const secret = await resolveAuthSecret({ authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault' })
        const newSession = await createInteractiveSession({
          hostId: host.id, host: host.address, port: host.port || 22,
          username: host.username || defaultUsername, authType: host.authType,
          password: host.authType === 'password' ? secret : undefined,
          privateKey: host.authType === 'privateKey' ? secret : undefined,
          keepAliveIntervalSecs,
          jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser,
          acceptHostKey: true,
        })
        setInteractiveSessions((prev) => [...prev, newSession])
        initializeInteractiveSessionState(newSession.sessionId)
        if (pane === 'left') setLeftPaneSessionId(newSession.sessionId)
        else setRightPaneSessionId(newSession.sessionId)
        setPcSessionTabs((prev) => prev.map((t) =>
          t.sessionId === sessionId ? { ...t, sessionId: newSession.sessionId, status: 'connected' } : t,
        ))
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

  function initializeInteractiveSessionState(sessionId: string) {
    setInteractiveChunksBySession((prev) => ({ ...prev, [sessionId]: [] }))
    interactiveNextSeqRef.current[sessionId] = 0
    setInteractiveInputBySession((prev) => ({ ...prev, [sessionId]: '' }))
    setInteractiveHistoryBySession((prev) => ({ ...prev, [sessionId]: [] }))
    setInteractiveHistoryCursorBySession((prev) => ({ ...prev, [sessionId]: null }))
  }

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
      for (const session of interactiveSessionsRef.current) {
        void closeInteractiveSession(session.sessionId)
      }
    }
  }, [])

  // Polling
  const allPolledSessionIds = useMemo(() => {
    const ids = new Set<string>()
    if (leftPaneSessionId) ids.add(leftPaneSessionId)
    if (rightPaneSessionId) ids.add(rightPaneSessionId)
    for (const tab of pcSessionTabs) {
      if (tab.sessionId && !tab.sessionId.startsWith('pending-')) ids.add(tab.sessionId)
    }
    return Array.from(ids)
  }, [leftPaneSessionId, rightPaneSessionId, pcSessionTabs])

  const pollSessionRef = useRef<(sessionId: string) => Promise<void>>(async () => {})

  useEffect(() => {
    pollSessionRef.current = async (sessionId: string) => {
      try {
        const response = await pollInteractiveOutput(sessionId, interactiveNextSeqRef.current[sessionId] ?? 0)
        interactiveNextSeqRef.current[sessionId] = response.nextSeq
        if (response.chunks.length > 0) {
          consecutiveEmptyRef.current = 0
          pollIntervalRef.current = 30
          const emitter = pcChunkEmitterRef.current[sessionId]
          if (emitter) {
            emitter(response.chunks)
          } else {
            setInteractiveChunksBySession((prev) => ({
              ...prev,
              [sessionId]: [...(prev[sessionId] ?? []), ...response.chunks].slice(-INTERACTIVE_OUTPUT_MAX_CHUNKS),
            }))
          }
        } else {
          consecutiveEmptyRef.current++
          if (consecutiveEmptyRef.current > 10) pollIntervalRef.current = Math.min(500, pollIntervalRef.current + 50)
          else if (consecutiveEmptyRef.current > 3) pollIntervalRef.current = Math.min(200, pollIntervalRef.current + 20)
        }
        if (sessionStatusCacheRef.current[sessionId] !== response.status) {
          sessionStatusCacheRef.current[sessionId] = response.status
          setInteractiveSessions((prev) =>
            prev.map((s) => (s.sessionId === sessionId ? { ...s, status: response.status } : s)),
          )
        }
        if (response.status.startsWith('closed') && !closedSessionCleanupRef.current.has(sessionId)) {
          closedSessionCleanupRef.current.add(sessionId)
          const pane = paneForSession(sessionId)
          const info = interactiveSessionsRef.current.find((s) => s.sessionId === sessionId)
          const tab = pcSessionTabs.find((t) => t.sessionId === sessionId)
          const rs = reconnectSettingsRef.current
          setPcSessionTabs((prev) => prev.map((t) => t.sessionId === sessionId ? { ...t, status: 'closed' } : t))
          if (tab && tab.hostAddress !== 'local') {
            void appendActivity({
              event: 'disconnect', hostId: info?.hostId ?? undefined,
              hostName: tab.hostName, hostAddress: tab.hostAddress,
              username: info?.username ?? undefined,
            })
          }
          if (pane && rs.enabled && rs.maxRetries > 0 && info?.hostId && !reconnectingRef.current.has(sessionId)) {
            reconnectingRef.current.add(sessionId)
            setReconnectingSessionIds((prev) => new Set(prev).add(sessionId))
            appendPaneEvent(pane, 'warn', 'Session disconnected. Reconnecting...', sessionId)
            void attemptReconnect(sessionId, info.hostId, pane, rs)
          }
        }
      } catch { /* resilient */ }
    }
  })

  const pollIntervalRef = useRef(50)
  const consecutiveEmptyRef = useRef(0)

  useEffect(() => {
    if (allPolledSessionIds.length === 0) return
    let timer: ReturnType<typeof setTimeout>
    const poll = () => {
      void Promise.all(allPolledSessionIds.map((sid) => pollSessionRef.current(sid))).then(() => {
        timer = window.setTimeout(poll, pollIntervalRef.current)
      })
    }
    timer = window.setTimeout(poll, pollIntervalRef.current)
    return () => window.clearTimeout(timer)
  }, [allPolledSessionIds])

  async function cleanupClosedSession(sessionId: string) {
    try { await closeInteractiveSession(sessionId) } catch { /* may already be removed */ } finally {
      closedSessionCleanupRef.current.delete(sessionId)
      setInteractiveSessions((prev) => prev.filter((s) => s.sessionId !== sessionId))
      setInteractiveChunksBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      delete interactiveNextSeqRef.current[sessionId]
      setInteractiveInputBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setInteractiveHistoryBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setInteractiveHistoryCursorBySession((prev) => { const n = { ...prev }; delete n[sessionId]; return n })
      setLeftPaneSessionId((prev) => {
        if (prev !== sessionId) return prev
        const rest = interactiveSessionsRef.current.filter((s) => s.sessionId !== sessionId)
        return rest[0]?.sessionId ?? null
      })
      setRightPaneSessionId((prev) => (prev === sessionId ? null : prev))
    }
  }

  async function handleConnectHost(hostId: string) {
    const host = hosts.find((h) => h.id === hostId)
    if (!host) return
    setSelectedHostId(hostId)
    const placeholderId = `pending-${Date.now()}`
    const newTab: SessionTab = { sessionId: placeholderId, hostName: host.name, hostAddress: host.address, status: 'connecting' }
    setPcSessionTabs((prev) => [...prev, newTab])
    setPcActiveSessionId(placeholderId)
    try {
      const resolvedSecret = await resolveAuthSecret({ authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault' })
      const session = await connectWithHostKeyPrompt({
        hostId: host.id, host: host.address, port: host.port || 22,
        username: host.username || defaultUsername, authType: host.authType,
        password: host.authType === 'password' ? resolvedSecret : undefined,
        privateKey: host.authType === 'privateKey' ? resolvedSecret : undefined,
        keepAliveIntervalSecs,
        jumpHost: host.jumpHost, jumpPort: host.jumpPort, jumpUser: host.jumpUser,
      })
      setInteractiveSessions((prev) => [...prev, session])
      setLeftPaneSessionId(session.sessionId)
      appendPaneEvent('left', 'info', `Connected: ${host.username || defaultUsername}@${host.address}`, session.sessionId)
      initializeInteractiveSessionState(session.sessionId)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === placeholderId ? { ...t, sessionId: session.sessionId, status: 'connected' } : t))
      setPcActiveSessionId(session.sessionId)
      await refreshInteractiveSessions()
      void appendActivity({
        event: 'connect', hostId: host.id, hostName: host.name, hostAddress: host.address,
        username: host.username || defaultUsername, authType: host.authType,
      })
    } catch (error) {
      const msg = String(error instanceof Error ? error.message : error)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === placeholderId ? { ...t, status: 'error' } : t))
      const emitter = pcChunkEmitterRef.current[placeholderId]
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

  async function handleOpenLocalTerminal() {
    const placeholderId = `pending-${Date.now()}`
    const newTab: SessionTab = { sessionId: placeholderId, hostName: t('common.local'), hostAddress: 'local', status: 'connecting' }
    setPcSessionTabs((prev) => [...prev, newTab])
    setPcActiveSessionId(placeholderId)
    try {
      const session = await createLocalTerminal()
      setInteractiveSessions((prev) => [...prev, session])
      setLeftPaneSessionId(session.sessionId)
      initializeInteractiveSessionState(session.sessionId)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === placeholderId ? { ...t, sessionId: session.sessionId, status: 'connected' } : t))
      setPcActiveSessionId(session.sessionId)
      await refreshInteractiveSessions()
      void appendActivity({ event: 'local_terminal', hostName: t('common.local'), hostAddress: 'local' })
    } catch (error) {
      const msg = String(error instanceof Error ? error.message : error)
      setPcSessionTabs((prev) => prev.map((t) => t.sessionId === placeholderId ? { ...t, status: 'error' } : t))
      appendPaneEvent('left', 'error', `Local terminal failed: ${msg}`, null)
    }
  }

  function handleCloseSessionTab(sessionId: string) {
    setPcSessionTabs((prev) => prev.filter((t) => t.sessionId !== sessionId))
    if (pcActiveSessionId === sessionId) setPcActiveSessionId(null)
    const session = interactiveSessions.find((s) => s.sessionId === sessionId)
    if (session) void closeInteractiveSession(sessionId).then(() => refreshInteractiveSessions())
  }

  const sendRaw = useCallback((sessionId: string, data: string) => {
    void sendInteractiveInput(sessionId, data).then(() => {
      setTimeout(() => { void pollSessionRef.current(sessionId) }, 10)
    })
  }, [])

  return (
    <SessionsContext.Provider value={{
      interactiveSessions, interactiveChunksBySession, pcSessionTabs, pcActiveSessionId,
      setPcActiveSessionId, pcChunkEmitterRef, leftPaneSessionId, setLeftPaneSessionId,
      rightPaneSessionId, setRightPaneSessionId,
      handleConnectHost, handleOpenLocalTerminal, handleCloseSessionTab, sendRaw, refreshInteractiveSessions,
      initializeInteractiveSessionState, cleanupClosedSession,
      interactiveInputBySession, setInteractiveInputBySession,
      interactiveHistoryBySession, setInteractiveHistoryBySession,
      interactiveHistoryCursorBySession, setInteractiveHistoryCursorBySession,
      setInteractiveChunksBySession, setInteractiveSessions, interactiveSessionsRef,
      reconnectSettings, setReconnectSettings, paneEvents, setPaneEvents, appendPaneEvent,
      leftPaneSessionIdRef, rightPaneSessionIdRef, closedSessionCleanupRef,
      pendingHostKey, acceptPendingHostKey, rejectPendingHostKey,
      reconnectingSessionIds, manualReconnect,
    }}>
      {children}
    </SessionsContext.Provider>
  )
}
