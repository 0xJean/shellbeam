import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { runSshCommand } from '@/lib/sessions'
import { WorkspaceEmptyState } from './workspace-empty-state'

const PROCESS_COMMAND = 'ps -eo pid=,comm=,%cpu=,%mem=,state= --sort=-%cpu | head -n 24'
const PROCESS_HANDOFFS = [
  { label: 'Run top', command: 'top' },
  { label: 'Run htop', command: 'htop' },
  { label: 'Run ps aux', command: 'ps aux --sort=-%mem | head -n 40' },
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
  hosts,
  resolveAuthSecret,
}: WorkspaceProcessesAppProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [handoffCommand, setHandoffCommand] = useState(PROCESS_COMMAND)

  const host = useMemo(
    () => hosts.find((entry) => entry.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
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
      const secret = await resolveAuthSecret(host)
      const result = await runSshCommand({
        hostId: host.id,
        host: host.address,
        port: host.port || 22,
        username: host.username || 'root',
        authType: host.authType,
        password: host.authType === 'password' ? secret : undefined,
        privateKey: host.authType === 'privateKey' ? secret : undefined,
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
        title="Processes"
        description="Connect a remote host to inspect running processes here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Processes</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Process Monitor</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review the busiest workloads first, then jump into terminal-native tools when you need deeper inspection.
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
            {item.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border/60 bg-card/70 px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Terminal Handoff</div>
        <div className="mt-2 text-xs text-muted-foreground">{handoffCommand}</div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/70 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by process or PID"
          className="h-10 rounded-xl border border-border/60 bg-background/80 px-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => void loadProcesses()}
          className="rounded-xl border border-border/60 px-3 py-2 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? 'Refreshing…' : 'Refresh Processes'}
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[28px] border border-border/60 bg-card/80">
          <div className="grid grid-cols-[96px_minmax(0,1.4fr)_100px_100px_96px] gap-3 border-b border-border/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <div>PID</div>
            <div>Command</div>
            <div>CPU</div>
            <div>Memory</div>
            <div>State</div>
          </div>
          <div className="max-h-[26rem] overflow-auto">
            {loading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Loading process list…</div>
            ) : filteredRows.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">No matching processes found.</div>
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
