import { AppWindow, Search, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getBrowserRouteDotClass } from './browser-tab-visuals'

export type BrowserOverviewDialogScope = 'all' | 'remote' | 'local' | 'pending'

export interface BrowserOverviewDialogSession {
  sessionId: string
  hostName: string
  hostAddress: string
  browserTabs: number
  visibleTabs: Array<{
    id: string
    title: string
    url: string
    isActive: boolean
    routeIndicator: { scope: 'local' | 'remote' | 'pending'; label: string } | null
  }>
}

interface BrowserOverviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: BrowserOverviewDialogScope
  onScopeChange: (scope: BrowserOverviewDialogScope) => void
  getScopeLabel: (scope: BrowserOverviewDialogScope) => string
  scopeCounts: Record<BrowserOverviewDialogScope, { tabs: number }>
  query: string
  onQueryChange: (query: string) => void
  sessions: BrowserOverviewDialogSession[]
  visibleTabCount: number
  onResumeSession: (sessionId: string) => void
  onResumeTab: (sessionId: string, tabId: string) => void
}

const chipClass = 'inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10.5px] font-medium'

export function BrowserOverviewDialog({
  open,
  onOpenChange,
  scope: activeScope,
  onScopeChange,
  getScopeLabel,
  scopeCounts,
  query,
  onQueryChange,
  sessions,
  visibleTabCount,
  onResumeSession,
  onResumeTab,
}: BrowserOverviewDialogProps) {
  const { t } = useT()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-md:w-full border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] md:w-[860px] md:max-w-[calc(100vw-32px)] md:border md:shadow-[var(--workspace-shadow-overlay)]">
        <section className="max-h-[90vh] overflow-y-auto p-5 text-[var(--workspace-text)] md:max-h-[86vh]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-lg font-semibold text-[var(--workspace-text-strong)]">
                <AppWindow className="h-[18px] w-[18px]" />
                {t('browser.overview.title')}
              </div>
              <div className="mt-0.5 text-[12.5px] text-[var(--workspace-text-subtle)]">{t('browser.overview.description')}</div>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"
              aria-label={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(['all', 'remote', 'local', 'pending'] as const).map((scope) => {
              const label = getScopeLabel(scope)
              const active = activeScope === scope
              return (
                <button
                  key={scope}
                  type="button"
                  onClick={() => onScopeChange(scope)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
                    active
                      ? 'border-transparent bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
                      : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)] hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]',
                  )}
                  aria-label={t('browser.overview.filterScope', { label })}
                  aria-pressed={active}
                >
                  {scope !== 'all' && <span className={cn('h-1.5 w-1.5 rounded-full', getBrowserRouteDotClass(scope))} />}
                  {label} {scopeCounts[scope].tabs}
                </button>
              )
            })}
            <span className="flex-1" />
            <span className="text-xs text-[var(--workspace-text-subtle)]">
              {t('browser.overview.counts', { sessions: sessions.length, tabs: visibleTabCount })}
            </span>
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('browser.overview.searchPlaceholder')}
              aria-label={t('browser.overview.searchLabel')}
              className="h-8 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-[13px] text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-strong)]"
            />
          </div>
          {sessions.length > 0 ? (
            <div className="mt-3.5 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {sessions.map((item) => {
                const hasPending = item.visibleTabs.some((tab) => tab.routeIndicator?.scope === 'pending')
                return (
                  <section key={item.sessionId} className="sb-card p-3">
                    <button
                      type="button"
                      onClick={() => onResumeSession(item.sessionId)}
                      className="flex w-full items-center gap-2 rounded-md text-left transition-colors hover:text-[var(--workspace-text-strong)]"
                      aria-label={t('browser.overview.resumeSession', { host: item.hostName })}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', hasPending ? 'bg-[color:var(--workspace-status-warn)]' : 'bg-[color:var(--workspace-status-good)]')} />
                      <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{item.hostName}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{item.hostAddress}</span>
                      <span className={cn(chipClass, 'ml-auto bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
                        {item.visibleTabs.length === item.browserTabs
                          ? t('browser.overview.tabCount', { count: item.browserTabs })
                          : t('browser.overview.visibleTabCount', { visible: item.visibleTabs.length, total: item.browserTabs })}
                      </span>
                    </button>
                    {item.visibleTabs.length > 0 && (
                      <div className="mt-2">
                        <div className="mb-1.5 text-[11px] text-[var(--workspace-text-subtle)]">
                          {t('browser.overview.openTabs')} · {t('browser.overview.openTabsHint')}
                        </div>
                        {item.visibleTabs.slice(0, 4).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => onResumeTab(item.sessionId, tab.id)}
                            className="grid w-full grid-cols-[8px_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--workspace-surface-800)]"
                            aria-label={t('browser.overview.resumeTab', { title: tab.title, host: item.hostName })}
                          >
                            <span className={cn('h-1.5 w-1.5 rounded-full', getBrowserRouteDotClass(tab.routeIndicator?.scope))} />
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[12.5px] font-medium text-[var(--workspace-text-strong)]">{tab.title}</span>
                              {tab.isActive && (
                                <span className={cn(chipClass, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}>{t('browser.tab.active')}</span>
                              )}
                              {tab.routeIndicator && (
                                <span className={cn(chipClass, 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>{tab.routeIndicator.label}</span>
                              )}
                            </span>
                            {tab.url && (
                              <span className="col-start-2 mt-0.5 truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{tab.url}</span>
                            )}
                          </button>
                        ))}
                        {item.visibleTabs.length > 4 && (
                          <div className="px-2 pt-1 text-[11px] text-[var(--workspace-text-subtle)]">
                            {t('browser.overview.moreTabs', { count: item.visibleTabs.length - 4 })}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-[color:var(--workspace-border-soft)] px-4 py-6 text-center">
              <div className="text-sm font-medium text-[var(--workspace-text)]">{t('browser.overview.noMatches')}</div>
              <div className="mt-1 text-xs text-[var(--workspace-text-subtle)]">{t('browser.overview.noMatchesHint')}</div>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
