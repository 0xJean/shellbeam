import { flushLocalOpsHost, hydrateLocalOpsHost } from './local-ops-persistence'
import type { HostProfile } from './hosts'
import { isUnknownOperationError, type OperationJob } from './operation-job'
import { isRemoteOperationOutcomeUnknown, remoteOperationStatus } from './operation-verification'
import { createScheduledTaskScheduler, isScheduledTaskAuthorized, isScheduledTaskDue, isScheduledTaskRunning, loadScheduledTasks, pauseScheduledTasks, revokeScheduledTaskAuthorization, runScheduledTaskOperation, saveScheduledTasks, withScheduledTaskLock, type ScheduledTask, type ScheduledTaskRunResult } from './scheduled-tasks'

export interface ScheduledOpsOptions {
  vaultId: string
  getHosts: () => HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  now?: () => number
  isCurrent?: () => boolean
  pollMs?: number
  runTask?: (host: HostProfile, task: ScheduledTask) => Promise<ScheduledTaskRunResult>
}
/** Persist running intent and a future due time before sending the command.
 * A terminated app therefore cannot silently replay a possibly-applied write. */
export async function runScopedScheduledTask(options: ScheduledOpsOptions, host: HostProfile, task: ScheduledTask) {
  if (host.vaultId && host.vaultId !== options.vaultId) throw new Error('Scheduled task vault mismatch')
  return withScheduledTaskLock(options.vaultId, task, async () => {
    const now = options.now ?? Date.now
    await hydrateLocalOpsHost(options.vaultId, host.id)
    let tasks = loadScheduledTasks(options.vaultId, host.id)
    const current = tasks.find((row) => row.id === task.id)
    if (!current || current.hostId !== host.id || options.isCurrent?.() === false || !isScheduledTaskAuthorized(options.vaultId, current) || !isScheduledTaskDue(current, now())) throw new Error('Scheduled task authorization or scope changed')
    const startedAt = now()
    const running: ScheduledTask = { ...current, lastStatus: 'running', lastRunAt: startedAt, nextRunAt: startedAt + current.intervalMinutes * 60_000, updatedAt: startedAt }
    try {
      saveScheduledTasks(options.vaultId, host.id, tasks.map((row) => row.id === task.id ? running : row), startedAt)
      await flushLocalOpsHost(options.vaultId, host.id)
      const result = options.runTask ? await options.runTask(host, running) : await runScheduledTaskOperation({ vaultId: options.vaultId, host, task: running, resolveAuthSecret: options.resolveAuthSecret, now })
      const status = result.job.status === 'unknown' || isRemoteOperationOutcomeUnknown(result) ? 'unknown' : remoteOperationStatus(result)
      if (status === 'unknown') revokeScheduledTaskAuthorization(options.vaultId, current)
      if (options.isCurrent?.() === false) return result
      tasks = loadScheduledTasks(options.vaultId, host.id)
      saveScheduledTasks(options.vaultId, host.id, tasks.map((row) => row.id === task.id ? { ...row, ...(status === 'unknown' ? { enabled: false, pausedReason: 'interrupted' as const } : {}), lastRunAt: startedAt, nextRunAt: status === 'unknown' ? null : row.enabled ? now() + row.intervalMinutes * 60_000 : null, lastStatus: status, lastResultSummary: `job=${result.job.jobId} audit=${result.job.auditId} status=${result.job.status} exit=${result.exitCode}`, lastErrorSummary: status === 'unknown' ? 'Remote result is unknown; verify before resuming' : status === 'completed' ? null : 'Scheduled command exited with a non-zero status', updatedAt: now() } : row), now())
      await flushLocalOpsHost(options.vaultId, host.id)
      return result
    } catch (error) {
      if (options.isCurrent?.() !== false) {
        const job = (error as { operationJob?: OperationJob })?.operationJob
        const unknown = job?.status === 'unknown' || isUnknownOperationError(error)
        tasks = loadScheduledTasks(options.vaultId, host.id)
        saveScheduledTasks(options.vaultId, host.id, tasks.map((row) => {
          if (row.id !== task.id) return row
          revokeScheduledTaskAuthorization(options.vaultId, row)
          return { ...row, enabled: false, nextRunAt: null, lastStatus: unknown ? 'unknown' : 'failed', pausedReason: unknown ? 'interrupted' : 'user', lastErrorSummary: unknown ? 'Remote result is unknown; verify before resuming' : 'Scheduled execution failed; resume explicitly after checking the host', updatedAt: now() }
        }), now())
      }
      throw error
    }
  })
}
/** Owns one app-lifetime schedule across hosts, with dynamic persisted tasks.
 * Restart/unlock pauses persisted authorizations; enabling in the UI creates a
 * new confirmed session authorization and always schedules a future run. */
export function createScheduledOpsScheduler(options: ScheduledOpsOptions) {
  const schedulers = new Map<string, ReturnType<typeof createScheduledTaskScheduler>>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  const current = () => !stopped && options.isCurrent?.() !== false
  async function tick() {
    if (!current()) return
    if (ticking) return ticking
    const work = Promise.resolve().then(async () => {
      const hosts = options.getHosts()
      const hostIds = new Set(hosts.map((host) => host.id))
      for (const [id, scheduler] of schedulers) if (!hostIds.has(id)) { scheduler.stop(); schedulers.delete(id) }
      for (const host of hosts) {
        if (schedulers.has(host.id)) continue
        await hydrateLocalOpsHost(options.vaultId, host.id)
        pauseScheduledTasks(options.vaultId, host.id, 'restart', options.now?.() ?? Date.now())
        schedulers.set(host.id, createScheduledTaskScheduler({ vaultId: options.vaultId, tasks: [], host, resolveAuthSecret: options.resolveAuthSecret, now: options.now, isCurrent: current, getTasks: () => loadScheduledTasks(options.vaultId, host.id).filter((task) => isScheduledTaskAuthorized(options.vaultId, task) && !isScheduledTaskRunning(options.vaultId, task)), runTask: (task) => runScopedScheduledTask({ ...options, isCurrent: current }, options.getHosts().find((row) => row.id === host.id) ?? host, task) }))
      }
      await Promise.all([...schedulers.values()].map((scheduler) => scheduler.tick()))
    })
    ticking = work
    try { await work } finally { if (ticking === work) ticking = undefined }
  }
  return {
    tick,
    start() { if (timer) return; stopped = false; void tick(); timer = setInterval(() => { void tick() }, Math.max(1_000, options.pollMs ?? 5_000)) },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; for (const scheduler of schedulers.values()) scheduler.stop(); for (const host of options.getHosts()) pauseScheduledTasks(options.vaultId, host.id, 'vault-locked', options.now?.() ?? Date.now()) },
  }
}
