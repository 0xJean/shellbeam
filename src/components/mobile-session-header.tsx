import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useT } from '@/lib/i18n'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { requestTerminalAiToggle } from '@/lib/terminal-events'
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { ChevronDown, ChevronLeft, Ellipsis, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { MobileNoSession } from './mobile/mobile-no-session'
import { MobileSessionSheet } from './mobile/mobile-session-sheet'
import { sessionStatusDot } from './mobile/mobile-terminal-styles'

interface MobileSessionHeaderProps {
  sessionTabs: SessionTab[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewConnection: () => void
  onOpenLocalTerminal: () => void
  hosts?: HostProfile[]
  onConnectHost?: (hostId: string) => void
  onBack?: () => void
  /** Opens the terminal side drawer (snippets, history, look). */
  onOpenDrawer?: () => void
}

const iconButton = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--workspace-text)] active:bg-[var(--workspace-surface-800)]'

export function MobileSessionHeader({
  sessionTabs,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewConnection,
  onOpenLocalTerminal,
  hosts = [],
  onConnectHost,
  onBack,
  onOpenDrawer,
}: MobileSessionHeaderProps) {
  const { t, locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [listOpen, setListOpen] = useState(false)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  if (sessionTabs.length === 0) {
    return (
      <MobileNoSession hosts={hosts} networkByAddress={networkByAddress} inventoryStates={inventoryStates}
        onNewConnection={onNewConnection} onOpenLocalTerminal={onOpenLocalTerminal} onConnectHost={onConnectHost} />
    )
  }

  const activeIndex = sessionTabs.findIndex((tab) => tab.sessionId === activeSessionId)
  const activeTab = activeIndex >= 0 ? sessionTabs[activeIndex] : undefined

  return (
    <>
      <div data-testid="mobile-session-header" className="relative flex h-12 shrink-0 items-center gap-1 bg-[var(--workspace-surface-950)] px-1">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label={copy.back} className={cn(iconButton, 'text-[var(--workspace-accent-text)]')}>
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : <span className="w-11 shrink-0" />}
        <div className="flex min-w-0 flex-1 justify-center">
          <button
            type="button"
            onClick={() => setListOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={listOpen}
            aria-label={copy.switchSession}
            className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--workspace-surface-800)] px-3.5 active:opacity-80"
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', activeTab ? sessionStatusDot(activeTab.status) : 'bg-[var(--workspace-text-subtle)]')} />
            <span className="min-w-0 truncate text-[15px] font-semibold text-[var(--workspace-text-strong)]">
              {activeTab?.hostName || activeTab?.hostAddress || t('mobile.selectSession')}
            </span>
            <span className="shrink-0 rounded-md bg-[var(--workspace-surface-700)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--workspace-text-muted)]">
              {activeIndex >= 0 ? `${activeIndex + 1}/${sessionTabs.length}` : sessionTabs.length}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />
          </button>
        </div>
        {activeTab?.status === 'connected' ? (
          <button type="button" onClick={() => requestTerminalAiToggle(activeTab.sessionId)} aria-label={copy.aiAssistant} className={iconButton}>
            <Sparkles className="h-5 w-5" />
          </button>
        ) : <span className="w-11 shrink-0" />}
        {onOpenDrawer ? (
          <button type="button" onClick={onOpenDrawer} aria-label={copy.more} className={iconButton}>
            <Ellipsis className="h-5 w-5" />
          </button>
        ) : <span className="w-11 shrink-0" />}
      </div>

      {listOpen && (
        <MobileSessionSheet
          sessionTabs={sessionTabs}
          activeSessionId={activeSessionId}
          hosts={hosts}
          networkByAddress={networkByAddress}
          inventoryStates={inventoryStates}
          onSelectSession={onSelectSession}
          onCloseSession={(sessionId) => { onCloseSession(sessionId); if (sessionTabs.length <= 1) setListOpen(false) }}
          onNewConnection={onNewConnection}
          onOpenLocalTerminal={onOpenLocalTerminal}
          onClose={() => setListOpen(false)}
        />
      )}
    </>
  )
}
