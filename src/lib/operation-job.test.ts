import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isUnknownOperationError,
  listOperationAudit,
  listOperationJobs,
  operationTransport,
  runConfirmedOperation,
  safeOperationTarget,
  summarizeRemoteResult,
} from './operation-job'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const host = {
  id: 'host-1',
  name: 'Production',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  authType: 'password' as const,
  group: 'Default',
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

describe('operation jobs', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('classifies transport failures as unknown', () => {
    expect(isUnknownOperationError(new Error('SSH connection lost during handshake'))).toBe(true)
    expect(isUnknownOperationError(new Error('systemctl exited with code 1'))).toBe(false)
  })

  it('summarizes results without remote output', () => {
    expect(summarizeRemoteResult({ exitCode: 0, durationMs: 42 })).toBe('exit=0; durationMs=42')
  })

  it('detects ProxyJump transport and bounds audit targets', () => {
    const host = { jumpHost: 'bastion.example.com' } as Parameters<typeof operationTransport>[0]
    expect(operationTransport(host)).toBe('proxy-jump')
    expect(safeOperationTarget('  service\u0000\nname  ')).toBe('servicename')
  })

  it('records a rejected confirmation without executing the remote action', async () => {
    const queued = { jobId: 'job-1', auditId: 'audit-1', status: 'queued' }
    const cancelled = { ...queued, status: 'cancelled', confirmationStatus: 'rejected' }
    invoke.mockResolvedValueOnce(queued).mockResolvedValueOnce(cancelled)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const execute = vi.fn()

    const result = await runConfirmedOperation({
      host,
      action: 'service.stop',
      target: 'nginx',
      risk: 'high',
      confirmMessage: 'Confirm?',
      execute,
    })

    expect(result).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenNthCalledWith(1, 'operation_job_create', expect.objectContaining({ request: expect.objectContaining({ action: 'service.stop', confirmationRequired: true }) }))
    expect(invoke).toHaveBeenNthCalledWith(2, 'operation_job_update', expect.objectContaining({ request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'rejected' }) }))
  })

  it('keeps provider-specific rollback state in the durable job audit', async () => {
    const queued = { jobId: 'job-2', auditId: 'audit-2', status: 'queued' }
    const running = { ...queued, status: 'running' }
    const failed = { ...queued, status: 'failed' }
    invoke.mockResolvedValueOnce(queued).mockResolvedValueOnce(running).mockResolvedValueOnce(failed)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    await runConfirmedOperation({
      host,
      action: 'agent.install.artifact',
      target: 'shellbeam-agent 0.2.0',
      risk: 'high',
      provider: 'shellbeam-agent',
      confirmMessage: 'Confirm?',
      execute: async () => ({ exitCode: 29, durationMs: 7 }),
      getResult: (result) => ({
        ...result,
        resultSummary: 'exit=29; durationMs=7; rollback=verified',
        errorCode: 'artifact_install_failed_rolled_back',
        errorSummary: 'Artifact activation failed; rollback=verified.',
      }),
    })

    expect(invoke).toHaveBeenNthCalledWith(3, 'operation_job_update', {
      request: expect.objectContaining({
        status: 'failed',
        resultSummary: 'exit=29; durationMs=7; rollback=verified',
        errorCode: 'artifact_install_failed_rolled_back',
      }),
    })
  })

  it('passes host-scoped job and audit filters through to the local store', async () => {
    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await listOperationJobs({ hostId: 'host-1', status: 'failed', source: 'workspace', limit: 12 })
    await listOperationAudit({ hostId: 'host-1', limit: 8 })

    expect(invoke).toHaveBeenNthCalledWith(1, 'operation_job_list', {
      query: { hostId: 'host-1', status: 'failed', source: 'workspace', limit: 12 },
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'operation_audit_list', {
      query: { hostId: 'host-1', limit: 8 },
    })
  })
  it('does not claim a timed-out remote write failed with a known outcome', async () => {
    const queued = { jobId: 'timeout-job', auditId: 'timeout-audit', status: 'queued' }
    invoke.mockResolvedValueOnce(queued).mockResolvedValueOnce({ ...queued, status: 'running' }).mockResolvedValueOnce({ ...queued, status: 'unknown' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const result = await runConfirmedOperation({ host, action: 'service.restart', target: 'nginx.service', risk: 'high', confirmMessage: 'Restart?',
      execute: async () => ({ exitCode: -1, durationMs: 100, errorCode: 'target_timeout' }), getResult: (value) => value })
    expect(result?.job.status).toBe('unknown')
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'target_timeout' }) })
  })

})
