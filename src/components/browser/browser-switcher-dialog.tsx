import type { Dispatch, RefObject, SetStateAction } from 'react'
import { AppWindow, Trash2, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'
import { browserV3Copy } from '@/lib/locales/browser-v3'
import { cn } from '@/lib/utils'
import { BrowserKbd } from './browser-kbd'
import { browserModKey, getBrowserRouteDotClass } from './browser-tab-visuals'

export interface BrowserSwitcherDialogEntry {
  id: string
  sessionId: string
  hostName: string
  title: string
  url: string
  routeScope: 'local' | 'remote' | 'pending'
  routeLabel: string
  isActive: boolean
}

interface BrowserSwitcherDialogProps<T extends BrowserSwitcherDialogEntry> {
  open: boolean
  onOpenChange: (open: boolean) => void
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  entries: T[]
  activeIndex: number
  onActiveIndexChange: Dispatch<SetStateAction<number>>
  onCommit: (entry: T) => void
  onCloseTab: (entry: T) => void
  onClearSession: (sessionId: string) => void
}

export function BrowserSwitcherDialog<T extends BrowserSwitcherDialogEntry>({
  open,
  onOpenChange,
  inputRef,
  query,
  onQueryChange,
  entries,
  activeIndex,
  onActiveIndexChange,
  onCommit,
  onCloseTab,
  onClearSession,
}: BrowserSwitcherDialogProps<T>) {
  const { t, locale } = useT()
  const copy = browserV3Copy[locale]
  const activeEntry = entries[activeIndex] ?? entries[0] ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="md:items-start md:pt-[12vh]">
      <DialogContent className="border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] md:w-[640px] md:max-w-[calc(100vw-32px)] md:border md:shadow-[var(--workspace-shadow-overlay)]">
        <div
          className="flex h-full flex-col"
          onKeyDown={(event) => {
            if (!open) return
            if (event.key === 'Escape') {
              event.preventDefault()
              onOpenChange(false)
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              onActiveIndexChange((current) => (entries.length === 0 ? 0 : (current + 1) % entries.length))
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              onActiveIndexChange((current) => (entries.length === 0 ? 0 : (current - 1 + entries.length) % entries.length))
              return
            }
            if (event.key === 'Enter' && activeEntry) {
              event.preventDefault()
              onCommit(activeEntry)
            }
          }}
        >
          <div className="flex h-[54px] items-center gap-2.5 border-b border-[color:var(--workspace-border-soft)] px-4">
            <AppWindow className="h-[18px] w-[18px] shrink-0 text-[var(--workspace-text-subtle)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t('browser.switcher.searchPlaceholder')}
              aria-label={t('browser.switcher.searchLabel')}
              className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]"
            />
            <BrowserKbd>{browserModKey}⇧B</BrowserKbd>
          </div>
          <div className="max-h-[52vh] overflow-y-auto px-1.5 py-1.5">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[var(--workspace-text-subtle)]" title={t('browser.switcher.description')}>
              {t('browser.switcher.title')} · {copy.recentOrder}
            </div>
            {entries.length > 0 ? (
              entries.map((entry, index) => {
                const highlighted = index === activeIndex
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      'group flex items-center gap-1 rounded-lg pr-1.5 transition-colors',
                      highlighted ? 'bg-[var(--workspace-accent-subtle)]' : 'hover:bg-[var(--workspace-surface-800)]',
                    )}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    <button
                      type="button"
                      onClick={() => onCommit(entry)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left text-[13px]"
                      aria-label={t('browser.switcher.switchToTab', { title: entry.title, host: entry.hostName })}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', getBrowserRouteDotClass(entry.routeScope))} />
                      <span className="max-w-[40%] shrink-0 truncate font-medium text-[var(--workspace-text-strong)]">{entry.title}</span>
                      {entry.isActive && (
                        <span className="shrink-0 rounded bg-[var(--workspace-accent-subtle)] px-1.5 text-[10.5px] font-medium leading-[18px] text-[var(--workspace-accent-text)]">
                          {t('browser.tab.active')}
                        </span>
                      )}
                      <span className="shrink-0 rounded bg-[var(--workspace-surface-700)] px-1.5 text-[10.5px] leading-[18px] text-[var(--workspace-text-muted)]">
                        {entry.routeLabel}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--workspace-text-subtle)]">
                        {entry.hostName}
                        {entry.url && <> · <span className="font-mono">{entry.url}</span></>}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseTab(entry)
                      }}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-[opacity,color,background-color] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] focus-visible:opacity-100',
                        highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      aria-label={t('browser.switcher.closeTab', { title: entry.title, host: entry.hostName })}
                      title={t('browser.switcher.closeTabShort')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onClearSession(entry.sessionId)
                      }}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-[opacity,color,background-color] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)] focus-visible:opacity-100',
                        highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      aria-label={t('browser.switcher.clearSession', { host: entry.hostName })}
                      title={t('browser.switcher.clearSessionShort')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )
              })
            ) : (
              <div className="px-4 py-8 text-center">
                <div className="text-sm font-medium text-[var(--workspace-text)]">{t('browser.switcher.noMatches')}</div>
                <div className="mt-1 text-xs text-[var(--workspace-text-subtle)]">{t('browser.switcher.noMatchesHint')}</div>
              </div>
            )}
          </div>
          <div className="mt-auto flex h-[38px] items-center gap-4 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3.5 text-[11px] text-[var(--workspace-text-subtle)]">
            <span className="flex items-center gap-1"><BrowserKbd>↑</BrowserKbd><BrowserKbd>↓</BrowserKbd><span className="ml-0.5">{copy.select}</span></span>
            <span className="flex items-center gap-1"><BrowserKbd>↵</BrowserKbd><span className="ml-0.5">{copy.switchTo}</span></span>
            <span className="flex items-center gap-1"><BrowserKbd>esc</BrowserKbd><span className="ml-0.5">{copy.dismiss}</span></span>
            <span className="flex-1" />
            <span className="hidden sm:inline">{copy.autoClose}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
