import type { HostProfile } from './hosts'
import { t } from './i18n'
import { createOperationJob, isUnknownOperationError, operationTransport, updateOperationJob, type OperationJob, type OperationRisk } from './operation-job'
import { DEFAULT_VAULT_ID } from './vaults'
import { normalizeInvokeError } from './invoke-error'
import { requestUserDecision, type UserConfirmationDecision } from './user-confirmation'

export type FileMutationAction = 'upload' | 'write' | 'create-file' | 'create-directory' | 'rename' | 'delete' | 'chmod'
export type FileVerification = { status: 'unknown' | 'failed' } | {
  status: 'verified'
  evidence: 'path-absent' | 'directory-present' | 'rename-observed' | 'file-size' | 'mode'
  sizeBytes?: number
  permissions?: number
}

export interface FileMutation {
  action: FileMutationAction
  path: string
  destination?: string
  mode?: number
  /** Resolving credentials and reading content belong inside this callback, after review. */
  execute: () => Promise<void>
  /** Must observe post-state independently of the mutation response. */
  verify?: () => Promise<FileVerification>
}

export interface FileOperationContext {
  host: HostProfile
  vaultId?: string
  onJob?: (job: OperationJob) => void
  isCurrent?: () => boolean
}

function riskFor(action: FileMutationAction): OperationRisk {
  // SFTP create/upload/write/rename can replace existing data. A stale listing is
  // insufficient evidence that the target will still be absent at execution.
  return action === 'create-directory' ? 'low' : 'high'
}

async function privateTarget(path: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return `remote-item:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function uncertainFileError(error: unknown) {
  const nativeError = normalizeInvokeError(error)
  return isUnknownOperationError(error) || /network_error|socket|tcp/i.test(String(error))
    || (nativeError.source === 'sftp' && nativeError.code === 'unknown_error')
}

/** File contents, returned paths and directory names never enter the journal. */
export async function runFileRead<T>(context: FileOperationContext, action: 'home' | 'list' | 'read' | 'stat', path: string, execute: () => Promise<T>, summary: (value: T) => string): Promise<T> {
  const job = await createOperationJob({
    hostId: context.host.id, vaultId: context.vaultId ?? context.host.vaultId ?? DEFAULT_VAULT_ID,
    hostName: context.host.name, hostAddress: context.host.address, username: context.host.username,
    source: 'workspace', actor: 'local-user', action: `file.${action}`, target: await privateTarget(path),
    risk: 'read-only', provider: 'sftp', transport: operationTransport(context.host), confirmationRequired: false,
  })
  context.onJob?.(job)
  const running = await updateOperationJob({ jobId: job.jobId, status: 'running', confirmationStatus: 'not_required' })
  context.onJob?.(running)
  let value: T
  try {
    value = await execute()
  } catch (error) {
    const unknown = uncertainFileError(error)
    const failed = await updateOperationJob({
      jobId: job.jobId, status: unknown ? 'unknown' : 'failed',
      errorCode: unknown ? 'remote_state_unknown' : 'file_read_failed',
      errorSummary: unknown ? 'Remote file observation was interrupted' : 'Remote file observation failed',
    })
    context.onJob?.(failed)
    throw error
  }
  const completed = await updateOperationJob({ jobId: job.jobId, status: 'completed', resultSummary: summary(value) })
  context.onJob?.(completed)
  return value
}

function reviewText(host: HostProfile, mutations: FileMutation[]) {
  const lines = mutations.map((mutation) => {
    const destination = mutation.destination ? ` → ${JSON.stringify(mutation.destination)}` : ''
    const mode = mutation.mode == null ? '' : ` (${mutation.mode.toString(8)})`
    return `${t(`files.operation.action.${mutation.action}`)}: ${JSON.stringify(mutation.path)}${destination}${mode}`
  })
  return [
    t('files.operation.reviewHost', { name: host.name, username: host.username || 'root', address: host.address, port: host.port || 22 }),
    t('files.operation.reviewScope', { count: mutations.length, risk: t(mutations.some((mutation) => riskFor(mutation.action) === 'high') ? 'files.operation.highRisk' : 'files.operation.lowRisk') }),
    ...lines,
    mutations.some((mutation) => ['upload', 'write', 'create-file', 'rename'].includes(mutation.action)) ? t('files.operation.overwriteWarning') : '',
    mutations.some((mutation) => mutation.action === 'delete') ? t('files.operation.deleteWarning') : '',
  ].filter(Boolean).join('\n')
}

/** One reviewed batch, one durable job per remote target, no nested prompts. */
export async function runFileMutations(context: FileOperationContext, mutations: FileMutation[]): Promise<boolean> {
  if (mutations.length === 0) return false
  const jobs: OperationJob[] = []
  const emit = (job: OperationJob) => { context.onJob?.(job) }
  async function cancel(job: OperationJob, reason: UserConfirmationDecision['reason'] | 'batch-aborted', accepted = false) {
    const rejected = reason === 'rejected'
    emit(await updateOperationJob({
      jobId: job.jobId,
      status: 'cancelled',
      confirmationStatus: accepted ? 'confirmed' : rejected ? 'rejected' : 'pending',
      ...(accepted ? { confirmedBy: 'local-user' } : {}),
      errorCode: reason === 'scope-changed' ? 'operation_scope_changed' : rejected ? 'confirmation_rejected' : reason === 'batch-aborted' ? 'file_batch_aborted' : `confirmation_${reason}`,
      errorSummary: reason === 'scope-changed' ? 'The initiating host or Vault changed before execution' : rejected ? 'File operation was cancelled before execution' : 'File operation was not started because its review was interrupted',
    }))
  }

  try {
    for (const mutation of mutations) {
      const target = await privateTarget(mutation.path)
      const destination = mutation.destination ? await privateTarget(mutation.destination) : undefined
      const job = await createOperationJob({
        hostId: context.host.id,
        vaultId: context.vaultId ?? context.host.vaultId ?? DEFAULT_VAULT_ID,
        hostName: context.host.name,
        hostAddress: context.host.address,
        username: context.host.username,
        source: 'workspace',
        actor: 'local-user',
        action: `file.${mutation.action}`,
        target,
        risk: riskFor(mutation.action),
        provider: 'sftp',
        transport: operationTransport(context.host),
        paramsSummary: [destination ? `destination=${destination}` : '', mutation.mode == null ? '' : `mode=${mutation.mode.toString(8)}`].filter(Boolean).join('; ') || undefined,
        confirmationRequired: true,
      })
      jobs.push(job)
      emit(job)
    }
  } catch (error) {
    await Promise.allSettled(jobs.map((job) => cancel(job, 'unavailable')))
    throw error
  }

  const highRisk = mutations.some((mutation) => riskFor(mutation.action) === 'high')
  const token = mutations.some((mutation) => mutation.action === 'delete') ? 'DELETE'
    : mutations.some((mutation) => ['upload', 'write', 'create-file', 'rename'].includes(mutation.action)) ? 'OVERWRITE' : 'CHANGE'
  let decision: UserConfirmationDecision = { accepted: false, reason: 'unavailable' }
  try {
    const message = reviewText(context.host, mutations)
    decision = await requestUserDecision({
      message: highRisk ? `${message}\n\n${t('files.operation.typeToken', { token })}` : message,
      ...(highRisk ? { token } : {}),
      risk: highRisk ? 'high' : 'low',
      host: context.host,
      vaultId: context.vaultId ?? context.host.vaultId ?? DEFAULT_VAULT_ID,
      isCurrent: context.isCurrent,
    })
  } catch {
    // A missing/blocked dialog is not consent.
  }
  const isCurrent = () => {
    try { return context.isCurrent?.() !== false && decision.isCurrent?.() !== false } catch { return false }
  }
  async function stopAfterSentMutation(index: number): Promise<never> {
    try {
      emit(await updateOperationJob({ jobId: jobs[index].jobId, status: 'unknown', errorCode: 'remote_state_unknown', errorSummary: 'File mutation was sent but its post-state could not be observed after the initiating host or Vault changed' }))
    } finally {
      await Promise.all(jobs.slice(index + 1).map(pending => cancel(pending, 'scope-changed', true)))
    }
    throw new Error('Remote file post-state is unknown; verify before retrying')
  }
  if (decision.accepted !== true || !isCurrent()) {
    await Promise.all(jobs.map((job) => cancel(job, decision.accepted === true ? 'scope-changed' : decision.reason, decision.accepted === true)))
    return false
  }

  for (let index = 0; index < mutations.length; index++) {
    const job = jobs[index]
    if (!isCurrent()) {
      await Promise.all(jobs.slice(index).map(pending => cancel(pending, 'scope-changed', true)))
      return false
    }
    try {
      emit(await updateOperationJob({ jobId: job.jobId, status: 'running', confirmationStatus: 'confirmed', confirmedBy: 'local-user' }))
    } catch (error) {
      await Promise.allSettled(jobs.slice(index).map((pending) => cancel(pending, 'batch-aborted', true)))
      throw error
    }
    if (!isCurrent()) {
      await Promise.all(jobs.slice(index).map(pending => cancel(pending, 'scope-changed', true)))
      return false
    }
    try {
      await mutations[index].execute()
    } catch (error) {
      const unknown = uncertainFileError(error)
      // Native errors may contain private paths or credentials. Persist only a
      // bounded category, keeping the original error available to the caller.
      try {
        emit(await updateOperationJob({
          jobId: job.jobId,
          status: unknown ? 'unknown' : 'failed',
          errorCode: unknown ? 'remote_state_unknown' : 'file_operation_failed',
          errorSummary: unknown ? 'Connection ended; remote file state must be verified before retrying' : 'Remote file operation failed',
        }))
      } finally {
        await Promise.allSettled(jobs.slice(index + 1).map((pending) => cancel(pending, 'batch-aborted', true)))
      }
      throw error
    }
    if (!isCurrent()) {
      return stopAfterSentMutation(index)
    }
    let verification: FileVerification = { status: 'unknown' }
    try { verification = await mutations[index].verify?.() ?? { status: 'unknown' } } catch {
      // A failed observation cannot invalidate a mutation already accepted by
      // the server, nor prove that it completed. Keep the outcome uncertain.
    }
    if (!isCurrent()) return stopAfterSentMutation(index)
    if (verification.status !== 'verified') {
      try {
        emit(await updateOperationJob({
          jobId: job.jobId, status: verification.status,
          errorCode: verification.status === 'unknown' ? 'remote_state_unknown' : 'file_post_state_mismatch',
          errorSummary: verification.status === 'unknown' ? 'File mutation was accepted but its post-state could not be observed; verify before retrying' : 'Observed file post-state did not match the reviewed operation',
        }))
      } finally {
        await Promise.allSettled(jobs.slice(index + 1).map((pending) => cancel(pending, 'batch-aborted', true)))
      }
      throw new Error(verification.status === 'unknown' ? 'Remote file post-state is unknown; verify before retrying' : 'Remote file post-state did not match the reviewed operation')
    }
    try {
      const evidence = [`verification=${verification.evidence}`, verification.sizeBytes == null ? '' : `sizeBytes=${verification.sizeBytes}`, verification.permissions == null ? '' : `permissions=${verification.permissions.toString(8)}`].filter(Boolean).join('; ')
      emit(await updateOperationJob({ jobId: job.jobId, status: 'completed', resultSummary: evidence }))
    } catch (error) {
      await Promise.allSettled(jobs.slice(index + 1).map((pending) => cancel(pending, 'batch-aborted', true)))
      throw error
    }
  }
  return true
}
