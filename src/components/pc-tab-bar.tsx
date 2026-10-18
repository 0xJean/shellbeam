import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { Columns2, LayoutDashboard, Plus, RefreshCw, SquareTerminal, X } from 'lucide-react'
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
}: PcSessionTabBarProps) {
  const { t } = useT()
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  return (
    <div className="sticky top-0 z-50 hidden h-12 shrink-0 items-end gap-0 overflow-x-auto border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-1 shadow-[var(--workspace-shadow-card)] backdrop-blur-sm scrollbar-none md:flex md:h-10">
      <button
        type="button"
        data-testid="pc-dashboard" onClick={onGoToDashboard}
          className={cn(
            'flex h-10 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-xs font-medium transition-colors md:h-8',
            isDashboard
            ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active'
            : 'bg-transparent text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
        )}
        title={t('tab.dashboard')}
      >
        <LayoutDashboard className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('tab.dashboard')}</span>
      </button>

      {onOpenLocalTerminal && (
        <button
          type="button"
          onClick={onOpenLocalTerminal}
          className="flex h-10 shrink-0 items-center justify-center gap-1 rounded-t-md px-2.5 text-workspace-nav transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)] md:h-8"
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
            className={cn(
              'group flex h-10 shrink-0 items-center gap-1.5 rounded-t-md pl-3 pr-1 text-xs font-medium transition-colors md:h-8',
              isActive
                ? 'bg-[var(--workspace-surface-950)] text-[var(--workspace-text-strong)]'
                : 'bg-transparent text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
            )}
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
              className="flex h-6 w-6 items-center justify-center rounded opacity-100 transition-all hover:bg-[var(--workspace-surface-700)] sm:opacity-0 sm:group-hover:opacity-100"
              style={isActive ? { opacity: 1 } : undefined}
              title={t('tab.close')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      <div className="ml-1 flex items-end gap-0.5 border-l border-[color:var(--workspace-border-soft)] pl-1">
        {onNewConnection && (
          <button
          type="button"
          onClick={onNewConnection}
            className="flex h-10 shrink-0 items-center justify-center gap-1 rounded-t-md px-2.5 text-workspace-nav transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)] md:h-8"
            title={t('tab.newSsh')}
          >
            <Plus className="h-4 w-4" />
          </button>
        )}

        {onToggleSplit && sessionTabs.length >= 2 && (
          <button
            type="button"
            onClick={onToggleSplit}
            className={cn(
              'flex h-10 shrink-0 items-center justify-center rounded-t-md px-2.5 transition-colors md:h-8',
              isSplit ? 'text-workspace-nav-active' : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]',
            )}
            title={isSplit ? t('tab.exitSplit') : t('tab.splitTerminal')}
          >
            <Columns2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
