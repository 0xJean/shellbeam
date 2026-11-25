import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import QRCode from 'qrcode'
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Laptop,
  Loader2,
  Play,
  Radio,
  ScanLine,
  Smartphone,
  Sparkles,
  Terminal,
  Unplug,
  Wifi,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import { fill } from '@/lib/locales/probe-install'
import { copyTextToClipboard } from '@/lib/clipboard'
import { isMobileDevice } from '@/lib/mobile-back'
import {
  buildPairingQrPayload,
  companionConnect,
  companionDisconnect,
  companionKickClient,
  companionLocalEndpoints,
  describeCompanionError,
  EMPTY_COMPANION_SERVER,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  getCompanionServerSnapshot,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  isTauriRuntime,
  localizeSessionStatus,
  openCompanionCenter,
  openRemoteDesktopSession,
  requestMobileQrScan,
  resolveDesktopSessionTitle,
  subscribeCompanionServer,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
} from '@/lib/companion'
import type { HostProfile } from '@/lib/hosts'
import type { PeerRoute, SyncTrustedPeer } from '@/lib/sync'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface CompanionTopBarInfo {
  deviceName?: string
  serverRunning: boolean
  serverPort: number
  onStartServer?: () => Promise<void>
  trustedPeers?: SyncTrustedPeer[]
  hosts?: HostProfile[]
}

/**
 * Always-visible top-bar companion status pill.
 * - On desktop OS: shows Mobile Remote host quick-connect QR popover & connected phones.
 * - On mobile/tablet OS with wide screen (unfolded foldables / iPad): shows My Desktop client
 *   status pill with 1-click connect, QR scan, and live desktop session shortcuts.
 */
export function CompanionStatusPill({ info }: { info?: CompanionTopBarInfo }) {
  if (isMobileDevice()) {
    return <MobileClientTopBarPill info={info} />
  }
  return <DesktopHostTopBarPill info={info} />
}

function MobileClientTopBarPill({ info }: { info?: CompanionTopBarInfo }) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
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
  const [open, setOpen] = useState(false)
  const [busyPeerId, setBusyPeerId] = useState<string | null>(null)
  const [connectError, setConnectError] = useState('')
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverPos({
      top: Math.round(rect.bottom + 6),
      right: Math.max(8, Math.round(window.innerWidth - rect.right)),
    })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onResize = () => updatePosition()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const connected = status.state === 'connected'
  const peers = info?.trustedPeers ?? []
  const hosts = info?.hosts ?? []
  const routeBadge = status.routeKind === 'tailnet'
    ? copy.routeTailnet
    : status.routeKind === 'lan'
      ? copy.routeLan
      : status.routeKind === 'iroh'
        ? copy.routeIroh
        : copy.routeCustom

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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="companion-status-pill"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          connected
            ? 'border border-emerald-500/40 bg-emerald-500/12 text-emerald-400 hover:bg-emerald-500/20'
            : open
              ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active'
              : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]',
        )}
        title={connected ? (status.peerDeviceName || copy.myDesktop) : copy.myDesktop}
      >
        {connected && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
        <Laptop className={cn('h-3.5 w-3.5', !connected && 'text-[var(--workspace-accent-text)]')} />
        <span className="max-w-[130px] truncate">
          {connected ? (status.peerDeviceName || copy.myDesktop) : copy.myDesktop}
        </span>
      </button>

      {open && popoverPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={copy.myDesktop}
          style={{ top: popoverPos.top, right: popoverPos.right }}
          className="fixed z-[100] w-80 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-xs shadow-[var(--workspace-shadow-overlay)]"
        >
          <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--workspace-text-strong)]">
              <Laptop className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />
              <span>{connected ? (status.peerDeviceName || copy.myDesktop) : copy.myDesktop}</span>
            </div>
            {connected && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-400">
                <Radio className="h-2.5 w-2.5" />
                {routeBadge}
              </span>
            )}
          </div>

          {connected ? (
            <div className="space-y-2 p-3">
              {workspace.sessions.length === 0 ? (
                <p className="py-2 text-center text-[11.5px] text-[var(--workspace-text-muted)]">
                  {copy.desktopWaitingHint}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {workspace.sessions.slice(0, 5).map((sess) => {
                    const aiSnap = workspace.aiBySession[sess.sessionId]
                    const { title } = resolveDesktopSessionTitle(sess, aiSnap, hosts, copy.localShellLabel)
                    const statusInfo = localizeSessionStatus(sess.status, copy)
                    return (
                      <button
                        key={sess.sessionId}
                        type="button"
                        onClick={() => {
                          setOpen(false)
                          openRemoteDesktopSession(sess.sessionId)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg bg-[var(--workspace-surface-900)] px-2.5 py-2 text-left hover:bg-[var(--workspace-surface-800)]"
                      >
                        {aiSnap && (aiSnap.messages.length > 0 || aiSnap.pendingCommand)
                          ? <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
                          : <Terminal className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-[var(--workspace-text-strong)]">{title}</p>
                          <p className="truncate text-[10.5px] text-[var(--workspace-text-muted)]">
                            {aiSnap?.modelLabel ? `${aiSnap.modelLabel} · ${statusInfo.label}` : statusInfo.label}
                          </p>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
                      </button>
                    )
                  })}
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full gap-1.5 text-[11.5px]"
                onClick={() => void companionDisconnect()}
              >
                <Unplug className="h-3.5 w-3.5" />
                {copy.disconnect}
              </Button>
            </div>
          ) : (
            <div className="space-y-2.5 p-3">
              {peers.length > 0 && (
                <div className="space-y-1.5">
                  {peers.slice(0, 3).map((peer) => {
                    const isBusy = busyPeerId === peer.peerDeviceId || (status.state === 'connecting' && status.peerDeviceId === peer.peerDeviceId)
                    return (
                      <div key={peer.peerDeviceId} className="flex items-center gap-2 rounded-lg bg-[var(--workspace-surface-900)] px-2.5 py-2">
                        <Wifi className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--workspace-text-strong)]">
                          {peer.peerDeviceName ?? peer.peerDeviceId}
                        </span>
                        <Button
                          size="sm"
                          className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                          disabled={isBusy}
                          onClick={() => void handleConnect(peer.peerDeviceId)}
                        >
                          {isBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                          {isBusy ? copy.connecting : copy.connectDesktop}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}

              {(connectError || status.error) && (
                <p className="rounded-lg bg-[var(--workspace-status-bad-bg)] px-2.5 py-2 text-[11px] leading-relaxed text-[color:var(--workspace-status-bad-text)]">
                  {describeCompanionError(connectError || status.error, locale).message}
                </p>
              )}

              <Button
                size="sm"
                variant="outline"
                className="h-8 w-full gap-1.5 text-[12px]"
                onClick={() => {
                  setOpen(false)
                  requestMobileQrScan()
                  openCompanionCenter()
                }}
              >
                <ScanLine className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />
                {copy.scanQrAction}
              </Button>
            </div>
          )}

          <div className="border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/60 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openCompanionCenter()
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-nav-hover-bg)]"
            >
              <span>{copy.myDesktop}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function DesktopHostTopBarPill({ info }: { info?: CompanionTopBarInfo }) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const serverSnap = useSyncExternalStore(
    subscribeCompanionServer,
    getCompanionServerSnapshot,
    () => EMPTY_COMPANION_SERVER,
  )
  const clients = serverSnap.clients
  const [open, setOpen] = useState(false)
  const [routes, setRoutes] = useState<PeerRoute[]>([])
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [startingServer, setStartingServer] = useState(false)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverPos({
      top: Math.round(rect.bottom + 6),
      right: Math.max(8, Math.round(window.innerWidth - rect.right)),
    })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    let active = true
    void companionLocalEndpoints().then((list) => {
      if (active) setRoutes(list)
    })
    let unlistenEndpoints: (() => void) | undefined
    if (isTauriRuntime()) {
      void listen('companion:endpoints-changed', () => {
        void companionLocalEndpoints().then((list) => {
          if (active) setRoutes(list)
        })
      }).then((fn) => { unlistenEndpoints = fn })
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onResize = () => updatePosition()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      active = false
      unlistenEndpoints?.()
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, info?.serverRunning, info?.serverPort])

  const pairPayload = useMemo(
    () => buildPairingQrPayload({ routes, port: info?.serverPort || 9123, deviceName: info?.deviceName }),
    [routes, info?.serverPort, info?.deviceName],
  )

  useEffect(() => {
    if (!open || routes.length === 0) {
      setQrDataUrl('')
      return
    }
    let active = true
    void QRCode.toDataURL(pairPayload, {
      margin: 2,
      width: 260,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => { if (active) setQrDataUrl(url) })
      .catch(() => { if (active) setQrDataUrl('') })
    return () => { active = false }
  }, [open, pairPayload, routes.length])

  const connected = clients.length > 0
  const primaryName = clients.length === 1
    ? clients[0].peerDeviceName
    : clients.length > 1
      ? `${clients[0].peerDeviceName} +${clients.length - 1}`
      : copy.navLabel

  const routeLabel = (kind: string) => (
    kind === 'tailnet'
      ? copy.routeTailnet
      : kind === 'lan'
        ? copy.routeLan
        : kind === 'iroh'
          ? copy.routeIroh
          : copy.routeCustom
  )

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(pairPayload)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }
  }

  const handleStartServer = async () => {
    if (!info?.onStartServer) return
    setStartingServer(true)
    try {
      await info.onStartServer()
      const list = await companionLocalEndpoints()
      setRoutes(list)
    } finally {
      setStartingServer(false)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="companion-status-pill"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          connected
            ? 'border border-emerald-500/40 bg-emerald-500/12 text-emerald-400 hover:bg-emerald-500/20'
            : open
              ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active'
              : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]',
        )}
        title={connected ? fill(copy.connectedClientsBanner, { name: primaryName }) : copy.navLabel}
      >
        {connected && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
        <Smartphone className={cn('h-3.5 w-3.5', !connected && 'text-[var(--workspace-accent-text)]')} />
        <span className="max-w-[120px] truncate">{primaryName}</span>
      </button>

      {open && popoverPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={copy.navLabel}
          style={{ top: popoverPos.top, right: popoverPos.right }}
          className="fixed z-[100] w-80 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-xs shadow-[var(--workspace-shadow-overlay)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--workspace-text-strong)]">
              <Smartphone className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />
              <span>{copy.navLabel}</span>
            </div>
            {info && (
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 font-mono text-[10.5px]',
                  info.serverRunning
                    ? 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]'
                    : 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
                )}
              >
                {info.serverRunning
                  ? fill(copy.serverRunningBadge, { port: info.serverPort })
                  : copy.serverStoppedBadge}
              </span>
            )}
          </div>

          {/* Connected clients (if any) */}
          {clients.length > 0 && (
            <div className="space-y-1.5 border-b border-[color:var(--workspace-border-soft)] bg-emerald-500/5 p-3">
              {clients.map((client) => (
                <div
                  key={client.connId}
                  className="flex items-center gap-2 rounded-lg bg-[var(--workspace-surface-900)] px-2.5 py-1.5"
                >
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[var(--workspace-text-strong)]">{client.peerDeviceName}</p>
                    <p className="truncate font-mono text-[10px] text-[var(--workspace-text-subtle)]">{client.remoteAddr}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void companionKickClient(client.connId)}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-[var(--workspace-status-bad-bg)] px-2 text-[10.5px] font-medium text-[color:var(--workspace-status-bad-text)] hover:opacity-90"
                  >
                    <Unplug className="h-3 w-3" />
                    {copy.kickClient}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Quick QR + Server Start + Copy Link */}
          <div className="space-y-3 p-3.5">
            {info && !info.serverRunning && info.onStartServer && (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--workspace-status-warn-bg)] px-2.5 py-2 text-[11px] text-[color:var(--workspace-status-warn-text)]">
                <span className="min-w-0 flex-1">{copy.serverStoppedBadge}</span>
                <Button
                  size="sm"
                  className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                  disabled={startingServer}
                  onClick={() => void handleStartServer()}
                >
                  {startingServer ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  {copy.startServerAction}
                </Button>
              </div>
            )}

            <div className="flex flex-col items-center gap-2.5">
              {qrDataUrl ? (
                <div className="rounded-xl bg-white p-2 shadow-sm">
                  <img src={qrDataUrl} alt={copy.qrPairTitle} className="block h-[136px] w-[136px]" />
                </div>
              ) : (
                <p className="py-4 text-center text-[11px] text-[var(--workspace-text-subtle)]">
                  {copy.qrUnavailable}
                </p>
              )}
              <p className="text-center text-[11px] text-[var(--workspace-text-muted)]">
                {copy.quickPopoverHint}
              </p>
            </div>

            {routes.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {routes.slice(0, 3).map((r) => (
                  <span
                    key={`${r.kind}:${r.host}:${r.port}`}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px]',
                      r.kind === 'tailnet' || r.kind === 'iroh'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
                    )}
                  >
                    <Radio className="h-2.5 w-2.5" />
                    <span className="font-sans font-medium">{routeLabel(r.kind)}</span>
                    <span>{r.kind === 'iroh' ? `${r.host.slice(0, 8)}…` : r.host}</span>
                  </span>
                ))}
              </div>
            )}

            {routes.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full gap-1.5 text-[11.5px]"
                onClick={() => void handleCopy()}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? copy.copied : copy.copyPairLink}
              </Button>
            )}
          </div>

          {/* Footer link to dedicated Mobile Remote page */}
          <div className="border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/60 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openCompanionCenter()
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-nav-hover-bg)]"
            >
              <span>{copy.openCenter}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
