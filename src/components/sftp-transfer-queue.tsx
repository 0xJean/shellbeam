import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { sftpCopyFor } from '@/lib/locales/sftp-v3'
import { formatBytes, summarizeTransfers, transferPercent, type SftpTransferItem } from '@/lib/sftp-transfers'
import { cn } from '@/lib/utils'

interface SftpTransferQueueProps {
  items: SftpTransferItem[]
  onClearFinished: () => void
}

export function SftpTransferQueue({ items, onClearFinished }: SftpTransferQueueProps) {
  const { locale } = useT()
  const c = sftpCopyFor(locale)
  const summary = summarizeTransfers(items)
  const finished = items.length - summary.active

  return (
    <section data-testid="sftp-transfer-queue" aria-label={c.queue} className="sb-card shrink-0 px-4 py-3">
      <header className="flex items-center gap-3">
        <h2 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{c.queue}</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--workspace-text-subtle)]">
          {items.length === 0 ? c.queueEmpty : fill(c.summary, summary) + (summary.failed ? fill(c.summaryFailed, summary) : '')}
        </span>
        <button
          type="button"
          disabled={finished === 0}
          onClick={onClearFinished}
          className="rounded-md px-2 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-40"
        >
          {c.clearFinished}
        </button>
      </header>
      {items.length > 0 && (
        <ul className="mt-1.5 max-h-40 overflow-auto">
          {items.map((item) => <TransferRow key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  )
}

function TransferRow({ item }: { item: SftpTransferItem }) {
  const { locale } = useT()
  const c = sftpCopyFor(locale)
  const percent = transferPercent(item)
  const Icon = item.state === 'done' ? CircleCheck
    : item.state === 'failed' || item.state === 'cancelled' ? CircleX
      : item.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine
  const stateLabel = item.state === 'running'
    ? [percent == null ? c.running : `${percent}%`, item.bytesPerSec ? `${formatBytes(item.bytesPerSec)}/s` : ''].filter(Boolean).join(' · ')
    : [c[item.state], item.state === 'done' && item.bytesTotal != null ? formatBytes(item.bytesTotal) : ''].filter(Boolean).join(' · ')

  return (
    <li data-testid="sftp-transfer-item" data-state={item.state} className="flex items-center gap-3 py-1.5 text-xs">
      <Icon
        aria-label={item.direction === 'upload' ? c.upload : c.download}
        className={cn('h-3.5 w-3.5 shrink-0',
          item.state === 'done' ? 'text-[var(--workspace-status-good)]'
            : item.state === 'failed' ? 'text-[var(--workspace-status-bad)]'
              : item.state === 'cancelled' ? 'text-[var(--workspace-text-subtle)]' : 'text-[var(--workspace-accent-text)]')}
      />
      <span className="w-40 shrink-0 truncate text-[var(--workspace-text-strong)] md:w-52" title={item.fileName}>{item.fileName}</span>
      <span className="hidden w-48 shrink-0 truncate font-mono text-[11px] text-[var(--workspace-text-subtle)] lg:block" title={item.route}>
        {item.direction === 'upload' ? '→' : '←'} {item.route}
      </span>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={item.fileName}
        className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--workspace-surface-700)]"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300',
            item.state === 'done' ? 'bg-[var(--workspace-status-good)]'
              : item.state === 'failed' ? 'bg-[var(--workspace-status-bad)]'
                : percent == null ? 'w-1/3 animate-pulse bg-[color:var(--workspace-primary-500)]' : 'bg-[color:var(--workspace-primary-500)]')}
          style={percent == null ? undefined : { width: `${item.state === 'cancelled' ? 0 : percent}%` }}
        />
      </div>
      <span className={cn('w-32 shrink-0 text-right font-mono text-[11px]',
        item.state === 'failed' ? 'text-[var(--workspace-status-bad-text)]' : 'text-[var(--workspace-text-muted)]')}>
        {item.state === 'running' && percent == null && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
        {stateLabel}
      </span>
    </li>
  )
}
