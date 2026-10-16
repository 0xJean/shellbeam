import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { operationTransport, runConfirmedOperation } from '@/lib/operation-job'
import {
  createScheduledTaskScheduler,
  loadScheduledTasks,
  normalizeScheduledTask,
  saveScheduledTasks,
  scheduledTaskSummary,
  type ScheduledTask,
} from '@/lib/scheduled-tasks'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { CalendarClock, CheckCircle2, CircleAlert, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ScheduledTasksPanelProps {
  activeVaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function statusClass(status: ScheduledTask['lastStatus']) {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
  if (status === 'failed' || status === 'unknown') return 'border-red-500/30 bg-red-500/10 text-red-600'
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-600'
  return 'border-border/60 bg-muted/30 text-muted-foreground'
}

export function ScheduledTasksPanel({ activeVaultId, host, resolveAuthSecret }: ScheduledTasksPanelProps) {
  const { t } = useT()
  const [tasks, setTasks] = useState<ScheduledTask[]>(() => loadScheduledTasks(activeVaultId, host.id))
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [runningId, setRunningId] = useState<string | null>(null)

  useEffect(() => {
    setTasks(loadScheduledTasks(activeVaultId, host.id))
    setOutput('')
    setError('')
  }, [activeVaultId, host.id])

  function persist(next: ScheduledTask[]) {
    try {
      setTasks(saveScheduledTasks(activeVaultId, host.id, next))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  function addTask() {
    try {
      const now = Date.now()
      const task = normalizeScheduledTask({
        id: `${host.id}:task-${now}`,
        hostId: host.id,
        name,
        command,
        intervalMinutes: Number(intervalMinutes),
        enabled: false,
        nextRunAt: null,
      }, now)
      persist([...tasks, task])
      setName('')
      setCommand('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  function toggleTask(task: ScheduledTask) {
    const enabled = !task.enabled
    const now = Date.now()
    persist(tasks.map((item) => item.id === task.id ? { ...item, enabled, nextRunAt: enabled ? now + item.intervalMinutes * 60_000 : null, updatedAt: now } : item))
  }

  async function runNow(task: ScheduledTask) {
    setRunningId(task.id)
    setError('')
    try {
      const execution = await runConfirmedOperation({
        host,
        action: 'scheduled-task.run',
        target: task.name,
        risk: 'high',
        paramsSummary: task.command,
        confirmMessage: t('workspace.scheduledTasks.confirm', { target: task.name }),
        source: 'workspace',
        provider: 'ssh-agentless',
        transport: operationTransport(host),
        execute: () => runWorkspaceRemoteCommand({ host, resolveAuthSecret, command: task.command }),
        getResult: (result) => result,
      })
      if (!execution) {
        setOutput(t('workspace.operation.cancelled'))
        return
      }
      const result = execution.value
      const now = Date.now()
      persist(tasks.map((item) => item.id === task.id ? {
        ...item,
        lastRunAt: now,
        nextRunAt: item.enabled ? now + item.intervalMinutes * 60_000 : null,
        lastStatus: result.exitCode === 0 ? 'completed' : 'failed',
        lastResultSummary: `job=${execution.job.jobId} audit=${execution.job.auditId} exit=${result.exitCode}`,
        lastErrorSummary: result.exitCode === 0 ? null : t('workspace.scheduledTasks.failed'),
        updatedAt: now,
      } : item))
      setOutput([`job=${execution.job.jobId} audit=${execution.job.auditId} status=${execution.job.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunningId(null)
    }
  }

  useEffect(() => {
    if (!tasks.some((task) => task.enabled)) return
    const scheduler = createScheduledTaskScheduler({
      tasks,
      host,
      resolveAuthSecret,
      onTaskRun: (result) => {
        const now = Date.now()
        setTasks((current) => saveScheduledTasks(activeVaultId, host.id, current.map((item) => item.id === result.task.id ? {
          ...item,
          lastRunAt: now,
          nextRunAt: item.enabled ? now + item.intervalMinutes * 60_000 : null,
          lastStatus: result.exitCode === 0 ? 'completed' : 'failed',
          lastResultSummary: `job=${result.job.jobId} audit=${result.job.auditId} exit=${result.exitCode}`,
          lastErrorSummary: result.exitCode === 0 ? null : t('workspace.scheduledTasks.failed'),
          updatedAt: now,
        } : item), now))
        setOutput([`job=${result.job.jobId} audit=${result.job.auditId} status=${result.job.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
      },
      onTaskError: (caught, task) => {
        const now = Date.now()
        const message = caught instanceof Error ? caught.message : String(caught)
        setTasks((current) => saveScheduledTasks(activeVaultId, host.id, current.map((item) => item.id === task.id ? { ...item, lastRunAt: now, nextRunAt: item.enabled ? now + item.intervalMinutes * 60_000 : null, lastStatus: 'unknown', lastErrorSummary: message.slice(0, 200), updatedAt: now } : item), now))
        setError(message)
      },
    })
    scheduler.start()
    return () => scheduler.stop()
  }, [tasks, host.id, activeVaultId, resolveAuthSecret])

  return (
    <section data-testid="scheduled-tasks-panel" className="space-y-3 rounded-xl border border-border/60 bg-card px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4" />{t('workspace.scheduledTasks.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('workspace.scheduledTasks.description')}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">{t('workspace.scheduledTasks.proxyJumpNote')}</span>
      </div>
      <div className="space-y-2">
        {tasks.length === 0 ? <div className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">{t('workspace.scheduledTasks.empty')}</div> : tasks.map((task) => (
          <div key={task.id} className="space-y-2 rounded-lg border border-border/50 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{task.name}</div><div className="truncate text-[11px] text-muted-foreground" title={task.command}>{scheduledTaskSummary(task)}</div></div>
              <span className={`rounded-full border px-2 py-1 text-[10px] ${statusClass(task.lastStatus)}`}>{t(`workspace.scheduledTasks.status.${task.lastStatus}`)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => toggleTask(task)}><span className="mr-1">{task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</span>{task.enabled ? t('workspace.scheduledTasks.disable') : t('workspace.scheduledTasks.enable')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={runningId !== null} onClick={() => void runNow(task)}><RefreshCw className="mr-1 h-3.5 w-3.5" />{runningId === task.id ? t('workspace.scheduledTasks.running') : t('workspace.scheduledTasks.runNow')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => persist(tasks.filter((item) => item.id !== task.id))}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('workspace.scheduledTasks.remove')}</Button>
              {task.nextRunAt && task.enabled && <span className="text-[11px] text-muted-foreground">{t('workspace.scheduledTasks.nextRun', { time: new Date(task.nextRunAt).toLocaleString() })}</span>}
            </div>
            {task.lastErrorSummary && <div className="flex items-center gap-1 text-[11px] text-red-600"><CircleAlert className="h-3 w-3" />{task.lastErrorSummary}</div>}
            {task.lastStatus === 'completed' && <div className="flex items-center gap-1 text-[11px] text-emerald-600"><CheckCircle2 className="h-3 w-3" />{task.lastResultSummary}</div>}
          </div>
        ))}
      </div>
      <div className="grid gap-2 rounded-lg border border-dashed border-border/60 p-3 sm:grid-cols-[1fr_1.5fr_120px_auto]">
        <Input aria-label={t('workspace.scheduledTasks.name')} placeholder={t('workspace.scheduledTasks.name')} value={name} onChange={(event) => setName(event.target.value)} />
        <Input aria-label={t('workspace.scheduledTasks.command')} placeholder={t('workspace.scheduledTasks.command')} value={command} onChange={(event) => setCommand(event.target.value)} />
        <Input aria-label={t('workspace.scheduledTasks.interval')} type="number" min={1} max={10080} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} />
        <Button type="button" size="sm" variant="outline" onClick={addTask}><Plus className="mr-1 h-3.5 w-3.5" />{t('workspace.scheduledTasks.add')}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/20 p-3 text-[11px]">{output}</pre>}
      <p className="text-[11px] text-muted-foreground">{t('workspace.scheduledTasks.auditNote')}</p>
    </section>
  )
}

export default ScheduledTasksPanel
