import { useState } from 'react'
import { X, ChevronDown, Plus, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import type { SessionTab } from '@/lib/types'

interface MobileSessionHeaderProps {
  sessionTabs: SessionTab[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewConnection: () => void
  onOpenLocalTerminal: () => void
}

export function MobileSessionHeader({
  sessionTabs,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewConnection,
  onOpenLocalTerminal,
}: MobileSessionHeaderProps) {
  const { t } = useT()
  const [listOpen, setListOpen] = useState(false)

  const activeTab = sessionTabs.find((tab) => tab.sessionId === activeSessionId)

  // No sessions — show empty state
  if (sessionTabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
          <SquareTerminal className="h-8 w-8 text-muted-foreground/40" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">{t('mobile.noSessions')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('mobile.noSessionsHint')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onNewConnection}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            {t('mobile.newConnection')}
          </button>
          <button
            type="button"
            onClick={onOpenLocalTerminal}
            className="flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium"
          >
            <SquareTerminal className="h-4 w-4" />
            {t('mobile.localTerminal')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Compact header bar */}
      <div className="flex h-11 shrink-0 items-center border-b border-border/50 bg-background/95 px-2">
        {/* Session selector */}
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
        >
          <span className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            activeTab?.status === 'connected' ? 'bg-emerald-500' : activeTab?.status === 'error' ? 'bg-red-500' : 'bg-amber-500'
          )} />
          <span className="min-w-0 truncate text-sm font-medium">
            {activeTab?.hostName || activeTab?.hostAddress || t('mobile.selectSession')}
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', listOpen && 'rotate-180')} />
          {sessionTabs.length > 1 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-bold text-muted-foreground">
              {sessionTabs.length}
            </span>
          )}
        </button>

        {/* Close active session */}
        {activeTab && (
          <button
            type="button"
            onClick={() => onCloseSession(activeTab.sessionId)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            title={t('tab.close')}
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* New connection */}
        <button
          type="button"
          onClick={onNewConnection}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          title={t('mobile.newConnection')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Session list overlay */}
      {listOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setListOpen(false)} />
          <div className="absolute inset-x-0 top-11 z-40 border-b border-border bg-background shadow-lg">
            <div className="max-h-64 overflow-y-auto p-2">
              {sessionTabs.map((tab) => {
                const isActive = tab.sessionId === activeSessionId
                return (
                  <button
                    key={tab.sessionId}
                    type="button"
                    onClick={() => { onSelectSession(tab.sessionId); setListOpen(false) }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                      isActive ? 'bg-primary/10' : 'hover:bg-muted/40',
                    )}
                  >
                    <span className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      tab.status === 'connected' ? 'bg-emerald-500' : tab.status === 'error' ? 'bg-red-500' : 'bg-amber-500'
                    )} />
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate text-sm', isActive ? 'font-medium text-primary' : '')}>{tab.hostName || tab.hostAddress}</p>
                      {tab.hostAddress && tab.hostName && (
                        <p className="truncate text-[11px] text-muted-foreground">{tab.hostAddress}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onCloseSession(tab.sessionId); if (sessionTabs.length <= 1) setListOpen(false) }}
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2 border-t border-border/50 p-2">
              <button
                type="button"
                onClick={() => { onNewConnection(); setListOpen(false) }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/40"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('mobile.newConnection')}
              </button>
              <button
                type="button"
                onClick={() => { onOpenLocalTerminal(); setListOpen(false) }}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/40"
              >
                <SquareTerminal className="h-3.5 w-3.5" />
                {t('mobile.localTerminal')}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
