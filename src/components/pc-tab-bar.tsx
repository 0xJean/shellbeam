import { useT } from '@/lib/i18n'
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Columns2, LayoutDashboard, Plus, RefreshCw, SquareTerminal, X } from 'lucide-react'

export type { SessionTab }

export interface SessionBrowserTabMeta {
  tabCount: number
  routeScope: 'local' | 'remote' | 'pending'
  routeLabel: 'Local' | 'Server' | 'Pending'
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
}: PcSessionTabBarProps) {
  const { t } = useT()

  return (
    <div className="sticky top-0 z-50 hidden h-12 shrink-0 items-end gap-0 overflow-x-auto border-b border-border/50 bg-background/95 px-1 shadow-sm backdrop-blur-sm scrollbar-none md:flex md:h-10">
      <button
        type="button"
        onClick={onGoToDashboard}
        className={cn(
          'flex h-10 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-xs font-medium transition-colors md:h-8',
          isDashboard
            ? 'bg-primary/10 text-primary'
            : 'bg-transparent text-muted-foreground hover:text-foreground'
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
          className="flex h-10 shrink-0 items-center justify-center gap-1 rounded-t-md px-2.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground md:h-8"
          title={t('tab.localTerminal')}
        >
          <SquareTerminal className="h-4 w-4" />
        </button>
      )}

      {sessionTabs.map((session) => {
        const isActive = !isDashboard && activeSessionId === session.sessionId
        return (
          <div
            key={session.sessionId}
            className={cn(
              'group flex h-10 shrink-0 items-center gap-1.5 rounded-t-md pl-3 pr-1 text-xs font-medium transition-colors md:h-8',
              isActive
                ? 'bg-[#1a1b26] text-slate-200'
                : 'bg-transparent text-muted-foreground hover:text-foreground'
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
                  session.status === 'connected' ? 'bg-emerald-500' : session.status === 'error' ? 'bg-red-500' : 'bg-slate-600'
                )} />
              )}
              <span className="max-w-[100px] truncate sm:max-w-[140px]">{session.hostName || session.hostAddress}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseSession(session.sessionId) }}
              className="flex h-6 w-6 items-center justify-center rounded opacity-100 transition-all hover:bg-muted sm:opacity-0 sm:group-hover:opacity-100"
              style={isActive ? { opacity: 1 } : undefined}
              title={t('tab.close')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      <div className="ml-1 flex items-end gap-0.5 border-l border-border/30 pl-1">
        {onNewConnection && (
          <button
            type="button"
            onClick={onNewConnection}
            className="flex h-10 shrink-0 items-center justify-center gap-1 rounded-t-md px-2.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground md:h-8"
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
              isSplit ? 'text-primary' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
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
