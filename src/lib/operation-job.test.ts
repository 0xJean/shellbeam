import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isUnknownOperationError, operationTransport, runConfirmedOperation, safeOperationTarget, summarizeRemoteResult } from './operation-job'

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
})
