import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import QRCode from 'qrcode'
import {
  Check,
  ChevronRight,
  Copy,
  Globe,
  Laptop,
  Link2,
  Loader2,
  Play,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Terminal,
  Unlink,
  Unplug,
  Wifi,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { fill } from '@/lib/locales/probe-install'
import { copyTextToClipboard } from '@/lib/clipboard'
import { isMobileDevice } from '@/lib/mobile-back'
import {
  buildPairingQrPayload,
  COMPANION_OPEN_SCANNER_EVENT,
  companionAddPeerRoute,
  companionConnect,
  companionDisconnect,
  companionKickClient,
  companionLocalCliBackends,
  companionLocalEndpoints,
  companionSetPeerPermissions,
  companionSetServerEnabled,
  consumePendingMobileQrScan,
  describeCompanionError,
  EMPTY_COMPANION_SERVER,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  formatCompanionError,
  getCompanionServerSnapshot,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  isTauriRuntime,
  localizeSessionStatus,
  openRemoteDesktopSession,
  parsePairingQrPayload,
  refreshCompanionServerStatus,
  resolveDesktopSessionTitle,
  subscribeCompanionServer,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
  type CliBackendInfo,
  type ParsedPairingLink,
} from '@/lib/companion'
import type { HostProfile } from '@/lib/hosts'
import { QrScannerModal } from '@/components/mobile/qr-scanner-modal'
import {
  getSystemHostname,
  syncAcceptPair,
  syncResolveOutgoingPair,
  syncSendPairRequest,
  type PeerBridgePermissions,
  type PeerRoute,
  type SyncDeviceIdentity,
  type SyncTrustedPeer,
} from '@/lib/sync'
import type { InteractiveSessionInfo } from '@/lib/interactive-session'
import type { AIBrandId } from '@/lib/ai-brand'
import type { DiscoveredDevice } from '@/lib/mdns'
import { AI_CLI_AGENTS } from '@/lib/agents'
import { AIProviderLogo } from '@/components/ai-provider-logo'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/sync-widgets'
import {
  ConfirmingView,
  IncomingPairView,
  PairDialog,
  PairingView,
  type PairStep,
} from '@/components/sync-pairing-views'
import { cn } from '@/lib/utils'

const CLI_META: Record<string, { label: string; brand: AIBrandId }> = Object.fromEntries(
  AI_CLI_AGENTS.map((agent) => [agent.cliBackend, { label: agent.cliLabel ?? agent.name, brand: agent.id }]),
)

const DEFAULT_CLI_BACKENDS: CliBackendInfo[] = AI_CLI_AGENTS.map((agent) => ({
  backend: agent.cliBackend,
  available: false,
}))

interface CompanionCenterPanelProps {
  localDevice: SyncDeviceIdentity | null
  trustedPeers: SyncTrustedPeer[]
  hosts?: HostProfile[]
  loading: boolean
  serverRunning: boolean
  serverPort: number
  interactiveSessions: InteractiveSessionInfo[]
  onRefresh: () => Promise<void>
  onInitDevice: (deviceName?: string) => Promise<void>
  onStartServer: (port?: number) => Promise<void>
  onRemoveTrustedPeer: (peerDeviceId: string) => Promise<void>
  onSelectSession?: (sessionId: string) => void
}

type PairView = 'idle' | 'pairing' | 'confirming' | 'incoming'

export function CompanionCenterPanel(props: CompanionCenterPanelProps) {
  // Unfolded foldables (e.g. Pixel Fold) and tablets (iPad) use the wide sidebar layout,
  // but their OS role is still a mobile client connecting TO a desktop — never a desktop host.
  if (isMobileDevice()) {
    return <MobileDesktopClientCenter {...props} />
  }
  return <DesktopCompanionHostCenter {...props} />
}

function MobileDesktopClientCenter({
  localDevice,
  trustedPeers,
  hosts = [],
  loading,
  serverRunning,
  onRefresh,
  onInitDevice,
  onStartServer,
  onRemoveTrustedPeer,
}: CompanionCenterPanelProps) {
  const { t, locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const syncCopy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const status = useSyncExternalStore(
    subscribeCompanionStatus,
    getCompanionStatusSnapshot,
    () => EMPTY_COMPANION_STATUS,
  )
  const workspace = useSyncExternalStore(
    subscribeCompanionWorkspace,
    getCompanionWorkspaceSnapshot,
    () => EMPTY_COMPANION_WORKSPACE,
  )

  const [busyPeerId, setBusyPeerId] = useState<string | null>(null)
  const [connectError, setConnectError] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [directInput, setDirectInput] = useState('')
  const [directBusy, setDirectBusy] = useState(false)
  const [directError, setDirectError] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [pairView, setPairView] = useState<'idle' | 'pairing' | 'confirming'>('idle')
  const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null)
  const [generatedPin, setGeneratedPin] = useState('')
  const [outgoingSessionId, setOutgoingSessionId] = useState('')
  const [codeConfirmed, setCodeConfirmed] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const pendingExtraRoutesRef = useRef<PendingExtraRoutes | null>(null)

  const needsInit = !localDevice

  useEffect(() => {
    if (consumePendingMobileQrScan()) setScannerOpen(true)
    const onOpenScanner = () => {
      consumePendingMobileQrScan()
      setScannerOpen(true)
    }
    window.addEventListener(COMPANION_OPEN_SCANNER_EVENT, onOpenScanner)
    return () => window.removeEventListener(COMPANION_OPEN_SCANNER_EVENT, onOpenScanner)
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlistenConf: (() => void) | null = null
    void listen<{ peerDeviceId: string; peerDeviceName: string }>('pair-confirmed', (event) => {
      const extra = pendingExtraRoutesRef.current
      pendingExtraRoutesRef.current = null
      if (extra && event.payload?.peerDeviceId) {
        void saveExtraPeerRoutes(event.payload.peerDeviceId, extra).then(() => void onRefresh())
      } else {
        void onRefresh()
      }
      setGeneratedPin('')
      setOutgoingSessionId('')
      setSelectedDevice(null)
      setPairView('idle')
    }).then((fn) => { unlistenConf = fn })
    return () => { unlistenConf?.() }
  }, [onRefresh])

  const handleConnect = async (peerId: string) => {
    setConnectError('')
    setBusyPeerId(peerId)
    try {
      await companionConnect(peerId)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyPeerId(null)
    }
  }

  const handleDirectPair = async (parsed: ParsedPairingLink) => {
    if (!serverRunning) {
      try { await onStartServer() } catch { /* ignore */ }
    }
    const targets = buildDirectPairTargets(parsed)
    pendingExtraRoutesRef.current = {
      hosts: parsed.hosts,
      port: parsed.port,
      irohId: parsed.irohId,
      relayUrl: parsed.relayUrl,
    }
    const displayName = parsed.deviceName || parsed.hosts[0] || (parsed.irohId ? `P2P ${parsed.irohId.slice(0, 8)}` : 'Desktop')
    let lastError: unknown = null
    for (const target of targets) {
      setSelectedDevice({ name: displayName, host: target.host, port: target.port, deviceType: 'computer' })
      setPairView('pairing')
      setPairingError('')
      try {
        const session = await syncSendPairRequest({
          peerHost: target.host,
          peerPort: target.port,
          peerName: displayName,
        })
        setGeneratedPin(session.verificationCode)
        setOutgoingSessionId(session.sessionId)
        setCodeConfirmed(false)
        setPairView('confirming')
        await onRefresh()
        return
      } catch (err) {
        lastError = err
      }
    }
    pendingExtraRoutesRef.current = null
    setPairView('idle')
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Connection failed'))
  }

  const handleDirectSubmit = async () => {
    setDirectError('')
    const parsed = parsePairingQrPayload(directInput)
    if (!parsed) {
      setDirectError(copy.directConnectHint)
      return
    }
    setDirectBusy(true)
    try {
      await handleDirectPair(parsed)
      setDirectInput('')
    } catch (err) {
      setDirectError(formatCompanionError(err, locale))
    } finally {
      setDirectBusy(false)
    }
  }

  const handleScannedQr = async (_raw: string, parsed: ParsedPairingLink) => {
    setScannerOpen(false)
    setDirectError('')
    setDirectBusy(true)
    try {
      await handleDirectPair(parsed)
    } catch (err) {
      setDirectError(formatCompanionError(err, locale))
    } finally {
      setDirectBusy(false)
    }
  }

  const handleConfirmCode = async () => {
    try {
      await syncResolveOutgoingPair({ sessionId: outgoingSessionId, accepted: true })
      setCodeConfirmed(true)
    } catch (err) {
      setPairingError(String(err))
    }
  }

  const handleCancelPair = () => {
    if (outgoingSessionId) {
      void syncResolveOutgoingPair({ sessionId: outgoingSessionId, accepted: false }).catch(() => {})
      setOutgoingSessionId('')
    }
    setSelectedDevice(null)
    setPairingError('')
    setGeneratedPin('')
    setPairView('idle')
  }

  const connected = status.state === 'connected'
  const availableClis = status.cliBackends.filter((c) => c.available)
  const routeBadge = status.routeKind === 'tailnet'
    ? copy.routeTailnet
    : status.routeKind === 'lan'
      ? copy.routeLan
      : status.routeKind === 'iroh'
        ? copy.routeIroh
        : copy.routeCustom

  return (
    <div data-testid="companion-client-center" className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">
              {copy.myDesktop}
            </h1>
            {connected && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11.5px] font-medium text-emerald-400">
                <Radio className="h-3 w-3" />
                {status.peerDeviceName || copy.myDesktop} · {routeBadge}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{copy.subtitle}</p>
        </div>

        {!needsInit && (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setScannerOpen(true)}>
              <ScanLine className="h-3.5 w-3.5" />
              {copy.scanQrAction}
            </Button>
            {connected && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void companionDisconnect()}>
                <Unplug className="h-3.5 w-3.5" />
                {copy.disconnect}
              </Button>
            )}
          </div>
        )}
      </div>

      {needsInit ? (
        <section className="sb-card mx-auto flex max-w-lg flex-col items-center gap-4 px-7 py-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
            <Smartphone className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--workspace-text-strong)]">{t('sync.initDevice')}</h2>
            <p className="mt-1 text-[12.5px] text-[var(--workspace-text-muted)]">{copy.initDeviceFirstClient}</p>
          </div>
          <div className="w-full max-w-sm space-y-2 text-left">
            <label htmlFor="client-device-name" className="text-[12px] font-medium text-[var(--workspace-text-strong)]">
              {syncCopy.deviceName}
            </label>
            <input
              id="client-device-name"
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder={t('sync.deviceName')}
              className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] text-[var(--workspace-text-strong)] outline-none"
            />
            <Button className="h-10 w-full" disabled={loading} onClick={() => void onInitDevice(deviceName.trim() || undefined)}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sync.initialize')}
            </Button>
          </div>
        </section>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {/* Left Column: Paired Computers + Pair via QR/Link + Ready Desktop CLIs */}
          <div className="space-y-4">
            <section className="sb-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
                <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--workspace-text-strong)]">
                  <Laptop className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                  <span>{copy.myDesktop}</span>
                </div>
                <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                  {trustedPeers.length}
                </span>
              </div>

              {trustedPeers.length === 0 ? (
                <p className="px-4 py-5 text-[12.5px] text-[var(--workspace-text-muted)]">
                  {copy.noAuthorizedDevices}
                </p>
              ) : (
                <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                  {trustedPeers.map((peer) => {
                    const isThisConnected = connected && status.peerDeviceId === peer.peerDeviceId
                    const isBusy = busyPeerId === peer.peerDeviceId || (status.state === 'connecting' && status.peerDeviceId === peer.peerDeviceId)
                    return (
                      <div key={peer.peerDeviceId} className="flex items-center gap-3 px-4 py-3">
                        <Wifi className={cn('h-4 w-4 shrink-0', isThisConnected ? 'text-emerald-400' : 'text-[var(--workspace-text-subtle)]')} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium text-[var(--workspace-text-strong)]">
                            {peer.peerDeviceName ?? peer.peerDeviceId}
                          </p>
                          <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                            {isThisConnected
                              ? `${copy.connected} · ${routeBadge}`
                              : peer.peerEndpoint && !peer.peerEndpoint.startsWith('iroh://')
                                ? peer.peerEndpoint
                                : peer.routes?.find((r) => r.kind === 'lan')?.host || copy.routeIroh}
                          </p>
                        </div>
                        {isThisConnected ? (
                          <Button size="sm" variant="outline" className="h-8 gap-1 text-[12px]" onClick={() => void companionDisconnect()}>
                            <Unplug className="h-3.5 w-3.5" />
                            {copy.disconnect}
                          </Button>
                        ) : (
                          <Button size="sm" className="h-8 gap-1.5 text-[12px]" disabled={isBusy} onClick={() => void handleConnect(peer.peerDeviceId)}>
                            {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {isBusy ? copy.connecting : copy.connectDesktop}
                          </Button>
                        )}
                        <button
                          type="button"
                          title={copy.revokeDevice}
                          aria-label={copy.revokeDevice}
                          onClick={() => void onRemoveTrustedPeer(peer.peerDeviceId)}
                          className="rounded-md p-1.5 text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
                        >
                          <Unlink className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {(connectError || status.error) && (
                <div className="border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-status-bad-bg)]/50 px-4 py-2.5 text-[12px] text-[color:var(--workspace-status-bad-text)]">
                  {describeCompanionError(connectError || status.error, locale).message}
                </div>
              )}

              {/* Direct Link / IP pairing input */}
              <div className="space-y-2 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/40 p-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={directInput}
                    onChange={(e) => { setDirectInput(e.target.value); setDirectError('') }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !directBusy && directInput.trim()) void handleDirectSubmit() }}
                    placeholder={copy.directConnectPlaceholder}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2.5 font-mono text-[12px] text-[var(--workspace-text-strong)] outline-none placeholder:font-sans"
                  />
                  <Button size="sm" variant="outline" className="h-8 shrink-0 px-3 text-[12px]" disabled={directBusy || !directInput.trim()} onClick={() => void handleDirectSubmit()}>
                    {directBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {copy.directConnectAction}
                  </Button>
                </div>
                {directError && <p className="text-[11.5px] text-[color:var(--workspace-status-bad-text)]">{directError}</p>}
              </div>
            </section>

            {/* Desktop AI CLIs ready on connected Mac */}
            {connected && (
              <section className="sb-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
                    <Sparkles className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                    <span>{copy.desktopCliGroup}</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                    {availableClis.length}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                  {status.cliBackends.map((cli) => {
                    const meta = CLI_META[cli.backend] ?? { label: cli.backend, brand: 'custom' as AIBrandId }
                    return (
                      <div
                        key={cli.backend}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px]',
                          cli.available
                            ? 'border-emerald-500/25 bg-emerald-500/8 text-[var(--workspace-text-strong)]'
                            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/50 text-[var(--workspace-text-subtle)] opacity-60',
                        )}
                      >
                        <AIProviderLogo brand={meta.brand} className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-medium">{meta.label}</span>
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cli.available ? 'bg-emerald-400' : 'bg-[var(--workspace-border-strong)]')} />
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </div>

          {/* Right Column: Live Auto-Pushed Desktop Sessions */}
          <section className="sb-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--workspace-text-strong)]">
                <SquareTerminal className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                <span>{copy.activeDesktopSessions}</span>
              </div>
              <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                {workspace.sessions.length}
              </span>
            </div>

            {!connected ? (
              <p className="px-4 py-8 text-center text-[12.5px] text-[var(--workspace-text-muted)]">
                {copy.subtitle}
              </p>
            ) : workspace.sessions.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12.5px] text-[var(--workspace-text-muted)]">
                {copy.desktopWaitingHint}
              </p>
            ) : (
              <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                {workspace.sessions.map((sess) => {
                  const aiSnap = workspace.aiBySession[sess.sessionId]
                  const hasPending = Boolean(aiSnap?.pendingCommand)
                  const { title } = resolveDesktopSessionTitle(sess, aiSnap, hosts, copy.localShellLabel)
                  const statusInfo = localizeSessionStatus(sess.status, copy)
                  return (
                    <button
                      key={sess.sessionId}
                      type="button"
                      onClick={() => openRemoteDesktopSession(sess.sessionId)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--workspace-surface-800)]"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-surface-800)] text-[var(--workspace-accent-text)]">
                        {aiSnap && (aiSnap.messages.length > 0 || hasPending || aiSnap.isStreaming)
                          ? <Sparkles className="h-4 w-4" />
                          : <Terminal className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusInfo.live ? 'bg-emerald-400' : 'bg-[var(--workspace-text-subtle)]')} />
                          <p className="truncate text-[14px] font-medium text-[var(--workspace-text-strong)]">{title}</p>
                          {hasPending && (
                            <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                              {copy.pendingApprovalBadge}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[12px] text-[var(--workspace-text-muted)]">
                          {aiSnap?.modelLabel ? `${aiSnap.modelLabel} · ${statusInfo.label}` : statusInfo.label}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}

      <QrScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(raw, parsed) => void handleScannedQr(raw, parsed)}
      />

      <PairDialog open={pairView !== 'idle'} step="verify" onClose={handleCancelPair}>
        {pairView === 'pairing' ? (
          <PairingView
            selectedDeviceName={selectedDevice?.name ?? 'Desktop'}
            pairingError={pairingError}
            onCancel={handleCancelPair}
          />
        ) : pairView === 'confirming' ? (
          <ConfirmingView
            selectedDevice={selectedDevice}
            generatedPin={generatedPin}
            pairingError={pairingError}
            codeConfirmed={codeConfirmed}
            onConfirmCode={() => void handleConfirmCode()}
            onCancel={handleCancelPair}
          />
        ) : null}
      </PairDialog>
    </div>
  )
}

type PendingExtraRoutes = {
  hosts: string[]
  port: number
  irohId?: string
  relayUrl?: string
}

function buildDirectPairTargets(parsed: ParsedPairingLink): Array<{ host: string; port: number }> {
  const targets: Array<{ host: string; port: number }> = parsed.hosts.map((host) => ({ host, port: parsed.port }))
  if (parsed.irohId) {
    const irohHost = parsed.relayUrl
      ? `iroh://${parsed.irohId}?relay=${encodeURIComponent(parsed.relayUrl)}`
      : `iroh://${parsed.irohId}`
    targets.push({ host: irohHost, port: 1 })
  }
  return targets
}

function saveExtraPeerRoutes(peerDeviceId: string, extra: PendingExtraRoutes): Promise<unknown[]> {
  const saves: Array<Promise<unknown>> = extra.hosts.map((host) =>
    companionAddPeerRoute({ peerDeviceId, host, port: extra.port }).catch(() => {}),
  )
  if (extra.irohId) {
    saves.push(
      companionAddPeerRoute({
        peerDeviceId,
        host: extra.irohId,
        port: 1,
        kind: 'iroh',
        label: extra.relayUrl,
      }).catch(() => {}),
    )
  }
  return Promise.all(saves)
}

function DesktopCompanionHostCenter({
  localDevice,
  trustedPeers,
  loading,
  serverRunning,
  serverPort,
  interactiveSessions,
  onRefresh,
  onInitDevice,
  onStartServer,
  onRemoveTrustedPeer,
  onSelectSession,
}: CompanionCenterPanelProps) {
  const { t, locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const syncCopy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']

  const serverSnap = useSyncExternalStore(
    subscribeCompanionServer,
    getCompanionServerSnapshot,
    () => EMPTY_COMPANION_SERVER,
  )

  const [routes, setRoutes] = useState<PeerRoute[]>([])
  const [cliBackends, setCliBackends] = useState<CliBackendInfo[]>(DEFAULT_CLI_BACKENDS)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [pairTab, setPairTab] = useState<'qr' | 'link'>('qr')
  const [startingServer, setStartingServer] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showAllPeers, setShowAllPeers] = useState(false)
  const [deviceName, setDeviceName] = useState('')
  const [localHostname, setLocalHostname] = useState('')

  // Outbound direct link / IP pairing state
  const [directInput, setDirectInput] = useState('')
  const [directBusy, setDirectBusy] = useState(false)
  const [directError, setDirectError] = useState('')
  const [pairView, setPairView] = useState<PairView>('idle')
  const [selectedDevice, setSelectedDevice] = useState<DiscoveredDevice | null>(null)
  const [generatedPin, setGeneratedPin] = useState('')
  const [outgoingSessionId, setOutgoingSessionId] = useState('')
  const [codeConfirmed, setCodeConfirmed] = useState(false)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [incomingPairRequest, setIncomingPairRequest] = useState<{
    sessionId: string
    peerDeviceId: string
    peerDeviceName: string
    peerHost: string
    verificationCode: string
  } | null>(null)
  const pendingExtraRoutesRef = useRef<PendingExtraRoutes | null>(null)

  const needsInit = !localDevice

  useEffect(() => {
    if (!needsInit) return
    void getSystemHostname().then((name) => {
      if (name) {
        setLocalHostname(name)
        setDeviceName((prev) => prev || name)
      }
    })
  }, [needsInit])

  const loadLocalDiagnostics = useCallback(async () => {
    setRefreshing(true)
    try {
      const [ep, clis] = await Promise.all([
        companionLocalEndpoints(),
        companionLocalCliBackends(),
        refreshCompanionServerStatus(),
      ])
      setRoutes(ep)
      if (clis.length > 0) setCliBackends(clis)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadLocalDiagnostics()
  }, [loadLocalDiagnostics, serverRunning, serverPort])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen('companion:endpoints-changed', () => {
      void companionLocalEndpoints().then((ep) => setRoutes(ep))
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  const pairPayload = useMemo(
    () => buildPairingQrPayload({ routes, port: serverPort || 9123, deviceName: localDevice?.deviceName }),
    [routes, serverPort, localDevice?.deviceName],
  )

  useEffect(() => {
    if (routes.length === 0) {
      setQrDataUrl('')
      return
    }
    let active = true
    void QRCode.toDataURL(pairPayload, {
      margin: 2,
      width: 312,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => { if (active) setQrDataUrl(url) })
      .catch(() => { if (active) setQrDataUrl('') })
    return () => { active = false }
  }, [pairPayload, routes.length])

  // Listen for outbound pair-confirmed events while on this page (incoming pair requests
  // are handled globally in PcLayout so they pop up regardless of the active page).
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlistenConf: (() => void) | null = null

    void listen<{ peerDeviceId: string; peerDeviceName: string }>('pair-confirmed', (event) => {
      const extra = pendingExtraRoutesRef.current
      pendingExtraRoutesRef.current = null
      if (extra && event.payload?.peerDeviceId) {
        void saveExtraPeerRoutes(event.payload.peerDeviceId, extra).then(() => void onRefresh())
      } else {
        void onRefresh()
      }
      setGeneratedPin('')
      setOutgoingSessionId('')
      setSelectedDevice(null)
      setPairView('idle')
    }).then((fn) => { unlistenConf = fn })

    return () => {
      unlistenConf?.()
    }
  }, [onRefresh])

  const hasTailnetRoute = routes.some((r) => r.kind === 'tailnet')
  const hasIrohRoute = routes.some((r) => r.kind === 'iroh')
  const readyCliCount = cliBackends.filter((c) => c.available).length
  const connectedPeerIds = useMemo(
    () => new Set(serverSnap.clients.map((c) => c.peerDeviceId)),
    [serverSnap.clients],
  )

  const sortedPeers = useMemo(() => {
    return [...trustedPeers].sort((a, b) => {
      const aConn = connectedPeerIds.has(a.peerDeviceId) ? 1 : 0
      const bConn = connectedPeerIds.has(b.peerDeviceId) ? 1 : 0
      if (aConn !== bConn) return bConn - aConn
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    })
  }, [trustedPeers, connectedPeerIds])

  const routeLabel = (kind: string) => (
    kind === 'tailnet'
      ? copy.routeTailnet
      : kind === 'lan'
        ? copy.routeLan
        : kind === 'iroh'
          ? copy.routeIroh
          : copy.routeCustom
  )

  const formatRouteDisplay = (r: PeerRoute) => (
    r.kind === 'iroh'
      ? `${r.host.slice(0, 8)}…`
      : r.port > 0
        ? `${r.host}:${r.port}`
        : r.host
  )

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(pairPayload)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }
  }

  const handleToggleBridge = async (next: boolean) => {
    try {
      await companionSetServerEnabled(next)
    } catch {
      void refreshCompanionServerStatus()
    }
  }

  const handleStartServer = async () => {
    setStartingServer(true)
    try {
      await onStartServer()
      await loadLocalDiagnostics()
    } finally {
      setStartingServer(false)
    }
  }

  const handleDirectPair = async (parsed: ParsedPairingLink) => {
    if (!serverRunning) {
      try { await onStartServer() } catch { /* ignore */ }
    }
    const targets = buildDirectPairTargets(parsed)
    pendingExtraRoutesRef.current = {
      hosts: parsed.hosts,
      port: parsed.port,
      irohId: parsed.irohId,
      relayUrl: parsed.relayUrl,
    }
    const displayName = parsed.deviceName || parsed.hosts[0] || (parsed.irohId ? `P2P ${parsed.irohId.slice(0, 8)}` : 'Desktop')
    let lastError: unknown = null
    for (const target of targets) {
      setSelectedDevice({ name: displayName, host: target.host, port: target.port, deviceType: 'computer' })
      setPairView('pairing')
      setPairingBusy(true)
      setPairingError('')
      try {
        const session = await syncSendPairRequest({
          peerHost: target.host,
          peerPort: target.port,
          peerName: displayName,
        })
        setGeneratedPin(session.verificationCode)
        setOutgoingSessionId(session.sessionId)
        setCodeConfirmed(false)
        setPairView('confirming')
        setPairingBusy(false)
        await onRefresh()
        return
      } catch (err) {
        lastError = err
      }
    }
    setPairingBusy(false)
    pendingExtraRoutesRef.current = null
    setPairView('idle')
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Connection failed'))
  }

  const handleDirectSubmit = async () => {
    setDirectError('')
    const parsed = parsePairingQrPayload(directInput)
    if (!parsed) {
      setDirectError(copy.directConnectHint)
      return
    }
    setDirectBusy(true)
    try {
      await handleDirectPair(parsed)
      setDirectInput('')
    } catch (err) {
      setDirectError(formatCompanionError(err, locale))
    } finally {
      setDirectBusy(false)
    }
  }

  const handleConfirmCode = async () => {
    try {
      await syncResolveOutgoingPair({ sessionId: outgoingSessionId, accepted: true })
      setCodeConfirmed(true)
    } catch (err) {
      setPairingError(String(err))
    }
  }

  const handleAcceptPair = async () => {
    if (!incomingPairRequest) return
    setPairingBusy(true)
    setPairingError('')
    try {
      await syncAcceptPair({
        sessionId: incomingPairRequest.sessionId,
        peerHost: incomingPairRequest.peerHost,
        peerPort: 9123,
      })
      setIncomingPairRequest(null)
      setPairView('idle')
      await onRefresh()
    } catch (err) {
      setPairingError(String(err))
    } finally {
      setPairingBusy(false)
    }
  }

  const handleCancelPair = () => {
    if (outgoingSessionId) {
      void syncResolveOutgoingPair({ sessionId: outgoingSessionId, accepted: false }).catch(() => {})
      setOutgoingSessionId('')
    }
    setSelectedDevice(null)
    setPairingError('')
    setIncomingPairRequest(null)
    setGeneratedPin('')
    setPairView('idle')
  }

  const pairBody = (() => {
    if (pairView === 'pairing') {
      return (
        <PairingView
          selectedDeviceName={selectedDevice?.name ?? 'peer device'}
          pairingError={pairingError}
          onCancel={handleCancelPair}
        />
      )
    }
    if (pairView === 'confirming') {
      return (
        <ConfirmingView
          selectedDevice={selectedDevice}
          generatedPin={generatedPin}
          pairingError={pairingError}
          codeConfirmed={codeConfirmed}
          onConfirmCode={() => void handleConfirmCode()}
          onCancel={handleCancelPair}
        />
      )
    }
    if (pairView === 'incoming' && incomingPairRequest) {
      return (
        <IncomingPairView
          request={incomingPairRequest}
          pairingBusy={pairingBusy}
          pairingError={pairingError}
          onAccept={() => void handleAcceptPair()}
          onCancel={handleCancelPair}
        />
      )
    }
    return null
  })()
  const pairStep: PairStep = pairView === 'incoming' ? 'incoming' : 'verify'

  return (
    <div data-testid="companion-center-panel" className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">
              {copy.navLabel}
            </h1>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-medium',
                serverRunning
                  ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]'
                  : 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  serverRunning ? 'bg-[color:var(--workspace-status-good)]' : 'bg-[color:var(--workspace-status-warn-text)]',
                )}
              />
              {serverRunning
                ? fill(copy.serverRunningBadge, { port: serverPort })
                : copy.serverStoppedBadge}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{copy.pageSubtitle}</p>
        </div>

        {!needsInit && (
          <div className="flex flex-wrap items-center gap-2.5">
            {!serverRunning && (
              <Button
                size="sm"
                className="h-8 gap-1.5"
                disabled={startingServer}
                onClick={() => void handleStartServer()}
              >
                {startingServer ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {copy.startServerAction}
              </Button>
            )}
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[12px] text-[var(--workspace-text)]">
              <span>{copy.remoteBridgeToggleShort}</span>
              <Switch
                checked={serverSnap.enabled}
                label={copy.remoteBridgeEnabled}
                onChange={(v) => void handleToggleBridge(v)}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={copy.refreshStatus}
              title={copy.refreshStatus}
              disabled={refreshing || loading}
              onClick={() => {
                void onRefresh()
                void loadLocalDiagnostics()
              }}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (refreshing || loading) && 'animate-spin')} />
            </Button>
          </div>
        )}
      </div>

      {needsInit ? (
        <section className="sb-card mx-auto flex max-w-lg flex-col items-center gap-4 px-7 py-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
            <Smartphone className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--workspace-text-strong)]">{t('sync.initDevice')}</h2>
            <p className="mt-1 text-[12.5px] text-[var(--workspace-text-muted)]">{copy.initDeviceFirst}</p>
          </div>
          <div className="w-full max-w-sm space-y-1.5 text-left">
            <label htmlFor="companion-device-name" className="text-[12px] font-medium text-[var(--workspace-text-strong)]">
              {syncCopy.deviceName}
            </label>
            <input
              id="companion-device-name"
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder={t('sync.deviceName')}
              className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] text-[var(--workspace-text-strong)] outline-none focus:border-[color:var(--workspace-primary-500)]"
            />
            {localHostname && deviceName === localHostname && (
              <p className="text-[11px] text-[var(--workspace-text-subtle)]">{syncCopy.prefilled}</p>
            )}
            <Button
              className="mt-2 h-10 w-full"
              disabled={loading}
              onClick={() => void onInitDevice(deviceName.trim() || undefined)}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sync.initialize')}
            </Button>
          </div>
        </section>
      ) : (
        <>
          {/* Hero 2-Column Grid */}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            {/* Left: QR & Direct Pairing Card */}
            <section className="sb-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-5 py-3">
                <div className="flex items-center gap-2">
                  <QrCode className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                  <h2 className="text-[14px] font-semibold text-[var(--workspace-text-strong)]">
                    {copy.qrPairTitle}
                  </h2>
                </div>
                <div className="inline-flex rounded-lg bg-[var(--workspace-surface-900)] p-0.5 text-[11.5px]">
                  <button
                    type="button"
                    onClick={() => setPairTab('qr')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                      pairTab === 'qr'
                        ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm'
                        : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                    )}
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    {copy.qrPairTab}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPairTab('link')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                      pairTab === 'link'
                        ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm'
                        : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                    )}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {copy.linkPairTab}
                  </button>
                </div>
              </div>

              <div className="p-5">
                {pairTab === 'qr' ? (
                  <div className="space-y-4">
                    {!serverRunning && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--workspace-status-warn-bg)] px-3.5 py-2.5 text-[12px] text-[color:var(--workspace-status-warn-text)]">
                        <span>{copy.startServerHint}</span>
                        <Button
                          size="sm"
                          className="h-7 shrink-0 gap-1 px-2.5 text-[11.5px]"
                          disabled={startingServer}
                          onClick={() => void handleStartServer()}
                        >
                          {startingServer ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                          {copy.startServerAction}
                        </Button>
                      </div>
                    )}

                    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
                      {qrDataUrl ? (
                        <div
                          data-testid="companion-center-qr"
                          className="shrink-0 rounded-2xl bg-white p-2.5 shadow-md ring-1 ring-black/5"
                        >
                          <img
                            src={qrDataUrl}
                            alt={copy.qrPairTitle}
                            className="block h-[156px] w-[156px]"
                          />
                        </div>
                      ) : (
                        <div className="flex h-[176px] w-[176px] shrink-0 flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-center text-[11.5px] text-[var(--workspace-text-subtle)]">
                          <QrCode className="mb-2 h-6 w-6 opacity-40" />
                          {copy.qrUnavailable}
                        </div>
                      )}

                      <div className="min-w-0 flex-1 space-y-3">
                        <div>
                          <p className="mb-1.5 text-[11.5px] font-medium text-[var(--workspace-text-subtle)]">
                            {copy.networkChannels}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {routes.map((r) => (
                              <span
                                key={`${r.kind}:${r.host}:${r.port}`}
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11.5px]',
                                  r.kind === 'tailnet' || r.kind === 'iroh'
                                    ? 'bg-emerald-500/15 text-emerald-400'
                                    : 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
                                )}
                              >
                                <Radio className="h-3 w-3" />
                                <span className="font-sans font-medium">{routeLabel(r.kind)}</span>
                                <span>{formatRouteDisplay(r)}</span>
                              </span>
                            ))}
                          </div>
                        </div>

                        <p className={cn(
                          'flex items-start gap-1.5 text-[11.5px] leading-relaxed',
                          hasTailnetRoute || hasIrohRoute ? 'text-emerald-400' : 'text-[var(--workspace-text-muted)]',
                        )}>
                          <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            {hasTailnetRoute
                              ? copy.tailscaleDetected
                              : hasIrohRoute
                                ? copy.irohReadyHint
                                : copy.tailscaleTip}
                          </span>
                        </p>

                        <div className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5">
                          <code
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]"
                            title={pairPayload}
                          >
                            {pairPayload}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 gap-1 px-2 text-[11px] text-[color:var(--workspace-accent-text)]"
                            onClick={() => void handleCopy()}
                          >
                            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            {copied ? copy.copied : copy.copyPairLink}
                          </Button>
                        </div>

                        <p className="text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">
                          {copy.qrPairDesc}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 py-2">
                    <p className="text-[12.5px] text-[var(--workspace-text-muted)]">{copy.directConnectHint}</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={directInput}
                        onChange={(e) => { setDirectInput(e.target.value); setDirectError('') }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !directBusy && directInput.trim()) void handleDirectSubmit()
                        }}
                        placeholder={copy.directConnectPlaceholder}
                        aria-label={copy.directConnectTitle}
                        className="h-9 min-w-0 flex-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 font-mono text-[12px] text-[var(--workspace-text-strong)] outline-none placeholder:font-sans placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]"
                      />
                      <Button
                        size="sm"
                        className="h-9 shrink-0 gap-1.5 px-4"
                        disabled={directBusy || !directInput.trim()}
                        onClick={() => void handleDirectSubmit()}
                      >
                        {directBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {copy.directConnectAction}
                      </Button>
                    </div>
                    {directError && (
                      <p className="text-[11.5px] text-[color:var(--workspace-status-bad-text)]">{directError}</p>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Right: 3 Live Capability / Status Cards */}
            <div className="space-y-4">
              {/* 1. Online Connected Phones */}
              <section className="sb-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
                    <Smartphone className="h-4 w-4 text-emerald-400" />
                    <span>{copy.onlineClientsTitle}</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                    {serverSnap.clients.length}
                  </span>
                </div>
                {serverSnap.clients.length === 0 ? (
                  <p className="px-4 py-3 text-[12px] text-[var(--workspace-text-muted)]">
                    {copy.noOnlineClients}
                  </p>
                ) : (
                  <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                    {serverSnap.clients.map((client) => (
                      <div key={client.connId} className="flex items-center gap-2.5 px-4 py-2.5">
                        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[var(--workspace-text-strong)]">
                            {client.peerDeviceName}
                          </p>
                          <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                            {client.remoteAddr}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 shrink-0 gap-1 bg-[var(--workspace-status-bad-bg)] px-2 text-[11px] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)] hover:opacity-90"
                          onClick={() => void companionKickClient(client.connId)}
                        >
                          <Unplug className="h-3 w-3" />
                          {copy.kickClient}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 2. Local AI CLI Readiness */}
              <section className="sb-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
                    <Terminal className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                    <span>{copy.cliCardTitle}</span>
                  </div>
                  <span className="rounded-md bg-[var(--workspace-surface-800)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--workspace-text-muted)]">
                    {fill(copy.cliReadyCount, { ready: readyCliCount, total: cliBackends.length })}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                  {cliBackends.map((cli) => {
                    const meta = CLI_META[cli.backend] ?? { label: cli.backend, brand: 'custom' as AIBrandId }
                    return (
                      <div
                        key={cli.backend}
                        title={cli.executable || meta.label}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px] transition-colors',
                          cli.available
                            ? 'border-emerald-500/25 bg-emerald-500/8 text-[var(--workspace-text-strong)]'
                            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/50 text-[var(--workspace-text-subtle)] opacity-70',
                        )}
                      >
                        <AIProviderLogo brand={meta.brand} className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-medium">{meta.label}</span>
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            cli.available ? 'bg-emerald-400' : 'bg-[var(--workspace-border-strong)]',
                          )}
                          title={cli.available ? copy.cliInstalled : copy.cliNotInstalled}
                        />
                      </div>
                    )
                  })}
                </div>
              </section>

              {/* 3. Live Desktop Sessions available for handoff */}
              <section className="sb-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
                    <SquareTerminal className="h-4 w-4 text-[var(--workspace-text-muted)]" />
                    <span>{copy.sessionsCardTitle}</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                    {fill(copy.sessionsCount, { count: interactiveSessions.length })}
                  </span>
                </div>
                {interactiveSessions.length === 0 ? (
                  <p className="px-4 py-3 text-[12px] text-[var(--workspace-text-muted)]">
                    {copy.noDesktopSessions}
                  </p>
                ) : (
                  <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                    {interactiveSessions.slice(0, 4).map((session) => (
                      <div key={session.sessionId} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            session.status === 'connected' ? 'bg-[color:var(--workspace-status-good)]' : 'bg-[var(--workspace-text-subtle)]',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--workspace-text-strong)]">
                          {session.username ? `${session.username}@${session.host}` : session.host}
                        </span>
                        {onSelectSession && (
                          <button
                            type="button"
                            onClick={() => onSelectSession(session.sessionId)}
                            className="shrink-0 text-[11px] font-medium text-[color:var(--workspace-accent-text)] hover:underline"
                          >
                            {copy.openTerminal}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>

          {/* Authorized Devices & Per-Device Permissions */}
          <section className="sb-card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-5 py-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[var(--workspace-accent-text)]" />
                <h2 className="text-[14px] font-semibold text-[var(--workspace-text-strong)]">
                  {copy.authorizedDevicesTitle}
                </h2>
                <span className="rounded-md bg-[var(--workspace-surface-800)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--workspace-text-muted)]">
                  {sortedPeers.length}
                </span>
              </div>
              {sortedPeers.length > 4 && (
                <button
                  type="button"
                  onClick={() => setShowAllPeers((v) => !v)}
                  className="text-[12px] font-medium text-[color:var(--workspace-accent-text)] hover:underline"
                >
                  {showAllPeers ? copy.collapsePeers : fill(copy.showAllPeers, { n: sortedPeers.length })}
                </button>
              )}
            </div>

            {sortedPeers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <Laptop className="h-6 w-6 text-[var(--workspace-text-subtle)] opacity-60" />
                <p className="max-w-md text-[12.5px] leading-relaxed text-[var(--workspace-text-muted)]">
                  {copy.noAuthorizedDevices}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[color:var(--workspace-border-soft)]">
                {(showAllPeers ? sortedPeers : sortedPeers.slice(0, 4)).map((peer) => (
                  <AuthorizedDeviceRow
                    key={peer.peerDeviceId}
                    peer={peer}
                    connected={connectedPeerIds.has(peer.peerDeviceId)}
                    onRefresh={onRefresh}
                    onRemove={onRemoveTrustedPeer}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <PairDialog open={pairBody != null} step={pairStep} onClose={handleCancelPair}>
        {pairBody}
      </PairDialog>
    </div>
  )
}

function AuthorizedDeviceRow({
  peer,
  connected,
  onRefresh,
  onRemove,
}: {
  peer: SyncTrustedPeer
  connected: boolean
  onRefresh: () => Promise<void>
  onRemove: (peerDeviceId: string) => Promise<void>
}) {
  const { t, locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const [perms, setPerms] = useState<PeerBridgePermissions>(() => ({
    allowAiCli: peer.bridgePermissions?.allowAiCli ?? true,
    allowTerminalView: peer.bridgePermissions?.allowTerminalView ?? true,
    allowTerminalControl: peer.bridgePermissions?.allowTerminalControl ?? true,
  }))
  const [addingRoute, setAddingRoute] = useState(false)
  const [routeInput, setRouteInput] = useState('')
  const [routeBusy, setRouteBusy] = useState(false)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    setPerms({
      allowAiCli: peer.bridgePermissions?.allowAiCli ?? true,
      allowTerminalView: peer.bridgePermissions?.allowTerminalView ?? true,
      allowTerminalControl: peer.bridgePermissions?.allowTerminalControl ?? true,
    })
  }, [peer.bridgePermissions?.allowAiCli, peer.bridgePermissions?.allowTerminalControl, peer.bridgePermissions?.allowTerminalView])

  const handleTogglePerm = async (key: keyof PeerBridgePermissions, value: boolean) => {
    const prev = perms
    const next = { ...perms, [key]: value }
    setPerms(next)
    try {
      await companionSetPeerPermissions(peer.peerDeviceId, next)
      await onRefresh()
    } catch {
      setPerms(prev)
    }
  }

  const handleAddRoute = async () => {
    const parsed = parsePairingQrPayload(routeInput)
    if (!parsed || parsed.hosts.length === 0) return
    setRouteBusy(true)
    try {
      for (const host of parsed.hosts) {
        await companionAddPeerRoute({
          peerDeviceId: peer.peerDeviceId,
          host,
          port: parsed.port,
        })
      }
      setRouteInput('')
      setAddingRoute(false)
      await onRefresh()
    } finally {
      setRouteBusy(false)
    }
  }

  const routes = peer.routes && peer.routes.length > 0
    ? peer.routes
    : peer.peerEndpoint
      ? [{ kind: 'lan' as const, host: peer.peerEndpoint, port: 0 }]
      : []

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            connected
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
          )}
        >
          <Smartphone className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[13.5px] font-medium text-[var(--workspace-text-strong)]">
              {peer.peerDeviceName ?? t('sync.unknown')}
            </p>
            {connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                {copy.connectedNow}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">
            {peer.peerEndpoint ?? t('sync.noEndpoint')}
            {' · '}
            {new Date(peer.lastSeenAt).toLocaleDateString()}
          </p>
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 text-[11.5px] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
          disabled={removing}
          onClick={async () => {
            setRemoving(true)
            try {
              await onRemove(peer.peerDeviceId)
            } finally {
              setRemoving(false)
            }
          }}
        >
          <Unlink className="h-3 w-3" />
          {copy.revokeDevice}
        </Button>
      </div>

      {/* Inline 3 Permissions */}
      <div className="grid gap-2 sm:grid-cols-3">
        {([
          { key: 'allowAiCli', label: copy.allowAiCli },
          { key: 'allowTerminalView', label: copy.allowTerminalView },
          { key: 'allowTerminalControl', label: copy.allowTerminalControl },
        ] as const).map((item) => (
          <label
            key={item.key}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/60 px-3 py-2 text-[12px]"
          >
            <span className="truncate text-[var(--workspace-text)]">{item.label}</span>
            <Switch
              checked={perms[item.key]}
              label={item.label}
              onChange={(v) => void handleTogglePerm(item.key, v)}
            />
          </label>
        ))}
      </div>

      {/* Saved Routes + Inline Add Route */}
      <div className="flex flex-wrap items-center gap-1.5">
        {routes.map((r, idx) => (
          <span
            key={`${r.host}:${r.port}:${idx}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px]',
              r.kind === 'tailnet' || r.kind === 'iroh'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
            )}
          >
            <span className="font-sans text-[10px] font-medium opacity-80">
              {r.kind === 'tailnet' ? copy.routeTailnet : r.kind === 'lan' ? copy.routeLan : r.kind === 'iroh' ? copy.routeIroh : copy.routeCustom}
            </span>
            <span>{r.kind === 'iroh' ? `${r.host.slice(0, 8)}…` : r.port > 0 ? `${r.host}:${r.port}` : r.host}</span>
          </span>
        ))}
        {!addingRoute ? (
          <button
            type="button"
            onClick={() => setAddingRoute(true)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-[color:var(--workspace-border-soft)] px-2 py-0.5 text-[11px] text-[var(--workspace-text-subtle)] transition-colors hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text)]"
          >
            <Plus className="h-3 w-3" />
            {copy.addRouteInline}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={routeInput}
              onChange={(e) => setRouteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && routeInput.trim() && !routeBusy) void handleAddRoute()
                if (e.key === 'Escape') setAddingRoute(false)
              }}
              placeholder={copy.addRoutePlaceholder}
              className="h-7 w-56 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:font-sans focus:border-[color:var(--workspace-primary-500)]"
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={routeBusy || !routeInput.trim()}
              onClick={() => void handleAddRoute()}
            >
              {routeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : copy.addRouteAction}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
