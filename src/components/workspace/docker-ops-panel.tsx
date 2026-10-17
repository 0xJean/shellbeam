import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { buildDockerCommand, DOCKER_LIST_COMMAND, parseDockerContainers, runDockerContainerAction, type DockerContainer } from '@/lib/docker-ops'
import { Box, CircleAlert, FileText, Play, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

interface DockerOpsPanelProps {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function statusClass(running: boolean) {
  return running ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-amber-500/30 bg-amber-500/10 text-amber-700'
}

export function DockerOpsPanel({ host, resolveAuthSecret }: DockerOpsPanelProps) {
  const { t } = useT()
  const [rows, setRows] = useState<DockerContainer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [action, setAction] = useState<'start' | 'stop' | 'restart' | 'logs' | null>(null)
  const selected = useMemo(() => rows.find((row) => row.name === selectedName) ?? rows[0] ?? null, [rows, selectedName])

  async function loadContainers() {
    setLoading(true)
    setError('')
    setUnsupported(false)
    try {
      const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: DOCKER_LIST_COMMAND })
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (/__SB_DOCKER_UNAVAILABLE|command not found/i.test(combined) || result.exitCode === 127) {
        setUnsupported(true)
        setRows([])
        return
      }
      const parsed = parseDockerContainers(combined)
      setRows(parsed)
      setSelectedName((current) => current && parsed.some((row) => row.name === current) ? current : parsed[0]?.name ?? null)
      if (parsed.length === 0 && combined) setOutput(combined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  async function execute(actionName: 'start' | 'stop' | 'restart' | 'logs') {
    if (!selected) return
    setAction(actionName)
    setError('')
    try {
      if (actionName === 'logs') {
        const result = await runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: buildDockerCommand('logs', selected.name) })
        setOutput([result.stdout, result.stderr].filter(Boolean).join('\n') || t('workspace.docker.actionCompleted'))
        return
      }
      const execution = await runDockerContainerAction({
        host,
        resolveAuthSecret,
        action: actionName,
        container: selected,
        confirmMessage: t('workspace.docker.confirm', { action: t(`workspace.docker.action.${actionName}`), target: selected.name }),
      })
      if (!execution) {
        setOutput(t('workspace.operation.cancelled'))
        return
      }
      const result = execution.value
      setOutput(`job=${execution.job.jobId} audit=${execution.job.auditId} status=${execution.job.status}\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`)
      await loadContainers()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setAction(null)
    }
  }

  useEffect(() => { void loadContainers() }, [host.id])

  return (
    <section data-testid="docker-ops-panel" className="space-y-3 rounded-xl border border-border/60 bg-card px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Box className="h-4 w-4" />{t('workspace.docker.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('workspace.docker.description')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void loadContainers()} disabled={loading}>
          <RefreshCw className={loading ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />{loading ? t('workspace.docker.loading') : t('workspace.docker.reload')}
        </Button>
      </div>
      {unsupported ? <div className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">{t('workspace.docker.unsupported')}</div> : error ? <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600">{error}</div> : (
        <div className="space-y-2">
          {loading && rows.length === 0 ? <div className="px-2 py-4 text-xs text-muted-foreground">{t('workspace.docker.loadingContainers')}</div> : rows.length === 0 ? <div className="px-2 py-4 text-xs text-muted-foreground">{t('workspace.docker.empty')}</div> : rows.map((row) => (
            <button key={row.id} type="button" onClick={() => setSelectedName(row.name)} className={`grid w-full grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs ${selected?.name === row.name ? 'border-primary/40 bg-primary/5' : 'border-border/50 hover:bg-muted/40'}`}>
              <div className="min-w-0"><div className="truncate font-medium">{row.name}</div><div className="truncate text-[11px] text-muted-foreground">{row.image}</div></div>
              <div className="truncate text-muted-foreground">{row.status}</div>
              <span className={`rounded-full border px-2 py-1 text-[10px] ${statusClass(row.running)}`}>{row.running ? t('workspace.docker.status.running') : t('workspace.docker.status.stopped')}</span>
            </button>
          ))}
          {selected && <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" onClick={() => void execute('start')} disabled={action !== null || selected.running}><Play className="mr-1 h-3.5 w-3.5" />{t('workspace.docker.action.start')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void execute('stop')} disabled={action !== null || !selected.running}><Square className="mr-1 h-3.5 w-3.5" />{t('workspace.docker.action.stop')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void execute('restart')} disabled={action !== null}><RotateCcw className="mr-1 h-3.5 w-3.5" />{t('workspace.docker.action.restart')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void execute('logs')} disabled={action !== null}><FileText className="mr-1 h-3.5 w-3.5" />{t('workspace.docker.action.logs')}</Button>
          </div>}
        </div>
      )}
      {output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/20 p-3 text-[11px]" data-testid="docker-ops-output">{output}</pre>}
      {!unsupported && !error && rows.length > 0 && <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><CircleAlert className="h-3 w-3" />{t('workspace.docker.auditNote')}</p>}
    </section>
  )
}

export default DockerOpsPanel
