import { NativeSelect } from '@/components/ui/select'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
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

type ProcessRow = DiagnosticProcess

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

export function WorkspaceProcessesApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  vaultId,
  onOpenTerminal,
}: WorkspaceProcessesAppProps) {
  const { t } = useT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [handoffCommand, setHandoffCommand] = useState(PROCESS_COMMAND)
  const [terminatingPid, setTerminatingPid] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [sort, setSort] = useState<'cpu' | 'memory' | 'pid'>('cpu')
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(0)
  const [details, setDetails] = useState<{ pid: string; text: string; scope: string } | null>(null)
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
    setDetails({ pid: row.pid, text: t('workspace.diagnostics.loadingDetails'), scope })
    try {
      const result = await runWorkspaceRemoteCommand({ host, vaultId, resolveAuthSecret, command: `ps -p ${row.pid} -o pid,ppid,user,etime,rss,vsz,pcpu,pmem,stat,comm`, audit: { action: 'process.details', target: `PID ${row.pid}` } })
      setDetails({ pid: row.pid, text: result.exitCode === 0 ? result.stdout.slice(0, 16_384) : t('workspace.diagnostics.processGone'), scope })
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

  return (
    <div data-testid="workspace-processes-app" className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-[var(--workspace-accent-text)]">{t('workspace.app.processes')}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.processes.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('workspace.processes.description')}
        </p>
      </div>

      <WorkspaceOperationRecoveryNotice host={host} vaultId={vaultId} />

      <div className="grid gap-3 md:grid-cols-3">
        {PROCESS_HANDOFFS.map((item) => (
          <button
            key={item.command}
            type="button"
            onClick={() => { setHandoffCommand(item.command); onOpenTerminal?.(item.command) }}
            className="rounded-2xl border border-border/60 bg-card/70 px-4 py-4 text-left text-sm font-medium hover:bg-muted/40"
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border/60 bg-card px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.processes.terminalHandoff')}</div>
        <div className="mt-2 text-xs text-muted-foreground">{handoffCommand}</div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 md:flex-row md:items-center md:justify-between">
        <input
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(0) }}
          placeholder={t('workspace.processes.filterPlaceholder')}
          className="h-10 rounded-xl border border-border/60 bg-background/80 px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <NativeSelect aria-label={t('workspace.diagnostics.sort')} value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(0) }} className="rounded border bg-background p-2 text-sm">
          <option value="cpu">CPU</option><option value="memory">{t('workspace.common.memory')}</option><option value="pid">PID</option>
        </NativeSelect>
        <button type="button" onClick={() => setAscending(!ascending)}>{t(ascending ? 'workspace.diagnostics.ascending' : 'workspace.diagnostics.descending')}</button>
        <button
          type="button"
          onClick={() => void loadProcesses()}
          className="rounded-xl border border-border/60 px-3 py-2 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? t('workspace.processes.refreshing') : t('workspace.processes.refresh')}
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
          {error}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="grid grid-cols-[96px_minmax(0,1.4fr)_100px_100px_96px_96px] gap-3 border-b border-border/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <div>{t('workspace.processes.column.pid')}</div>
            <div>{t('workspace.processes.column.command')}</div>
            <div>{t('workspace.common.cpu')}</div>
            <div>{t('workspace.common.memory')}</div>
            <div>{t('workspace.processes.column.state')}</div>
            <div>{t('workspace.processes.column.action')}</div>
          </div>
          <div data-testid="workspace-processes-list" className="max-h-[26rem] overflow-auto">
            {loading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.processes.loadingList')}</div>
            ) : filteredRows.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.processes.emptyList')}</div>
            ) : (
              visibleRows.map((row) => (
                <div
                  key={`${row.pid}-${row.command}`}
                  className="grid grid-cols-[96px_minmax(0,1.4fr)_100px_100px_96px_96px] gap-3 border-b border-border/40 px-4 py-3 text-sm last:border-b-0"
                >
                  <div className="font-medium">{row.pid}</div>
                  <button type="button" className="truncate text-left underline" onClick={() => void inspectProcess(row)} aria-label={t('workspace.diagnostics.processDetails', { pid: row.pid })}>{row.command}</button>
                  <div>{row.cpu}%</div>
                  <div>{row.memory}%</div>
                  <div>{row.state}</div>
                  <button
                    type="button"
                    disabled={terminatingPid !== null}
                    onClick={() => void terminateProcess(row)}
                    className="rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {terminatingPid === row.pid ? t('workspace.processes.terminating') : t('workspace.processes.terminate')}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t('workspace.diagnostics.processCount', { count: filteredRows.length, limit: PROCESS_LIMIT })}</span>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('workspace.diagnostics.previous')}</button>
        <span>{currentPage + 1}/{pageCount}</span>
        <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('workspace.diagnostics.next')}</button>
      </div>
      {truncated && <p role="status" className="text-xs text-amber-500">{t('workspace.diagnostics.processTruncated', { limit: PROCESS_LIMIT })}</p>}
      {details?.scope === scope && <section aria-label={t('workspace.diagnostics.processDetails', { pid: details.pid })} className="rounded border p-4"><pre className="overflow-auto whitespace-pre-wrap text-xs">{details.text}</pre><button type="button" onClick={() => setDetails(null)}>{t('workspace.diagnostics.closeDetails')}</button></section>}
      {actionOutput && (
        <div className="rounded-xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground" data-testid="workspace-processes-output">
          {actionOutput}
        </div>
      )}
    </div>
  )
}
