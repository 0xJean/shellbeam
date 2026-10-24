import { invoke } from '@tauri-apps/api/core'
import type { CommandRunResult } from './sessions'
import type { HostProfile } from './hosts'
import { remoteOperationStatus } from './operation-verification'
import { requestUserDecision, type UserConfirmationDecision } from './user-confirmation'
import { hostOperationReview } from './operation-review'

export type OperationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled'
export type OperationRisk = 'read-only' | 'low' | 'high'
export type OperationSource = 'terminal' | 'workspace' | 'mcp' | 'monitor'
export type OperationConfirmationStatus = 'not_required' | 'pending' | 'confirmed' | 'rejected'

export interface OperationJob {
  jobId: string
  auditId: string
  hostId?: string | null
  vaultId?: string | null
  hostName?: string | null
  hostAddress?: string | null
  username?: string | null
  source: OperationSource
  actor: string
  action: string
  target: string
  risk: OperationRisk
  provider: string
  transport: string
  paramsSummary?: string | null
  status: OperationJobStatus
  confirmationRequired: boolean
  confirmationStatus: OperationConfirmationStatus
  confirmedAt?: number | null
  confirmedBy?: string | null
  queuedAt: number
  startedAt?: number | null
  finishedAt?: number | null
  updatedAt: number
  durationMs?: number | null
  resultSummary?: string | null
  errorCode?: string | null
  errorSummary?: string | null
  requestId?: string | null
}

export interface OperationAuditEntry {
  auditId: string
  jobId: string
  hostId?: string | null
  vaultId?: string | null
  hostName?: string | null
  hostAddress?: string | null
  source: OperationSource
  actor: string
  action: string
  target: string
  risk: OperationRisk
  provider: string
  transport: string
  event: string
  status: OperationJobStatus
  confirmationStatus: OperationConfirmationStatus
  paramsSummary?: string | null
  resultSummary?: string | null
  errorCode?: string | null
  errorSummary?: string | null
  createdAt: number
}

export interface CreateOperationJobRequest {
  hostId?: string
  vaultId?: string
  hostName: string
  hostAddress: string
  username?: string
  source: OperationSource
  actor?: string
  action: string
  target: string
  risk: OperationRisk
  provider?: string
  transport?: string
  paramsSummary?: string
  confirmationRequired?: boolean
  requestId?: string
}

export interface UpdateOperationJobRequest {
  jobId: string
  status: OperationJobStatus
  confirmationStatus?: OperationConfirmationStatus
  confirmedBy?: string
  resultSummary?: string
  errorCode?: string
  errorSummary?: string
  actor?: string
}

/** Filters shared by the host list and activity/audit views. Keep these
 * aligned with the optional fields accepted by the Tauri command so callers
 * can request a host-scoped slice without loading the entire local journal. */
/** Stable keyset boundary in the journal's descending time/id order. */
export interface OperationHistoryCursor {
  timestamp: number
  id: string
}

export interface OperationJobListQuery {
  hostId?: string
  vaultId?: string
  status?: OperationJobStatus
  action?: string
  source?: OperationSource
  limit?: number
  before?: OperationHistoryCursor
}

export interface OperationAuditListQuery {
  jobId?: string
  hostId?: string
  vaultId?: string
  source?: OperationSource
  status?: OperationJobStatus
  limit?: number
  before?: OperationHistoryCursor
}

export async function createOperationJob(payload: CreateOperationJobRequest) {
  return invoke<OperationJob>('operation_job_create', { request: payload })
}

export async function updateOperationJob(payload: UpdateOperationJobRequest) {
  return invoke<OperationJob>('operation_job_update', { request: payload })
}

export async function getOperationJob(jobId: string) {
  return invoke<OperationJob | null>('operation_job_get', { jobId })
}

export async function listOperationJobs(query: OperationJobListQuery | number = 100) {
  return invoke<OperationJob[]>('operation_job_list', {
    query: typeof query === 'number' ? { limit: query } : query,
  })
}

export async function listOperationAudit(query: OperationAuditListQuery | number = 100) {
  return invoke<OperationAuditEntry[]>('operation_audit_list', {
    query: typeof query === 'number' ? { limit: query } : query,
  })
}

export function operationTransport(host: HostProfile): 'direct' | 'proxy-jump' {
  return host.jumpHostId || host.jumpHost?.trim() ? 'proxy-jump' : 'direct'
}

export function summarizeRemoteResult(result: Pick<CommandRunResult, 'exitCode' | 'durationMs'>) {
  return `exit=${result.exitCode}; durationMs=${result.durationMs}`
}

export function isUnknownOperationError(error: unknown) {
  const message = String(error).toLowerCase()
  return /(timeout|timed out|connection (?:lost|reset|closed)|disconnect|handshake|channel|eof|broken pipe|transport)/i.test(message)
}

export function safeOperationTarget(target: string, maxLength = 160) {
  return Array.from(target)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, maxLength)
}

export interface OperationExecutionContext {
  /** Includes the caller's scope and the confirmation presenter's persistent guard. */
  isCurrent: () => boolean
}

/** A staged operation must report whether a remote mutation may already have been sent. */
export class OperationScopeChangedError extends Error {
  readonly sent: boolean

  constructor(sent: boolean = true) {
    super('The initiating operation scope changed')
    this.name = 'OperationScopeChangedError'
    this.sent = sent !== false
  }
}

export interface RunConfirmedOperationOptions<T> {
  /** Recheck the initiating UI scope before consent and before execution. */
  isCurrent?: () => boolean
  host: HostProfile
  /** Optional vault scope for host ids that can exist in more than one vault. */
  vaultId?: string
  actor?: string
  action: string
  target: string
  risk: OperationRisk
  paramsSummary?: string
  confirmMessage: string
  execute: (context: OperationExecutionContext) => Promise<T>
  getResult?: (value: T) => Pick<CommandRunResult, 'exitCode' | 'durationMs'> & {
    resultSummary?: string
    errorCode?: string
    errorSummary?: string
    errorType?: CommandRunResult['errorType']
  }
  onJob?: (job: OperationJob) => void
  provider?: string
  transport?: string
  source?: OperationSource
  requestId?: string
}

/**
 * Creates the durable job before prompting so rejected confirmations are auditable.
 * The callback is only called after the user confirms. Transport errors remain unknown
 * because a lost connection cannot prove the remote state.
 */
export async function runConfirmedOperation<T>({
  host,
  vaultId,
  actor,
  action,
  target,
  risk,
  paramsSummary,
  confirmMessage,
  execute,
  getResult,
  onJob,
  provider,
  transport,
  source,
  requestId,
  isCurrent,
}: RunConfirmedOperationOptions<T>): Promise<{ value: T; job: OperationJob } | null> {
  if (isCurrent?.() === false) return null
  const job = await createOperationJob({
    hostId: host.id,
    vaultId: vaultId ?? host.vaultId,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    source: source ?? 'workspace',
    actor: actor ?? 'local-user',
    action,
    target: safeOperationTarget(target),
    risk,
    provider: provider ?? 'ssh-agentless',
    transport: transport ?? operationTransport(host),
    paramsSummary: paramsSummary ? safeOperationTarget(paramsSummary) : undefined,
    confirmationRequired: risk !== 'read-only',
    requestId,
  })
  onJob?.(job)

  const cancelChangedScope = async (current: OperationJob, consentGiven = false) => {
    const cancelled = await updateOperationJob({
      jobId: current.jobId,
      status: 'cancelled',
      confirmationStatus: consentGiven ? (risk === 'read-only' ? 'not_required' : 'confirmed') : current.confirmationStatus,
      ...(consentGiven && risk !== 'read-only' ? { confirmedBy: actor ?? 'local-user' } : {}),
      errorCode: 'operation_scope_changed',
      errorSummary: 'The initiating host or Vault changed before a remote mutation was sent',
      actor: actor ?? 'local-user',
    })
    onJob?.(cancelled)
    return null
  }
  if (isCurrent?.() === false) return cancelChangedScope(job)

  const decision: UserConfirmationDecision = risk === 'read-only' ? { accepted: true, reason: 'accepted' } : await requestUserDecision({
    message: `${confirmMessage}\n\n${hostOperationReview(host, paramsSummary ?? `${action} ${target}`)}`,
    vaultId: vaultId ?? host.vaultId,
    host,
    risk,
    isCurrent,
  })
  const scopeCurrent = () => {
    try { return isCurrent?.() !== false && decision.isCurrent?.() !== false } catch { return false }
  }
  if (!scopeCurrent() || decision.reason === 'scope-changed') return cancelChangedScope(job, decision.accepted)
  if (!decision.accepted) {
    const rejected = decision.reason === 'rejected'
    const cancelled = await updateOperationJob({
      jobId: job.jobId,
      status: 'cancelled',
      confirmationStatus: rejected ? 'rejected' : job.confirmationStatus,
      errorCode: rejected ? 'confirmation_rejected' : `confirmation_${decision.reason}`,
      errorSummary: rejected ? 'Operation was cancelled before execution' : 'Operation confirmation was unavailable; no action was sent',
      actor: actor ?? 'local-user',
    })
    onJob?.(cancelled)
    return null
  }
  const running = await updateOperationJob({
    jobId: job.jobId,
    status: 'running',
    confirmationStatus: risk === 'read-only' ? 'not_required' : 'confirmed',
    confirmedBy: actor ?? 'local-user',
    actor: actor ?? 'local-user',
  })
  onJob?.(running)
  if (!scopeCurrent()) return cancelChangedScope(running, true)

  try {
    const value = await execute({ isCurrent: scopeCurrent })
    const result = getResult?.(value)
    const status = result ? remoteOperationStatus(result) : 'completed'
    const completed = await updateOperationJob({
      jobId: job.jobId,
      status,
      actor: actor ?? 'local-user',
      resultSummary: result?.resultSummary ?? (result ? summarizeRemoteResult(result) : 'completed'),
      ...(result && status !== 'completed' ? {
        errorCode: result.errorCode ?? (status === 'unknown' ? 'remote_state_unknown' : `exit_${result.exitCode}`),
        errorSummary: result.errorSummary ?? (status === 'unknown' ? 'Remote operation outcome is unknown; verify before retrying' : 'Remote command exited with a non-zero status'),
      } : {}),
    })
    onJob?.(completed)
    return { value, job: completed }
  } catch (error) {
    const scopeChanged = error instanceof OperationScopeChangedError
    if (scopeChanged && error.sent === false) return cancelChangedScope(running, true)
    const unknown = scopeChanged || isUnknownOperationError(error)
    const failed = await updateOperationJob({
      jobId: job.jobId,
      status: unknown ? 'unknown' : 'failed',
      ...(scopeChanged ? {
        confirmationStatus: risk === 'read-only' ? 'not_required' : 'confirmed',
        ...(risk !== 'read-only' ? { confirmedBy: actor ?? 'local-user' } : {}),
      } : {}),
      errorCode: scopeChanged ? 'operation_scope_changed' : unknown ? 'remote_state_unknown' : 'operation_failed',
      errorSummary: scopeChanged ? 'The initiating host or Vault changed after a remote action was sent; remote state is unknown and must be verified before retrying' : safeOperationTarget(error instanceof Error ? error.message : String(error), 240),
      actor: actor ?? 'local-user',
    })
    onJob?.(failed)
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { operationJob: failed })
  }
}
