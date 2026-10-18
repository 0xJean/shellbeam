import { flushLocalOpsHost, LOCAL_OPS_PERSISTENCE_EVENT, localOpsPersistenceError } from '@/lib/local-ops-persistence'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { isUnknownOperationError, operationTransport, runConfirmedOperation, type OperationJob } from '@/lib/operation-job'
import { hostOperationReview } from '@/lib/operation-review'
import {
  authorizeScheduledTask,
  revokeScheduledTaskAuthorization,
  withScheduledTaskLock,
  SCHEDULED_TASK_CHANGED_EVENT,
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

  useEffect(() => {
    const update = () => setTasks(loadScheduledTasks(activeVaultId, host.id))
    window.addEventListener(SCHEDULED_TASK_CHANGED_EVENT, update)
    window.addEventListener('storage', update)
    window.addEventListener(LOCAL_OPS_PERSISTENCE_EVENT, update)
    return () => { window.removeEventListener(SCHEDULED_TASK_CHANGED_EVENT, update); window.removeEventListener('storage', update); window.removeEventListener(LOCAL_OPS_PERSISTENCE_EVENT, update) }
  }, [activeVaultId, host.id])

  function persist(next: ScheduledTask[], requirePersistence = false) {
    try {
      setTasks(saveScheduledTasks(activeVaultId, host.id, next))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      if (requirePersistence) throw caught
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

  async function toggleTask(task: ScheduledTask) {
    setError('')
    if (task.enabled) {
      revokeScheduledTaskAuthorization(activeVaultId, task)
      persist(loadScheduledTasks(activeVaultId, host.id).map((item) => item.id === task.id ? { ...item, enabled: false, pausedReason: 'user', nextRunAt: null } : item))
      return
    }
    setRunningId(task.id)
    try {
      let authorizationJob: OperationJob | undefined
      await runConfirmedOperation({ vaultId: activeVaultId, host, action: 'scheduled-task.enable', target: task.name, risk: 'high', paramsSummary: `task=${task.id}; intervalMinutes=${task.intervalMinutes}`, confirmMessage: t('scheduledOps.confirmEnable', { host: `${host.name} (${host.username}@${host.address}:${host.port})`, path: host.jumpHostId ? `ProxyJump ${host.jumpHostId}` : host.jumpHost ? `ProxyJump ${host.jumpHost}` : 'direct', target: task.name, interval: task.intervalMinutes, command: task.command }), source: 'workspace', provider: 'ssh-agentless', transport: operationTransport(host),
        onJob: (job) => { if (job.status === 'running' && job.confirmationStatus === 'confirmed') authorizationJob = job },
        execute: async () => {
          if (!authorizationJob) throw new Error('SCHEDULE_CONFIRMED_JOB_REQUIRED')
          const latest = loadScheduledTasks(activeVaultId, host.id)
          const current = latest.find((item) => item.id === task.id)
          if (!current || current.command !== task.command || current.intervalMinutes !== task.intervalMinutes) throw new Error('Scheduled task changed; confirm again')
          persist(latest.map((item) => item.id === task.id ? authorizeScheduledTask(activeVaultId, item, authorizationJob!.jobId) : item), true)
          await flushLocalOpsHost(activeVaultId, host.id)
          return { exitCode: 0, durationMs: 0 }
        }, getResult: (value) => value })
    } catch {
      revokeScheduledTaskAuthorization(activeVaultId, task)
      persist(loadScheduledTasks(activeVaultId, host.id).map((item) => item.id === task.id ? { ...item, enabled: false, nextRunAt: null, pausedReason: 'user' } : item))
      setError(t('scheduledOps.enableFailed'))
    } finally { setRunningId(null) }
  }

  async function runNow(task: ScheduledTask) {
    setRunningId(task.id)
    setError('')
    try {
      const execution = await withScheduledTaskLock(activeVaultId, task, () => runConfirmedOperation({
        vaultId: activeVaultId,
        host,
        action: 'scheduled-task.run',
        target: task.name,
        risk: 'high',
        paramsSummary: `task=${task.id}; manual=true`,
        confirmMessage: `${t('workspace.scheduledTasks.confirm', { target: task.name })}\n\n${hostOperationReview(host, task.command, t)}`,
        source: 'workspace',
        provider: 'ssh-agentless',
        transport: operationTransport(host),
        execute: async () => {
          const current = loadScheduledTasks(activeVaultId, host.id).find((item) => item.id === task.id)
          if (!current || current.command !== task.command || current.intervalMinutes !== task.intervalMinutes) throw new Error('Scheduled task changed; confirm again')
          persist(loadScheduledTasks(activeVaultId, host.id).map((item) => item.id === task.id ? { ...item, lastStatus: 'running', lastRunAt: Date.now() } : item), true)
          await flushLocalOpsHost(activeVaultId, host.id)
          return runWorkspaceRemoteCommand({ vaultId: activeVaultId, host, resolveAuthSecret, command: task.command })
        },
        getResult: (result) => result,
      }))
      if (!execution) {
        setOutput(t('workspace.operation.cancelled'))
        return
      }
      const result = execution.value
      const now = Date.now()
      const status = execution.job.status === 'completed' ? 'completed' : execution.job.status === 'failed' ? 'failed' : 'unknown'
      persist(loadScheduledTasks(activeVaultId, host.id).map((item) => {
        if (item.id !== task.id || item.command !== task.command || item.intervalMinutes !== task.intervalMinutes) return item
        if (status === 'unknown') revokeScheduledTaskAuthorization(activeVaultId, item)
        return {
          ...item,
          ...(status === 'unknown' ? { enabled: false, pausedReason: 'interrupted' as const } : {}),
          lastRunAt: now,
          nextRunAt: item.enabled && status !== 'unknown' ? now + item.intervalMinutes * 60_000 : null,
          lastStatus: status,
          lastResultSummary: `job=${execution.job.jobId} audit=${execution.job.auditId} status=${status} exit=${result.exitCode}`,
          lastErrorSummary: status === 'completed' ? null : t(status === 'unknown' ? 'scheduledOps.unknown' : 'workspace.scheduledTasks.failed'),
          updatedAt: now,
        }
      }), true)
      await flushLocalOpsHost(activeVaultId, host.id)
      setOutput([`job=${execution.job.jobId} audit=${execution.job.auditId} status=${execution.job.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
    } catch (caught) {
      const job = (caught as { operationJob?: OperationJob })?.operationJob
      const unknown = job ? job.status === 'unknown' : isUnknownOperationError(caught)
      persist(loadScheduledTasks(activeVaultId, host.id).map((item) => {
        if (item.id !== task.id || item.command !== task.command || item.intervalMinutes !== task.intervalMinutes) return item
        revokeScheduledTaskAuthorization(activeVaultId, item)
        return { ...item, enabled: false, nextRunAt: null, lastStatus: unknown ? 'unknown' : 'failed', pausedReason: unknown ? 'interrupted' : 'user', lastErrorSummary: t(unknown ? 'scheduledOps.unknown' : 'workspace.scheduledTasks.failed') }
      }))
      setError(t(unknown ? 'scheduledOps.unknown' : 'workspace.scheduledTasks.failed'))
    } finally {
      setRunningId(null)
    }
  }


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
              <Button type="button" size="sm" variant="outline" disabled={runningId !== null || task.lastStatus === 'running'} onClick={() => void toggleTask(task)}><span className="mr-1">{task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</span>{task.enabled ? t('workspace.scheduledTasks.disable') : t('workspace.scheduledTasks.enable')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={runningId !== null || task.lastStatus === 'running'} onClick={() => void runNow(task)}><RefreshCw className="mr-1 h-3.5 w-3.5" />{runningId === task.id ? t('workspace.scheduledTasks.running') : t('workspace.scheduledTasks.runNow')}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={runningId !== null || task.lastStatus === 'running'} onClick={() => { revokeScheduledTaskAuthorization(activeVaultId, task); persist(loadScheduledTasks(activeVaultId, host.id).filter((item) => item.id !== task.id)) }}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('workspace.scheduledTasks.remove')}</Button>
              {task.nextRunAt && task.enabled && <span className="text-[11px] text-muted-foreground">{t('workspace.scheduledTasks.nextRun', { time: new Date(task.nextRunAt).toLocaleString() })}</span>}
            </div>
            {task.pausedReason && <div className="text-[11px] text-amber-600">{t(`scheduledOps.paused.${task.pausedReason}`)}</div>}
            {task.authorizationJobId && <div className="truncate text-[10px] text-muted-foreground">{t('scheduledOps.authorization')}: {task.authorizationJobId}</div>}
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
      {localOpsPersistenceError(activeVaultId, host.id) && <p role="alert" className="text-xs text-red-600">{t('localOps.persistenceFailed')}</p>}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/20 p-3 text-[11px]">{output}</pre>}
      <p className="text-[11px] text-muted-foreground">{t('workspace.scheduledTasks.auditNote')}</p>
      <p className="text-[11px] text-muted-foreground">{t('scheduledOps.lifecycle')}</p>
    </section>
  )
}

export default ScheduledTasksPanel
