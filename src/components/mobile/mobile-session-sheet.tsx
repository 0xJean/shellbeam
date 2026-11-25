import { useSyncExternalStore } from 'react'
import type { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { companionCopy } from '@/lib/locales/companion'
import {
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
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { isMobileDevice, useMobileBackHandler } from '@/lib/mobile-back'
import { ChevronRight, Laptop, Plus, SquareTerminal, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from '../host-display-meta'
import { sessionStatusDot, sheetPrimaryButton, sheetTintedButton } from './mobile-terminal-styles'

interface MobileSessionSheetProps {
  sessionTabs: SessionTab[]
  activeSessionId: string | null
  hosts: HostProfile[]
  networkByAddress: ReturnType<typeof useHostNetworkMetadata>
  inventoryStates: ReturnType<typeof useWorkspaceInventoryStates>
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewConnection: () => void
  onOpenLocalTerminal?: () => void
  onClose: () => void
}

export function MobileSessionSheet({
  sessionTabs, activeSessionId, hosts, networkByAddress, inventoryStates, onSelectSession, onCloseSession, onNewConnection, onOpenLocalTerminal, onClose,
}: MobileSessionSheetProps) {
  const { t, locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const compCopy = companionCopy[locale] ?? companionCopy['zh-CN']
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
  useMobileBackHandler(true, onClose)
  const statusText = (status: SessionTab['status']) => status === 'connecting' ? copy.connecting : status === 'reconnecting' ? copy.reconnecting : status === 'error' ? copy.failed : status === 'closed' ? copy.disconnected : null

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden" data-testid="mobile-session-sheet">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <section role="dialog" aria-modal="true" aria-label={copy.switchSession}
        className="relative flex max-h-[80dvh] flex-col rounded-t-[20px] bg-[var(--workspace-surface-950)] px-4 shadow-[var(--workspace-shadow-overlay)]"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}>
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--workspace-border-strong)]" aria-hidden="true" />
        <header className="flex shrink-0 items-center justify-between">
          <h2 className="text-[17px] font-semibold text-[var(--workspace-text-strong)]">{fill(copy.sessionsCount, { count: sessionTabs.length })}</h2>
          <button type="button" onClick={onClose} className="flex h-11 min-w-11 items-center justify-end text-[15px] text-[var(--workspace-accent-text)]">{copy.done}</button>
        </header>
        <ul className="sb-card mb-3 min-h-0 overflow-y-auto">
          {sessionTabs.map((tab) => {
            const isActive = tab.sessionId === activeSessionId
            const host = resolveHostForDisplay(hosts, tab.hostId, tab.hostAddress)
            const isLocal = tab.connectionKind === 'local'
            const pending = statusText(tab.status)
            return (
              <li key={tab.sessionId} className="flex items-center border-b border-[color:var(--workspace-border-soft)] last:border-b-0">
                <button type="button" aria-current={isActive || undefined} onClick={() => { onSelectSession(tab.sessionId); onClose() }}
                  className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2.5 pl-3.5 text-left">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', sessionStatusDot(tab.status))} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[15px] text-[var(--workspace-text-strong)]">{tab.hostName || tab.hostAddress || copy.localShell}</span>
                      {isActive && <span className="shrink-0 rounded-md bg-[var(--workspace-accent-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--workspace-accent-text)]">{copy.current}</span>}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
                      {pending ? <span className="truncate">{pending}</span> : isLocal ? <span className="truncate">{copy.local}</span> : (
                        <>
                          {host?.username && tab.hostAddress && <span className="shrink-0 truncate">{host.username}@{tab.hostAddress}</span>}
                          <HostMetadataLine network={host ? networkByAddress[host.address] : undefined} resource={getHostInventoryResource(host, inventoryStates)}
                            regionLabel={!host?.username && tab.hostAddress && tab.hostName ? tab.hostAddress : undefined}
                            className="min-w-0 flex-nowrap text-xs text-[var(--workspace-text-muted)]" itemClassName="max-w-[8rem]" iconClassName="h-3 w-3" />
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <button type="button" aria-label={`${copy.closeSession} ${tab.hostName || tab.hostAddress}`} onClick={() => onCloseSession(tab.sessionId)}
                  className="mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--workspace-text-muted)] active:bg-[var(--workspace-surface-800)]">
                  <X className="h-[18px] w-[18px]" />
                </button>
              </li>
            )
          })}
        </ul>
        {companionStatus.state === 'connected' && companionWorkspace.sessions.length > 0 && (
          <div className="mb-3">
            <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] text-[var(--workspace-text-muted)]">
              <Laptop className="h-3.5 w-3.5 text-emerald-400" />
              <span>{fill(compCopy.fromDesktop, { name: companionStatus.peerDeviceName || compCopy.myDesktop })}</span>
            </p>
            <ul className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden">
              {companionWorkspace.sessions.map((sess) => {
                const aiSnap = companionWorkspace.aiBySession[sess.sessionId]
                const { title } = resolveDesktopSessionTitle(sess, aiSnap, hosts, compCopy.localShellLabel)
                const statusInfo = localizeSessionStatus(sess.status, compCopy)
                return (
                  <li key={sess.sessionId}>
                    <button
                      type="button"
                      onClick={() => { onClose(); openRemoteDesktopSession(sess.sessionId) }}
                      className="flex min-h-[54px] w-full items-center gap-3 px-3.5 py-2 text-left active:bg-[var(--workspace-surface-800)]"
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', statusInfo.live ? 'bg-emerald-400' : 'bg-[var(--workspace-text-subtle)]')} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] text-[var(--workspace-text-strong)]">{title}</span>
                        <span className="block truncate text-[11.5px] text-[var(--workspace-text-muted)]">
                          {aiSnap?.modelLabel ? `${aiSnap.modelLabel} · ${statusInfo.label}` : statusInfo.label}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <div className="flex shrink-0 gap-3">
          <button type="button" onClick={() => { onNewConnection(); onClose() }} className={sheetPrimaryButton}><Plus className="h-4 w-4" />{t('mobile.newConnection')}</button>
          {showLocalTerminal && (
            <button type="button" onClick={() => { onOpenLocalTerminal(); onClose() }} className={sheetTintedButton}><SquareTerminal className="h-4 w-4" />{t('mobile.localTerminal')}</button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}
