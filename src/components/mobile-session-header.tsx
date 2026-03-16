import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import type { SessionTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus, Server, SquareTerminal, X, Zap } from 'lucide-react'
import { useState } from 'react'

interface MobileSessionHeaderProps {
  sessionTabs: SessionTab[]
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onNewConnection: () => void
  onOpenLocalTerminal: () => void
  hosts?: HostProfile[]
  onConnectHost?: (hostId: string) => void
}

export function MobileSessionHeader({
  sessionTabs,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewConnection,
  onOpenLocalTerminal,
  hosts = [],
  onConnectHost,
}: MobileSessionHeaderProps) {
  const { t } = useT()
  const [listOpen, setListOpen] = useState(false)

  const activeTab = sessionTabs.find((tab) => tab.sessionId === activeSessionId)

  // No sessions — show rich empty state with recent hosts
  if (sessionTabs.length === 0) {
    const recentHosts = [...hosts]
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .slice(0, 5)

    return (
      <div className="flex flex-1 flex-col px-5 pt-10">
        {/* Hero area */}
        <div className="flex flex-col items-center text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5 ring-1 ring-primary/10">
            <SquareTerminal className="h-10 w-10 text-primary/70" />
          </div>
          <p className="mt-4 text-base font-semibold">{t('mobile.noSessions')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('mobile.noSessionsHint')}</p>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onNewConnection}
              className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm active:opacity-80"
            >
              <Plus className="h-4 w-4" />
              {t('mobile.newConnection')}
            </button>
            <button
              type="button"
              onClick={onOpenLocalTerminal}
              className="flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-medium active:bg-muted/40"
            >
              <SquareTerminal className="h-4 w-4" />
              {t('mobile.localTerminal')}
            </button>
          </div>
        </div>

        {/* Recent hosts quick connect */}
        {recentHosts.length > 0 && onConnectHost && (
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                {t('mobile.quickConnect')}
              </span>
            </div>
            <div className="space-y-1.5">
              {recentHosts.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  onClick={() => onConnectHost(host.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-card/50 px-4 py-3 text-left transition-colors active:bg-muted/40"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                    <Server className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{host.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {host.username || 'root'}@{host.address}
                    </p>
                  </div>
                  {host.group && (
                    <span className="shrink-0 rounded-md bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {host.group}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
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
