import { monitoringDiagnostic, monitoringOperationTarget, monitoringProviderLabel } from '@/lib/monitoring-presentation'
import { NativeSelect } from '@/components/ui/select'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileClock,
  Info,
  Loader2,
  Radio,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import {
  listOperationAudit,
  listOperationJobs,
  type OperationAuditEntry,
  type OperationJob,
  type OperationJobStatus,
  type OperationHistoryCursor,
  type OperationSource,
} from '@/lib/operation-job'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { guideAuditCopy } from '@/lib/locales/guide-audit-v3'
import { fill } from '@/lib/locales/probe-install'

export type OperationsAuditView = 'operations' | 'audit'
export type OperationStatusFilter = 'all' | OperationJobStatus

export interface OperationsAuditCenterProps {
  /** Limit queries to one host when opened from a host's operations view. */
  hostId?: string
  /** Visible rows per page (1–100); the store also bounds every request. */
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
const SOURCE_FILTERS = ['all', 'terminal', 'workspace', 'mcp', 'monitor'] as const
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
  if (status === 'completed') return 'text-[var(--workspace-status-good-text)]'
  if (status === 'failed') return 'text-[var(--workspace-status-bad-text)]'
  if (status === 'unknown' || status === 'running') return 'text-[var(--workspace-status-warn-text)]'
  return 'text-[var(--workspace-text-muted)]'
}

function chipTone(status: OperationJobStatus) {
  if (status === 'completed') return 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]'
  if (status === 'failed') return 'bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]'
  if (status === 'unknown') return 'bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]'
  return 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]'
}

function formatTime(value: number | null | undefined, locale: string) {
  if (!value || !Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function StatusBadge({ status }: { status: OperationJobStatus }) {
  const { t } = useT()
  return (
    <span data-testid={`operation-status-${status}`} className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium', statusTone(status))}>
      {status === 'running' ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {t(`operations.status.${status}`)}
    </span>
  )
}

function GroupSummary({ group }: { group: RequestGroup }) {
  const { t } = useT()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(['completed', 'failed', 'unknown', 'cancelled', 'running', 'queued'] as OperationJobStatus[]).map((status) => {
        const count = group.counts[status]
        if (!count) return null
        return <span key={status} className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', chipTone(status))}>{t(`operations.status.${status}`)} {count}</span>
      })}
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; testId: string }) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="hidden flex-wrap gap-0.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-0.5 md:inline-flex">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
          className={cn('rounded-md px-2.5 py-1 text-xs transition-colors', value === option.value ? 'bg-[var(--workspace-surface-700)] font-medium text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function OperationsAuditCenter({ hostId, limit = 100, onRetry, source, vaultId, className }: OperationsAuditCenterProps) {
  // Scope changes remount immediately, so rows from the previous Vault/host
  // cannot remain visible until an effect or late request finishes.
  return <ScopedOperationsAuditCenter key={JSON.stringify([hostId, vaultId, source, limit])} hostId={hostId} limit={limit} onRetry={onRetry} source={source} vaultId={vaultId} className={className} />
}

function ScopedOperationsAuditCenter({ hostId, limit = 100, onRetry, source, vaultId, className }: OperationsAuditCenterProps) {
  const { t, locale } = useT()
  const copy = guideAuditCopy[locale]
  const [view, setView] = useState<OperationsAuditView>('operations')
  const [status, setStatus] = useState<OperationStatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<(typeof SOURCE_FILTERS)[number]>('all')
  const selectedSource = source ?? (sourceFilter === 'all' ? undefined : sourceFilter)
  const pageSize = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 100
  const [boundaries, setBoundaries] = useState<Record<OperationsAuditView, (OperationHistoryCursor | undefined)[]>>({ operations: [undefined], audit: [undefined] })
  const jobsBefore = boundaries.operations.at(-1)
  const auditBefore = boundaries.audit.at(-1)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const queryKey = JSON.stringify([status, selectedSource, jobsBefore, auditBefore, refreshVersion])
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const sequence = useRef(0)
  const [jobs, setJobs] = useState<OperationJob[]>([])
  const [audits, setAudits] = useState<OperationAuditEntry[]>([])
  const [hasOlder, setHasOlder] = useState({ operations: false, audit: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [restored, setRestored] = useState(false)

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const query = { ...(hostId ? { hostId } : {}), ...(vaultId ? { vaultId } : {}), ...(selectedSource ? { source: selectedSource } : {}), ...(status !== 'all' ? { status } : {}), limit: pageSize + 1 }
      const [nextJobs, nextAudits] = await Promise.all([
        listOperationJobs({ ...query, ...(jobsBefore ? { before: jobsBefore } : {}) }),
        listOperationAudit({ ...query, ...(auditBefore ? { before: auditBefore } : {}) }),
      ])
      if (request !== sequence.current) return
      const safeJobs = Array.isArray(nextJobs) ? nextJobs : []
      const safeAudits = Array.isArray(nextAudits) ? nextAudits : []
      const matches = (row: { hostId?: string | null; vaultId?: string | null; source: OperationSource; status: OperationJobStatus }) => (!hostId || row.hostId === hostId) && (!vaultId || row.vaultId === vaultId) && (!selectedSource || row.source === selectedSource) && (status === 'all' || row.status === status)
      setJobs(safeJobs.slice(0, pageSize).filter(matches))
      setAudits(safeAudits.slice(0, pageSize).filter(matches))
      setHasOlder({ operations: safeJobs.length > pageSize, audit: safeAudits.length > pageSize })
      setLoadedKey(queryKey)
      setLastRefreshAt(Date.now())
      setRestored(true)
    } catch (cause) {
      if (request !== sequence.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }, [hostId, vaultId, selectedSource, status, pageSize, jobsBefore, auditBefore, queryKey])

  useEffect(() => { void refresh(); return () => { sequence.current += 1 } }, [refresh])

  function resetPages() {
    sequence.current += 1
    setLoadedKey(null)
    setError(null)
    setRestored(false)
    setBoundaries({ operations: [undefined], audit: [undefined] })
    setRefreshVersion(previous => previous + 1)
  }

  const browsingHistory = boundaries.operations.length > 1 || boundaries.audit.length > 1

  // MCP workers can finish while the Settings or Activity surface is in the
  // background. Re-read the durable journal when the app becomes visible so a
  // later session observes the canonical status instead of stale in-memory
  // output. The short interval also covers a long-running remote operation.
  useEffect(() => {
    if (browsingHistory) return
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [refresh, browsingHistory])

  const current = loadedKey === queryKey
  const filteredJobs = useMemo(() => current ? jobs : [], [current, jobs])
  const groups = useMemo(() => groupJobs(filteredJobs), [filteredJobs])
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.jobId, job])), [jobs])
  const filteredAudits = useMemo(() => current ? audits : [], [current, audits])
  const unknownMcpJobs = useMemo(() => filteredJobs.filter((job) => job.source === 'mcp' && job.status === 'unknown'), [filteredJobs])

  function olderPage() {
    const lastJob = filteredJobs.at(-1)
    const lastAudit = filteredAudits.at(-1)
    const before = view === 'operations' ? lastJob && { timestamp: lastJob.updatedAt, id: lastJob.jobId } : lastAudit && { timestamp: lastAudit.createdAt, id: lastAudit.auditId }
    if (!before || !hasOlder[view] || loading || !current) return
    sequence.current += 1
    setBoundaries(previous => ({ ...previous, [view]: [...previous[view], before] }))
  }

  function newerPage() {
    if (boundaries[view].length <= 1 || loading) return
    sequence.current += 1
    setBoundaries(previous => ({ ...previous, [view]: previous[view].slice(0, -1) }))
  }

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

  function changeSource(value: (typeof SOURCE_FILTERS)[number]) { resetPages(); setSourceFilter(value) }
  function changeStatus(value: OperationStatusFilter) { resetPages(); setStatus(value) }
  const sourceOptions = SOURCE_FILTERS.map(value => ({ value, label: t(`operations.source.${value}`) }))
  const statusOptions = STATUS_FILTERS.map(value => ({ value, label: t(`operations.filter.${value}`) }))
  const tab = (id: OperationsAuditView, testId: string, label: string) => (
    <button type="button" role="tab" aria-selected={view === id} data-testid={testId} onClick={() => setView(id)}
      className={cn('relative -mb-px border-b-2 pb-2.5 text-[13px] font-medium transition-colors', view === id ? 'border-[color:var(--workspace-primary-500)] text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text)]')}>{label}</button>
  )
  const pagerButton = 'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40'
  const th = 'whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-[var(--workspace-text-subtle)]'

  return (
    <section data-testid="operations-audit-center" className={cn('flex w-full flex-col gap-4 p-6 text-[var(--workspace-text)]', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[22px] font-semibold tracking-tight text-[var(--workspace-text-strong)]">{copy.auditTitle}</h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{copy.auditDescription}</p>
        </div>
        <button type="button" data-testid="operations-refresh" onClick={() => { if (browsingHistory) resetPages(); else void refresh() }} disabled={loading} aria-label={t('operations.refresh')}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-800)] disabled:opacity-50">
          <RefreshCw aria-hidden className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />{copy.refresh}
        </button>
      </div>

      <div role="tablist" className="flex gap-6 border-b border-[color:var(--workspace-border-soft)]">
        {tab('operations', 'operations-tab', copy.tabOperations)}
        {tab('audit', 'audit-tab', copy.tabAudit)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!source && <>
          <Segmented label={copy.sourceFilter} testId="operations-source-segments" value={sourceFilter} options={sourceOptions} onChange={changeSource} />
          <label className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)] md:hidden" htmlFor="operations-source-filter">
            {t('operations.source.label')}
            <NativeSelect id="operations-source-filter" data-testid="operations-source-filter" value={sourceFilter} onChange={(event) => changeSource(event.target.value as typeof sourceFilter)} className="h-8 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 text-xs text-[var(--workspace-text-strong)]">
              {sourceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </NativeSelect>
          </label>
        </>}
        <Segmented label={copy.statusFilter} testId="operations-status-segments" value={status} options={statusOptions} onChange={changeStatus} />
        <label className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)] md:hidden" htmlFor="operations-status-filter">
          {copy.statusFilter}
          <NativeSelect id="operations-status-filter" data-testid="operations-filter" value={status} onChange={(event) => changeStatus(event.target.value as OperationStatusFilter)} className="h-8 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 text-xs text-[var(--workspace-text-strong)]">
            {statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </label>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11.5px] text-[var(--workspace-text-subtle)]">
          {restored && lastRefreshAt && <span data-testid="operations-restored">{t('operations.restored')} · {formatTime(lastRefreshAt, locale)}</span>}
          <span className="inline-flex items-center gap-1.5"><Radio aria-hidden className="h-3 w-3" />{browsingHistory ? t('operations.historyPaused') : copy.live}</span>
        </div>
      </div>

      {error && <div role="alert" data-testid="operations-error" className="flex items-start gap-2 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[var(--workspace-status-bad-text)]"><XCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
      {unknownMcpJobs.length > 0 && <div data-testid="operations-mcp-recovery" className="flex flex-wrap items-center gap-2.5 rounded-lg border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] px-4 py-3 text-[13px] font-medium text-[var(--workspace-status-warn-text)]"><CircleHelp aria-hidden className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{t('operations.mcpUnknown', { count: unknownMcpJobs.length })}</span><button type="button" onClick={() => { resetPages(); setStatus('unknown') }} className="rounded-md px-2.5 py-1 text-xs font-medium text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]">{copy.onlyUnknown}</button></div>}
      {loading && jobs.length === 0 && audits.length === 0 && <div className="py-8 text-center text-sm text-[var(--workspace-text-muted)]">{t('common.loading')}</div>}

      {view === 'operations' && !loading && groups.length === 0 && <div data-testid="operations-empty" className="py-12 text-center"><FileClock aria-hidden className="mx-auto h-10 w-10 text-[var(--workspace-text-subtle)] opacity-40" /><p className="mt-3 text-sm text-[var(--workspace-text-muted)]">{t('operations.empty')}</p></div>}
      {view === 'audit' && !loading && filteredAudits.length === 0 && <div data-testid="audit-empty" className="py-12 text-center"><FileClock aria-hidden className="mx-auto h-10 w-10 text-[var(--workspace-text-subtle)] opacity-40" /><p className="mt-3 text-sm text-[var(--workspace-text-muted)]">{t('operations.auditEmpty')}</p></div>}

      {view === 'operations' && groups.length > 0 && <div className="sb-card overflow-hidden">
        {groups.map((group) => {
          const first = group.jobs[0]
          if (!first) return null
          const hasBatch = group.jobs.length > 1 || first.requestId
          return (
            <article key={group.requestId} data-testid="operations-request-group" className="border-b border-[color:var(--workspace-border-soft)] last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-[var(--workspace-surface-800)] px-4 py-2.5 text-xs">
                <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{first.action} · {monitoringOperationTarget(first.target, first.action, locale)}</span>
                <span className="text-[var(--workspace-text-muted)]">
                  {hasBatch && <span data-testid="operation-request-id" className="font-mono">{t('operations.requestId', { id: first.requestId ?? group.requestId.replace(/^job:/, '') })} · </span>}
                  {t('operations.hostsCount', { count: group.jobs.length })}
                </span>
                <StatusBadge status={group.status} />
                <div className="ml-auto"><GroupSummary group={group} /></div>
              </div>
              {group.jobs.map((job) => {
                const canRetry = !!onRetry && RETRYABLE_STATUSES.includes(job.status)
                return (
                  <div key={job.jobId} className="grid gap-x-4 gap-y-1.5 border-t border-[color:var(--workspace-border-soft)] px-4 py-2.5 text-[13px] md:grid-cols-[132px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto] md:items-center">
                    <span className="font-mono text-xs text-[var(--workspace-text-subtle)]">{formatTime(job.updatedAt || job.queuedAt, locale)}</span>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--workspace-text-strong)]">{job.action}</div>
                      <div className="flex flex-wrap gap-x-1.5 font-mono text-[11px] text-[var(--workspace-text-subtle)]"><span>job={job.jobId}</span>·<span>audit={job.auditId}</span></div>
                    </div>
                    <span className="min-w-0 truncate text-[var(--workspace-text-strong)]">{job.hostName || job.hostAddress || t('operations.unknownHost')}</span>
                    <div className="min-w-0 text-xs text-[var(--workspace-text-muted)]">
                      <div className="truncate">{t(`operations.source.${job.source}`)} · {monitoringProviderLabel(job.provider, locale)} · {job.transport}</div>
                      {job.errorSummary && <div className="truncate text-[var(--workspace-status-bad-text)]">{monitoringDiagnostic(job.errorSummary, locale)}</div>}
                      {job.status === 'unknown' && <div className="text-[var(--workspace-status-warn-text)]">{t('operations.reconcileBeforeRetry')}</div>}
                    </div>
                    <div className="flex items-center gap-2 md:justify-end">
                      <StatusBadge status={job.status} />
                      {canRetry && <button type="button" data-testid="operation-retry" onClick={() => void retry(job)} disabled={retryingJobId !== null} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)] disabled:opacity-50">{retryingJobId === job.jobId ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <RotateCcw aria-hidden className="h-3 w-3" />}{t('operations.retry')}</button>}
                    </div>
                  </div>
                )
              })}
            </article>
          )
        })}
      </div>}

      {view === 'audit' && filteredAudits.length > 0 && <div className="sb-card overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="border-b border-[color:var(--workspace-border-soft)]">
            <tr><th className={th}>{copy.colTime}</th><th className={th}>{copy.colEvent}</th><th className={th}>{copy.colAction}</th><th className={th}>{copy.colHost}</th><th className={th}>{copy.colRequest}</th><th className={th}>{copy.colStatus}</th><th className={th}>{copy.colSummary}</th></tr>
          </thead>
          <tbody>
            {filteredAudits.map((entry) => {
              const job = jobsById.get(entry.jobId)
              const summary = entry.errorSummary ?? entry.resultSummary
              return (
                <tr key={entry.auditId} data-testid="operation-audit-row" data-job-id={entry.jobId} data-host-id={entry.hostId} data-vault-id={entry.vaultId} data-action={entry.action} data-target={entry.target} data-status={entry.status} data-confirmation={entry.confirmationStatus} data-transport={entry.transport} className="border-b border-[color:var(--workspace-border-soft)] align-top last:border-b-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-[var(--workspace-text)]">{formatTime(entry.createdAt, locale)}</td>
                  <td className="px-3 py-2"><div className="font-mono text-[11.5px] text-[var(--workspace-text-strong)]">{entry.event}</div><div className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">audit={entry.auditId}</div></td>
                  <td className="px-3 py-2 text-[var(--workspace-text-strong)]">{entry.action} · {monitoringOperationTarget(entry.target, entry.action, locale)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[var(--workspace-text-strong)]">{entry.hostName || entry.hostAddress || t('operations.unknownHost')}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-[var(--workspace-text)]">{job?.requestId ? t('operations.requestId', { id: job.requestId }) : '—'}</td>
                  <td className="px-3 py-2"><StatusBadge status={entry.status} /></td>
                  <td className="min-w-[200px] px-3 py-2 text-[var(--workspace-text-muted)]">
                    {summary && <div className={cn('line-clamp-2', entry.errorSummary && 'text-[var(--workspace-status-bad-text)]')}>{monitoringDiagnostic(summary, locale)}</div>}
                    <div className="text-[11px] text-[var(--workspace-text-subtle)]">{t(`operations.source.${entry.source}`)} · {monitoringProviderLabel(entry.provider, locale)} · {entry.transport}</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>}

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--workspace-text-subtle)]">
        <span data-testid="operations-page" className="inline-flex items-center gap-1.5"><Info aria-hidden className="h-3.5 w-3.5" />{fill(copy.page, { page: boundaries[view].length, size: pageSize })}</span>
        <span className="flex-1" />
        <button type="button" data-testid="operations-newer" disabled={loading || boundaries[view].length <= 1} onClick={newerPage} className={cn(pagerButton, 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)]')}><ChevronLeft aria-hidden className="h-3.5 w-3.5" />{t('operations.newer')}</button>
        <button type="button" data-testid="operations-older" disabled={loading || !current || !hasOlder[view]} onClick={olderPage} className={cn(pagerButton, 'border border-[color:var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-800)]')}>{t('operations.older')}<ChevronRight aria-hidden className="h-3.5 w-3.5" /></button>
      </div>
    </section>
  )
}

export default OperationsAuditCenter
