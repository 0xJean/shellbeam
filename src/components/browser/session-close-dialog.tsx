import { Info, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface SessionCloseTab {
  id: string
  title: string
  url: string
  routeIndicator: { scope: 'local' | 'remote' | 'pending'; label: string } | null
}

interface SessionCloseDialogProps {
  open: boolean
  hostName: string
  tabs: SessionCloseTab[]
  onCancel: () => void
  onConfirm: () => void
}

const SCOPE_DOT: Record<'local' | 'remote' | 'pending', string> = {
  local: 'bg-[var(--workspace-status-good)]',
  remote: 'bg-[var(--workspace-status-info)]',
  pending: 'bg-[var(--workspace-status-warn)]',
}

/** v3 "close session?" confirmation: lists the browser tabs the session still holds. Cancel takes focus. */
export function SessionCloseDialog({ open, hostName, tabs, onCancel, onConfirm }: SessionCloseDialogProps) {
  const { t } = useT()
  const remote = tabs.filter((tab) => tab.routeIndicator?.scope === 'remote').length
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }} labelledBy="session-close-title" describedBy="session-close-description">
      <DialogContent className="flex flex-col overflow-hidden border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-overlay)] md:w-[460px] md:max-w-[92vw] md:rounded-xl">
        <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-[18px]">
          <div className="min-w-0">
            <h2 id="session-close-title" className="text-lg font-semibold text-[var(--workspace-text-strong)]">{t('browser.sessionClose.title')}</h2>
            <p id="session-close-description" className="mt-1 text-[12.5px] text-[var(--workspace-text-muted)]">{t('browser.sessionClose.description', { host: hostName })}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label={t('common.close')} className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
            <X className="h-4 w-4" />
          </button>
        </header>
        {tabs.length > 0 && (
          <div className="px-5 pb-4">
            <ul data-testid="session-close-tabs" className="max-h-[220px] overflow-y-auto rounded-lg border border-[color:var(--workspace-border-soft)]">
              {tabs.map((tab) => (
                <li key={tab.id} className="flex items-center gap-2.5 border-t border-[color:var(--workspace-border-soft)] px-3 py-2.5 text-[12.5px] first:border-t-0">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', SCOPE_DOT[tab.routeIndicator?.scope ?? 'local'])} aria-hidden="true" />
                  <b className="w-28 shrink-0 truncate font-semibold text-[var(--workspace-text-strong)]" title={tab.title}>{tab.title}</b>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--workspace-text-muted)]" title={tab.url}>{tab.url}</span>
                  {tab.routeIndicator && <span className="shrink-0 rounded-md bg-[var(--workspace-surface-800)] px-1.5 text-[11px] leading-5 text-[var(--workspace-text)]">{tab.routeIndicator.label}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-3 flex gap-1.5 text-xs text-[var(--workspace-text-muted)]">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t('browser.sessionClose.tabCount', { count: tabs.length })}
                {remote > 0 && ` · ${t('browser.sessionClose.remoteCount', { count: remote })}`}
              </span>
            </p>
          </div>
        )}
        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
          <button type="button" data-autofocus onClick={onCancel} className="h-8 rounded-lg border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] px-3.5 text-[13px] font-medium text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-primary-400)]">
            {t('common.cancel')}
          </button>
          <button type="button" onClick={onConfirm} className="h-8 rounded-lg bg-[var(--workspace-status-bad-bg)] px-3.5 text-[13px] font-medium text-[var(--workspace-status-bad-text)] ring-1 ring-[color:var(--workspace-status-bad-border)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-status-bad)]">
            {t('browser.sessionClose.confirm')}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
