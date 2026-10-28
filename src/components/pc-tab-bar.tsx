import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { Columns2, LayoutDashboard, Moon, Plus, RefreshCw, Sparkles, SquareTerminal, Sun, X } from 'lucide-react'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from './host-display-meta'

export type { SessionTab }

export interface SessionBrowserTabMeta {
  tabCount: number
  routeScope: 'local' | 'remote' | 'pending'
  routeLabel: string
  detail: string
}

export interface BrowserSwitcherSummary {
  totalTabs: number
  recentHostLabel: string | null
  remoteTabs: number
  localTabs: number
  pendingTabs: number
  scope: 'remote' | 'local' | 'pending' | 'mixed'
}

interface PcSessionTabBarProps {
  sessionTabs: SessionTab[]
  activeSessionId: string | null
  isDashboard: boolean
  isSplit: boolean
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onGoToDashboard: () => void
  onOpenLocalTerminal?: () => void
  onNewConnection?: () => void
  onToggleSplit?: () => void
  hosts?: HostProfile[]
  /** Right-hand actions: AI assistant for the active terminal, theme toggle. */
  onToggleAi?: () => void
  /** The active session's AI bar is open. */
  aiOpen?: boolean
  theme?: string
  onToggleTheme?: () => void
}

export function PcSessionTabBar({
  sessionTabs,
  activeSessionId,
  isDashboard,
  isSplit,
  onSelectSession,
  onCloseSession,
  onGoToDashboard,
  onOpenLocalTerminal,
  onNewConnection,
  onToggleSplit,
  hosts = [],
  onToggleAi,
  aiOpen = false,
  theme,
  onToggleTheme,
}: PcSessionTabBarProps) {
  const { t } = useT()
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  return (
    <div data-testid="pc-tab-bar" className="sticky top-0 z-50 hidden h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-nav-translucent)] px-2 backdrop-blur-sm scrollbar-none md:flex">
      <button
        type="button"
        data-testid="pc-dashboard" onClick={onGoToDashboard}
          className={cn(TAB, isDashboard ? TAB_ACTIVE : TAB_IDLE)}
        title={t('tab.dashboard')}
      >
        <LayoutDashboard className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('tab.dashboard')}</span>
      </button>

      {onOpenLocalTerminal && (
        <button
          type="button"
          onClick={onOpenLocalTerminal}
          className={ICON_BUTTON}
          title={t('tab.localTerminal')}
        >
          <SquareTerminal className="h-4 w-4" />
        </button>
      )}

      {sessionTabs.map((session) => {
        const isActive = !isDashboard && activeSessionId === session.sessionId
        const host = resolveHostForDisplay(hosts, session.hostId, session.hostAddress)
        return (
          <div
            key={session.sessionId}
            data-testid="pc-session-tab"
            data-host-id={session.hostId}
            data-status={session.status}
            data-connection-stage={session.connectionStage}
            className={cn(TAB, 'group pl-2.5 pr-1', isActive ? TAB_ACTIVE : TAB_IDLE)}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5"
              onClick={() => onSelectSession(session.sessionId)}
            >
              {session.status === 'connecting' ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
              <span className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  session.status === 'connected' ? 'bg-[color:var(--workspace-status-good)]' : session.status === 'error' ? 'bg-[color:var(--workspace-status-bad)]' : 'bg-[color:var(--workspace-text-muted)]'
                )} />
              )}
              {host && (
                <HostMetadataLine
                  network={networkByAddress[host.address]}
                  resource={getHostInventoryResource(host, inventoryStates)}
                  showLocationText={false}
                  showSystemText={false}
                  className="hidden flex-nowrap gap-x-1 sm:flex"
                  iconClassName="h-3 w-3"
                />
              )}
              <span className="max-w-[100px] truncate sm:max-w-[140px]">{session.hostName || session.hostAddress}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseSession(session.sessionId) }}
              className="flex h-5 w-5 items-center justify-center rounded opacity-100 transition-all hover:bg-[var(--workspace-surface-700)] sm:opacity-0 sm:group-hover:opacity-100"
              style={isActive ? { opacity: 1 } : undefined}
              title={t('tab.close')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      <div className="ml-1 flex items-center gap-0.5">
        {onNewConnection && (
          <button
          type="button"
          onClick={onNewConnection}
            className={ICON_BUTTON}
            title={t('tab.newSsh')}
          >
            <Plus className="h-4 w-4" />
          </button>
        )}

        {onToggleSplit && sessionTabs.length >= 2 && (
          <button
            type="button"
            onClick={onToggleSplit}
            className={cn(ICON_BUTTON, isSplit && 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active')}
            title={isSplit ? t('tab.exitSplit') : t('tab.splitTerminal')}
          >
            <Columns2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {onToggleAi && !isDashboard && activeSessionId && (
          <button type="button" data-testid="pc-tab-ai" onClick={onToggleAi} title={t('tab.aiAssistant')} aria-pressed={aiOpen}
            className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors', aiOpen
              ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active'
              : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]')}>
            <Sparkles className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />{t('tab.aiAssistant')}
            <kbd className="rounded border border-[color:var(--workspace-border-soft)] px-1 font-sans text-[10px] text-[var(--workspace-text-subtle)]">⌘I</kbd>
          </button>
        )}
        {onToggleTheme && (
          <button type="button" data-testid="pc-tab-theme" onClick={onToggleTheme} className={ICON_BUTTON} title={t(theme === 'dark' ? 'settings.light' : 'settings.dark')}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  )
}

const TAB = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors'
const TAB_ACTIVE = 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]'
const TAB_IDLE = 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
const ICON_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-workspace-nav transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
