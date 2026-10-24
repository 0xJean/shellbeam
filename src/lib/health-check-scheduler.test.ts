import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { defaultHealthCheck, latestHealthCheckResults, loadHealthCheckHistory, loadHealthChecks, persistHealthCheckResult, saveHealthChecks, type HealthCheckResult } from './health-checks'
import { createHealthCheckScheduler, runAndPersistHealthCheck } from './health-check-scheduler'
import { clearLocalOpsMemory, loadLocalAlertState } from './local-ops-store'
import { runWorkspaceRemoteCommand } from './workspace-remote'
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
const host = { id: 'host', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1 } as HostProfile
const check = defaultHealthCheck(host)
function result(status: HealthCheckResult['status'], at: number, checkId = check.id): HealthCheckResult { return { checkId, hostId: host.id, status, checkedAt: at, durationMs: 5, latencyMs: 5, transport: 'proxy-jump', provider: 'ssh-agentless', nextCheckAt: at + check.intervalMs } }
beforeEach(() => { localStorage.clear(); clearLocalOpsMemory(); vi.mocked(runWorkspaceRemoteCommand).mockReset() })
describe('app-level health check scheduler', () => {
  it('hydrates nextCheckAt and respects locked vaults and disabled checks', async () => {
    const run = vi.fn(async () => result('passing', 2_000))
    persistHealthCheckResult('vault', result('passing', 1_000))
    let now = 2_000; let unlocked = false
    const scheduler = createHealthCheckScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), now: () => now, run, isUnlocked: () => unlocked })
    await scheduler.tick(); expect(run).not.toHaveBeenCalled()
    unlocked = true; await scheduler.tick(); expect(run).not.toHaveBeenCalled()
    now = 61_000; await scheduler.tick(); expect(run).toHaveBeenCalledTimes(1)
    saveHealthChecks('vault', host.id, [{ ...check, enabled: false }])
    now = 300_000; await scheduler.tick(); expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
  it('shares in-flight work with manual refresh and caps all checks to four concurrent commands', async () => {
    let active = 0; let peak = 0
    const checks = Array.from({ length: 9 }, (_, i) => ({ ...check, id: `check-${i}` }))
    const run = vi.fn(async (_: HostProfile, row: typeof check) => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--; return result('passing', 1_000, row.id) })
    const scheduler = createHealthCheckScheduler({ vaultId: 'vault', getHosts: () => [host], getChecks: () => checks, resolveAuthSecret: vi.fn(), run, now: () => 1_000 })
    const pending = scheduler.tick()
    const manual = runAndPersistHealthCheck({ vaultId: 'vault', host, check: checks[0], resolveAuthSecret: vi.fn(), run: () => run(host, checks[0]), notify: false })
    await Promise.all([pending, scheduler.tick(), manual])
    expect(run).toHaveBeenCalledTimes(9)
    expect(peak).toBeLessThanOrEqual(4)
    expect(loadHealthCheckHistory('vault', host.id)).toHaveLength(9)
    scheduler.stop()
  })
  it('does not publish an old vault collection after stop', async () => {
    let finish!: (value: HealthCheckResult) => void
    const scheduler = createHealthCheckScheduler({ vaultId: 'vault', getHosts: () => [host], resolveAuthSecret: vi.fn(), run: () => new Promise((resolve) => { finish = resolve }) })
    const pending = scheduler.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    scheduler.stop(); finish(result('passing', 1_000)); await pending
    expect(loadHealthCheckHistory('vault', host.id)).toEqual([])
  })
  it('turns failures into durable alerts, keeps unknown open and recovers with a passing check', async () => {
    for (const [status, at] of [['failing', 1_000], ['unknown', 2_000], ['passing', 3_000]] as const) {
      await runAndPersistHealthCheck({ vaultId: 'vault', host, check, resolveAuthSecret: vi.fn(), run: async () => result(status, at), notify: false })
      expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe(status === 'passing' ? 'resolved' : 'active')
    }
    expect(loadLocalAlertState('vault', host.id).audit.map((a) => a.event)).toEqual(['opened', 'resolved'])
    expect(latestHealthCheckResults(loadHealthCheckHistory('vault', host.id))[check.id].status).toBe('passing')
    saveHealthChecks('vault', host.id, [])
    expect(loadHealthChecks('vault', host)).toEqual([])
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('resolved')
  })
  it('persists allowlisted diagnostics only and cannot mix host or vault histories', () => {
    persistHealthCheckResult('vault', { ...result('unknown', 1_000), errorCode: 'auth', errorSummary: 'password=secret', stdout: 'private-key' } as HealthCheckResult)
    expect(JSON.stringify(loadHealthCheckHistory('vault', host.id))).not.toContain('secret')
    expect(JSON.stringify(loadHealthCheckHistory('vault', host.id))).not.toContain('private-key')
    expect(loadHealthCheckHistory('other', host.id)).toEqual([])
    expect(loadHealthCheckHistory('vault', 'other')).toEqual([])
  })

  it.each([
    { label: 'saved jump reference', target: { ...host, jumpHostId: 'bastion-id' }, transport: 'proxy-jump' },
    { label: 'direct host', target: host, transport: 'direct' },
  ] as const)('retains the $label route through real check results, persisted history and alert recovery', async ({ target, transport }) => {
    const runCommand = vi.mocked(runWorkspaceRemoteCommand)
      .mockResolvedValueOnce({ stdout: '', stderr: 'Connection refused', exitCode: 1, durationMs: 5 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'Authentication failed', exitCode: 255, durationMs: 5, errorType: 'auth' })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, durationMs: 5 })
    for (const [status, at] of [['failing', 1_000], ['unknown', 2_000], ['passing', 3_000]] as const) {
      expect(await runAndPersistHealthCheck({ vaultId: 'vault', host: target, check, resolveAuthSecret: vi.fn(), now: at, notify: false })).toMatchObject({ status, checkedAt: at, transport })
      clearLocalOpsMemory()
      expect(loadLocalAlertState('vault', target.id).alerts[0]).toMatchObject({ status: status === 'passing' ? 'resolved' : 'active', transport, source: 'ssh-agentless' })
    }
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ host: target, vaultId: 'vault' }))
    expect(loadHealthCheckHistory('vault', target.id).map(({ status, transport }) => ({ status, transport }))).toEqual([
      { status: 'failing', transport }, { status: 'unknown', transport }, { status: 'passing', transport },
    ])
    expect(loadLocalAlertState('vault', target.id).audit.map(({ event }) => event)).toEqual(['opened', 'resolved'])
  })

  it.each([
    { label: 'saved jump reference', target: { ...host, jumpHostId: 'bastion-id' }, transport: 'proxy-jump' },
    { label: 'direct host', target: host, transport: 'direct' },
  ] as const)('keeps the $label route when cancelled before sending without saving an observation', async ({ target, transport }) => {
    const run = vi.fn()
    const resolveAuthSecret = vi.fn()
    expect(await runAndPersistHealthCheck({ vaultId: 'vault', host: target, check, resolveAuthSecret, now: 1_000, isCurrent: () => false, run, notify: false })).toMatchObject({ status: 'unknown', transport, checkedAt: 1_000, durationMs: null, latencyMs: null })
    expect(run).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(loadHealthCheckHistory('vault', target.id)).toEqual([])
    expect(loadLocalAlertState('vault', target.id)).toMatchObject({ alerts: [], audit: [], evaluations: [] })
  })
})
