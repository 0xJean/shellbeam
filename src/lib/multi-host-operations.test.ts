import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BATCH_CONCURRENCY,
  MAX_BATCH_HOSTS,
  normalizeBatchConcurrency,
  runBatchOperation,
  runBatchServiceOperation,
  runBatchDockerOperation,
  selectBatchHosts,
} from './multi-host-operations'
import type { HostProfile } from './hosts'
import type { CreateOperationJobRequest, OperationJob, UpdateOperationJobRequest } from './operation-job'
import { runWorkspaceRemoteCommand } from './workspace-remote'

vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))

const host = (id: string, jumpHost?: string): HostProfile => ({
  id,
  vaultId: 'vault-1',
  name: id,
  address: `${id}.example.test`,
  port: 22,
  username: 'ops',
  group: 'Production',
  authType: 'password' as const,
  tags: [],
  ...(jumpHost ? { jumpHost, jumpPort: 2200, jumpUser: 'jump' } : {}),
  createdAt: 0,
  updatedAt: 0,
})

function batchAudit() {
  const rows = new Map<string, OperationJob>()
  const createJob = vi.fn(async (request: CreateOperationJobRequest) => {
    const row = { ...request, jobId: `job-${request.hostId}`, auditId: `audit-${request.hostId}`, status: 'queued', confirmationStatus: 'pending', queuedAt: 1, updatedAt: 1 } as OperationJob
    rows.set(row.jobId, row)
    return row
  })
  const updateJob = vi.fn(async (request: UpdateOperationJobRequest) => {
    const row = { ...rows.get(request.jobId), ...request } as OperationJob
    rows.set(row.jobId, row)
    return row
  })
  return { createJob, updateJob }
}
const remoteResult = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, durationMs: 1 })

describe('batch canonical result closure', () => {
  beforeEach(() => { vi.mocked(runWorkspaceRemoteCommand).mockReset() })

  it.each(['target_timeout', 'target_disconnected', 'output_limit', 'remote_state_unknown'])('retains native %s as unknown in each job and the aggregate', async (errorCode) => {
    const audit = batchAudit()
    const execute = vi.fn(async () => ({ ...remoteResult('', -1), errorCode, errorType: 'network' as const }))
    const result = await runBatchOperation({ hosts: [host('a')], action: 'service.restart', target: 'nginx.service', risk: 'high', confirmMessage: 'Confirm?', confirm: () => true, execute, getResult: (value) => value, ...audit })
    expect(result).toMatchObject({ status: 'unknown', unknownCount: 1, failedCount: 0 })
    expect(result.outcomes[0].job).toMatchObject({ status: 'unknown', errorCode, vaultId: 'vault-1' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(audit.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unknown', errorCode }))
  })

  it('keeps pre-exec timeout known failed and keeps exact vault scope on the remote call and audit', async () => {
    const audit = batchAudit()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ ...remoteResult('', -1), errorCode: 'target_timeout_before_execution', errorType: 'network' })
    const result = await runBatchServiceOperation({ hosts: [{ ...host('a'), vaultId: undefined }], vaultId: 'explicit-vault', serviceName: 'nginx.service', serviceAction: 'restart', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: () => true, ...audit })
    expect(result.outcomes[0].job).toMatchObject({ status: 'failed', errorCode: 'target_timeout_before_execution', vaultId: 'explicit-vault' })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'explicit-vault', host: expect.objectContaining({ vaultId: 'explicit-vault' }) }))
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects missing, conflicting and ambiguous vault scope before creating jobs or executing', async () => {
    const audit = batchAudit()
    const options = { hosts: [host('a')], serviceName: 'nginx.service', serviceAction: 'restart' as const, resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: vi.fn(() => true), ...audit }
    await expect(runBatchServiceOperation({ ...options, vaultId: 'other' })).rejects.toThrow('batch_vault_scope_mismatch')
    await expect(runBatchServiceOperation({ ...options, hosts: [{ ...host('a'), vaultId: undefined }] })).rejects.toThrow('batch_vault_scope_required')
    await expect(runBatchServiceOperation({ ...options, hosts: [host('a'), { ...host('a'), vaultId: 'other' }] })).rejects.toThrow('batch_selection_ambiguous_host')
    expect(audit.createJob).not.toHaveBeenCalled()
    expect(options.confirm).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it('verifies a successfully stopped service as inactive without systemctl status exit 3', async () => {
    const audit = batchAudit()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(remoteResult()).mockResolvedValueOnce(remoteResult('ActiveState=inactive\nUnitFileState=enabled'))
    const result = await runBatchServiceOperation({ hosts: [host('a')], serviceName: 'nginx.service', serviceAction: 'stop', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: () => true, ...audit })
    expect(result.outcomes[0].job).toMatchObject({ status: 'completed', resultSummary: expect.stringContaining('active=inactive') })
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls.map(([request]) => request.command)).toEqual(['systemctl stop -- nginx.service', 'systemctl show --property=ActiveState --property=UnitFileState -- nginx.service'])
  })

  it('does not complete a service restart when the observed state is failed', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(remoteResult()).mockResolvedValueOnce(remoteResult('ActiveState=failed\nUnitFileState=enabled'))
    const result = await runBatchServiceOperation({ hosts: [host('a')], serviceName: 'nginx.service', serviceAction: 'restart', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: () => true, ...batchAudit() })
    expect(result.outcomes[0].job).toMatchObject({ status: 'unknown', errorCode: 'post_state_unverified' })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })

  it('keeps any unavailable post-service observation unknown and never replays the write', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(remoteResult()).mockRejectedValueOnce(new Error('permission denied to read service status'))
    const result = await runBatchServiceOperation({ hosts: [host('a')], serviceName: 'nginx.service', serviceAction: 'restart', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: () => true, ...batchAudit() })
    expect(result.outcomes[0].job).toMatchObject({ status: 'unknown', errorCode: 'remote_state_unknown' })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })

  it('resolves each host container after one confirmation and writes/verifies only its immutable id', async () => {
    const ids = { a: 'a'.repeat(64), b: 'b'.repeat(64) }
    const confirm = vi.fn(() => true)
    const audit = batchAudit()
    vi.mocked(runWorkspaceRemoteCommand).mockImplementation(async ({ host, command }) => {
      expect(confirm).toHaveBeenCalledTimes(1)
      const id = ids[host.id as keyof typeof ids]
      if (command.includes('__SB_DOCKER_ID=')) return remoteResult(`__SB_DOCKER_ID=${id}`)
      if (command.includes('__SB_DOCKER_VERIFY=')) return remoteResult(`__SB_DOCKER_VERIFY=${id}|${host.id === 'a' ? 'running|true' : 'exited|false'}|false|false`)
      expect(command).toBe(`docker restart '${id}'`)
      return remoteResult()
    })
    const result = await runBatchDockerOperation({ hosts: [host('a', 'jump'), host('b')], containerName: 'api', dockerAction: 'restart', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm, ...audit })
    expect(result).toMatchObject({ status: 'partial', completedCount: 1, unknownCount: 1 })
    expect(result.outcomes[0].job?.status).toBe('completed')
    expect(result.outcomes[1].job?.status).toBe('unknown')
    expect(audit.createJob).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls.filter(([request]) => request.command.startsWith('docker restart '))).toHaveLength(2)
    expect(vi.mocked(runWorkspaceRemoteCommand).mock.calls.every(([request]) => request.vaultId === 'vault-1')).toBe(true)
  })

  it('does not execute Docker writes after rejected confirmation or unparseable identity', async () => {
    const options = { hosts: [host('a')], containerName: 'api', dockerAction: 'start' as const, resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', ...batchAudit() }
    expect((await runBatchDockerOperation({ ...options, confirm: () => false })).status).toBe('cancelled')
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(remoteResult('__SB_DOCKER_ID=api'))
    expect((await runBatchDockerOperation({ ...options, confirm: () => true })).outcomes[0].job?.status).toBe('unknown')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
  })

  it('preserves native Docker action timeout and does not inspect or replay after it', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(remoteResult(`__SB_DOCKER_ID=${'a'.repeat(64)}`)).mockResolvedValueOnce({ ...remoteResult('', -1), errorCode: 'target_timeout', errorType: 'network' })
    const result = await runBatchDockerOperation({ hosts: [host('a')], containerName: 'api', dockerAction: 'restart', resolveAuthSecret: async () => '', confirmMessage: 'Confirm?', confirm: () => true, ...batchAudit() })
    expect(result.outcomes[0].job).toMatchObject({ status: 'unknown', errorCode: 'target_timeout' })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })
})

describe('multi-host operations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('requires an explicit bounded host selection', () => {
    expect(() => selectBatchHosts([host('a')], [])).toThrow('batch_selection_empty')
    expect(() => selectBatchHosts([host('a')], ['missing'])).toThrow('batch_selection_unknown_host')
    expect(() => selectBatchHosts(Array.from({ length: MAX_BATCH_HOSTS + 1 }, (_, index) => host(`h-${index}`)))).toThrow('batch_selection_too_large')
    expect(selectBatchHosts([host('a'), host('b')], ['b', 'b', 'a']).selectedHostIds).toEqual(['b', 'a'])
    expect(normalizeBatchConcurrency(100)).toBe(MAX_BATCH_CONCURRENCY)
    expect(normalizeBatchConcurrency(0)).toBe(2)
  })

  it('creates one audited job per selected host and runs a bounded ProxyJump batch', async () => {
    let jobNumber = 0
    const createJob = vi.fn(async (request: CreateOperationJobRequest): Promise<OperationJob> => ({
      jobId: `job-${++jobNumber}`,
      auditId: `audit-${jobNumber}`,
      hostId: request.hostId,
      hostName: request.hostName,
      hostAddress: request.hostAddress,
      username: request.username,
      source: request.source,
      actor: request.actor ?? 'local-user',
      action: request.action,
      target: request.target,
      risk: request.risk,
      provider: request.provider ?? 'ssh-agentless',
      transport: request.transport ?? 'direct',
      status: 'queued',
      confirmationRequired: true,
      confirmationStatus: 'pending',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const updateJob = vi.fn(async (request: UpdateOperationJobRequest): Promise<OperationJob> => ({
      jobId: request.jobId,
      auditId: `audit-for-${request.jobId}`,
      source: 'workspace',
      actor: request.actor ?? 'local-user',
      action: 'service.status',
      target: 'nginx.service',
      risk: 'read-only',
      provider: 'ssh-agentless',
      transport: 'direct',
      status: request.status,
      confirmationRequired: true,
      confirmationStatus: request.confirmationStatus ?? 'confirmed',
      queuedAt: 1,
      updatedAt: 1,
    }))
    let active = 0
    let maximumActive = 0
    const confirm = vi.fn().mockResolvedValue(true)
    const execute = vi.fn(async (item: ReturnType<typeof host>) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, item.id === 'a' ? 10 : 2))
      active -= 1
      return { exitCode: 0, durationMs: 2, hostId: item.id }
    })

    const result = await runBatchOperation({
      hosts: [host('a', 'bastion.example.test'), host('b'), host('c')],
      selectedHostIds: ['a', 'b', 'c'],
      action: 'service.status',
      target: 'nginx.service',
      risk: 'read-only',
      paramsSummary: 'systemctl status --no-pager nginx.service',
      confirmMessage: 'Confirm batch?',
      confirm,
      execute,
      getResult: (value) => value,
      createJob,
      updateJob,
      maxConcurrency: 2,
      now: (() => {
        let value = 100
        return () => ++value
      })(),
    })

    expect(result.status).toBe('completed')
    expect(result.completedCount).toBe(3)
    expect(result.outcomes.map((outcome) => outcome.transport)).toEqual(['proxy-jump', 'direct', 'direct'])
    expect(createJob).toHaveBeenCalledTimes(3)
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({ action: 'service.status', transport: 'proxy-jump', confirmationRequired: false })
    expect(updateJob.mock.calls.some(([request]) => request.confirmationStatus === 'not_required')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(createJob.mock.calls[0]?.[0].requestId).toMatch(/^batch:/)
    expect(result.batchId).toMatch(/^batch:/)
    expect(maximumActive).toBeLessThanOrEqual(2)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('records confirmation rejection for every queued host without executing', async () => {
    const createJob = vi.fn(async (request: CreateOperationJobRequest): Promise<OperationJob> => ({
      jobId: `job-${request.hostId}`,
      auditId: `audit-${request.hostId}`,
      source: request.source,
      actor: request.actor ?? 'local-user',
      action: request.action,
      target: request.target,
      risk: request.risk,
      provider: request.provider ?? 'ssh-agentless',
      transport: request.transport ?? 'direct',
      status: 'queued',
      confirmationRequired: true,
      confirmationStatus: 'pending',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const updateJob = vi.fn(async (request: UpdateOperationJobRequest): Promise<OperationJob> => ({
      jobId: request.jobId,
      auditId: 'audit',
      source: 'workspace',
      actor: request.actor ?? 'local-user',
      action: 'service.restart',
      target: 'nginx.service',
      risk: 'high',
      provider: 'ssh-agentless',
      transport: 'direct',
      status: request.status,
      confirmationRequired: true,
      confirmationStatus: request.confirmationStatus ?? 'rejected',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const execute = vi.fn()

    const result = await runBatchOperation({
      hosts: [host('a'), host('b')],
      action: 'service.restart',
      target: 'nginx.service',
      risk: 'high',
      confirmMessage: 'Confirm batch?',
      confirm: () => false,
      execute,
      createJob,
      updateJob,
    })

    expect(result.status).toBe('cancelled')
    expect(result.cancelledCount).toBe(2)
    expect(execute).not.toHaveBeenCalled()
    expect(updateJob).toHaveBeenCalledTimes(2)
    expect(updateJob.mock.calls.every(([request]) => request.status === 'cancelled')).toBe(true)
  })

  it('keeps per-host failure and unknown transport state while continuing', async () => {
    let jobNumber = 0
    const createJob = vi.fn(async (request: CreateOperationJobRequest): Promise<OperationJob> => ({
      jobId: `job-${++jobNumber}`,
      auditId: 'audit',
      source: request.source,
      actor: request.actor ?? 'local-user',
      action: request.action,
      target: request.target,
      risk: request.risk,
      provider: request.provider ?? 'ssh-agentless',
      transport: request.transport ?? 'direct',
      status: 'queued',
      confirmationRequired: true,
      confirmationStatus: 'pending',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const updateJob = vi.fn(async (request: UpdateOperationJobRequest): Promise<OperationJob> => ({
      jobId: request.jobId,
      auditId: 'audit',
      source: 'workspace',
      actor: request.actor ?? 'local-user',
      action: 'service.status',
      target: 'nginx.service',
      risk: 'read-only',
      provider: 'ssh-agentless',
      transport: 'direct',
      status: request.status,
      confirmationRequired: true,
      confirmationStatus: request.confirmationStatus ?? 'confirmed',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const result = await runBatchOperation({
      hosts: [host('ok'), host('unknown'), host('failed')],
      action: 'service.status',
      target: 'nginx.service',
      risk: 'read-only',
      confirmMessage: 'Confirm batch?',
      confirm: () => true,
      execute: async (item) => {
        if (item.id === 'unknown') throw new Error('ProxyJump connection lost')
        if (item.id === 'failed') return { exitCode: 1, durationMs: 5 }
        return { exitCode: 0, durationMs: 5 }
      },
      getResult: (value) => value,
      createJob,
      updateJob,
    })

    expect(result.status).toBe('partial')
    expect(result.completedCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(result.unknownCount).toBe(1)
    expect(result.outcomes.find((outcome) => outcome.host.id === 'unknown')).toMatchObject({ status: 'unknown', errorCode: 'remote_state_unknown' })
    expect(result.outcomes.find((outcome) => outcome.host.id === 'failed')).toMatchObject({ status: 'failed', errorCode: 'exit_1' })
  })

  it('allows the fixed read-only health refresh action without confirmation', async () => {
    const createJob = vi.fn(async (request: CreateOperationJobRequest): Promise<OperationJob> => ({
      jobId: `job-${request.hostId}`,
      auditId: `audit-${request.hostId}`,
      source: 'workspace',
      actor: 'local-user',
      action: request.action,
      target: request.target,
      risk: request.risk,
      provider: request.provider ?? 'ssh-agentless',
      transport: request.transport ?? 'direct',
      status: 'queued',
      confirmationRequired: false,
      confirmationStatus: 'not_required',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const updateJob = vi.fn(async (request: UpdateOperationJobRequest): Promise<OperationJob> => ({
      jobId: request.jobId,
      auditId: 'audit',
      source: 'workspace',
      actor: 'local-user',
      action: 'health.refresh',
      target: 'remote-health',
      risk: 'read-only',
      provider: 'ssh-agentless',
      transport: 'direct',
      status: request.status,
      confirmationRequired: false,
      confirmationStatus: request.confirmationStatus ?? 'not_required',
      queuedAt: 1,
      updatedAt: 1,
    }))
    const confirm = vi.fn(() => true)
    const result = await runBatchOperation({
      hosts: [host('a')],
      action: 'health.refresh',
      target: 'remote-health',
      risk: 'read-only',
      confirmMessage: 'Confirm?',
      confirm,
      execute: async () => ({ exitCode: 0, durationMs: 1 }),
      getResult: (value) => value,
      createJob,
      updateJob,
    })
    expect(result.status).toBe('completed')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects arbitrary shell actions at the batch boundary', async () => {
    await expect(runBatchOperation({
      hosts: [host('a')],
      action: 'command.exec',
      target: 'uname',
      risk: 'high',
      confirmMessage: 'Confirm?',
      confirm: () => true,
      execute: async () => undefined,
    })).rejects.toThrow('batch_action_not_allowed')
  })

  it('reports local audit creation failures as failed instead of cancelled', async () => {
    const result = await runBatchOperation({
      hosts: [host('a')],
      action: 'service.status',
      target: 'nginx.service',
      risk: 'read-only',
      confirmMessage: 'Confirm?',
      execute: async () => ({ exitCode: 0, durationMs: 1 }),
      createJob: async () => { throw new Error('local audit store unavailable') },
    })
    expect(result.status).toBe('failed')
    expect(result.failedCount).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ errorCode: 'operation_job_create_failed' })
  })
})
