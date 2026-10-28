import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, CircleX, RotateCw, Search, SquareTerminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SegmentedMeter } from '@/components/ui/segmented-meter'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceProcSvcCopy } from '@/lib/locales/workspace-procsvc'
import { cn } from '@/lib/utils'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { runConfirmedOperation, type OperationJob } from '@/lib/operation-job'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'
import { PROCESS_COMMAND, PROCESS_LIMIT, PROCESS_PAGE_SIZE, executeVerifiedProcessTermination, parseDiagnosticProcesses, safeDiagnosticPid, type DiagnosticProcess } from '@/lib/workspace-diagnostics'

const PROCESS_HANDOFFS = [
  { labelKey: 'workspace.processes.handoff.top', command: 'top' },
  { labelKey: 'workspace.processes.handoff.htop', command: 'htop' },
  { labelKey: 'workspace.processes.handoff.psAux', command: 'ps aux --sort=-%mem | head -n 40' },
] as const

const DETAIL_FIELDS = ['pid', 'ppid', 'user', 'etime', 'rss', 'vsz', 'pcpu', 'pmem', 'stat', 'comm'] as const
const DETAIL_COMMAND = `-o ${DETAIL_FIELDS.join(',')}`

type ProcessRow = DiagnosticProcess
type SortKey = 'cpu' | 'memory' | 'pid'
type ProcessDetails = Record<(typeof DETAIL_FIELDS)[number], string>

interface WorkspaceProcessesAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  vaultId?: string
  onOpenTerminal?: (command: string) => void
}

function operationOutput(job: OperationJob) {
  return `job=${job.jobId} audit=${job.auditId} status=${job.status}`
}

function parseProcessDetails(text: string): ProcessDetails | null {
  const [header, line] = text.trim().split('\n')
  if (!header?.trim().startsWith('PID') || !line) return null
  const values = line.trim().split(/\s+/)
  if (values.length < DETAIL_FIELDS.length) return null
  const comm = values.slice(DETAIL_FIELDS.length - 1).join(' ')
  return Object.fromEntries(DETAIL_FIELDS.map((field, index) => [field, field === 'comm' ? comm : values[index]])) as ProcessDetails
}

function formatKib(value: string) {
  const kib = Number(value)
  if (!Number.isFinite(kib)) return value
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(1)} GB`
  if (kib >= 1024) return `${Math.round(kib / 1024)} MB`
  return `${kib} KB`
}

const ghostButton = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-45'
const quietButton = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)] disabled:cursor-not-allowed disabled:opacity-45'
const dangerButton = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 text-[13px] font-medium text-[var(--workspace-status-bad-text)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50'

export function WorkspaceProcessesApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  vaultId,
  onOpenTerminal,
}: WorkspaceProcessesAppProps) {
  const { t, locale } = useT()
  const copy = workspaceProcSvcCopy[locale]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [handoffCommand, setHandoffCommand] = useState(PROCESS_COMMAND)
  const [terminatingPid, setTerminatingPid] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [sort, setSort] = useState<SortKey>('cpu')
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(0)
  const [details, setDetails] = useState<{ pid: string; command: string; text: string; scope: string } | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [snapshotScope, setSnapshotScope] = useState('')
  const loadGeneration = useRef(0)

  const host = useMemo(
    () => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )
  const scope = `${vaultId ?? ''}:${host?.id ?? ''}`

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (snapshotScope === scope ? rows : []).filter((row) => !query || row.command.toLowerCase().includes(query) || row.pid.includes(query))
      .sort((left, right) => ((Number(left[sort]) - Number(right[sort])) || Number(left.pid) - Number(right.pid)) * (ascending ? 1 : -1))
  }, [rows, search, sort, ascending, scope, snapshotScope])
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PROCESS_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRows = filteredRows.slice(currentPage * PROCESS_PAGE_SIZE, (currentPage + 1) * PROCESS_PAGE_SIZE)
  const openDetails = details?.scope === scope ? details : null
  const parsedDetails = openDetails ? parseProcessDetails(openDetails.text) : null
  const detailRow = openDetails ? rows.find((row) => row.pid === openDetails.pid) ?? null : null

  function changeSort(next: SortKey) {
    if (next === sort) setAscending(!ascending)
    else setSort(next)
    setPage(0)
  }

  async function loadProcesses() {
    if (!host) return
    const generation = ++loadGeneration.current

    setLoading(true)
    setError('')

    try {
      const result = await runWorkspaceRemoteCommand({
        host,
        resolveAuthSecret,
        vaultId,
        command: PROCESS_COMMAND,
        audit: { action: 'process.list', target: 'bounded process table' },
      })
      if (generation !== loadGeneration.current) return

      if (result.exitCode !== 0) throw new Error(result.stderr || 'process_list_failed')
      const parsed = parseDiagnosticProcesses(result.stdout)
      setRows(parsed.slice(0, PROCESS_LIMIT))
      setSnapshotScope(scope)
      setTruncated(parsed.length > PROCESS_LIMIT)
    } catch (caught) {
      if (generation !== loadGeneration.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setRows([])
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  async function terminateProcess(row: ProcessRow) {
    if (!host || !safeDiagnosticPid(row.pid)) {
      setError(t('workspace.processes.invalidPid'))
      return
    }

    setTerminatingPid(row.pid)
    setError('')
    try {
      const execution = await runConfirmedOperation({
        host,
        vaultId,
        action: 'process.terminate',
        target: `${row.pid} (${row.command})`,
        risk: 'high',
        paramsSummary: `kill -TERM -- ${row.pid}`,
        confirmMessage: t('workspace.operation.confirm', {
          action: t('workspace.processes.terminate'),
          target: `${row.command} (PID ${row.pid})`,
        }),
        execute: () => executeVerifiedProcessTermination((command) => runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command }), row.pid),
        getResult: (result) => result,
      })
      if (!execution) {
        setActionOutput(t('workspace.operation.cancelled'))
        return
      }
      setActionOutput(`${operationOutput(execution.job)}\n${execution.value.resultSummary}`)
      await loadProcesses()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setTerminatingPid(null)
    }
  }

  async function inspectProcess(row: ProcessRow) {
    if (!host || !safeDiagnosticPid(row.pid)) return
    setDetails({ pid: row.pid, command: row.command, text: t('workspace.diagnostics.loadingDetails'), scope })
    try {
      const result = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: `ps -p ${row.pid} ${DETAIL_COMMAND}`, audit: { action: 'process.details', target: `PID ${row.pid}` } })
      setDetails({ pid: row.pid, command: row.command, text: result.exitCode === 0 ? result.stdout.slice(0, 16_384) : t('workspace.diagnostics.processGone'), scope })
    } catch (caught) { setError(String(caught)) }
  }

  useEffect(() => {
    if (!host) return
    const generation = loadGeneration
    void loadProcesses()
    return () => { generation.current++ }
    // Host/vault changes reload; search/sort/page remain local to the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, vaultId])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.app.processes')}
        description={t('workspace.processes.emptyDescription')}
      />
    )
  }

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'cpu', label: t('workspace.common.cpu') },
    { key: 'memory', label: t('workspace.common.memory') },
    { key: 'pid', label: t('workspace.processes.column.pid') },
  ]
  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <th scope="col" aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'} className={cn('px-3 py-2.5 font-medium', className)}>
      <button type="button" onClick={() => changeSort(key)} aria-label={fill(copy.sortBy, { column: label })}
        className={cn('inline-flex items-center gap-1 hover:text-[var(--workspace-text-strong)]', sort === key && 'text-[var(--workspace-text)]')}>
        {label}
        {sort === key && (ascending ? <ArrowUpNarrowWide className="h-3 w-3" /> : <ArrowDownWideNarrow className="h-3 w-3" />)}
      </button>
    </th>
  )
  const detailItems: [string, string][] = parsedDetails ? [
    ['PID', parsedDetails.pid],
    ['PPID', parsedDetails.ppid],
    [copy.user, parsedDetails.user],
    [copy.elapsed, parsedDetails.etime],
    ['RSS', formatKib(parsedDetails.rss)],
    ['VSZ', formatKib(parsedDetails.vsz)],
    [t('workspace.common.cpu'), `${parsedDetails.pcpu}%`],
    [t('workspace.common.memory'), `${parsedDetails.pmem}%`],
    [t('workspace.processes.column.state'), parsedDetails.stat],
  ] : []

  return (
    <div data-testid="workspace-processes-app" className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{t('workspace.app.processes')}</h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{copy.procSubtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {PROCESS_HANDOFFS.map((item) => (
            <button
              key={item.command}
              type="button"
              onClick={() => { setHandoffCommand(item.command); onOpenTerminal?.(item.command) }}
              className={ghostButton}
            >
              <SquareTerminal className="h-3.5 w-3.5" />
              {t(item.labelKey)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void loadProcesses()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-[13px] font-semibold text-[var(--workspace-primary-foreground)] transition-colors hover:bg-[color:var(--workspace-primary-400)]"
          >
            <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? t('workspace.processes.refreshing') : t('workspace.processes.refresh')}
          </button>
        </div>
      </div>

      <WorkspaceOperationRecoveryNotice host={host} vaultId={vaultId} />

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(0) }}
            placeholder={t('workspace.processes.filterPlaceholder')}
            className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 pr-3 text-[13px] text-[var(--workspace-text)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-strong)]"
          />
        </div>
        <span className="text-xs text-[var(--workspace-text-subtle)]">{copy.sortLabel}</span>
        <div role="group" aria-label={t('workspace.diagnostics.sort')} className="inline-flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-0.5">
          {sortOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={sort === option.key}
              onClick={() => { setSort(option.key); setPage(0) }}
              className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                sort === option.key ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setAscending(!ascending)} className={quietButton}>
          {ascending ? <ArrowUpNarrowWide className="h-3.5 w-3.5" /> : <ArrowDownWideNarrow className="h-3.5 w-3.5" />}
          {t(ascending ? 'workspace.diagnostics.ascending' : 'workspace.diagnostics.descending')}
        </button>
        <span className="hidden flex-1 md:block" />
        <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-subtle)] md:max-w-[22rem]">
          <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{t('workspace.processes.terminalHandoff')}:</span>
          <span className="truncate font-mono">{handoffCommand}</span>
        </span>
      </div>

      <div className={cn('grid min-w-0 gap-4', openDetails && 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
        {error ? (
          <div role="alert" className="self-start rounded-xl border border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
            {error}
          </div>
        ) : (
          <div className="sb-card min-w-0 overflow-hidden bg-[var(--workspace-surface-panel)]">
            <div data-testid="workspace-processes-list" className="max-h-[26rem] overflow-auto">
              <table className="w-full min-w-[36rem] table-fixed text-sm">
                <thead className="sticky top-0 z-10 bg-[var(--workspace-surface-panel)] text-left text-xs text-[var(--workspace-text-subtle)]">
                  <tr className="border-b border-[color:var(--workspace-border-soft)]">
                    {sortHeader('pid', t('workspace.processes.column.pid'), 'w-20 pl-4')}
                    <th scope="col" className="px-3 py-2.5 font-medium">{t('workspace.processes.column.command')}</th>
                    {sortHeader('cpu', t('workspace.common.cpu'), 'w-40')}
                    {sortHeader('memory', t('workspace.common.memory'), 'w-20')}
                    <th scope="col" className="w-16 px-3 py-2.5 font-medium">{t('workspace.processes.column.state')}</th>
                    <th scope="col" className="w-24 px-3 py-2.5 pr-4 font-medium"><span className="sr-only">{t('workspace.processes.column.action')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-sm text-[var(--workspace-text-muted)]">{t('workspace.processes.loadingList')}</td></tr>
                  ) : filteredRows.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-sm text-[var(--workspace-text-muted)]">{t('workspace.processes.emptyList')}</td></tr>
                  ) : (
                    visibleRows.map((row) => {
                      const selected = openDetails?.pid === row.pid
                      const cpu = Number(row.cpu)
                      return (
                        <tr
                          key={`${row.pid}-${row.command}`}
                          className={cn('border-b border-[color:var(--workspace-border-soft)] last:border-b-0',
                            selected ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[var(--workspace-surface-row)]')}
                        >
                          <td className="py-2.5 pl-4 pr-3 font-mono text-[12.5px] text-[var(--workspace-text)]">{row.pid}</td>
                          <td className="min-w-0 px-3 py-2.5">
                            <button type="button" className="block max-w-full truncate text-left font-mono text-xs text-[var(--workspace-text-strong)] hover:text-primary hover:underline" onClick={() => void inspectProcess(row)} aria-label={t('workspace.diagnostics.processDetails', { pid: row.pid })}>{row.command}</button>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <SegmentedMeter kind="cpu" value={Number.isFinite(cpu) ? cpu : null} className="w-16 shrink-0" />
                              <span className="font-mono text-xs text-[var(--workspace-text)]">{row.cpu}%</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-[var(--workspace-text)]">{row.memory}%</td>
                          <td className="px-3 py-2.5 font-mono text-xs text-[var(--workspace-text-subtle)]">{row.state}</td>
                          <td className="py-2 pl-3 pr-4 text-right">
                            <button
                              type="button"
                              disabled={terminatingPid !== null}
                              onClick={() => void terminateProcess(row)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-status-bad-bg)] hover:text-[var(--workspace-status-bad-text)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <CircleX className="h-3.5 w-3.5" />
                              {terminatingPid === row.pid ? t('workspace.processes.terminating') : t('workspace.processes.terminate')}
                            </button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--workspace-border-soft)] px-4 py-2.5 text-xs text-[var(--workspace-text-subtle)]">
              <span>{fill(copy.pager, { page: currentPage + 1, pages: pageCount, count: filteredRows.length, size: PROCESS_PAGE_SIZE, limit: PROCESS_LIMIT })}</span>
              <span className="flex-1" />
              <button type="button" className={ghostButton} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-3.5 w-3.5" />{t('workspace.diagnostics.previous')}</button>
              <button type="button" className={ghostButton} disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight className="h-3.5 w-3.5" />{t('workspace.diagnostics.next')}</button>
            </div>
          </div>
        )}

        {openDetails && (
          <section aria-label={t('workspace.diagnostics.processDetails', { pid: openDetails.pid })} className="sb-card flex min-w-0 flex-col self-start bg-[var(--workspace-surface-panel)]">
            <div className="flex items-center justify-between border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
              <h3 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{copy.detailTitle}</h3>
              <button type="button" aria-label={t('workspace.diagnostics.closeDetails')} onClick={() => setDetails(null)} className="rounded-md p-1 text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 p-4">
              <div className="min-w-0">
                <div className="break-all font-mono text-[13px] text-[var(--workspace-text-strong)]">{openDetails.command}</div>
                <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--workspace-text-subtle)]">ps -p {openDetails.pid} {DETAIL_COMMAND}</div>
              </div>
              {parsedDetails ? (
                <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  {detailItems.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-[var(--workspace-text-subtle)]">{label}</dt>
                      <dd className="break-all font-mono text-[var(--workspace-text)]">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-[var(--workspace-text)]">{openDetails.text}</pre>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {detailRow && (
                  <button type="button" disabled={terminatingPid !== null} onClick={() => void terminateProcess(detailRow)} className={dangerButton}>
                    <CircleX className="h-3.5 w-3.5" />
                    {terminatingPid === detailRow.pid ? t('workspace.processes.terminating') : copy.terminateSigterm}
                  </button>
                )}
                <button type="button" onClick={() => setDetails(null)} className={quietButton}>{t('workspace.diagnostics.closeDetails')}</button>
              </div>
            </div>
          </section>
        )}
      </div>
      {truncated && <p role="status" className="text-xs text-[var(--workspace-status-warn-text)]">{t('workspace.diagnostics.processTruncated', { limit: PROCESS_LIMIT })}</p>}
      {actionOutput && (
        <div className="sb-card whitespace-pre-wrap bg-[var(--workspace-surface-panel)] px-4 py-3 font-mono text-xs text-[var(--workspace-text-muted)]" data-testid="workspace-processes-output">
          {actionOutput}
        </div>
      )}
    </div>
  )
}
