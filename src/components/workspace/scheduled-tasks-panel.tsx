import { flushLocalOpsHost, LOCAL_OPS_PERSISTENCE_EVENT, localOpsPersistenceError } from '@/lib/local-ops-persistence'
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
  type ScheduledTask,
} from '@/lib/scheduled-tasks'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { fill } from '@/lib/locales/probe-install'
import { workspaceOpsPanelsCopy } from '@/lib/locales/workspace-ops-panels'
import { cn } from '@/lib/utils'
import { CheckCircle2, CircleAlert, Info, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ScheduledTasksPanelProps {
  activeVaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function statusTone(status: ScheduledTask['lastStatus']) {
  if (status === 'running') return { dot: 'bg-[var(--workspace-status-good)]', text: 'text-[color:var(--workspace-status-good-text)]' }
  if (status === 'unknown') return { dot: 'bg-[var(--workspace-status-warn)]', text: 'text-[color:var(--workspace-status-warn-text)]' }
  if (status === 'failed') return { dot: 'bg-[var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]' }
  return { dot: 'bg-[var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]' }
}

const fieldClass = 'h-8 rounded-md border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-[13px] text-[var(--workspace-text-strong)]'

export function ScheduledTasksPanel({ activeVaultId, host, resolveAuthSecret }: ScheduledTasksPanelProps) {
  const { t, locale } = useT()
  const c = workspaceOpsPanelsCopy[locale].cron
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


  const formatTime = (value: number) => new Date(value).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const persistenceFailed = localOpsPersistenceError(activeVaultId, host.id)

  return (
    <section data-testid="scheduled-tasks-panel" className="flex min-h-0 flex-col gap-4 p-4 text-[var(--workspace-text)] md:p-5">
      <header className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('workspace.scheduledTasks.title')}</h2>
        <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{c.summary}</p>
      </header>
      {persistenceFailed && <p role="alert" className="rounded-lg bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{t('localOps.persistenceFailed')}</p>}
      {error && <p role="alert" className="rounded-lg bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{error}</p>}
      <div className="sb-card overflow-hidden">
        {tasks.length === 0 ? <div className="px-4 py-8 text-center text-xs text-[var(--workspace-text-muted)]">{t('workspace.scheduledTasks.empty')}</div> : <div className="divide-y divide-[color:var(--workspace-border-soft)]">{tasks.map((task) => {
          const tone = statusTone(task.lastStatus)
          const busy = runningId !== null || task.lastStatus === 'running'
          const schedule = task.lastStatus === 'running' && task.lastRunAt ? fill(c.startedAt, { time: formatTime(task.lastRunAt) }) : task.enabled && task.nextRunAt ? fill(c.next, { time: formatTime(task.nextRunAt) }) : c.paused
          const lastRun = task.lastRunAt ? fill(c.last, { time: formatTime(task.lastRunAt), status: t(`workspace.scheduledTasks.status.${task.lastStatus}`) }) : c.neverRun
          return (
            <div key={task.id} className="grid gap-3 px-4 py-3 text-xs lg:grid-cols-[minmax(0,1fr)_150px_minmax(0,220px)_auto] lg:items-center">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{task.name}</span>
                  <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', tone.text)}><span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />{t(`workspace.scheduledTasks.status.${task.lastStatus}`)}</span>
                </div>
                <code className="mt-1 block truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" title={task.command}>{task.command}</code>
              </div>
              <div className="text-[var(--workspace-text-muted)]"><div>{fill(c.every, { count: task.intervalMinutes })}</div><div>{schedule}</div></div>
              <div className="min-w-0 space-y-0.5 text-[var(--workspace-text-muted)]">
                <div className={cn(task.lastStatus === 'failed' && 'text-[color:var(--workspace-status-bad-text)]', task.lastStatus === 'unknown' && 'text-[color:var(--workspace-status-warn-text)]')}>{lastRun}</div>
                {task.pausedReason && <div className="text-[color:var(--workspace-status-warn-text)]">{t(`scheduledOps.paused.${task.pausedReason}`)}</div>}
                {task.lastErrorSummary && <div className="flex items-start gap-1 text-[color:var(--workspace-status-bad-text)]"><CircleAlert className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-words">{task.lastErrorSummary}</span></div>}
                {task.lastStatus === 'completed' && task.lastResultSummary && <div className="flex items-start gap-1 text-[color:var(--workspace-status-good-text)]"><CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /><span className="truncate font-mono text-[11px]" title={task.lastResultSummary}>{task.lastResultSummary}</span></div>}
                {task.authorizationJobId && <div className="truncate font-mono text-[11px]" title={`${t('scheduledOps.authorization')}: ${task.authorizationJobId}`}>{fill(c.authorization, { job: task.authorizationJobId })}</div>}
              </div>
              <div className="flex items-center gap-2 lg:justify-end">
                <button type="button" aria-pressed={task.enabled} aria-label={task.enabled ? t('workspace.scheduledTasks.disable') : t('workspace.scheduledTasks.enable')} title={task.enabled ? t('workspace.scheduledTasks.disable') : t('workspace.scheduledTasks.enable')} disabled={busy} onClick={() => void toggleTask(task)}
                  className={cn('relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', task.enabled ? 'bg-[color:var(--workspace-primary-500)]' : 'bg-[var(--workspace-surface-700)]')}>
                  <span className={cn('h-3.5 w-3.5 rounded-full bg-white shadow transition-transform', task.enabled ? 'translate-x-[16px]' : 'translate-x-0.5')} />
                </button>
                <button type="button" disabled={busy} onClick={() => void runNow(task)} className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 text-xs font-medium text-[var(--workspace-text-strong)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:pointer-events-none disabled:opacity-50">
                  {runningId === task.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{runningId === task.id ? t('workspace.scheduledTasks.running') : t('workspace.scheduledTasks.runNow')}
                </button>
                <button type="button" aria-label={t('workspace.scheduledTasks.remove')} title={t('workspace.scheduledTasks.remove')} disabled={busy} onClick={() => { revokeScheduledTaskAuthorization(activeVaultId, task); persist(loadScheduledTasks(activeVaultId, host.id).filter((item) => item.id !== task.id)) }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)] disabled:pointer-events-none disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        })}</div>}
      </div>
      {output && (
        <div className="sb-card overflow-hidden">
          <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5"><h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{c.output}</h3></div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap bg-[var(--workspace-surface-950)] px-4 py-3 font-mono text-[11px] leading-5">{output}</pre>
        </div>
      )}
      <div className="sb-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{c.addTitle}</h3>
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--workspace-text-subtle)]"><Info className="h-3 w-3" />{c.addNote}</span>
        </div>
        <div className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_2fr_140px_auto] sm:items-end">
          <label className="grid gap-1.5 text-xs text-[var(--workspace-text-muted)]">{t('workspace.scheduledTasks.name')}<Input className={fieldClass} aria-label={t('workspace.scheduledTasks.name')} placeholder={t('workspace.scheduledTasks.name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="grid gap-1.5 text-xs text-[var(--workspace-text-muted)]">{t('workspace.scheduledTasks.command')}<Input className={cn(fieldClass, 'font-mono')} aria-label={t('workspace.scheduledTasks.command')} placeholder={t('workspace.scheduledTasks.command')} value={command} onChange={(event) => setCommand(event.target.value)} /></label>
          <label className="grid gap-1.5 text-xs text-[var(--workspace-text-muted)]"><span>{t('workspace.scheduledTasks.interval')} <span className="text-[var(--workspace-text-subtle)]">{c.intervalRange}</span></span><Input className={fieldClass} aria-label={t('workspace.scheduledTasks.interval')} type="number" min={1} max={10080} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>
          <button type="button" onClick={addTask} className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[color:var(--workspace-primary-500)] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"><Plus className="h-3.5 w-3.5" />{t('workspace.scheduledTasks.add')}</button>
        </div>
      </div>
      <div className="space-y-1 text-[11px] text-[var(--workspace-text-subtle)]">
        <p>{t('workspace.scheduledTasks.auditNote')}</p>
        <p>{t('scheduledOps.lifecycle')}</p>
      </div>
    </section>
  )
}

export default ScheduledTasksPanel
