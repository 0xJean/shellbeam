import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Clock3,
  FileClock,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from 'lucide-react'
import {
  listOperationAudit,
  listOperationJobs,
  type OperationAuditEntry,
  type OperationJob,
  type OperationJobStatus,
} from '@/lib/operation-job'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type OperationsAuditView = 'operations' | 'audit'
export type OperationStatusFilter = 'all' | OperationJobStatus

export interface OperationsAuditCenterProps {
  /** Limit queries to one host when opened from a host's operations view. */
  hostId?: string
  /** Maximum rows fetched from the local journal. The local store bounds this again. */
  limit?: number
  /** Retry is deliberately delegated to the caller so this surface cannot
   * silently repeat a remote write. The caller should show confirmation and
   * create a new OperationJob linked to the original job. */
  onRetry?: (job: OperationJob) => void | Promise<void>
  /** Restrict this view to a provider/source, such as MCP remote jobs. */
  source?: OperationJob['source']
  /** Restrict the journal to the active Vault when the surface is scoped. */
  vaultId?: string
  className?: string
}

type RequestGroup = {
  requestId: string
  jobs: OperationJob[]
  status: OperationJobStatus
  counts: Partial<Record<OperationJobStatus, number>>
}

const STATUS_FILTERS: OperationStatusFilter[] = ['all', 'queued', 'running', 'completed', 'failed', 'unknown', 'cancelled']
const RETRYABLE_STATUSES: OperationJobStatus[] = ['failed', 'unknown', 'cancelled']

function groupKey(job: OperationJob) {
  const requestId = job.requestId?.trim()
  return requestId || `job:${job.jobId}`
}

function aggregateStatus(jobs: OperationJob[]): OperationJobStatus {
  const priority: OperationJobStatus[] = ['unknown', 'failed', 'running', 'queued', 'cancelled', 'completed']
  return priority.find((status) => jobs.some((job) => job.status === status)) ?? 'completed'
}

function groupJobs(jobs: OperationJob[]): RequestGroup[] {
  const groups = new Map<string, OperationJob[]>()
  jobs.forEach((job) => {
    const key = groupKey(job)
    const existing = groups.get(key)
    if (existing) existing.push(job)
    else groups.set(key, [job])
  })
  return Array.from(groups.entries()).map(([requestId, grouped]) => {
    const counts: Partial<Record<OperationJobStatus, number>> = {}
    grouped.forEach((job) => { counts[job.status] = (counts[job.status] ?? 0) + 1 })
    return { requestId, jobs: grouped, status: aggregateStatus(grouped), counts }
  })
}

function statusTone(status: OperationJobStatus) {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
  if (status === 'failed' || status === 'unknown') return 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300'
  if (status === 'cancelled') return 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300'
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300'
  return 'border-border/60 bg-muted/20 text-muted-foreground'
}

function formatTime(value: number | null | undefined, locale: string) {
  if (!value || !Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function StatusBadge({ status }: { status: OperationJobStatus }) {
  const { t } = useT()
  return (
    <span data-testid={`operation-status-${status}`} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase', statusTone(status))}>
      {status === 'completed' && <CheckCircle2 className="h-3 w-3" />}
      {(status === 'failed' || status === 'unknown') && <AlertTriangle className="h-3 w-3" />}
      {status === 'cancelled' && <CircleX className="h-3 w-3" />}
      {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
      {(status === 'queued') && <Clock3 className="h-3 w-3" />}
      {t(`operations.status.${status}`)}
    </span>
  )
}

function GroupSummary({ group }: { group: RequestGroup }) {
  const { t } = useT()
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {(['completed', 'failed', 'unknown', 'cancelled', 'running', 'queued'] as OperationJobStatus[]).map((status) => {
        const count = group.counts[status]
        if (!count) return null
        return <span key={status} className="rounded border border-border/60 px-1.5 py-0.5">{t(`operations.status.${status}`)}: {count}</span>
      })}
    </div>
  )
}

export function OperationsAuditCenter({ hostId, limit = 100, onRetry, source, vaultId, className }: OperationsAuditCenterProps) {
  const { t, locale } = useT()
  const [view, setView] = useState<OperationsAuditView>('operations')
  const [status, setStatus] = useState<OperationStatusFilter>('all')
  const [jobs, setJobs] = useState<OperationJob[]>([])
  const [audits, setAudits] = useState<OperationAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [restored, setRestored] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = { ...(hostId ? { hostId } : {}), ...(vaultId ? { vaultId } : {}), ...(source ? { source } : {}), limit }
      const [nextJobs, nextAudits] = await Promise.all([
        listOperationJobs(query),
        listOperationAudit({ ...(hostId ? { hostId } : {}), ...(vaultId ? { vaultId } : {}), ...(source ? { source } : {}), limit }),
      ])
      const safeJobs = Array.isArray(nextJobs) ? nextJobs : []
      const safeAudits = Array.isArray(nextAudits) ? nextAudits : []
      setJobs(source ? safeJobs.filter((job) => job.source === source) : safeJobs)
      setAudits(source ? safeAudits.filter((audit) => audit.source === source) : safeAudits)
      setLastRefreshAt(Date.now())
      setRestored(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [hostId, limit, source, vaultId])

  useEffect(() => { void refresh() }, [refresh])

  // MCP workers can finish while the Settings or Activity surface is in the
  // background. Re-read the durable journal when the app becomes visible so a
  // later session observes the canonical status instead of stale in-memory
  // output. The short interval also covers a long-running remote operation.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [refresh])

  const filteredJobs = useMemo(() => status === 'all' ? jobs : jobs.filter((job) => job.status === status), [jobs, status])
  const groups = useMemo(() => groupJobs(filteredJobs), [filteredJobs])
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.jobId, job])), [jobs])
  const filteredAudits = useMemo(() => status === 'all' ? audits : audits.filter((audit) => audit.status === status), [audits, status])
  const unknownMcpJobs = useMemo(() => jobs.filter((job) => job.source === 'mcp' && job.status === 'unknown'), [jobs])

  async function retry(job: OperationJob) {
    if (!onRetry || retryingJobId) return
    setRetryingJobId(job.jobId)
    try {
      await onRetry(job)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRetryingJobId(null)
      void refresh()
    }
  }

  return (
    <section data-testid="operations-audit-center" className={cn('flex w-full flex-col', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-6">
        <div className="flex items-center gap-2">
          <FileClock className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">{t('operations.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('operations.description')}</p>
          </div>
        </div>
        <button type="button" data-testid="operations-refresh" onClick={() => void refresh()} disabled={loading} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label={t('operations.refresh')}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-6">
        <button type="button" data-testid="operations-tab" onClick={() => setView('operations')} className={cn('border-b-2 px-1 py-2 text-xs font-medium', view === 'operations' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground')}>{t('operations.tab.operations')}</button>
        <button type="button" data-testid="audit-tab" onClick={() => setView('audit')} className={cn('border-b-2 px-1 py-2 text-xs font-medium', view === 'audit' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground')}>{t('operations.tab.audit')}</button>
        <label className="ml-auto flex items-center gap-1.5 py-1.5 text-xs text-muted-foreground" htmlFor="operations-status-filter">
          <Search className="h-3.5 w-3.5" />
          <select id="operations-status-filter" data-testid="operations-filter" value={status} onChange={(event) => setStatus(event.target.value as OperationStatusFilter)} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground">
            {STATUS_FILTERS.map((value) => <option key={value} value={value}>{t(`operations.filter.${value}`)}</option>)}
          </select>
        </label>
      </div>

      {error && <div role="alert" data-testid="operations-error" className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
      {restored && lastRefreshAt && <div data-testid="operations-restored" className="mx-6 mt-3 flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground"><span>{t('operations.restored')}</span><span>{formatTime(lastRefreshAt, locale)}</span></div>}
      {unknownMcpJobs.length > 0 && <div data-testid="operations-mcp-recovery" className="mx-6 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{t('operations.mcpUnknown', { count: unknownMcpJobs.length })}</span><button type="button" onClick={() => setStatus('unknown')} className="rounded border border-amber-500/40 px-2 py-1 text-[10px] font-medium hover:bg-amber-500/10">{t('operations.filter.unknown')}</button></div>}
      {loading && jobs.length === 0 && audits.length === 0 && <div className="px-6 py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>}

      {view === 'operations' && !loading && groups.length === 0 && <div data-testid="operations-empty" className="px-6 py-12 text-center"><FileClock className="mx-auto h-10 w-10 text-muted-foreground/20" /><p className="mt-3 text-sm text-muted-foreground">{t('operations.empty')}</p></div>}
      {view === 'audit' && !loading && filteredAudits.length === 0 && <div data-testid="audit-empty" className="px-6 py-12 text-center"><FileClock className="mx-auto h-10 w-10 text-muted-foreground/20" /><p className="mt-3 text-sm text-muted-foreground">{t('operations.auditEmpty')}</p></div>}

      {view === 'operations' && groups.length > 0 && <div className="space-y-3 px-6 pb-6 pt-4">
        {groups.map((group) => {
          const first = group.jobs[0]
          if (!first) return null
          const hasBatch = group.jobs.length > 1 || first.requestId
          return (
            <article key={group.requestId} data-testid="operations-request-group" className="rounded-lg border border-border/50 bg-card/30 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{first.action}</span>
                    <span className="truncate text-xs text-muted-foreground">{first.target}</span>
                    <StatusBadge status={group.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{t('operations.hostsCount', { count: group.jobs.length })}</span>
                    {hasBatch && <span data-testid="operation-request-id" className="font-mono">{t('operations.requestId', { id: first.requestId ?? group.requestId.replace(/^job:/, '') })}</span>}
                    <GroupSummary group={group} />
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                {group.jobs.map((job) => {
                  const canRetry = !!onRetry && RETRYABLE_STATUSES.includes(job.status)
                  return (
                    <div key={job.jobId} className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 px-2.5 py-2 text-xs">
                      <StatusBadge status={job.status} />
                      <span className="min-w-0 flex-1 truncate">{job.hostName || job.hostAddress || t('operations.unknownHost')}</span>
                      <span className="text-[11px] text-muted-foreground">{formatTime(job.updatedAt || job.queuedAt, locale)}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">job={job.jobId}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">audit={job.auditId}</span>
                      <span className="text-[10px] text-muted-foreground">{job.source} · {job.provider} · {job.transport}</span>
                      {canRetry && <button type="button" data-testid="operation-retry" onClick={() => void retry(job)} disabled={retryingJobId !== null} className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:opacity-50">{retryingJobId === job.jobId ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}{t('operations.retry')}</button>}
                      {job.errorSummary && <span className="basis-full truncate text-[11px] text-muted-foreground">{job.errorSummary}</span>}
                      {job.status === 'unknown' && <span className="basis-full text-[11px] text-amber-700 dark:text-amber-300">{t('operations.reconcileBeforeRetry')}</span>}
                    </div>
                  )
                })}
              </div>
            </article>
          )
        })}
      </div>}

      {view === 'audit' && filteredAudits.length > 0 && <div className="space-y-1.5 px-6 pb-6 pt-4">
        {filteredAudits.map((entry) => {
          const job = jobsById.get(entry.jobId)
          return (
            <div key={entry.auditId} data-testid="operation-audit-row" className="flex flex-wrap items-start gap-2 rounded-lg border border-border/40 bg-card/30 px-3 py-2.5 text-xs">
              <StatusBadge status={entry.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{entry.event}</span>
                  <span className="text-muted-foreground">{entry.action} · {entry.target}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{entry.hostName || entry.hostAddress || t('operations.unknownHost')}</span>
                  <span>{formatTime(entry.createdAt, locale)}</span>
                  <span className="font-mono">audit={entry.auditId}</span>
                  <span>{entry.source} · {entry.provider} · {entry.transport}</span>
                  {job?.requestId && <span className="font-mono">{t('operations.requestId', { id: job.requestId })}</span>}
                </div>
                {(entry.errorSummary || entry.resultSummary) && <p className="mt-1 truncate text-[11px] text-muted-foreground">{entry.errorSummary ?? entry.resultSummary}</p>}
              </div>
            </div>
          )
        })}
      </div>}
    </section>
  )
}

export default OperationsAuditCenter
