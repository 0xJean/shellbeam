import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isUnknownOperationError,
  listOperationAudit,
  listOperationJobs,
  OperationScopeChangedError,
  operationTransport,
  runConfirmedOperation,
  safeOperationTarget,
  summarizeRemoteResult,
} from './operation-job'
import { registerUserConfirmationPresenter } from './user-confirmation'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
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

  it.each([true, false])('does not mark running or send a command before asynchronous consent resolves %s', async accepted => {
    const queued = { jobId: 'async-job', auditId: 'async-audit', status: 'queued', confirmationStatus: 'pending' }
    invoke.mockImplementation(async (command, args) => command === 'operation_job_create' ? queued : { ...queued, ...(args as { request: object }).request })
    let respond!: (answer: boolean) => void
    vi.spyOn(window, 'confirm').mockReturnValue(new Promise<boolean>(resolve => { respond = resolve }) as unknown as boolean)
    const execute = vi.fn(async () => ({ exitCode: 0, durationMs: 1 }))
    const pending = runConfirmedOperation({ host, action: 'service.restart', target: 'nginx.service', risk: 'high', confirmMessage: 'Restart?', execute, getResult: value => value })
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    respond(accepted)
    const result = await pending
    expect(execute).toHaveBeenCalledTimes(accepted ? 1 : 0)
    expect(result?.job.status ?? 'cancelled').toBe(accepted ? 'completed' : 'cancelled')
    expect(invoke).toHaveBeenNthCalledWith(2, 'operation_job_update', { request: expect.objectContaining({ status: accepted ? 'running' : 'cancelled', confirmationStatus: accepted ? 'confirmed' : 'rejected' }) })
  })

  it('does not invent human rejection when the asynchronous dialog is unavailable', async () => {
    const queued = { jobId: 'blocked-dialog-job', auditId: 'blocked-dialog-audit', status: 'queued', confirmationStatus: 'pending' }
    invoke.mockImplementation(async (command, args) => command === 'operation_job_create' ? queued : { ...queued, ...(args as { request: object }).request })
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.reject(new Error('dialog unavailable')) as unknown as boolean)
    const execute = vi.fn()
    expect(await runConfirmedOperation({ host, action: 'service.restart', target: 'nginx.service', risk: 'high', confirmMessage: 'Restart?', execute })).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'pending', errorCode: 'confirmation_unavailable' }) })
  })

  it.each(['before-create', 'after-create', 'after-consent', 'after-running'] as const)('does not execute when the host or Vault changes %s', async (phase) => {
    let current = phase !== 'before-create'
    const queued = { jobId: 'scoped-job', auditId: 'scoped-audit', status: 'queued', confirmationStatus: 'pending' }
    invoke.mockImplementation(async (command, args) => {
      if (command === 'operation_job_create') {
        if (phase === 'after-create') current = false
        return queued
      }
      const request = (args as { request: Record<string, unknown> }).request
      if (request.status === 'running' && phase === 'after-running') current = false
      return { ...queued, ...request }
    })
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
      if (phase === 'after-consent') current = false
      return true
    })
    const execute = vi.fn()
    expect(await runConfirmedOperation({ host, action: 'local-alert.close', target: 'probe:metrics', risk: 'low', confirmMessage: 'Confirm?', isCurrent: () => current, execute })).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    if (phase === 'before-create') expect(invoke).not.toHaveBeenCalled()
    else expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({
      status: 'cancelled', errorCode: 'operation_scope_changed', confirmationStatus: phase === 'after-create' ? 'pending' : 'confirmed',
    }) })
    expect(confirm).toHaveBeenCalledTimes(phase === 'before-create' || phase === 'after-create' ? 0 : 1)
  })

  it('retains the actual outcome when the UI scope changes after execution has begun', async () => {
    let current = true
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'executed-job', auditId: 'executed-audit', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const execute = vi.fn(async () => { current = false; return { exitCode: 0, durationMs: 1 } })
    const result = await runConfirmedOperation({ host, action: 'service.start', target: 'nginx', risk: 'low', confirmMessage: 'Confirm?', isCurrent: () => current, execute, getResult: value => value })
    expect(execute).toHaveBeenCalledOnce()
    expect(result?.job.status).toBe('completed')
  })

  it.each(['caller', 'host', 'jump', 'guard-error'] as const)('cancels before the first mutation when the %s scope changes during an awaited read', async (changedScope) => {
    const scope = { caller: true, host: 1, jump: 1, guardError: false }
    const readStarted = deferred<void>()
    const finishRead = deferred<void>()
    const queued = { jobId: 'staged-job', auditId: 'staged-audit', status: 'queued', confirmationStatus: 'pending' }
    invoke.mockImplementation(async (command, args) => command === 'operation_job_create' ? queued : { ...queued, ...(args as { request: object }).request })
    const unregister = registerUserConfirmationPresenter(async () => ({
      accepted: true,
      reason: 'accepted',
      isCurrent: () => {
        if (scope.guardError) throw new Error('scope unavailable')
        return scope.host === 1 && scope.jump === 1
      },
    }))
    const write = vi.fn(async () => ({ exitCode: 0, durationMs: 1 }))
    const execute = vi.fn(async ({ isCurrent }: { isCurrent: () => boolean }) => {
      expect(isCurrent()).toBe(true)
      readStarted.resolve()
      await finishRead.promise
      if (!isCurrent()) throw new OperationScopeChangedError(false)
      return write()
    })
    try {
      const pending = runConfirmedOperation({ host, action: 'agent.install', target: 'shellbeam-agent', risk: 'high', confirmMessage: 'Install?', isCurrent: () => scope.caller, execute, getResult: value => value })
      await readStarted.promise
      expect(write).not.toHaveBeenCalled()
      if (changedScope === 'caller') scope.caller = false
      else if (changedScope === 'guard-error') scope.guardError = true
      else scope[changedScope] += 1
      finishRead.resolve()
      expect(await pending).toBeNull()
      expect(write).not.toHaveBeenCalled()
      expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({
        status: 'cancelled', confirmationStatus: 'confirmed', confirmedBy: 'local-user', errorCode: 'operation_scope_changed',
      }) })
    } finally { finishRead.resolve(); unregister() }
  })

  it.each(['high', 'read-only'] as const)('retains %s consent when a staged read is cancelled before a remote mutation', async risk => {
    let current = true
    const readStarted = deferred<void>()
    const finishRead = deferred<void>()
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'read-phase-job', auditId: 'read-phase-audit', confirmationStatus: 'pending', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = runConfirmedOperation({ host, action: 'agent.inspect', target: 'shellbeam-agent', risk, confirmMessage: 'Inspect?', isCurrent: () => current,
      execute: async ({ isCurrent }) => {
        readStarted.resolve()
        await finishRead.promise
        if (!isCurrent()) throw new OperationScopeChangedError(false)
        return 'unexpected'
      },
    })
    await readStarted.promise
    current = false
    finishRead.resolve()
    expect(await pending).toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: risk === 'read-only' ? 'not_required' : 'confirmed', errorCode: 'operation_scope_changed' }) })
  })

  it.each(['high', 'read-only'] as const)('records an unknown outcome with %s consent when the scope changes after a mutation was sent', async risk => {
    let current = true
    const writeStarted = deferred<void>()
    const finishWrite = deferred<void>()
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'sent-job', auditId: 'sent-audit', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const cleanup = vi.fn()
    const onJob = vi.fn()
    const pending = runConfirmedOperation({ host, action: 'agent.install', target: 'shellbeam-agent', risk, confirmMessage: 'Install?', isCurrent: () => current, onJob,
      execute: async ({ isCurrent }) => {
        writeStarted.resolve()
        await finishWrite.promise
        if (!isCurrent()) throw new OperationScopeChangedError(true)
        cleanup()
        return 'unexpected'
      },
    })
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'OperationScopeChangedError', sent: true, message: 'The initiating operation scope changed',
      operationJob: { jobId: 'sent-job', status: 'unknown', confirmationStatus: risk === 'read-only' ? 'not_required' : 'confirmed', errorCode: 'operation_scope_changed' },
    })
    await writeStarted.promise
    current = false
    finishWrite.resolve()
    await rejection
    expect(cleanup).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({
      status: 'unknown', confirmationStatus: risk === 'read-only' ? 'not_required' : 'confirmed', errorCode: 'operation_scope_changed',
      errorSummary: 'The initiating host or Vault changed after a remote action was sent; remote state is unknown and must be verified before retrying',
    }) })
    expect(onJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unknown', errorCode: 'operation_scope_changed' }))
  })

  it('requires an explicit unsent marker before cancelling a scope-changed operation', async () => {
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'unspecified-send-job', auditId: 'unspecified-send-audit', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(runConfirmedOperation({ host, action: 'agent.install', target: 'shellbeam-agent', risk: 'high', confirmMessage: 'Install?',
      execute: async () => { throw new OperationScopeChangedError() },
    })).rejects.toMatchObject({ sent: true, operationJob: { status: 'unknown', confirmationStatus: 'confirmed', errorCode: 'operation_scope_changed' } })
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'operation_scope_changed' }) })
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

  it.each([
    { exitCode: -1, errorCode: 'target_timeout', errorType: 'network' as const, status: 'unknown' },
    { exitCode: -1, errorCode: 'target_disconnected', errorType: 'network' as const, status: 'unknown' },
    { exitCode: -1, errorCode: 'output_limit', errorType: 'unknown' as const, status: 'unknown' },
    { exitCode: -1, errorCode: 'remote_state_unknown', errorType: 'unknown' as const, status: 'unknown' },
    { exitCode: -1, errorCode: 'target_timeout_before_execution', errorType: 'network' as const, status: 'failed' },
    { exitCode: 0, errorCode: undefined, errorType: 'unknown' as const, status: 'unknown' },
  ])('uses native outcome metadata instead of guessing from exitCode ($errorCode)', async ({ status, ...result }) => {
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'native-job', auditId: 'native-audit', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const execution = await runConfirmedOperation({ host, action: 'service.restart', target: 'nginx', risk: 'high', confirmMessage: 'Restart?', execute: async () => ({ ...result, durationMs: 1 }), getResult: (value) => value })
    expect(execution?.job.status).toBe(status)
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status, errorCode: result.errorCode ?? 'remote_state_unknown' }) })
  })

  it('attaches the canonical job to thrown errors for schedule recovery', async () => {
    invoke.mockImplementation(async (_command, args) => ({ jobId: 'throw-job', auditId: 'throw-audit', ...(args as { request: object }).request }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(runConfirmedOperation({ host, action: 'service.restart', target: 'nginx', risk: 'high', confirmMessage: 'Restart?', execute: async () => { throw new Error('transport connection lost') } })).rejects.toMatchObject({ operationJob: { jobId: 'throw-job', status: 'unknown' } })
  })

})
