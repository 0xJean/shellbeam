import { invoke } from '@tauri-apps/api/core'
import type { CommandRunResult } from './sessions'
import type { HostProfile } from './hosts'

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
export interface OperationJobListQuery {
  hostId?: string
  status?: OperationJobStatus
  action?: string
  source?: OperationSource
  limit?: number
}

export interface OperationAuditListQuery {
  jobId?: string
  hostId?: string
  limit?: number
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
  return host.jumpHost?.trim() ? 'proxy-jump' : 'direct'
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

export interface RunConfirmedOperationOptions<T> {
  host: HostProfile
  action: string
  target: string
  risk: OperationRisk
  paramsSummary?: string
  confirmMessage: string
  execute: () => Promise<T>
  getResult?: (value: T) => Pick<CommandRunResult, 'exitCode' | 'durationMs'>
  onJob?: (job: OperationJob) => void
  provider?: string
  transport?: string
  source?: OperationSource
}

/**
 * Creates the durable job before prompting so rejected confirmations are auditable.
 * The callback is only called after the user confirms. Transport errors remain unknown
 * because a lost connection cannot prove the remote state.
 */
export async function runConfirmedOperation<T>({
  host,
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
}: RunConfirmedOperationOptions<T>): Promise<{ value: T; job: OperationJob } | null> {
  const job = await createOperationJob({
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    source: source ?? 'workspace',
    actor: 'local-user',
    action,
    target: safeOperationTarget(target),
    risk,
    provider: provider ?? 'ssh-agentless',
    transport: transport ?? operationTransport(host),
    paramsSummary: paramsSummary ? safeOperationTarget(paramsSummary) : undefined,
    confirmationRequired: true,
  })
  onJob?.(job)

  if (!window.confirm(confirmMessage)) {
    const cancelled = await updateOperationJob({
      jobId: job.jobId,
      status: 'cancelled',
      confirmationStatus: 'rejected',
      errorCode: 'confirmation_rejected',
      errorSummary: 'Operation was cancelled before execution',
    })
    onJob?.(cancelled)
    return null
  }

  const running = await updateOperationJob({
    jobId: job.jobId,
    status: 'running',
    confirmationStatus: 'confirmed',
    confirmedBy: 'local-user',
  })
  onJob?.(running)

  try {
    const value = await execute()
    const result = getResult?.(value)
    const completed = await updateOperationJob({
      jobId: job.jobId,
      status: result && result.exitCode !== 0 ? 'failed' : 'completed',
      resultSummary: result ? summarizeRemoteResult(result) : 'completed',
      ...(result && result.exitCode !== 0 ? { errorCode: `exit_${result.exitCode}`, errorSummary: 'Remote command exited with a non-zero status' } : {}),
    })
    onJob?.(completed)
    return { value, job: completed }
  } catch (error) {
    const unknown = isUnknownOperationError(error)
    const failed = await updateOperationJob({
      jobId: job.jobId,
      status: unknown ? 'unknown' : 'failed',
      errorCode: unknown ? 'remote_state_unknown' : 'operation_failed',
      errorSummary: safeOperationTarget(error instanceof Error ? error.message : String(error), 240),
    })
    onJob?.(failed)
    throw error
  }
}
