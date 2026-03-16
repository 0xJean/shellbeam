import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { runSshCommand } from '@/lib/sessions'
import { WorkspaceEmptyState } from './workspace-empty-state'

type LogSourceId = 'journal' | 'syslog'

const LOG_SOURCES: Array<{ id: LogSourceId; label: string; command: string }> = [
  { id: 'journal', label: 'Run journalctl', command: 'journalctl -n 120 --no-pager' },
  { id: 'syslog', label: 'Tail /var/log', command: 'tail -n 120 /var/log/syslog 2>/dev/null || tail -n 120 /var/log/messages' },
]

interface WorkspaceLogsAppProps {
  selectedHostId?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

export function WorkspaceLogsApp({
  selectedHostId = null,
  hosts,
  resolveAuthSecret,
}: WorkspaceLogsAppProps) {
  const [source, setSource] = useState<LogSourceId>('journal')
  const [loading, setLoading] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')

  const host = useMemo(
    () => hosts.find((entry) => entry.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )

  const activeSource = LOG_SOURCES.find((entry) => entry.id === source) ?? LOG_SOURCES[0]

  async function loadLogs(target = activeSource) {
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
        command: target.command,
      })

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setOutput(combined || 'No log output')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setOutput('')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!host) return
    void loadLogs(activeSource)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, source])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title="Logs"
        description="Connect a remote host to inspect logs here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Logs</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Log Sources</h2>
        <p className="mt-1 text-sm text-muted-foreground">Inspect journal and file-based logs, then hand off to the terminal for deep filtering.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {LOG_SOURCES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSource(item.id)}
            className={`rounded-2xl border px-4 py-4 text-left text-sm font-medium transition-colors ${
              source === item.id
                ? 'border-primary/50 bg-primary/10'
                : 'border-border/60 bg-card/70 hover:bg-muted/40'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/70 px-4 py-3">
        <div className="text-xs text-muted-foreground">{activeSource.command}</div>
        <button
          type="button"
          onClick={() => void loadLogs()}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? 'Loading…' : activeSource.label}
        </button>
      </div>
      {error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : (
        <pre className="max-h-[26rem] overflow-auto rounded-2xl border border-border/60 bg-card/80 p-4 text-xs leading-6 text-slate-200">
          {loading ? 'Loading logs…' : output}
        </pre>
      )}
    </div>
  )
}
