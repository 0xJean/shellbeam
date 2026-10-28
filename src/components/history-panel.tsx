import { useState } from 'react'
import { Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import type { HistoryEntry } from '@/lib/history'
import { useCommandHistory } from '@/hooks/use-command-history'
import { useVault } from '@/contexts/vault-context'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

export function HistoryEntryRow({ entry, compact }: { entry: HistoryEntry; compact?: boolean }) {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={compact ? 'border-b border-border/30' : 'rounded-lg border border-border/50 bg-card/50'}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center text-left transition-colors hover:bg-muted/30',
          compact ? 'gap-2 px-3 py-2 text-[11px]' : 'gap-3 px-4 py-2.5 text-sm',
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? <ChevronDown className={cn('shrink-0 text-muted-foreground', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
          : <ChevronRight className={cn('shrink-0 text-muted-foreground', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />}
        {entry.status === 'success'
          ? <CheckCircle2 className={cn('shrink-0 text-emerald-500', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
          : <XCircle className={cn('shrink-0 text-red-500', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />}
        <code className={cn('min-w-0 flex-1 truncate font-mono', compact ? 'text-[11px]' : 'text-xs')}>{entry.command}</code>
        {!compact && (
          <>
            <span className="shrink-0 text-[10px] text-muted-foreground">{entry.host}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
          </>
        )}
      </button>
      {expanded && (
        <div className={cn('border-t border-border/20 text-xs', compact ? 'px-3 py-2 text-[11px]' : 'px-4 py-3')}>
          <div className={cn('gap-2 text-muted-foreground', compact ? 'space-y-1' : 'grid grid-cols-2')}>
            <p>{t('history.host')} {entry.host}</p>
            <p>{t('history.exitCode')} {entry.result.exitCode}</p>
            <p>{t('history.duration')} {entry.result.durationMs}ms</p>
            {entry.errorType && <p>{t('history.error')} {entry.errorType}</p>}
          </div>
          {entry.result.stdout && (
            <div className="mt-1.5">
              <span className="text-muted-foreground">{t('history.output')}</span>
              <pre className={cn(
                'mt-1 overflow-auto rounded bg-muted/30 font-mono',
                compact ? 'max-h-20 p-1.5 text-[10px]' : 'max-h-32 p-2 text-[11px]',
              )}>{entry.result.stdout.slice(0, compact ? 500 : 2000)}</pre>
            </div>
          )}
          {entry.result.stderr && (
            <div className="mt-1.5">
              <span className="text-red-400">{t('history.stderr')}</span>
              <pre className={cn(
                'mt-1 overflow-auto rounded bg-red-500/5 font-mono text-red-300',
                compact ? 'max-h-20 p-1.5 text-[10px]' : 'max-h-32 p-2 text-[11px]',
              )}>{entry.result.stderr.slice(0, compact ? 500 : 2000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function HistoryPanel() {
  const { t } = useT()
  const { activeVaultId } = useVault()
  const { entries, loading } = useCommandHistory(activeVaultId)
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all')

  const filtered = entries.filter((e) => {
    if (statusFilter === 'success') return e.status === 'success'
    if (statusFilter === 'failed') return e.status === 'failed'
    return true
  })

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('history.title')}</h2>
          <span className="text-xs text-muted-foreground">({filtered.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {(['all', 'success', 'failed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                statusFilter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {f === 'all' ? t('history.all') : f === 'success' ? t('history.success') : t('history.failed')}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="py-8 text-center text-sm text-muted-foreground">{t('history.loading')}</div>}

      {!loading && filtered.length === 0 && (
        <div className="py-12 text-center text-sm text-muted-foreground">{t('history.empty')}</div>
      )}

      <div className="space-y-1">
        {filtered.map((entry) => (
          <HistoryEntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}
