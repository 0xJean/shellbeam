import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { checkShellbeamAgent, createShellbeamAgentProbeProvider, buildShellbeamAgentPlan, deriveShellbeamAgentHealth, normalizeShellbeamAgentRecord, parseShellbeamAgentProbeOutput, recordShellbeamAgentHeartbeat, shellbeamAgentRecordToProbeSnapshot, parseShellbeamAgentObservation, runShellbeamAgentOperation } from './shellbeam-agent'
import type { HostProfile } from './hosts'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { remoteOperationStatus } from './operation-verification'
import { registerUserConfirmationPresenter } from './user-confirmation'
import type { CommandRunResult } from './sessions'
import { DEFAULT_VAULT_ID } from './vaults'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))

const host: HostProfile = {
  id: 'host-1',
  name: 'edge',
  address: '10.0.0.8',
  port: 2222,
  username: 'ops',
  group: 'Production',
  authType: 'privateKey',
  tags: [],
  jumpHost: 'bastion.internal',
  jumpPort: 22,
  jumpUser: 'jump',
  createdAt: 1,
  updatedAt: 1,
}

describe('ShellBeam Probe lifecycle', () => {
  it('never imports plausible live metrics or starts healthy state from an uncertain native read', async () => {
    const now = Date.now()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: JSON.stringify({ schemaVersion: 1, agentId: 'node', status: 'installed', health: 'online', sampledAt: now, lastHeartbeatAt: now, metrics: { cpuPercent: 20 } }), stderr: '', exitCode: 0, durationMs: 1, errorType: 'unknown' })
    const checked = await checkShellbeamAgent(host, async () => '', now)
    expect(checked.record.health).toBe('unknown')
    expect(checked.snapshot?.metrics).toBeNull()
    expect(checked.errorType).toBe('unknown')
    expect(remoteOperationStatus(checked)).toBe('unknown')
  })
  it('normalizes lifecycle records and derives heartbeat health without changing SSH semantics', () => {
    const record = normalizeShellbeamAgentRecord({
      hostId: host.id,
      transport: 'proxy-jump',
      status: 'installed',
      lastHeartbeatAt: 1_000,
      lastCheckedAt: 2_000,
      capabilities: ['metrics', 'metrics', 'logs'],
      lastError: 'token=secret\nignored',
    }, 2_000)

    expect(record.transport).toBe('proxy-jump')
    expect(record.capabilities).toEqual(['metrics', 'logs'])
    expect(record.health).toBe('online')
    expect(deriveShellbeamAgentHealth(record, 1_000 + 5 * 60 * 1000)).toBe('online')
    expect(deriveShellbeamAgentHealth(record, 1_000 + 5 * 60 * 1000 + 1)).toBe('offline')
  })

  it('parses JSON and marker check responses while keeping missing values unknown', () => {
    const json = parseShellbeamAgentProbeOutput(JSON.stringify({
      status: 'installed',
      version: '0.1.0',
      agentId: 'node-1',
      capabilities: ['heartbeat', 'metrics'],
      lastHeartbeat: '2026-10-16T04:00:00Z',
    }), host, 1_792_123_200_000)
    expect(json.status).toBe('installed')
    expect(json.version).toBe('0.1.0')
    expect(json.agentId).toBe('node-1')
    expect(json.transport).toBe('proxy-jump')

    const marker = parseShellbeamAgentProbeOutput('__SB_AGENT_STATUS=not-installed\n__SB_AGENT_CAPABILITIES=heartbeat,metrics', host, 2_000)
    expect(marker.status).toBe('not-installed')
    expect(marker.health).toBe('unknown')
    expect(marker.capabilities).toEqual(['heartbeat', 'metrics'])

    const unsupported = parseShellbeamAgentProbeOutput('__SB_AGENT_STATUS=unsupported', host, 2_000)
    expect(unsupported.status).toBe('unsupported')
    expect(unsupported.health).toBe('unsupported')
  })

  it('builds explicit plans with safe paths and confirmation metadata', () => {
    const plan = buildShellbeamAgentPlan('install', { installPath: '/tmp/unsafe', version: '1.2.3' })
    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.risk).toBe('high')
    expect(plan.command).toContain('$HOME/.local/bin/shellbeam-agent')
    expect(plan.command).toContain('--path "$HOME/.local/bin/shellbeam-agent"')
    expect(plan.command).not.toContain('/tmp/unsafe')
    expect(buildShellbeamAgentPlan('check').requiresConfirmation).toBe(false)
  })

  it('exposes shellbeam-agent lifecycle metadata through the shared probe snapshot', () => {
    const record = normalizeShellbeamAgentRecord({
      hostId: host.id,
      transport: 'proxy-jump',
      status: 'installed',
      version: '0.1.0',
      lastHeartbeatAt: 1_000,
      lastCheckedAt: 1_500,
      capabilities: ['heartbeat'],
    }, 1_500)
    const snapshot = shellbeamAgentRecordToProbeSnapshot(record, host, 1_500)
    expect(snapshot.provider.kind).toBe('shellbeam-agent')
    expect(snapshot.transport).toBe('proxy-jump')
    expect(snapshot.metrics).toBeNull()
    expect(snapshot.agent).toMatchObject({ status: 'installed', version: '0.1.0' })
  })

  it('uses the existing ProxyJump remote transport for a one-shot check', async () => {
    const check = vi.fn().mockResolvedValue({
      record: normalizeShellbeamAgentRecord({
        hostId: host.id,
        transport: 'proxy-jump',
        status: 'offline',
        lastCheckedAt: 3_000,
      }, 3_000),
      stdout: '', stderr: '', exitCode: 0, durationMs: 12,
    })
    const provider = createShellbeamAgentProbeProvider({ check })
    const snapshot = await provider.probe({ host, resolveAuthSecret: vi.fn(), now: 3_000 })
    expect(check).toHaveBeenCalledWith(host, expect.any(Function), 3_000)
    expect(snapshot.health).toBe('offline')
    expect(snapshot.agent?.status).toBe('offline')
  })

  it('uses real daemon metrics and inventory with original timestamps and unknown values', () => {
    const record = normalizeShellbeamAgentRecord({ hostId: host.id, status: 'installed', health: 'online', transport: 'proxy-jump', lastHeartbeatAt: 100_000, heartbeatTtlMs: 5_000, capabilities: ['metrics', 'inventory', 'heartbeat'] }, 102_000)
    const output = JSON.stringify({ schemaVersion: 1, sampledAt: 100_000, metrics: { hostname: 'edge', os: 'Linux', memoryTotalBytes: 4096, memoryUsedBytes: 2048, memoryPercent: 50, diskPercent: null, cpuPercent: 12 }, inventory: { resource: { arch: 'remote-aarch64' }, tools: [{ id: 'git', name: 'git', binary: 'git', path: '/usr/bin/git', secret: 'not-persisted' }], services: [{ name: 'app.service', active: 'active' }] }, secret: 'not-persisted' })
    const snapshot = parseShellbeamAgentObservation(output, record, host, 102_000)
    expect(snapshot.metrics?.data).toMatchObject({ cpuPercent: 12, memoryPercent: 50, diskPercent: null })
    expect(snapshot.metrics?.freshness).toMatchObject({ sampledAt: 100_000, receivedAt: 102_000, expiresAt: 105_000, expired: false })
    expect(snapshot.inventory?.data.tools[0]).toMatchObject({ id: 'git' })
    expect(snapshot.inventory?.data.services[0]).toMatchObject({ enabled: 'unknown' })
    expect(snapshot.inventory?.data.resource.arch).toBe('remote-aarch64')
    expect(parseShellbeamAgentObservation(output.replace('"resource":{"arch":"remote-aarch64"},', ''), record, host, 102_000).inventory?.data.resource.arch).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain('not-persisted')
    expect(parseShellbeamAgentObservation(output, record, host, 106_000).health).toBe('stale')
    expect(normalizeShellbeamAgentRecord({ ...record, status: 'unknown', health: 'unknown' }, 102_000).health).toBe('unknown')
  })

  it('never accepts a heartbeat or metric sample one minute ahead as healthy, including explicit online records', () => {
    const now = 1_800_000_000_000
    const future = now + 60000
    const record = normalizeShellbeamAgentRecord({ hostId: host.id, status: 'installed', health: 'online', transport: 'direct', lastHeartbeatAt: future }, now)
    expect(record.health).toBe('unknown')
    expect(deriveShellbeamAgentHealth(record, now)).toBe('unknown')
    expect(parseShellbeamAgentProbeOutput(JSON.stringify({ status: 'installed', health: 'online', lastHeartbeatAt: future }), host, now).health).toBe('unknown')
    const observed = normalizeShellbeamAgentRecord({ ...record, lastHeartbeatAt: now, health: 'online' }, now)
    const snapshot = parseShellbeamAgentObservation(JSON.stringify({ schemaVersion: 1, sampledAt: future, metrics: { cpuPercent: 99, memoryPercent: 99 }, inventory: { tools: [], services: [] } }), observed, host, now)
    expect(snapshot.health).toBe('unknown')
    expect(snapshot.metrics).toBeNull()
    expect(snapshot.inventory).toBeNull()
    expect(snapshot.errors).toEqual([expect.objectContaining({ code: 'agent_sample_in_future' })])
  })

  it('compares live samples with request completion so a sample created during collection remains valid', async () => {
    const startedAt = 1_800_000_000_000
    const completedAt = startedAt + 2000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(completedAt)
    try {
      vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: JSON.stringify({ schemaVersion: 1, status: 'installed', health: 'online', lastHeartbeatAt: startedAt + 1000, sampledAt: startedAt + 1000, metrics: { cpuPercent: 20 } }), stderr: '', exitCode: 0, durationMs: 2000 })
      const result = await checkShellbeamAgent(host, async () => '', startedAt)
      expect(result.record.health).toBe('online')
      expect(result.snapshot?.metrics?.freshness).toMatchObject({ sampledAt: startedAt + 1000, receivedAt: completedAt })
      expect(result.snapshot?.health).toBe('online')
    } finally { clock.mockRestore() }
  })

  it('uses the shared partial referenced identity until native SSH supplies the verified current route', async () => {
    const target = { ...host, jumpHostId: 'jump' }
    const record = normalizeShellbeamAgentRecord({ hostId: host.id, status: 'installed', health: 'online', transport: 'proxy-jump' }, 100)
    expect(shellbeamAgentRecordToProbeSnapshot(record, target, 100).host.jump).toEqual({ hostId: 'jump' })
    const hostIdentity = { hostId: host.id, address: host.address, port: host.port, username: host.username, jump: { hostId: 'jump', address: 'edited-bastion', port: 2200, username: 'current-user' } }
    const now = Date.now()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: JSON.stringify({ schemaVersion: 1, status: 'installed', health: 'online', lastHeartbeatAt: now, sampledAt: now, metrics: { cpuPercent: 20 } }), stderr: '', exitCode: 0, durationMs: 1, hostIdentity })
    const result = await checkShellbeamAgent(target, async () => '', now)
    expect(result.snapshot?.host).toEqual(hostIdentity)
  })

  it('rejects oversized, future and incompatible daemon observations', () => {
    const record = normalizeShellbeamAgentRecord({ hostId: host.id, status: 'unknown', health: 'unknown', transport: 'direct' }, 100)
    for (const payload of [{ schemaVersion: 2, sampledAt: 100, metrics: { cpuPercent: 2 } }, { schemaVersion: 1, sampledAt: 9999999999999, metrics: { cpuPercent: 2 } }]) {
      expect(parseShellbeamAgentObservation(JSON.stringify(payload), record, host, 100).metrics).toBeNull()
    }
  })

  it('keeps persistence wrappers scoped to host and vault' , async () => {
    vi.mocked(invoke).mockResolvedValueOnce([])
    const { listShellbeamAgents } = await import('./shellbeam-agent')
    await listShellbeamAgents({ vaultId: 'vault-1', hostId: host.id })
    expect(invoke).toHaveBeenCalledWith('list_shellbeam_agents', { vaultId: 'vault-1', hostId: host.id })
  })

  it('never upgrades persisted unknown or offline daemon health from a cached fresh heartbeat', async () => {
    const { listShellbeamAgents } = await import('./shellbeam-agent')
    const now = Date.now()
    const statuses = ['unknown', 'offline', 'online', 'stale'] as const
    vi.mocked(invoke).mockResolvedValueOnce(statuses.map((health) => normalizeShellbeamAgentRecord({ vaultId: 'vault-1', hostId: health, status: 'installed', health, transport: 'direct', lastHeartbeatAt: now, heartbeatTtlMs: 300000 }, now)))
    expect((await listShellbeamAgents({ vaultId: 'vault-1' })).map((record) => record.health)).toEqual(statuses)
    vi.mocked(invoke).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'vault-1', hostId: 'expired', status: 'installed', health: 'online', transport: 'direct', lastHeartbeatAt: now - 600000, heartbeatTtlMs: 300000 }, now)])
    expect((await listShellbeamAgents({ vaultId: 'vault-1' }))[0].health).toBe('offline')
    vi.mocked(invoke).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'vault-1', hostId: 'future', status: 'installed', health: 'online', transport: 'direct', lastHeartbeatAt: now + 60000 }, now + 60000)])
    expect((await listShellbeamAgents({ vaultId: 'vault-1' }))[0].health).toBe('unknown')
  })

  it('maps heartbeat timestamps to the heartbeat command payload', async () => {
    vi.mocked(invoke).mockReset().mockResolvedValueOnce({})
    await recordShellbeamAgentHeartbeat({
      vaultId: 'vault-1',
      hostId: host.id,
      status: 'installed',
      transport: 'proxy-jump',
      lastHeartbeatAt: 1_000,
      lastCheckedAt: 2_000,
    })
    expect(invoke).toHaveBeenCalledWith('record_shellbeam_agent_heartbeat', {
      input: expect.objectContaining({ heartbeatAt: 1_000, checkedAt: 2_000 }),
    })
    const payload = vi.mocked(invoke).mock.calls[0]?.[1] as { input?: Record<string, unknown> } | undefined
    expect(payload?.input).not.toHaveProperty('lastHeartbeatAt')
  })
})

describe('Agent lifecycle consent remains scoped throughout execution', () => {
  let callerCurrent: boolean
  let presenterCurrent: boolean
  let unregister: (() => void) | undefined

  beforeEach(() => {
    vi.resetAllMocks()
    callerCurrent = true
    presenterCurrent = true
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => presenterCurrent }))
    let job: Record<string, unknown> = {}
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'upsert_shellbeam_agent') return (args as { input: unknown }).input
      const request = (args as { request?: Record<string, unknown> })?.request ?? {}
      job = command === 'operation_job_create'
        ? { ...request, jobId: 'lifecycle-job', auditId: 'lifecycle-audit', status: 'queued', confirmationStatus: 'pending' }
        : { ...job, ...request }
      return { ...job }
    })
  })
  afterEach(() => { unregister?.(); vi.restoreAllMocks() })

  it.each([undefined, 'profile-vault'])('uses the saved profile or Personal Vault when no scope is supplied (%s)', async (profileVault) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ exitCode: 0, durationMs: 1, stdout: '__SB_AGENT_STATUS=retired', stderr: '' })
    const result = await runShellbeamAgentOperation({ host: { ...host, vaultId: profileVault }, action: 'uninstall', resolveAuthSecret: vi.fn() })
    const expectedVault = profileVault ?? DEFAULT_VAULT_ID
    expect(result?.record.vaultId).toBe(expectedVault)
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: expectedVault }) })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({ vaultId: expectedVault }))
  })

  it('rejects conflicting Vault ids before lifecycle state, audit, or remote work', async () => {
    const onRecord = vi.fn()
    await expect(runShellbeamAgentOperation({ host: { ...host, vaultId: 'profile-vault' }, vaultId: 'other-vault', action: 'uninstall', resolveAuthSecret: vi.fn(), onRecord })).rejects.toThrow('WORKSPACE_VAULT_SCOPE_MISMATCH')
    expect(invoke).not.toHaveBeenCalled()
    expect(onRecord).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it.each(['caller', 'presenter'] as const)('cancels with confirmed audit when the %s scope changes during validation', async (scope) => {
    let finishValidation!: () => void
    const beforeExecute = vi.fn(() => new Promise<void>((resolve) => { finishValidation = resolve }))
    const pending = runShellbeamAgentOperation({ host, vaultId: 'lifecycle-vault', action: 'uninstall', resolveAuthSecret: vi.fn(), isCurrent: () => callerCurrent, beforeExecute })
    await vi.waitFor(() => expect(beforeExecute).toHaveBeenCalledOnce())
    if (scope === 'caller') callerCurrent = false
    else presenterCurrent = false
    finishValidation()
    expect(await pending).toBeNull()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' }) })
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'upsert_shellbeam_agent')).toHaveLength(0)
  })

  it('retains a completed command on the original route and never publishes it to the new scope', async () => {
    let complete!: (result: CommandRunResult) => void
    vi.mocked(runWorkspaceRemoteCommand).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = runShellbeamAgentOperation({ host, vaultId: 'lifecycle-vault', action: 'uninstall', resolveAuthSecret: vi.fn(), isCurrent: () => callerCurrent })
    await vi.waitFor(() => expect(runWorkspaceRemoteCommand).toHaveBeenCalledOnce())
    presenterCurrent = false
    complete({ exitCode: 0, durationMs: 1, stdout: '__SB_AGENT_STATUS=retired', stderr: '' })
    const result = await pending
    expect(result?.job).toMatchObject({ status: 'completed', confirmationStatus: 'confirmed' })
    expect(result?.record.status).toBe('retired')
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'upsert_shellbeam_agent')).toHaveLength(0)
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: 'lifecycle-vault', hostId: host.id }) })
  })

  it('audits a sent command as unknown when its transport fails after the route changes', async () => {
    let fail!: (error: Error) => void
    vi.mocked(runWorkspaceRemoteCommand).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = runShellbeamAgentOperation({ host, vaultId: 'lifecycle-vault', action: 'uninstall', resolveAuthSecret: vi.fn(), isCurrent: () => callerCurrent })
    const assertion = expect(pending).rejects.toMatchObject({ sent: true, operationJob: { status: 'unknown', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' } })
    await vi.waitFor(() => expect(runWorkspaceRemoteCommand).toHaveBeenCalledOnce())
    callerCurrent = false
    fail(new Error('endpoint credentials must not be copied into a new scope error'))
    await assertion
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledOnce()
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'upsert_shellbeam_agent')).toHaveLength(0)
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorSummary: expect.not.stringContaining('credentials') }) })
  })

  it('never calls a native unknown result installed merely because it has exit zero', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ exitCode: 0, durationMs: 1, stdout: '__SB_AGENT_STATUS=installed', stderr: '', errorType: 'unknown' })
    const result = await runShellbeamAgentOperation({ host, vaultId: 'lifecycle-vault', action: 'upgrade', resolveAuthSecret: vi.fn() })
    expect(result?.job.status).toBe('unknown')
    expect(result?.record).toMatchObject({ status: 'unknown', health: 'unknown', lastErrorCode: 'remote_state_unknown' })
  })
})
