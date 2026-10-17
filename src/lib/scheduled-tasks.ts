import type { HostProfile } from './hosts'
import {
  createOperationJob,
  isUnknownOperationError,
  operationTransport,
  safeOperationTarget,
  updateOperationJob,
  type OperationJob,
} from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'

export const SCHEDULED_TASK_STORAGE_PREFIX = 'shellbeam.scheduled-tasks.v1'
export const SCHEDULED_TASK_MIN_INTERVAL_MINUTES = 1
export const SCHEDULED_TASK_MAX_INTERVAL_MINUTES = 7 * 24 * 60
export const SCHEDULED_TASK_MAX_COMMAND_LENGTH = 2_000

export type ScheduledTaskStatus = 'idle' | 'running' | 'completed' | 'failed' | 'unknown'

export interface ScheduledTask {
  id: string
  hostId: string
  name: string
  command: string
  intervalMinutes: number
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  lastStatus: ScheduledTaskStatus
  lastResultSummary: string | null
  lastErrorSummary: string | null
  createdAt: number
  updatedAt: number
}

export interface ScheduledTaskRunResult {
  task: ScheduledTask
  job: OperationJob
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

function storageKey(vaultId: string | undefined, hostId: string) {
  return `${SCHEDULED_TASK_STORAGE_PREFIX}:${vaultId?.trim() || 'local'}:${hostId}`
}

function cleanText(value: unknown, maxLength: number) {
  return Array.from(String(value ?? '')).map((character) => { const code = character.charCodeAt(0); return code >= 32 && code !== 127 ? character : ' ' }).join('').trim().slice(0, maxLength)
}

function safeTaskId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
}

function timeoutError(timeoutMs: number) {
  const error = new Error(`Scheduled task timed out after ${timeoutMs}ms`)
  error.name = 'ScheduledTaskTimeoutError'
  return error
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function normalizeScheduledTask(input: Partial<ScheduledTask> & Pick<ScheduledTask, 'hostId' | 'name' | 'command'>, now = Date.now()): ScheduledTask {
  const intervalMinutes = Math.max(
    SCHEDULED_TASK_MIN_INTERVAL_MINUTES,
    Math.min(SCHEDULED_TASK_MAX_INTERVAL_MINUTES, Math.floor(Number(input.intervalMinutes) || 0)),
  )
  const command = cleanText(input.command, SCHEDULED_TASK_MAX_COMMAND_LENGTH)
  if (!command || /[\r\n]/.test(String(input.command ?? ''))) throw new Error('Scheduled task command must be a single non-empty line')
  const id = cleanText(input.id || `${input.hostId}:${now}`, 128)
  if (!safeTaskId(id)) throw new Error('Scheduled task id is invalid')
  const lastRunAt = Number.isFinite(input.lastRunAt) && Number(input.lastRunAt) > 0 ? Number(input.lastRunAt) : null
  const requestedNext = Number.isFinite(input.nextRunAt) && Number(input.nextRunAt) > 0 ? Number(input.nextRunAt) : null
  return {
    id,
    hostId: cleanText(input.hostId, 160),
    name: cleanText(input.name, 120) || 'Scheduled task',
    command,
    intervalMinutes,
    enabled: input.enabled !== false,
    lastRunAt,
    nextRunAt: requestedNext ?? (input.enabled === false ? null : now + intervalMinutes * 60_000),
    lastStatus: input.lastStatus === 'running' || input.lastStatus === 'completed' || input.lastStatus === 'failed' || input.lastStatus === 'unknown' ? input.lastStatus : 'idle',
    lastResultSummary: input.lastResultSummary ? cleanText(input.lastResultSummary, 240) : null,
    lastErrorSummary: input.lastErrorSummary ? cleanText(input.lastErrorSummary, 240) : null,
    createdAt: Number.isFinite(input.createdAt) && Number(input.createdAt) > 0 ? Number(input.createdAt) : now,
    updatedAt: Number.isFinite(input.updatedAt) && Number(input.updatedAt) > 0 ? Number(input.updatedAt) : now,
  }
}

export function loadScheduledTasks(vaultId: string | undefined, hostId: string): ScheduledTask[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(vaultId, hostId)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      try { return [normalizeScheduledTask({ ...item, hostId }, Number(item?.updatedAt) || Date.now())] } catch { return [] }
    })
  } catch {
    return []
  }
}

export function saveScheduledTasks(vaultId: string | undefined, hostId: string, tasks: ScheduledTask[], now = Date.now()) {
  const normalized = tasks.map((task) => normalizeScheduledTask({ ...task, hostId, updatedAt: now }, now))
  if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(vaultId, hostId), JSON.stringify(normalized))
  return normalized
}

export function clearScheduledTasks(vaultId: string | undefined, hostId: string) {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey(vaultId, hostId))
}

export function isScheduledTaskDue(task: ScheduledTask, now = Date.now()) {
  return task.enabled && task.lastStatus !== 'running' && task.nextRunAt !== null && task.nextRunAt <= now
}

export function scheduledTaskSummary(task: ScheduledTask) {
  return `${task.name} · every ${task.intervalMinutes}m · ${safeOperationTarget(task.command, 120)}`
}

interface ScheduledTaskOperationOptions {
  host: HostProfile
  task: ScheduledTask
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  runCommand?: (task: ScheduledTask) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>
  createJob?: typeof createOperationJob
  updateJob?: typeof updateOperationJob
  now?: () => number
  timeoutMs?: number
}

/** Executes an enabled task without a prompt. Enabling the schedule is the
 * explicit authorization; every execution still creates a durable audit job. */
export async function runScheduledTaskOperation(options: ScheduledTaskOperationOptions): Promise<ScheduledTaskRunResult> {
  const createJob = options.createJob ?? createOperationJob
  const updateJob = options.updateJob ?? updateOperationJob
  const { host, task } = options
  const job = await createJob({
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    source: 'monitor',
    actor: 'scheduled-task',
    action: 'scheduled-task.run',
    target: safeOperationTarget(task.name),
    risk: 'high',
    provider: 'ssh-agentless',
    transport: operationTransport(host),
    paramsSummary: safeOperationTarget(task.command),
    confirmationRequired: false,
  })
  await updateJob({ jobId: job.jobId, status: 'running', confirmationStatus: 'not_required', actor: 'scheduled-task' })
  try {
    const result = await withTimeout((options.runCommand
      ? options.runCommand(task)
      : runWorkspaceRemoteCommand({ host, resolveAuthSecret: options.resolveAuthSecret, command: task.command })), options.timeoutMs ?? 120_000)
    const completed = await updateJob({
      jobId: job.jobId,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      resultSummary: `exit=${result.exitCode}; durationMs=${result.durationMs}`,
      ...(result.exitCode === 0 ? {} : { errorCode: `exit_${result.exitCode}`, errorSummary: 'Scheduled command exited with a non-zero status' }),
      actor: 'scheduled-task',
    })
    return { task, job: completed, ...result }
  } catch (error) {
    const unknown = isUnknownOperationError(error)
    const failed = await updateJob({
      jobId: job.jobId,
      status: unknown ? 'unknown' : 'failed',
      errorCode: unknown ? 'remote_state_unknown' : 'scheduled_task_failed',
      errorSummary: safeOperationTarget(error instanceof Error ? error.message : String(error), 240),
      actor: 'scheduled-task',
    })
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { operationJob: failed })
  }
}

export interface ScheduledTaskScheduler {
  start(): void
  stop(): void
  tick(now?: number): Promise<void>
  isRunning(): boolean
}

export function createScheduledTaskScheduler(options: {
  tasks: ScheduledTask[]
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  intervalMs?: number
  concurrency?: number
  now?: () => number
  runTask?: (task: ScheduledTask) => Promise<ScheduledTaskRunResult>
  onTaskRun?: (result: ScheduledTaskRunResult) => void
  onTaskError?: (error: unknown, task: ScheduledTask) => void
}): ScheduledTaskScheduler {
  const intervalMs = Math.max(1_000, Math.min(86_400_000, Math.floor(options.intervalMs ?? 30_000)))
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 2)))
  const now = options.now ?? (() => Date.now())
  const inFlight = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tick(at = now()) {
    const due = options.tasks.filter((task) => isScheduledTaskDue(task, at) && !inFlight.has(task.id))
    const queue = due.slice()
    async function worker() {
      while (queue.length) {
        const task = queue.shift()
        if (!task || inFlight.has(task.id)) continue
        inFlight.add(task.id)
        try {
          const result = await (options.runTask
            ? options.runTask(task)
            : runScheduledTaskOperation({ host: options.host, task, resolveAuthSecret: options.resolveAuthSecret, now }))
          options.onTaskRun?.(result)
        } catch (error) {
          options.onTaskError?.(error, task)
        } finally {
          inFlight.delete(task.id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, due.length)) }, () => worker()))
  }

  return {
    start() {
      if (running) return
      running = true
      void tick().catch(() => undefined)
      timer = setInterval(() => { if (running) void tick().catch(() => undefined) }, intervalMs)
    },
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = undefined
    },
    tick,
    isRunning: () => running,
  }
}
