import { useMemo, useState, useSyncExternalStore } from 'react'
import type { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import type { SyncTrustedPeer } from '@/lib/sync'
import { matchesHostSearch } from '@/lib/host-search'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { companionCopy } from '@/lib/locales/companion'
import {
  companionConnect,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  localizeSessionStatus,
  openRemoteDesktopSession,
  resolveDesktopSessionTitle,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
} from '@/lib/companion'
import type { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { isMobileDevice } from '@/lib/mobile-back'
import { ChevronRight, Laptop, Loader2, Plus, Search, Server, Sparkles, SquareTerminal, Terminal, X } from 'lucide-react'
import { getHostInventoryResource, HostMetadataLine } from '../host-display-meta'
import { WorkspaceOsIcon } from '../workspace/workspace-os-icon'
import { sheetPrimaryButton, sheetTintedButton } from './mobile-terminal-styles'
import { cn } from '@/lib/utils'

interface MobileNoSessionProps {
  hosts: HostProfile[]
  trustedPeers?: SyncTrustedPeer[]
  networkByAddress: ReturnType<typeof useHostNetworkMetadata>
  inventoryStates: ReturnType<typeof useWorkspaceInventoryStates>
  onNewConnection: () => void
  onOpenLocalTerminal?: () => void
  onOpenCompanion?: () => void
  onConnectHost?: (hostId: string) => void
}

/**
 * Mobile Sessions Launcher shown when there are no local SSH tabs yet.
 * Replaces a dead-end empty box with:
 * - Compact header + 1-tap Quick Connect button
 * - Live desktop sessions (or 1-tap connect to paired computer)
 * - Instant host search + 1-tap terminal launch
 */
export function MobileNoSession({
  hosts,
  trustedPeers = [],
  networkByAddress,
  inventoryStates,
  onNewConnection,
  onOpenLocalTerminal,
  onOpenCompanion,
  onConnectHost,
}: MobileNoSessionProps) {
  const { t, locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const compCopy = companionCopy[locale] ?? companionCopy['zh-CN']
  const isZh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null)

  const companionStatus = useSyncExternalStore(
    subscribeCompanionStatus,
    getCompanionStatusSnapshot,
    () => EMPTY_COMPANION_STATUS,
  )
  const companionWorkspace = useSyncExternalStore(
    subscribeCompanionWorkspace,
    getCompanionWorkspaceSnapshot,
    () => EMPTY_COMPANION_WORKSPACE,
  )
  const showLocalTerminal = !!onOpenLocalTerminal && !isMobileDevice()

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    [hosts],
  )
  const visibleHosts = useMemo(() => {
    const q = query.trim()
    if (!q) return sortedHosts.slice(0, 12)
    return sortedHosts.filter((h) => matchesHostSearch(h, q, sortedHosts))
  }, [query, sortedHosts])

  const groupLabel = (group: string) => { const label = t(`group.${group}`); return label !== `group.${group}` ? label : group }
  const primaryPeer = trustedPeers[0] ?? null
  const isConnectedDesktop = companionStatus.state === 'connected'
  const desktopSessions = isConnectedDesktop ? companionWorkspace.sessions : []
  const hasAnything = hosts.length > 0 || desktopSessions.length > 0

  const handleQuickConnectDesktop = async (peerId: string) => {
    setConnectingPeerId(peerId)
    try {
      await companionConnect(peerId)
    } catch {
      onOpenCompanion?.()
    } finally {
      setConnectingPeerId(null)
    }
  }

  return (
    <div data-testid="mobile-session-launcher" className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-y-auto px-4 pb-24">
      {/* Compact launcher header: title + 1-tap quick connect */}
      <header className="flex items-center justify-between gap-2 pb-3 pt-5">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-[var(--workspace-text-strong)]">
          {copy.sessions}
        </h1>
        <div className="flex items-center gap-2">
          {showLocalTerminal && (
            <button
              type="button"
              onClick={onOpenLocalTerminal}
              aria-label={t('mobile.localTerminal')}
              title={t('mobile.localTerminal')}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--workspace-surface-800)] text-[var(--workspace-text)] active:opacity-80"
            >
              <SquareTerminal className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            data-testid="mobile-launcher-new-connection"
            onClick={onNewConnection}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[color:var(--workspace-primary-500)] px-3.5 text-[13px] font-medium text-[var(--workspace-primary-foreground)] active:opacity-85"
          >
            <Plus className="h-4 w-4" />
            <span>{t('mobile.newConnection')}</span>
          </button>
        </div>
      </header>

      {/* Desktop Companion sessions or 1-tap quick connect banner */}
      {desktopSessions.length > 0 ? (
        <section className="mb-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--workspace-text-muted)]">
              <Laptop className="h-3.5 w-3.5 text-emerald-400" />
              <span>{fill(compCopy.fromDesktop, { name: companionStatus.peerDeviceName || compCopy.myDesktop })}</span>
            </h2>
            {onOpenCompanion && (
              <button type="button" onClick={onOpenCompanion} className="text-xs text-[var(--workspace-accent-text)]">
                {compCopy.myDesktop}
              </button>
            )}
          </div>
          <ul className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden">
            {desktopSessions.map((sess) => {
              const aiSnap = companionWorkspace.aiBySession[sess.sessionId]
              const hasPending = Boolean(aiSnap?.pendingCommand)
              const { title } = resolveDesktopSessionTitle(sess, aiSnap, hosts, compCopy.localShellLabel)
              const statusInfo = localizeSessionStatus(sess.status, compCopy)
              return (
                <li key={sess.sessionId}>
                  <button
                    type="button"
                    onClick={() => openRemoteDesktopSession(sess.sessionId)}
                    className="flex min-h-[58px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-400">
                      {aiSnap && (aiSnap.messages.length > 0 || hasPending || aiSnap.isStreaming)
                        ? <Sparkles className="h-4 w-4" />
                        : <Terminal className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusInfo.live ? 'bg-emerald-400' : 'bg-[var(--workspace-text-subtle)]')} />
                        <span className="truncate text-[15px] font-medium text-[var(--workspace-text-strong)]">{title}</span>
                        {hasPending && (
                          <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                            {compCopy.pendingApprovalBadge}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--workspace-text-muted)]">
                        {aiSnap?.modelLabel ? `${aiSnap.modelLabel} · ${statusInfo.label}` : statusInfo.label}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : isConnectedDesktop ? (
        <button
          type="button"
          onClick={onOpenCompanion}
          className="sb-card mb-4 flex items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--workspace-text-muted)]">
            <strong className="font-medium text-[var(--workspace-text-strong)]">{companionStatus.peerDeviceName || compCopy.myDesktop}</strong>
            {' · '}
            {compCopy.noDesktopSessions}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
        </button>
      ) : primaryPeer ? (
        <div className="sb-card mb-4 flex items-center gap-3 px-3.5 py-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
            <Laptop className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium text-[var(--workspace-text-strong)]">
              {primaryPeer.peerDeviceName}
            </p>
            <p className="truncate text-[11.5px] text-[var(--workspace-text-muted)]">
              {isZh ? '直连电脑即可实时接管桌面终端与 AI' : 'Connect to mirror live desktop terminals & AI'}
            </p>
          </div>
          <button
            type="button"
            disabled={connectingPeerId === primaryPeer.peerDeviceId || companionStatus.state === 'connecting'}
            onClick={() => void handleQuickConnectDesktop(primaryPeer.peerDeviceId)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-[var(--workspace-accent-subtle)] px-3 text-xs font-medium text-[color:var(--workspace-accent-text)] active:opacity-80 disabled:opacity-50"
          >
            {(connectingPeerId === primaryPeer.peerDeviceId || companionStatus.state === 'connecting') && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            <span>{compCopy.connectDesktop}</span>
          </button>
        </div>
      ) : null}

      {/* Truly empty state only when there are zero hosts and zero desktop sessions */}
      {!hasAnything ? (
        <section className="sb-card flex flex-col items-center px-4 pb-5 pt-7 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
            <SquareTerminal className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="mt-4 text-[17px] font-semibold text-[var(--workspace-text-strong)]">{t('mobile.noSessions')}</p>
          <p className="mt-1 text-sm text-[var(--workspace-text-muted)]">{t('mobile.noSessionsHint')}</p>
          <div className="mt-4 flex w-full gap-3">
            <button type="button" onClick={onNewConnection} className={sheetPrimaryButton}><Plus className="h-4 w-4" />{t('mobile.newConnection')}</button>
            {showLocalTerminal && (
              <button type="button" onClick={onOpenLocalTerminal} className={sheetTintedButton}><SquareTerminal className="h-4 w-4" />{t('mobile.localTerminal')}</button>
            )}
          </div>
        </section>
      ) : hosts.length > 0 && onConnectHost ? (
        <section>
          <label className="mb-3 flex h-10 items-center gap-2 rounded-xl bg-[var(--workspace-surface-800)] px-3 text-[var(--workspace-text-subtle)]">
            <Search className="h-4 w-4 shrink-0" />
            <input
              type="search"
              data-testid="mobile-launcher-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isZh ? '搜索主机、IP 或分组直接连接…' : 'Search hosts, IP, or group to connect…'}
              aria-label={isZh ? '搜索主机' : 'Search hosts'}
              className="min-w-0 flex-1 bg-transparent text-[14.5px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear" className="flex h-8 w-8 items-center justify-center">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>

          <h2 className="mb-2 px-1 text-[13px] text-[var(--workspace-text-muted)]">
            {query.trim()
              ? (isZh ? `匹配主机 · ${visibleHosts.length}` : `Matching hosts · ${visibleHosts.length}`)
              : fill(copy.quickConnectRecent, { count: visibleHosts.length })}
          </h2>

          {visibleHosts.length === 0 ? (
            <div className="sb-card px-4 py-6 text-center text-sm text-[var(--workspace-text-muted)]">
              {t('hosts.noMatchHint')}
            </div>
          ) : (
            <ul className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden">
              {visibleHosts.map((host) => {
                const resource = getHostInventoryResource(host, inventoryStates)
                return (
                  <li key={host.id}>
                    <button
                      type="button"
                      onClick={() => onConnectHost(host.id)}
                      className="flex min-h-[60px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]">
                        {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-4 w-4" /> : <Server className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[15px] font-medium text-[var(--workspace-text-strong)]">{host.name}</span>
                          {host.group && (
                            <span className="shrink-0 rounded bg-[var(--workspace-surface-800)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--workspace-text-muted)]">
                              {groupLabel(host.group)}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
                          <HostMetadataLine network={networkByAddress[host.address]} showSystem={false} showLocationText={false} className="shrink-0 flex-nowrap" iconClassName="h-3 w-3" />
                          <span className="truncate font-mono">{host.username ? `${host.username}@${host.address}` : host.address}</span>
                        </span>
                      </span>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]">
                        <Terminal className="h-4 w-4" />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}
