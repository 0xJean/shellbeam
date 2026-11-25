import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AICliBackend, AICliProfile, AIRequestMode, AIStreamCallbacks } from './ai'
import type { AIHistoryItem } from './ai-conversation'
import type { PeerBridgePermissions, PeerRoute, SyncTrustedPeer } from './sync'
import type { Locale } from './i18n'
import { companionCopy } from './locales/companion'
import { fill } from './locales/probe-install'
import { toInvokeErrorMessage } from './invoke-error'

export interface DescribedCompanionError {
  message: string
  needsRepair: boolean
}

/** Map raw Rust / transport companion errors into localized, actionable copy. */
export function describeCompanionError(error: unknown, locale: Locale = 'zh-CN'): DescribedCompanionError {
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const rawStr = error instanceof Error ? error.message : String(error ?? '')
  const cleaned = rawStr.replace(/^Error:\s*/i, '').replace(/^Operation failed:\s*/i, '').trim()
  const lower = cleaned.toLowerCase()

  if (
    lower.includes('older pairing') ||
    lower.includes('not paired') ||
    lower.includes('pair them again') ||
    lower.includes('repair_required')
  ) {
    return { message: copy.errRepairRequired, needsRepair: true }
  }
  if (lower.includes('trusted desktop peer not found') || lower.includes('trusted peer not found')) {
    return { message: copy.errPeerNotFound, needsRepair: true }
  }
  if (lower.includes('no routes configured')) {
    return { message: copy.errNoRoutes, needsRepair: true }
  }
  if (lower.includes('bridge is disabled on desktop')) {
    return { message: copy.errBridgeDisabled, needsRepair: false }
  }
  if (lower.includes('identity mismatch')) {
    return { message: copy.errIdentityMismatch, needsRepair: true }
  }
  if (lower.includes('permission') || lower.includes('disabled by desktop') || lower.includes('read-only')) {
    return { message: copy.errPermissionDenied, needsRepair: false }
  }
  if (lower.includes('not connected to a desktop') || lower.includes('connection closed')) {
    return { message: copy.errDisconnected, needsRepair: false }
  }
  const endpointMatch = cleaned.match(/(\d{1,3}(?:\.\d{1,3}){3}:\d+|[a-zA-Z0-9._-]+\.ts\.net:\d+)/)
  const endpointSuffix = endpointMatch ? ` (${endpointMatch[1]})` : ''

  if (lower.includes('connection refused') || lower.includes('os error 61') || lower.includes('os error 111')) {
    return { message: `${copy.errConnectionRefused}${endpointSuffix}`, needsRepair: false }
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return { message: `${copy.errTimeout}${endpointSuffix}`, needsRepair: true }
  }
  if (
    lower.includes('network is unreachable') ||
    lower.includes('no route to host') ||
    lower.includes('resolve ') ||
    lower.includes('no addresses resolved')
  ) {
    return { message: `${copy.errUnreachable}${endpointSuffix}`, needsRepair: true }
  }
  return {
    message: fill(copy.errUnknown, { detail: cleaned || 'unknown' }),
    needsRepair: false,
  }
}

export function formatCompanionError(error: unknown, locale: Locale = 'zh-CN'): string {
  return describeCompanionError(error, locale).message
}

export function resolveDesktopSessionTitle(
  session: RemoteDesktopSessionInfo,
  aiSnap: DesktopAiSessionSnapshot | null | undefined,
  hosts: Array<{ id: string; name: string; address: string }>,
  localShellLabel: string,
): { title: string; subtitle: string } {
  if (session.host === 'local' || session.host === 'localhost') {
    return { title: localShellLabel, subtitle: session.username || 'shell' }
  }
  const matchedHost = hosts.find(
    (h) => (session.hostId && h.id === session.hostId) || h.address === session.host,
  )
  const aiLabel = aiSnap?.hostLabel && aiSnap.hostLabel !== session.sessionId
    ? aiSnap.hostLabel
    : undefined
  const title = matchedHost?.name || aiLabel || `${session.username}@${session.host}`
  const subtitle = `${session.username}@${session.host}`
  return { title, subtitle }
}

export function localizeSessionStatus(
  status: string,
  copy: { sessionStatusRunning: string; sessionStatusConnecting: string; sessionStatusClosed: string },
): { label: string; live: boolean } {
  const lower = status.toLowerCase()
  if (lower === 'running' || lower === 'connected') {
    return { label: copy.sessionStatusRunning, live: true }
  }
  if (lower === 'connecting' || lower === 'reconnecting') {
    return { label: copy.sessionStatusConnecting, live: true }
  }
  return { label: copy.sessionStatusClosed, live: false }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export interface CliBackendInfo {
  backend: AICliBackend | string
  available: boolean
  executable?: string
}

export interface ConnectedCompanionClient {
  connId: string
  peerDeviceId: string
  peerDeviceName: string
  remoteAddr: string
  connectedAt: number
}

export interface CompanionConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  peerDeviceId?: string | null
  peerDeviceName?: string | null
  routeKind?: 'lan' | 'tailnet' | 'custom' | string | null
  routeEndpoint?: string | null
  desktopOs?: string | null
  appVersion?: string | null
  permissions?: PeerBridgePermissions | null
  cliBackends: CliBackendInfo[]
  error?: string | null
  connectedAt?: number | null
}

export interface RemoteAiMessage {
  id: string
  role: 'user' | 'assistant' | 'output' | 'status' | string
  content: string
  timestamp: number
  command?: string | null
  risk?: string | null
  executed: boolean
}

export interface DesktopAiSessionSnapshot {
  sessionId: string
  hostLabel: string
  mode: string
  modelLabel: string
  isStreaming: boolean
  streamingText: string
  stepLabel: string
  pendingCommand?: string | null
  pendingRisk?: string | null
  pendingMessageId?: string | null
  messages: RemoteAiMessage[]
  updatedAt: number
}

export interface CompanionAiActionEvent {
  sessionId: string
  action: 'run_pending' | 'cancel' | 'send_prompt' | 'set_mode'
  prompt?: string | null
  messageId?: string | null
  mode?: string | null
  peerDeviceId: string
}

export interface RemoteDesktopSessionInfo {
  sessionId: string
  hostId?: string | null
  host: string
  username: string
  port?: number | null
  createdAt: number
  lastActiveAt: number
  status: string
}

export interface RemoteTerminalChunk {
  seq: number
  stream: string
  data: string
  timestamp: number
}

export type RemoteTerminalEvent =
  | { kind: 'chunk'; sessionId: string; chunk: RemoteTerminalChunk }
  | { kind: 'status'; sessionId: string; status: string }

export interface ParsedPairingLink {
  hosts: string[]
  port: number
  deviceName?: string
  irohId?: string
  relayUrl?: string
}

export const EMPTY_COMPANION_STATUS: CompanionConnectionStatus = {
  state: 'disconnected',
  cliBackends: [],
}

export const COMPANION_OPEN_EVENT = 'shellbeam:open-companion'
export const COMPANION_OPEN_SCANNER_EVENT = 'shellbeam:open-companion-scanner'

let pendingMobileQrScan = false

export function requestMobileQrScan() {
  pendingMobileQrScan = true
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COMPANION_OPEN_SCANNER_EVENT))
  }
}

export function consumePendingMobileQrScan(): boolean {
  const value = pendingMobileQrScan
  pendingMobileQrScan = false
  return value
}

export function openCompanionCenter() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COMPANION_OPEN_EVENT))
  }
}

export interface CompanionServerSnapshot {
  enabled: boolean
  clients: ConnectedCompanionClient[]
}

export const EMPTY_COMPANION_SERVER: CompanionServerSnapshot = {
  enabled: true,
  clients: [],
}

let currentServer: CompanionServerSnapshot = EMPTY_COMPANION_SERVER
const serverListeners = new Set<() => void>()
let serverEventBound = false

function setServerSnapshot(next: CompanionServerSnapshot) {
  currentServer = next
  serverListeners.forEach((listener) => listener())
}

export function getCompanionServerSnapshot(): CompanionServerSnapshot {
  return currentServer
}

export function subscribeCompanionServer(listener: () => void): () => void {
  serverListeners.add(listener)
  if (!serverEventBound && isTauriRuntime()) {
    serverEventBound = true
    void invoke<CompanionServerSnapshot>('companion_server_status')
      .then((status) => setServerSnapshot(status))
      .catch(() => {})
    void listen<ConnectedCompanionClient[]>('companion:clients-changed', (event) => {
      setServerSnapshot({ ...currentServer, clients: event.payload ?? [] })
    }).catch(() => {})
  }
  return () => {
    serverListeners.delete(listener)
  }
}

export async function refreshCompanionServerStatus(): Promise<CompanionServerSnapshot> {
  const status = await companionServerStatus()
  setServerSnapshot(status)
  return status
}

// ── Shared reactive connection status store ──────────────────────────────────

let currentStatus: CompanionConnectionStatus = EMPTY_COMPANION_STATUS
const statusListeners = new Set<() => void>()
let statusEventBound = false

function setStatusSnapshot(next: CompanionConnectionStatus) {
  currentStatus = next
  statusListeners.forEach((listener) => listener())
}

export function getCompanionStatusSnapshot(): CompanionConnectionStatus {
  return currentStatus
}

export function subscribeCompanionStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  if (!statusEventBound && isTauriRuntime()) {
    statusEventBound = true
    void invoke<CompanionConnectionStatus>('companion_status')
      .then((status) => setStatusSnapshot(status))
      .catch(() => {})
    void listen<CompanionConnectionStatus>('companion:status', (event) => {
      setStatusSnapshot(event.payload)
    }).catch(() => {})
  }
  return () => {
    statusListeners.delete(listener)
  }
}

export function isRemoteCliBridgeAvailable(): boolean {
  return currentStatus.state === 'connected' && currentStatus.permissions?.allowAiCli !== false
}

// ── Shared live remote desktop workspace store (auto-pushed from desktop) ────

export interface CompanionRemoteWorkspaceState {
  sessions: RemoteDesktopSessionInfo[]
  aiBySession: Record<string, DesktopAiSessionSnapshot>
  activeSessionId: string | null
}

export const EMPTY_COMPANION_WORKSPACE: CompanionRemoteWorkspaceState = {
  sessions: [],
  aiBySession: {},
  activeSessionId: null,
}

let currentWorkspace: CompanionRemoteWorkspaceState = EMPTY_COMPANION_WORKSPACE
const workspaceListeners = new Set<() => void>()
let workspaceEventsBound = false
let lastLoadedConnectedAt: number | null = null

function setWorkspaceState(next: CompanionRemoteWorkspaceState) {
  currentWorkspace = next
  workspaceListeners.forEach((listener) => listener())
}

async function hydrateRemoteWorkspace() {
  if (!isTauriRuntime() || currentStatus.state !== 'connected') return
  try {
    const [res, aiList] = await Promise.all([
      companionRemoteListSessions().catch(() => null),
      companionRemoteSubscribeAi().catch(() => null),
    ])
    if (currentStatus.state !== 'connected') return
    const nextAi: Record<string, DesktopAiSessionSnapshot> = { ...currentWorkspace.aiBySession }
    for (const snap of res?.aiSessions ?? []) nextAi[snap.sessionId] = snap
    for (const snap of aiList ?? []) nextAi[snap.sessionId] = snap
    const nextSessions = res?.sessions ?? currentWorkspace.sessions
    setWorkspaceState({
      ...currentWorkspace,
      sessions: nextSessions,
      aiBySession: nextAi,
    })
  } catch {
    // Keep existing snapshot on transient RPC failure.
  }
}

function syncWorkspaceWithStatus(status: CompanionConnectionStatus) {
  if (status.state !== 'connected') {
    lastLoadedConnectedAt = null
    if (
      currentWorkspace.sessions.length > 0 ||
      Object.keys(currentWorkspace.aiBySession).length > 0 ||
      currentWorkspace.activeSessionId !== null
    ) {
      setWorkspaceState(EMPTY_COMPANION_WORKSPACE)
    }
    return
  }
  const stamp = status.connectedAt ?? Date.now()
  if (lastLoadedConnectedAt !== stamp) {
    lastLoadedConnectedAt = stamp
    void hydrateRemoteWorkspace()
  }
}

export function getCompanionWorkspaceSnapshot(): CompanionRemoteWorkspaceState {
  return currentWorkspace
}

export function openRemoteDesktopSession(sessionId: string) {
  setWorkspaceState({ ...currentWorkspace, activeSessionId: sessionId })
}

export function closeRemoteDesktopSession() {
  if (currentWorkspace.activeSessionId !== null) {
    setWorkspaceState({ ...currentWorkspace, activeSessionId: null })
  }
}

export function subscribeCompanionWorkspace(listener: () => void): () => void {
  workspaceListeners.add(listener)
  // Ensure status store is also subscribed so we react to connect/disconnect transitions.
  const unsubStatus = subscribeCompanionStatus(() => {
    syncWorkspaceWithStatus(currentStatus)
  })
  if (!workspaceEventsBound && isTauriRuntime()) {
    workspaceEventsBound = true
    void listen<RemoteDesktopSessionInfo[]>('companion:sessions', (event) => {
      const nextSessions = Array.isArray(event.payload) ? event.payload : []
      const stillOpen = currentWorkspace.activeSessionId
        ? nextSessions.some((s) => s.sessionId === currentWorkspace.activeSessionId)
        : false
      setWorkspaceState({
        ...currentWorkspace,
        sessions: nextSessions,
        activeSessionId: stillOpen ? currentWorkspace.activeSessionId : currentWorkspace.activeSessionId,
      })
    }).catch(() => {})
    void listen<DesktopAiSessionSnapshot>('companion:ai-state', (event) => {
      const snap = event.payload
      if (!snap?.sessionId) return
      setWorkspaceState({
        ...currentWorkspace,
        aiBySession: { ...currentWorkspace.aiBySession, [snap.sessionId]: snap },
      })
    }).catch(() => {})
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && currentStatus.state === 'connected') {
          void hydrateRemoteWorkspace()
        }
      })
    }
  }
  syncWorkspaceWithStatus(currentStatus)
  return () => {
    workspaceListeners.delete(listener)
    unsubStatus()
  }
}

// ── Pairing QR payload builder & parser (zero secrets in QR!) ───────────────

export function buildPairingQrPayload(params: {
  routes: PeerRoute[]
  port: number
  deviceName?: string
}): string {
  const ipRoutes = params.routes.filter((r) => r.kind !== 'iroh')
  const irohRoute = params.routes.find((r) => r.kind === 'iroh')
  const hosts = Array.from(new Set(ipRoutes.map((r) => r.host.trim()).filter(Boolean)))
  const query = new URLSearchParams()
  if (hosts.length > 0) query.set('hosts', hosts.join(','))
  query.set('port', String(params.port || 9123))
  if (irohRoute?.host.trim()) {
    query.set('iroh', irohRoute.host.trim())
    if (irohRoute.label?.trim()) {
      query.set('relay', irohRoute.label.trim())
    }
  }
  if (params.deviceName?.trim()) query.set('name', params.deviceName.trim())
  return `shellbeam://pair?${query.toString()}`
}

export function parsePairingQrPayload(raw: string): ParsedPairingLink | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.toLowerCase().startsWith('shellbeam://')) {
    try {
      const url = new URL(trimmed)
      const hostsParam = url.searchParams.get('hosts') ?? url.searchParams.get('host') ?? ''
      const hosts = hostsParam
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
      const portRaw = Number(url.searchParams.get('port') ?? '9123')
      const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : 9123
      const deviceName = url.searchParams.get('name')?.trim() || undefined
      const irohId = url.searchParams.get('iroh')?.trim() || undefined
      const relayUrl = url.searchParams.get('relay')?.trim() || undefined
      if (hosts.length === 0 && !irohId) return null
      return {
        hosts,
        port,
        ...(deviceName ? { deviceName } : {}),
        ...(irohId ? { irohId } : {}),
        ...(relayUrl ? { relayUrl } : {}),
      }
    } catch {
      return null
    }
  }

  if (trimmed.toLowerCase().startsWith('iroh://')) {
    const rest = trimmed.slice('iroh://'.length)
    const [idPart, queryPart] = rest.split('?')
    const irohId = idPart?.replace(/\/$/, '').trim()
    if (irohId && /^[0-9a-fA-F]{64}$/.test(irohId)) {
      const relayUrl = queryPart ? new URLSearchParams(queryPart).get('relay')?.trim() || undefined : undefined
      return { hosts: [], port: 1, irohId, ...(relayUrl ? { relayUrl } : {}) }
    }
    return null
  }

  // Fallback: accept raw `host:port` or bare IP / Tailscale MagicDNS hostname.
  const ipv6Match = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed)
  if (ipv6Match) {
    const port = Number(ipv6Match[2])
    if (port > 0 && port <= 65535) return { hosts: [ipv6Match[1]], port }
    return null
  }
  const colonIdx = trimmed.lastIndexOf(':')
  if (colonIdx > 0 && trimmed.indexOf(':') === colonIdx) {
    const host = trimmed.slice(0, colonIdx).trim()
    const port = Number(trimmed.slice(colonIdx + 1).trim())
    if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
      return { hosts: [host], port }
    }
  }
  if (/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return { hosts: [trimmed], port: 9123 }
  }
  return null
}

// ── Tauri command wrappers ──────────────────────────────────────────────────

export async function companionLocalEndpoints(): Promise<PeerRoute[]> {
  if (!isTauriRuntime()) return []
  try {
    return await invoke<PeerRoute[]>('companion_local_endpoints')
  } catch {
    return []
  }
}

export async function companionSetPeerPermissions(
  peerDeviceId: string,
  permissions: PeerBridgePermissions,
): Promise<SyncTrustedPeer> {
  try {
    return await invoke<SyncTrustedPeer>('companion_set_peer_permissions', {
      payload: { peerDeviceId, permissions },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function companionAddPeerRoute(payload: {
  peerDeviceId: string
  host: string
  port: number
  kind?: string
  label?: string
}): Promise<SyncTrustedPeer> {
  try {
    return await invoke<SyncTrustedPeer>('companion_add_peer_route', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function companionLocalCliBackends(): Promise<CliBackendInfo[]> {
  if (!isTauriRuntime()) return []
  try {
    return await invoke<CliBackendInfo[]>('companion_local_cli_backends')
  } catch {
    return []
  }
}

export async function companionServerStatus(): Promise<{
  enabled: boolean
  clients: ConnectedCompanionClient[]
}> {
  if (!isTauriRuntime()) return { enabled: false, clients: [] }
  try {
    const status = await invoke<{ enabled: boolean; clients: ConnectedCompanionClient[] }>('companion_server_status')
    setServerSnapshot(status)
    return status
  } catch {
    return { enabled: false, clients: [] }
  }
}

export async function companionSetServerEnabled(enabled: boolean): Promise<boolean> {
  const actual = await invoke<boolean>('companion_set_server_enabled', { enabled })
  setServerSnapshot({ ...currentServer, enabled: actual })
  return actual
}

export async function companionKickClient(connId: string): Promise<boolean> {
  const removed = await invoke<boolean>('companion_kick_client', { connId })
  if (removed) {
    setServerSnapshot({
      ...currentServer,
      clients: currentServer.clients.filter((c) => c.connId !== connId),
    })
  }
  return removed
}

export async function companionPublishAiState(snapshot: DesktopAiSessionSnapshot): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('companion_publish_ai_state', { snapshot }).catch(() => {})
}

export async function companionRemoveAiState(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('companion_remove_ai_state', { sessionId }).catch(() => {})
}

export async function companionConnect(peerDeviceId: string): Promise<CompanionConnectionStatus> {
  try {
    const status = await invoke<CompanionConnectionStatus>('companion_connect', { peerDeviceId })
    setStatusSnapshot(status)
    return status
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function companionDisconnect(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('companion_disconnect').catch(() => {})
  setStatusSnapshot(EMPTY_COMPANION_STATUS)
}

export async function companionRemoteListSessions(): Promise<{
  sessions: RemoteDesktopSessionInfo[]
  aiSessions: DesktopAiSessionSnapshot[]
}> {
  return invoke('companion_remote_list_sessions')
}

export async function companionRemoteAttachSession(
  sessionId: string,
  afterSeq = 0,
): Promise<{
  sessionId: string
  status: string
  chunks: RemoteTerminalChunk[]
  aiSession?: DesktopAiSessionSnapshot | null
}> {
  return invoke('companion_remote_attach_session', { sessionId, afterSeq })
}

export async function companionRemoteDetachSession(sessionId: string): Promise<void> {
  await invoke('companion_remote_detach_session', { sessionId }).catch(() => {})
}

export async function companionRemoteSendInput(sessionId: string, input: string): Promise<void> {
  await invoke('companion_remote_send_input', { sessionId, input })
}

export async function companionRemoteResizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke('companion_remote_resize_session', { sessionId, cols, rows })
}

export async function companionRemoteSubscribeAi(): Promise<DesktopAiSessionSnapshot[]> {
  return invoke<DesktopAiSessionSnapshot[]>('companion_remote_subscribe_ai')
}

export async function companionRemoteAiAction(params: {
  sessionId: string
  action: 'run_pending' | 'cancel' | 'send_prompt' | 'set_mode'
  prompt?: string
  messageId?: string
  mode?: string
}): Promise<void> {
  await invoke('companion_remote_ai_action', params)
}

export async function companionRemoteProbeCli(): Promise<CliBackendInfo[]> {
  return invoke<CliBackendInfo[]>('companion_remote_ai_cli_probe')
}

/** Stream a desktop-executed AI CLI generation over the encrypted Companion Bridge. */
export async function streamRemoteCliCommand(
  backend: AICliBackend,
  profile: AICliProfile | undefined,
  prompt: string,
  context: string,
  callbacks: AIStreamCallbacks,
  signal?: AbortSignal,
  history: AIHistoryItem[] = [],
  host = '',
  mode: AIRequestMode = 'confirm',
  formatError?: (code: unknown) => string,
): Promise<void> {
  if (signal?.aborted) return
  const requestId = crypto.randomUUID()
  let settled = false
  let started = false
  let unlisten: UnlistenFn | null = null
  let finish!: () => void
  const completion = new Promise<void>((resolve) => { finish = resolve })

  const cancelRemote = () => {
    void invoke('companion_remote_ai_cli_cancel', { requestId }).catch(() => {})
  }
  const abort = () => {
    if (settled) return
    settled = true
    if (started) cancelRemote()
    finish()
  }

  type RemoteCliEventPayload = {
    requestId: string
    event:
      | { type: 'token'; text: string }
      | { type: 'model'; name: string }
      | { type: 'done' }
      | { type: 'error'; code: string }
  }

  signal?.addEventListener('abort', abort, { once: true })
  try {
    unlisten = await listen<RemoteCliEventPayload>('companion:ai-cli-event', (e) => {
      if (settled || signal?.aborted || e.payload.requestId !== requestId) return
      const ev = e.payload.event
      if (ev.type === 'token') callbacks.onToken(ev.text)
      else if (ev.type === 'model') callbacks.onModel?.(ev.name)
      else {
        settled = true
        if (ev.type === 'done') callbacks.onDone()
        else callbacks.onError(formatError ? formatError(ev.code) : ev.code)
        finish()
      }
    })

    await invoke('companion_remote_ai_cli_start', {
      request: {
        requestId,
        backend,
        executable: profile?.executable ?? '',
        model: profile?.model ?? '',
        effort: profile?.effort ?? '',
        prompt,
        context,
        history,
        host,
        mode,
      },
    })
    started = true
    if (signal?.aborted) {
      cancelRemote()
      abort()
    }
    await completion
  } catch (error) {
    if (!settled && !signal?.aborted) {
      const msg = error instanceof Error ? error.message : String(error)
      callbacks.onError(formatError ? formatError(msg) : msg)
    }
  } finally {
    settled = true
    signal?.removeEventListener('abort', abort)
    unlisten?.()
  }
}
