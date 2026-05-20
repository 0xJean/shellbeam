import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { WorkspaceEmptyState } from './workspace-empty-state'

type LogSourceId = 'journal' | 'syslog'

const LOG_SOURCES: Array<{ id: LogSourceId; labelKey: string; command: string }> = [
  { id: 'journal', labelKey: 'workspace.logs.source.journal', command: 'journalctl -n 120 --no-pager' },
  { id: 'syslog', labelKey: 'workspace.logs.source.syslog', command: 'tail -n 120 /var/log/syslog 2>/dev/null || tail -n 120 /var/log/messages' },
]

interface WorkspaceLogsAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

export function WorkspaceLogsApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
}: WorkspaceLogsAppProps) {
  const { t } = useT()
  const [source, setSource] = useState<LogSourceId>('journal')
  const [loading, setLoading] = useState(false)
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')

  const host = useMemo(
    () => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )

  const activeSource = LOG_SOURCES.find((entry) => entry.id === source) ?? LOG_SOURCES[0]

  async function loadLogs(target = activeSource) {
    if (!host) return

    setLoading(true)
    setError('')

    try {
      const result = await runWorkspaceRemoteCommand({
        host,
        resolveAuthSecret,
        command: target.command,
      })

      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setOutput(combined || t('workspace.logs.noOutput'))
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
        title={t('workspace.app.logs')}
        description={t('workspace.logs.emptyDescription')}
      />
    )
  }

  return (
    <div data-testid="workspace-logs-app" className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-[var(--workspace-accent-text)]">{t('workspace.app.logs')}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.logs.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('workspace.logs.description')}</p>
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
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground">{activeSource.command}</div>
        <button
          type="button"
          onClick={() => void loadLogs()}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? t('workspace.logs.loading') : t(activeSource.labelKey)}
        </button>
      </div>
      {error ? (
        <div className="rounded-2xl border border-[var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
          {error}
        </div>
      ) : (
        <pre data-testid="workspace-logs-output" className="max-h-[26rem] overflow-auto rounded-xl border border-border/60 bg-card p-4 text-xs leading-6 text-foreground">
          {loading ? t('workspace.logs.loadingLogs') : output}
        </pre>
      )}
    </div>
  )
}
