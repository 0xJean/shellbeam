import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runFileMutations, type FileVerification } from './file-operation'
import type { OperationJob } from './operation-job'

const { createOperationJob, updateOperationJob } = vi.hoisted(() => ({ createOperationJob: vi.fn(), updateOperationJob: vi.fn() }))
vi.mock('./operation-job', async (importOriginal) => ({ ...await importOriginal<typeof import('./operation-job')>(), createOperationJob, updateOperationJob }))

const host = {
  id: 'host-1', name: 'Production', address: '10.0.0.15', port: 22, username: 'ops', authType: 'password' as const,
  group: 'Default', tags: [], createdAt: 0, updatedAt: 0, jumpHost: 'bastion.test',
}
const verified = async (): Promise<FileVerification> => ({ status: 'verified', evidence: 'path-absent' })

describe('confirmed file mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', webcrypto)
    createOperationJob.mockReset()
    updateOperationJob.mockReset()
    let sequence = 0
    createOperationJob.mockImplementation(async (request) => ({ ...request, jobId: `job-${++sequence}`, auditId: `audit-${sequence}`, status: 'queued' } as OperationJob))
    updateOperationJob.mockImplementation(async (request) => request as OperationJob)
  })

  it('creates scoped cancelled audit jobs for the reviewed selection with no execution on rejection', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
    const execute = vi.fn()
    const result = await runFileMutations({ host, vaultId: 'team' }, [
      { action: 'delete', path: '/secrets/a.env', execute }, { action: 'delete', path: '/secrets/b.env', execute },
    ])
    expect(result).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('/secrets/a.env'))
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('/secrets/b.env'))
    expect(execute).not.toHaveBeenCalled()
    expect(createOperationJob).toHaveBeenCalledTimes(2)
    expect(createOperationJob).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-1', vaultId: 'team', source: 'workspace', action: 'file.delete', provider: 'sftp', transport: 'proxy-jump', risk: 'high', confirmationRequired: true }))
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', status: 'cancelled', confirmationStatus: 'rejected' }))
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-2', status: 'cancelled', confirmationStatus: 'rejected' }))
    expect(JSON.stringify(createOperationJob.mock.calls)).not.toContain('/secrets')
  })

  it('requires an exact strong confirmation token before any destructive call', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('delete')
    const execute = vi.fn()
    await runFileMutations({ host }, [{ action: 'delete', path: '/tmp/old', execute }])
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('confirms once and individually records running/completed for each selected target', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('DELETE')
    const executeA = vi.fn(async () => {})
    const executeB = vi.fn(async () => {})
    expect(await runFileMutations({ host, vaultId: 'personal' }, [
      { action: 'delete', path: '/tmp/a', execute: executeA, verify: verified }, { action: 'delete', path: '/tmp/b', execute: executeB, verify: verified },
    ])).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(executeA).toHaveBeenCalledOnce()
    expect(executeB).toHaveBeenCalledOnce()
    expect(updateOperationJob.mock.calls.map(([request]) => [request.jobId, request.status])).toEqual([
      ['job-1', 'running'], ['job-1', 'completed'], ['job-2', 'running'], ['job-2', 'completed'],
    ])
    expect(updateOperationJob.mock.calls[0][0]).toMatchObject({ confirmationStatus: 'confirmed', confirmedBy: 'local-user' })
  })

  it('marks disconnect unknown, cancels the rest, and omits private error details from audit', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('OVERWRITE')
    const error = new Error('connection closed /etc/secret.env password=hidden')
    const execute = vi.fn(async () => { throw error })
    const skipped = vi.fn(async () => {})
    await expect(runFileMutations({ host }, [
      { action: 'write', path: '/etc/secret.env', execute }, { action: 'write', path: '/etc/other.env', execute: skipped },
    ])).rejects.toThrow(error)
    expect(skipped).not.toHaveBeenCalled()
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', status: 'unknown', errorCode: 'remote_state_unknown' }))
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-2', status: 'cancelled', errorCode: 'file_batch_aborted' }))
    expect(JSON.stringify([...createOperationJob.mock.calls, ...updateOperationJob.mock.calls])).not.toContain('secret.env')
    expect(JSON.stringify(updateOperationJob.mock.calls)).not.toContain('hidden')
  })

  it('requires low risk directory review and fails closed if initial audit persistence fails', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const execute = vi.fn(async () => {})
    expect(await runFileMutations({ host }, [{ action: 'create-directory', path: '/tmp/new', execute, verify: verified }])).toBe(true)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/tmp/new'))
    createOperationJob.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(runFileMutations({ host }, [{ action: 'create-directory', path: '/tmp/next', execute }])).rejects.toThrow('database unavailable')
    expect(execute).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledOnce()
  })

  it.each([
    ['unknown_error', 'Unable to send packet [-7]', 'unknown'],
    ['permission_denied', 'Permission denied', 'failed'],
  ])('keeps structured native %s outcomes honest without retaining native details', async (code, detail, status) => {
    vi.spyOn(window, 'prompt').mockReturnValue('DELETE')
    const error = JSON.stringify({ code, source: 'sftp', message: 'SFTP remove failed', detail: `${detail} /private/secret.env` })
    await expect(runFileMutations({ host, vaultId: 'team' }, [
      { action: 'delete', path: '/private/secret.env', execute: async () => { throw error } },
    ])).rejects.toBe(error)
    expect(updateOperationJob).toHaveBeenLastCalledWith(expect.objectContaining({ status }))
    expect(JSON.stringify(updateOperationJob.mock.calls)).not.toContain(detail)
    expect(JSON.stringify(updateOperationJob.mock.calls)).not.toContain('secret.env')
  })

  it('keeps an accepted write unknown when independent verification is missing or unavailable', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('OVERWRITE')
    const execute = vi.fn(async () => {})
    await expect(runFileMutations({ host }, [{ action: 'write', path: '/private/config', execute }])).rejects.toThrow('post-state is unknown')
    expect(execute).toHaveBeenCalledOnce()
    expect(updateOperationJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown' }))
    expect(updateOperationJob.mock.calls.some(([request]) => request.status === 'completed')).toBe(false)
  })
})
