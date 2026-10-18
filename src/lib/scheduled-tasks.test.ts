import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeScheduledTask, clearScheduledTaskAuthorizations, isScheduledTaskDue, loadScheduledTasks, normalizeScheduledTask, runScheduledTaskOperation, saveScheduledTasks } from './scheduled-tasks'

describe('scheduled tasks', () => {
  beforeEach(() => { localStorage.clear(); clearScheduledTaskAuthorizations() })

  it('normalizes intervals and schedules the next run', () => {
    const task = normalizeScheduledTask({ hostId: 'host-1', name: 'backup', command: 'tar -czf /tmp/backup.tgz /srv', intervalMinutes: 0 }, 1000)
    expect(task.intervalMinutes).toBe(1)
    expect(task.nextRunAt).toBe(61_000)
    expect(isScheduledTaskDue({ ...task, nextRunAt: 2000 }, 1000)).toBe(false)
    expect(isScheduledTaskDue({ ...task, nextRunAt: 999 }, 1000)).toBe(true)
  })

  it('rejects multiline commands and persists host-scoped records', () => {
    expect(() => normalizeScheduledTask({ hostId: 'host-1', name: 'bad', command: 'echo ok\nrm -rf /', intervalMinutes: 5 })).toThrow()
    const task = normalizeScheduledTask({ hostId: 'host-1', name: 'check', command: 'systemctl is-active nginx', intervalMinutes: 5 }, 10)
    saveScheduledTasks('vault-1', 'host-1', [task], 20)
    expect(loadScheduledTasks('vault-1', 'host-1')).toHaveLength(1)
    expect(loadScheduledTasks('vault-1', 'host-2')).toEqual([])
  })


  it('records scheduled executions with the host transport and bounded summaries', async () => {
    const task = authorizeScheduledTask(undefined, normalizeScheduledTask({ id: 'host-1:task', hostId: 'host-1', name: 'check', command: 'systemctl is-active nginx', intervalMinutes: 5 }, 10), 'enable-job', 10)
    const createJob = vi.fn().mockResolvedValue({ jobId: 'job-1', auditId: 'audit-1' })
    const updateJob = vi.fn().mockImplementation(async (request) => ({ jobId: 'job-1', auditId: 'audit-1', ...request }))
    const result = await runScheduledTaskOperation({
      task,
      host: { id: 'host-1', name: 'jumped', address: '10.0.0.4', port: 22, username: 'ops', group: 'Custom', authType: 'privateKey', jumpHost: 'bastion', jumpPort: 2222, jumpUser: 'jump', tags: [], createdAt: 0, updatedAt: 0 },
      resolveAuthSecret: async () => 'secret',
      runCommand: async () => ({ stdout: 'active', stderr: '', exitCode: 0, durationMs: 7 }),
      createJob,
      updateJob,
    })
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ action: 'scheduled-task.run', transport: 'proxy-jump', confirmationRequired: false }))
    expect(updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }))
    expect(result.job.jobId).toBe('job-1')
  })

  it('supports a bounded scheduler callback', async () => {
    vi.useFakeTimers()
    const task = normalizeScheduledTask({ id: 'host-1:task', hostId: 'host-1', name: 'check', command: 'true', intervalMinutes: 1, nextRunAt: 0 }, 0)
    const onTaskRun = vi.fn()
    const { createScheduledTaskScheduler } = await import('./scheduled-tasks')
    const scheduler = createScheduledTaskScheduler({
      tasks: [task],
      host: { id: 'host-1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 },
      resolveAuthSecret: vi.fn(),
      runTask: vi.fn().mockResolvedValue({ task, job: { jobId: 'job', auditId: 'audit' } as never, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      onTaskRun,
      now: () => 61_000,
    })
    await scheduler.tick(61_000)
    expect(onTaskRun).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
