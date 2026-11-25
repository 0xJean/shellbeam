import { useState, useSyncExternalStore } from 'react'
import {
  ChevronRight,
  Laptop,
  Loader2,
  Radio,
  ScanLine,
  Sparkles,
  Terminal,
  Unplug,
  Wifi,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import { fill } from '@/lib/locales/probe-install'
import {
  companionConnect,
  companionDisconnect,
  describeCompanionError,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  localizeSessionStatus,
  openRemoteDesktopSession,
  requestMobileQrScan,
  resolveDesktopSessionTitle,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
} from '@/lib/companion'
import type { HostProfile } from '@/lib/hosts'
import type { SyncTrustedPeer } from '@/lib/sync'
import { cn } from '@/lib/utils'

interface MobileDesktopCompanionCardProps {
  trustedPeers: SyncTrustedPeer[]
  hosts?: HostProfile[]
  onOpenSync?: () => void
}

/**
 * Slim, real-time "My Desktop" hub card for the mobile Hosts page.
 * Desktop sessions push automatically over the Companion Bridge — zero manual refresh needed.
 */
export function MobileDesktopCompanionCard({
  trustedPeers,
  hosts = [],
  onOpenSync,
}: MobileDesktopCompanionCardProps) {
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
  const [busyPeerId, setBusyPeerId] = useState<string | null>(null)
  const [connectError, setConnectError] = useState('')

  if (trustedPeers.length === 0) return null

  const availableClis = status.cliBackends.filter((c) => c.available)
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
    <section
      data-testid="mobile-desktop-companion"
      className="sb-card mx-4 mb-3 overflow-hidden border border-[color:var(--workspace-border-soft)]"
    >
      {/* Compact Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          status.state === 'connected'
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]',
        )}>
          <Laptop className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[14px] font-semibold text-[var(--workspace-text-strong)]">
              {status.state === 'connected' ? (status.peerDeviceName || copy.myDesktop) : copy.myDesktop}
            </p>
            {status.state === 'connected' && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                <Radio className="h-2.5 w-2.5" />
                {routeBadge}
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-[var(--workspace-text-muted)]">
            {status.state === 'connected'
              ? fill(copy.desktopCliReady, { count: availableClis.length })
              : copy.subtitle}
          </p>
        </div>

        {status.state === 'connected' ? (
          <button
            type="button"
            onClick={() => void companionDisconnect()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-[var(--workspace-surface-800)] px-2.5 text-[11.5px] font-medium text-[var(--workspace-text-muted)] active:opacity-80"
          >
            <Unplug className="h-3 w-3" />
            {copy.disconnect}
          </button>
        ) : onOpenSync ? (
          <button
            type="button"
            onClick={() => {
              requestMobileQrScan()
              onOpenSync()
            }}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 text-[11.5px] font-medium text-[var(--workspace-text)] active:opacity-80"
          >
            <ScanLine className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />
            {copy.scanQrAction}
          </button>
        ) : null}
      </div>

      {/* Body */}
      {status.state !== 'connected' ? (
        <div className="divide-y divide-[color:var(--workspace-border-soft)] border-t border-[color:var(--workspace-border-soft)]">
          {trustedPeers.map((peer) => {
            const isBusy = busyPeerId === peer.peerDeviceId || (status.state === 'connecting' && status.peerDeviceId === peer.peerDeviceId)
            return (
              <div key={peer.peerDeviceId} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <Wifi className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--workspace-text-strong)]">
                    {peer.peerDeviceName ?? peer.peerDeviceId}
                  </p>
                  <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                    {peer.peerEndpoint && !peer.peerEndpoint.startsWith('iroh://')
                      ? peer.peerEndpoint
                      : peer.routes?.find((r) => r.kind === 'lan')?.host || copy.routeIroh}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleConnect(peer.peerDeviceId)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-[12px] font-medium text-[var(--workspace-primary-foreground)] active:opacity-80 disabled:opacity-50"
                >
                  {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {isBusy ? copy.connecting : copy.connectDesktop}
                </button>
              </div>
            )
          })}
          {(connectError || status.error) && (() => {
            const described = describeCompanionError(connectError || status.error, locale)
            return (
              <div className="flex items-start justify-between gap-2.5 bg-[var(--workspace-status-bad-bg)]/50 px-3.5 py-2.5">
                <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-[color:var(--workspace-status-bad-text)]">
                  {described.message}
                </p>
                {onOpenSync && (
                  <button
                    type="button"
                    onClick={() => {
                      requestMobileQrScan()
                      onOpenSync()
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[color:var(--workspace-primary-500)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--workspace-primary-foreground)] active:opacity-80"
                  >
                    <ScanLine className="h-3.5 w-3.5" />
                    {copy.scanQrAction}
                  </button>
                )}
              </div>
            )
          })()}
        </div>
      ) : (
        <div className="border-t border-[color:var(--workspace-border-soft)]">
          {workspace.sessions.length === 0 ? (
            <p className="px-3.5 py-2.5 text-[12px] text-[var(--workspace-text-muted)]">
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
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-surface-800)] text-[var(--workspace-accent-text)]">
                      {aiSnap && (aiSnap.messages.length > 0 || aiSnap.isStreaming || hasPending)
                        ? <Sparkles className="h-4 w-4" />
                        : <Terminal className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusInfo.live ? 'bg-emerald-400' : 'bg-[var(--workspace-text-subtle)]')} />
                        <p className="truncate text-[13.5px] font-medium text-[var(--workspace-text-strong)]">
                          {title}
                        </p>
                        {hasPending && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                            {copy.pendingApprovalBadge}
                          </span>
                        )}
                        {!hasPending && aiSnap?.isStreaming && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--workspace-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--workspace-accent-text)]">
                            {copy.aiThinking}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[11.5px] text-[var(--workspace-text-muted)]">
                        {aiSnap?.modelLabel
                          ? `${aiSnap.modelLabel} · ${statusInfo.label}`
                          : statusInfo.label}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
