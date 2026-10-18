import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFileMutations, type FileVerification } from './file-operation'
import type { OperationJob } from './operation-job'
import { registerUserConfirmationPresenter } from './user-confirmation'

const { createOperationJob, updateOperationJob } = vi.hoisted(() => ({ createOperationJob: vi.fn(), updateOperationJob: vi.fn() }))
vi.mock('./operation-job', async (importOriginal) => ({ ...await importOriginal<typeof import('./operation-job')>(), createOperationJob, updateOperationJob }))

const host = {
  id: 'host-1', name: 'Production', address: '10.0.0.15', port: 22, username: 'ops', authType: 'password' as const,
  group: 'Default', tags: [], createdAt: 0, updatedAt: 0, jumpHost: 'bastion.test',
}
const verified = async (): Promise<FileVerification> => ({ status: 'verified', evidence: 'path-absent' })
let unregister: (() => void) | undefined
afterEach(() => { unregister?.(); unregister = undefined })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

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

  it.each([true, false])('awaits asynchronous directory consent resolving %s before any mutation or running audit', async answer => {
    let respond!: (value: boolean) => void
    const pending = new Promise<boolean>(resolve => { respond = resolve })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(pending as unknown as boolean)
    const execute = vi.fn(async () => {})
    const work = runFileMutations({ host, vaultId: 'team' }, [{ action: 'create-directory', path: '/tmp/new', execute, verify: verified }])
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(createOperationJob).toHaveBeenCalledOnce()
    expect(updateOperationJob).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    respond(answer)
    expect(await work).toBe(answer)
    expect(execute).toHaveBeenCalledTimes(answer ? 1 : 0)
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ status: answer ? 'running' : 'cancelled', confirmationStatus: answer ? 'confirmed' : 'rejected' }))
  })

  it.each(['DELETE', 'DELETE '])('awaits the exact asynchronous destructive token %j without coercion', async answer => {
    let respond!: (value: string) => void
    const pending = new Promise<string>(resolve => { respond = resolve })
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(pending as unknown as string)
    const execute = vi.fn(async () => {})
    const work = runFileMutations({ host }, [{ action: 'delete', path: '/tmp/private', execute, verify: verified }])
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('DELETE'))
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob).not.toHaveBeenCalled()
    respond(answer)
    expect(await work).toBe(answer === 'DELETE')
    expect(execute).toHaveBeenCalledTimes(answer === 'DELETE' ? 1 : 0)
  })

  it.each(['true', 1, null])('rejects non-boolean low-risk consent %j and cancels every queued job', async value => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(value) as unknown as boolean)
    const execute = vi.fn(async () => {})
    expect(await runFileMutations({ host }, [
      { action: 'create-directory', path: '/tmp/a', execute, verify: verified }, { action: 'create-directory', path: '/tmp/b', execute, verify: verified },
    ])).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob.mock.calls.map(([request]) => request.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('cancels all queued file jobs when an asynchronous native dialog rejects', async () => {
    vi.spyOn(window, 'confirm').mockImplementation(() => Promise.reject(new Error('dialog unavailable')) as unknown as boolean)
    const execute = vi.fn(async () => {})
    expect(await runFileMutations({ host }, [
      { action: 'create-directory', path: '/tmp/a', execute }, { action: 'create-directory', path: '/tmp/b', execute },
    ])).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob.mock.calls.map(([request]) => request.confirmationStatus)).toEqual(['pending', 'pending'])
  })

  it.each(['scope-changed', 'busy', 'unavailable', 'rejected'] as const)('distinguishes %s from human rejection in every queued file audit', async reason => {
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: false, reason }))
    const execute = vi.fn(async () => {})
    expect(await runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute }, { action: 'delete', path: '/tmp/b', execute }])).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob.mock.calls.map(([request]) => [request.status, request.confirmationStatus, request.errorCode])).toEqual(Array.from({ length: 2 }, () => [
      'cancelled', reason === 'rejected' ? 'rejected' : 'pending', reason === 'scope-changed' ? 'operation_scope_changed' : `confirmation_${reason}`,
    ]))
  })

  it('retains the app decision guard after consent while the native running job write is pending', async () => {
    let current = true
    const entered = deferred(), release = deferred()
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => current }))
    updateOperationJob.mockImplementation(async request => {
      if (request.status === 'running') { entered.resolve(); await release.promise }
      return request as OperationJob
    })
    const execute = vi.fn(async () => {})
    const work = runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute }, { action: 'delete', path: '/tmp/b', execute }])
    await entered.promise
    current = false; release.resolve()
    expect(await work).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob.mock.calls.filter(([request]) => request.status === 'cancelled').map(([request]) => [request.jobId, request.confirmationStatus, request.errorCode])).toEqual([
      ['job-1', 'confirmed', 'operation_scope_changed'], ['job-2', 'confirmed', 'operation_scope_changed'],
    ])
  })

  it('does not mark an already sent file mutation cancelled when its scope changes before independent verification', async () => {
    let current = true
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => current }))
    const sent = vi.fn(async () => { current = false })
    const notSent = vi.fn(async () => {})
    const observe = vi.fn(verified)
    await expect(runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute: sent, verify: observe }, { action: 'delete', path: '/tmp/b', execute: notSent, verify: observe }])).rejects.toThrow('Remote file post-state is unknown; verify before retrying')
    expect(sent).toHaveBeenCalledOnce()
    expect(notSent).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', status: 'unknown', errorCode: 'remote_state_unknown' }))
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-2', status: 'cancelled', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' }))
    expect(updateOperationJob.mock.calls.some(([request]) => request.jobId === 'job-1' && request.status === 'cancelled')).toBe(false)
  })

  it('preserves a verified completed target but cancels the next target if scope changes during its completion audit', async () => {
    let current = true
    const entered = deferred(), release = deferred()
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => current }))
    updateOperationJob.mockImplementation(async request => {
      if (request.status === 'completed') { entered.resolve(); await release.promise }
      return request as OperationJob
    })
    const first = vi.fn(async () => {}), second = vi.fn(async () => {})
    const work = runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute: first, verify: verified }, { action: 'delete', path: '/tmp/b', execute: second, verify: verified }])
    await entered.promise
    current = false; release.resolve()
    expect(await work).toBe(false)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(updateOperationJob.mock.calls.map(([request]) => [request.jobId, request.status])).toEqual([['job-1', 'running'], ['job-1', 'completed'], ['job-2', 'cancelled']])
  })

  it('does not accept a late verified post-state from an invalidated route as a completed file mutation', async () => {
    let current = true
    const entered = deferred(), release = deferred()
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => current }))
    const first = vi.fn(async () => {}), second = vi.fn(async () => {})
    const observe = vi.fn(async () => { entered.resolve(); await release.promise; return verified() })
    const work = runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute: first, verify: observe }, { action: 'delete', path: '/tmp/b', execute: second, verify: verified }])
    await entered.promise
    current = false; release.resolve()
    await expect(work).rejects.toThrow('Remote file post-state is unknown; verify before retrying')
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', status: 'unknown', errorCode: 'remote_state_unknown' }))
    expect(updateOperationJob.mock.calls.some(([request]) => request.status === 'completed')).toBe(false)
    expect(updateOperationJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-2', status: 'cancelled', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' }))
  })

  it('surfaces a scope-cancellation journal failure without sending any mutation', async () => {
    unregister = registerUserConfirmationPresenter(async () => ({ accepted: true, reason: 'accepted', isCurrent: () => false }))
    updateOperationJob.mockRejectedValue(new Error('journal unavailable'))
    const execute = vi.fn(async () => {})
    await expect(runFileMutations({ host }, [{ action: 'delete', path: '/tmp/a', execute }, { action: 'delete', path: '/tmp/b', execute }])).rejects.toThrow('journal unavailable')
    expect(execute).not.toHaveBeenCalled()
    expect(updateOperationJob).toHaveBeenCalledTimes(2)
    expect(updateOperationJob.mock.calls.every(([request]) => request.confirmationStatus === 'confirmed')).toBe(true)
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
