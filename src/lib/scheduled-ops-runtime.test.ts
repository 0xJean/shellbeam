import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { createScheduledOpsScheduler } from './scheduled-ops-runtime'
import { authorizeScheduledTask, clearScheduledTaskAuthorizations, isScheduledTaskAuthorized, loadScheduledTasks, normalizeScheduledTask, saveScheduledTasks, type ScheduledTask, type ScheduledTaskRunResult } from './scheduled-tasks'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from './workspace-remote'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
const host: HostProfile = { id: 'host', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', group: 'Custom', tags: [], createdAt: 1, updatedAt: 1 }
const makeTask = (id = 'task', hostId = host.id) => normalizeScheduledTask({ id, hostId, name: 'refresh', command: 'systemctl restart nginx', intervalMinutes: 1, enabled: true }, 1_000)
function runResult(task: ScheduledTask): ScheduledTaskRunResult { return { task, job: { jobId: 'run-job', auditId: 'run-audit', status: 'completed' } as ScheduledTaskRunResult['job'], stdout: 'private output', stderr: '', exitCode: 0, durationMs: 1 } }
beforeEach(() => { localStorage.clear(); clearScheduledTaskAuthorizations() })
describe('app-level scheduled operations', () => {
  it('pauses persisted schedules after restart and never replays missed writes without fresh confirmation', async () => {
    const task = { ...makeTask(), nextRunAt: 1_000 }
    saveScheduledTasks('vault', host.id, [task], 1_000)
    const runTask = vi.fn(async (_: HostProfile, current: ScheduledTask) => runResult(current))
    let now = 100_000
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now, runTask })
    await scheduler.tick()
    expect(runTask).not.toHaveBeenCalled()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, pausedReason: 'restart', nextRunAt: null })
    const approved = authorizeScheduledTask('vault', task, 'enable-job', now)
    saveScheduledTasks('vault', host.id, [approved], now)
    await scheduler.tick(); expect(runTask).not.toHaveBeenCalled()
    now += 60_000; await scheduler.tick()
    expect(runTask).toHaveBeenCalledOnce()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ lastStatus: 'completed', nextRunAt: 220_000, authorizationJobId: 'enable-job' })
    expect(JSON.stringify(loadScheduledTasks('vault', host.id))).not.toContain('private output')
    scheduler.stop()
  })
  it('persists running intent and converts interruption to unknown; unlock requires explicit future resume', async () => {
    let now = 61_000
    const task = authorizeScheduledTask('vault', makeTask(), 'enable-job', 1_000)
    saveScheduledTasks('vault', host.id, [task], 1_000)
    let finish!: (value: ScheduledTaskRunResult) => void
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now, runTask: () => new Promise((resolve) => { finish = resolve }) })
    const pending = scheduler.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ lastStatus: 'running', lastRunAt: 61_000, nextRunAt: 121_000 })
    scheduler.stop()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'unknown', pausedReason: 'interrupted' })
    finish(runResult(task)); await pending
    expect(loadScheduledTasks('vault', host.id)[0].lastStatus).toBe('unknown')
    now += 1_000_000
    const replay = vi.fn()
    const next = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now, runTask: replay })
    await next.tick(); expect(replay).not.toHaveBeenCalled(); next.stop()
  })
  it('bounds concurrency globally across hosts and prevents overlapping ticks', async () => {
    const hosts = Array.from({ length: 3 }, (_, i) => ({ ...host, id: `host-${i}` }))
    for (const item of hosts) saveScheduledTasks('vault', item.id, Array.from({ length: 3 }, (_, i) => authorizeScheduledTask('vault', makeTask(`task-${i}`, item.id), `enable-${i}`, 1_000)), 1_000)
    let active = 0; let peak = 0
    const runTask = vi.fn(async (_: HostProfile, task: ScheduledTask) => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; return runResult(task) })
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => hosts, resolveAuthSecret: vi.fn(), now: () => 61_000, runTask })
    await Promise.all([scheduler.tick(), scheduler.tick()])
    expect(runTask).toHaveBeenCalledTimes(9)
    expect(peak).toBeLessThanOrEqual(2)
    scheduler.stop()
  })
  it('invalidates authorization when command or interval changes and cannot cross vault scopes', () => {
    const task = authorizeScheduledTask('vault', makeTask(), 'enable-job', 1_000)
    expect(isScheduledTaskAuthorized('vault', task)).toBe(true)
    expect(isScheduledTaskAuthorized('other', task)).toBe(false)
    expect(isScheduledTaskAuthorized('vault', { ...task, command: 'rm -rf /tmp/x' })).toBe(false)
    expect(isScheduledTaskAuthorized('vault', { ...task, intervalMinutes: 2 })).toBe(false)
  })
  it('requires explicit resume after an unknown command result and persists only a safe category', async () => {
    saveScheduledTasks('vault', host.id, [authorizeScheduledTask('vault', makeTask(), 'enable-job', 1_000)], 1_000)
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => 61_000, runTask: vi.fn().mockRejectedValue(new Error('transport connection lost token=secret')) })
    await scheduler.tick()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, lastStatus: 'unknown', nextRunAt: null })
    expect(JSON.stringify(loadScheduledTasks('vault', host.id))).not.toContain('secret')
    scheduler.stop()
  })

  it.each(['target_timeout', 'target_disconnected', 'output_limit', 'remote_state_unknown'])('pauses structured %s returned by the native executor and does not issue the next periodic write', async (errorCode) => {
    const task = authorizeScheduledTask('vault', makeTask(), 'enable-job', 1000)
    saveScheduledTasks('vault', host.id, [task], 1000)
    let now = 61000
    const runTask = vi.fn(async (_: HostProfile, current: ScheduledTask): Promise<ScheduledTaskRunResult> => ({ ...runResult(current), exitCode: -1, errorType: 'network', errorCode, job: { ...runResult(current).job, status: 'unknown', errorCode } }))
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now, runTask })
    await scheduler.tick()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'unknown', pausedReason: 'interrupted' })
    expect(isScheduledTaskAuthorized('vault', task)).toBe(false)
    now += 10 * 60000
    await scheduler.tick()
    expect(runTask).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('preserves canonical unknown even if the command has exit code zero', async () => {
    const task = authorizeScheduledTask('vault', makeTask(), 'enable-job', 1000)
    saveScheduledTasks('vault', host.id, [task], 1000)
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => 61000, runTask: async (_host, current) => ({ ...runResult(current), job: { ...runResult(current).job, status: 'unknown' } }) })
    await scheduler.tick()
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'unknown' })
    scheduler.stop()
  })

  it('runs the native-returned timeout through the real canonical task executor and pauses before another tick', async () => {
    const task = authorizeScheduledTask('vault', makeTask(), 'enable-job', 1000)
    saveScheduledTasks('vault', host.id, [task], 1000)
    vi.mocked(invoke).mockImplementation(async (_command, args) => ({ jobId: 'native-job', auditId: 'native-audit', ...(args as { request: object }).request }))
    vi.mocked(runWorkspaceRemoteCommand).mockReset().mockResolvedValue({ stdout: '', stderr: 'Remote command outcome is unknown after timeout', exitCode: -1, durationMs: 30000, errorCode: 'target_timeout', errorType: 'network' })
    let now = 61000
    const scheduler = createScheduledOpsScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now })
    await scheduler.tick()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'target_timeout' }) })
    expect(loadScheduledTasks('vault', host.id)[0]).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'unknown' })
    expect(isScheduledTaskAuthorized('vault', task)).toBe(false)
    now += 600000
    await scheduler.tick()
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault', host }))
    scheduler.stop()
  })
})
