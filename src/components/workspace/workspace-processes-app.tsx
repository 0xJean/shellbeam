import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { WorkspaceEmptyState } from './workspace-empty-state'

const PROCESS_COMMAND = 'ps -eo pid=,comm=,%cpu=,%mem=,state= --sort=-%cpu | head -n 24'
const PROCESS_HANDOFFS = [
  { labelKey: 'workspace.processes.handoff.top', command: 'top' },
  { labelKey: 'workspace.processes.handoff.htop', command: 'htop' },
  { labelKey: 'workspace.processes.handoff.psAux', command: 'ps aux --sort=-%mem | head -n 40' },
] as const

interface ProcessRow {
  pid: string
  command: string
  cpu: string
  memory: string
  state: string
}

interface WorkspaceProcessesAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function parseProcesses(output: string): ProcessRow[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid = '', command = '', cpu = '', memory = '', state = ''] = line.split(/\s+/, 5)
      return { pid, command, cpu, memory, state }
    })
    .filter((row) => row.pid && row.command)
}

export function WorkspaceProcessesApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
}: WorkspaceProcessesAppProps) {
  const { t } = useT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [handoffCommand, setHandoffCommand] = useState(PROCESS_COMMAND)

  const host = useMemo(
    () => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter((row) => row.command.toLowerCase().includes(query) || row.pid.includes(query))
  }, [rows, search])

  async function loadProcesses() {
    if (!host) return

    setLoading(true)
    setError('')

    try {
      const result = await runWorkspaceRemoteCommand({
        host,
        resolveAuthSecret,
        command: PROCESS_COMMAND,
      })

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setRows(parseProcesses(combined))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!host) return
    void loadProcesses()
  }, [host?.id])

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

      <div className="grid gap-3 md:grid-cols-3">
        {PROCESS_HANDOFFS.map((item) => (
          <button
            key={item.command}
            type="button"
            onClick={() => setHandoffCommand(item.command)}
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
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('workspace.processes.filterPlaceholder')}
          className="h-10 rounded-xl border border-border/60 bg-background/80 px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
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
          <div className="grid grid-cols-[96px_minmax(0,1.4fr)_100px_100px_96px] gap-3 border-b border-border/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <div>{t('workspace.processes.column.pid')}</div>
            <div>{t('workspace.processes.column.command')}</div>
            <div>{t('workspace.common.cpu')}</div>
            <div>{t('workspace.common.memory')}</div>
            <div>{t('workspace.processes.column.state')}</div>
          </div>
          <div data-testid="workspace-processes-list" className="max-h-[26rem] overflow-auto">
            {loading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.processes.loadingList')}</div>
            ) : filteredRows.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.processes.emptyList')}</div>
            ) : (
              filteredRows.map((row) => (
                <div
                  key={`${row.pid}-${row.command}`}
                  className="grid grid-cols-[96px_minmax(0,1.4fr)_100px_100px_96px] gap-3 border-b border-border/40 px-4 py-3 text-sm last:border-b-0"
                >
                  <div className="font-medium">{row.pid}</div>
                  <div className="truncate">{row.command}</div>
                  <div>{row.cpu}%</div>
                  <div>{row.memory}%</div>
                  <div>{row.state}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
