import type { HostProfile } from './hosts'
import {
  createOperationJob,
  isUnknownOperationError,
  operationTransport,
  safeOperationTarget,
  updateOperationJob,
  type OperationJob,
  type OperationRisk,
} from './operation-job'
import type { CommandRunResult } from './sessions'
import { runWorkspaceRemoteCommand } from './workspace-remote'

/**
 * Multi-host work is deliberately bounded.  A batch is a convenience for a
 * small, explicitly selected set of hosts, rather than an unattended fleet
 * executor.  Keeping these limits here gives Workspace, MCP and future
 * automation callers the same safety envelope.
 */
export const MAX_BATCH_HOSTS = 32
export const MAX_BATCH_CONCURRENCY = 4
export const DEFAULT_BATCH_CONCURRENCY = 2

export type BatchOperationStatus = 'completed' | 'partial' | 'failed' | 'cancelled'
export type BatchHostOperationStatus = OperationJob['status']

export interface BatchHostOutcome<T> {
  host: HostProfile
  transport: ReturnType<typeof operationTransport>
  job: OperationJob | null
  status: BatchHostOperationStatus
  value?: T
  resultSummary?: string
  errorCode?: string
  errorSummary?: string
}

export interface BatchOperationResult<T> {
  /** Stable identifier shared by the per-host OperationJob request IDs. */
  batchId: string
  action: string
  target: string
  risk: OperationRisk
  status: BatchOperationStatus
  selectedHostIds: string[]
  outcomes: BatchHostOutcome<T>[]
  completedCount: number
  failedCount: number
  unknownCount: number
  cancelledCount: number
  startedAt: number
  finishedAt: number
}

export interface BatchConfirmationContext {
  action: string
  target: string
  hostCount: number
  hosts: HostProfile[]
  risk: OperationRisk
}

export interface RunBatchOperationOptions<T> {
  /** Hosts are expected to be the user's explicit selection. */
  hosts: HostProfile[]
  /** Optional IDs make it possible to pass an entire host list safely. */
  selectedHostIds?: readonly string[]
  action: string
  target: string
  risk: OperationRisk
  paramsSummary?: string
  confirmMessage: string
  /** Optional caller-provided ID for grouping jobs in the audit view. */
  requestId?: string
  /** Override browser confirmation in tests or an application-owned dialog. */
  confirm?: (context: BatchConfirmationContext) => boolean | Promise<boolean>
  execute: (host: HostProfile) => Promise<T>
  getResult?: (value: T) => Pick<CommandRunResult, 'exitCode' | 'durationMs'> & {
    resultSummary?: string
    errorCode?: string
    errorSummary?: string
  }
  onOutcome?: (outcome: BatchHostOutcome<T>) => void
  provider?: string
  source?: 'terminal' | 'workspace' | 'mcp' | 'monitor'
  maxConcurrency?: number
  now?: () => number
  createJob?: typeof createOperationJob
  updateJob?: typeof updateOperationJob
}

export interface BatchSelectionResult {
  hosts: HostProfile[]
  selectedHostIds: string[]
}

/**
 * Resolve a selected set without silently broadening it.  Duplicate IDs are
 * collapsed in selection order; unknown IDs and an empty selection are errors.
 */
export function selectBatchHosts(hosts: readonly HostProfile[], selectedHostIds?: readonly string[]): BatchSelectionResult {
  const source = selectedHostIds === undefined ? hosts.map((host) => host.id) : selectedHostIds
  const ids = [...new Set(source.map((id) => String(id).trim()).filter(Boolean))]
  if (ids.length === 0) throw new Error('batch_selection_empty')
  if (ids.length > MAX_BATCH_HOSTS) throw new Error(`batch_selection_too_large:max=${MAX_BATCH_HOSTS}`)

  const byId = new Map(hosts.map((host) => [host.id, host]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`batch_selection_unknown_host:${missing.join(',').slice(0, 240)}`)
  return {
    hosts: ids.map((id) => byId.get(id)!).filter(Boolean),
    selectedHostIds: ids,
  }
}

export function normalizeBatchConcurrency(value: number | undefined) {
  const requested = Number.isFinite(value) ? Math.floor(value as number) : DEFAULT_BATCH_CONCURRENCY
  return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, requested || DEFAULT_BATCH_CONCURRENCY))
}

function boundedError(error: unknown) {
  return safeOperationTarget(error instanceof Error ? error.message : String(error), 240)
}

function defaultConfirmation(_context: BatchConfirmationContext, message: string) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return window.confirm(message)
}

function initialOutcome<T>(host: HostProfile): BatchHostOutcome<T> {
  return {
    host,
    transport: operationTransport(host),
    job: null,
    status: 'queued',
  }
}

function summarizeResult<T>(value: T, getResult?: RunBatchOperationOptions<T>['getResult']) {
  const result = getResult?.(value)
  if (!result) return { result, status: 'completed' as const, resultSummary: 'completed' }
  const status = result.exitCode === 0 ? 'completed' as const : 'failed' as const
  return {
    result,
    status,
    resultSummary: result.resultSummary ?? `exit=${result.exitCode}; durationMs=${result.durationMs}`,
  }
}

function aggregateStatus<T>(outcomes: BatchHostOutcome<T>[], confirmed: boolean): BatchOperationStatus {
  const cancelled = outcomes.filter((outcome) => outcome.status === 'cancelled').length
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length
  if (!confirmed) {
    if (failed > 0 && cancelled === 0) return 'failed'
    if (failed > 0 && cancelled > 0) return 'partial'
    return 'cancelled'
  }
  const completed = outcomes.filter((outcome) => outcome.status === 'completed').length
  const unknown = outcomes.filter((outcome) => outcome.status === 'unknown').length
  if (completed === outcomes.length) return 'completed'
  if (unknown === outcomes.length) return 'failed'
  if (failed === outcomes.length) return 'failed'
  if (completed > 0) return 'partial'
  return unknown > 0 ? 'partial' : 'failed'
}

/** Fixed action vocabulary for finite batch operations. Arbitrary shell
 * commands must continue to use the single-host terminal/MCP confirmation. */
export const BATCH_ALLOWED_ACTIONS = [
  'health.refresh',
  'inventory.refresh',
  'service.status',
  'service.start',
  'service.stop',
  'service.restart',
  'docker.start',
  'docker.stop',
  'docker.restart',
] as const

export type BatchAllowedAction = (typeof BATCH_ALLOWED_ACTIONS)[number]

export function isBatchActionAllowed(action: string): action is BatchAllowedAction {
  return (BATCH_ALLOWED_ACTIONS as readonly string[]).includes(action)
}

/**
 * Run one fixed operation across selected hosts.  Jobs are queued before the
 * single confirmation prompt, so a rejection still leaves a durable audit
 * trail for every selected host. Each host is then executed independently
 * with a bounded worker pool; a ProxyJump host keeps its own transport label
 * and uses the existing workspace transport callback supplied by the caller.
 */
export async function runBatchOperation<T>(options: RunBatchOperationOptions<T>): Promise<BatchOperationResult<T>> {
  const { hosts, selectedHostIds } = selectBatchHosts(options.hosts, options.selectedHostIds)
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const action = safeOperationTarget(options.action, 120)
  const target = safeOperationTarget(options.target, 160)
  if (!action) throw new Error('batch_action_required')
  if (!isBatchActionAllowed(action)) throw new Error('batch_action_not_allowed')
  if (!target) throw new Error('batch_target_required')
  if (!options.confirmMessage.trim()) throw new Error('batch_confirmation_message_required')

  const createJob = options.createJob ?? createOperationJob
  const updateJob = options.updateJob ?? updateOperationJob
  const outcomes = hosts.map<BatchHostOutcome<T>>((host) => initialOutcome<T>(host))
  const batchId = safeOperationTarget(options.requestId || `batch:${startedAt}:${action}`, 96)
  const requiresConfirmation = options.risk !== 'read-only'

  // Queue all jobs first. If a local store rejects a create, surface that
  // host as failed rather than running an operation without an audit record.
  for (let index = 0; index < hosts.length; index += 1) {
    const host = hosts[index]
    if (!host) continue
    try {
      outcomes[index]!.job = await createJob({
        hostId: host.id,
        hostName: host.name,
        hostAddress: host.address,
        username: host.username,
        source: options.source ?? 'workspace',
        actor: 'local-user',
        action,
        target,
        risk: options.risk,
        provider: options.provider ?? 'ssh-agentless',
        transport: operationTransport(host),
        paramsSummary: options.paramsSummary ? safeOperationTarget(options.paramsSummary, 240) : undefined,
        confirmationRequired: requiresConfirmation,
        requestId: `${batchId}:${host.id}`.slice(0, 160),
      })
    } catch (error) {
      outcomes[index] = {
        ...outcomes[index]!,
        status: 'failed',
        errorCode: 'operation_job_create_failed',
        errorSummary: boundedError(error),
      }
      options.onOutcome?.(outcomes[index]!)
    }
  }

  const queueable = outcomes.filter((outcome) => outcome.job)
  // If every audit record failed to create, report those local failures rather
  // than mislabelling the batch as a user cancellation.
  const confirmed = queueable.length === 0 || (!requiresConfirmation || await (options.confirm
    ? options.confirm({ action, target, hostCount: hosts.length, hosts, risk: options.risk })
    : defaultConfirmation({ action, target, hostCount: hosts.length, hosts, risk: options.risk }, options.confirmMessage)))

  if (!confirmed) {
    await Promise.all(queueable.map(async (outcome) => {
      if (!outcome.job) return
      try {
        outcome.job = await updateJob({
          jobId: outcome.job.jobId,
          status: 'cancelled',
          confirmationStatus: 'rejected',
          errorCode: 'confirmation_rejected',
          errorSummary: 'Operation was cancelled before execution',
        })
      } catch (error) {
        outcome.errorCode = 'operation_job_update_failed'
        outcome.errorSummary = boundedError(error)
      }
      outcome.status = 'cancelled'
      options.onOutcome?.(outcome)
    }))
    const finishedAt = now()
    return finalizeResult({ options, batchId, action, target, risk: options.risk, selectedHostIds, outcomes, startedAt, finishedAt, confirmed: false })
  }

  // A job creation failure must not prevent confirmed hosts from running;
  // those hosts retain their per-host failed outcome and audit error.
  const queue = queueable.slice()
  let nextIndex = 0
  const concurrency = normalizeBatchConcurrency(options.maxConcurrency)
  async function worker() {
    while (nextIndex < queue.length) {
      const outcome = queue[nextIndex]
      nextIndex += 1
      if (!outcome?.job) continue
      const host = outcome.host
      try {
        outcome.job = await updateJob({
          jobId: outcome.job.jobId,
          status: 'running',
          confirmationStatus: requiresConfirmation ? 'confirmed' : 'not_required',
          ...(requiresConfirmation ? { confirmedBy: 'local-user' } : {}),
        })
        outcome.status = 'running'
        options.onOutcome?.(outcome)
        const value = await options.execute(host)
        const summary = summarizeResult(value, options.getResult)
        outcome.value = value
        outcome.resultSummary = summary.resultSummary
        outcome.status = summary.status
        if (summary.result && summary.result.exitCode !== 0) {
          outcome.errorCode = summary.result.errorCode ?? `exit_${summary.result.exitCode}`
          outcome.errorSummary = summary.result.errorSummary ?? 'Remote command exited with a non-zero status'
        }
        outcome.job = await updateJob({
          jobId: outcome.job.jobId,
          status: summary.status,
          resultSummary: outcome.resultSummary,
          ...(outcome.status === 'failed' ? { errorCode: outcome.errorCode, errorSummary: outcome.errorSummary } : {}),
        })
      } catch (error) {
        const unknown = isUnknownOperationError(error)
        outcome.status = unknown ? 'unknown' : 'failed'
        outcome.errorCode = unknown ? 'remote_state_unknown' : 'operation_failed'
        outcome.errorSummary = boundedError(error)
        try {
          outcome.job = await updateJob({
            jobId: outcome.job.jobId,
            status: outcome.status,
            errorCode: outcome.errorCode,
            errorSummary: outcome.errorSummary,
          })
        } catch (updateError) {
          outcome.errorSummary = `${outcome.errorSummary}; audit=${boundedError(updateError)}`.slice(0, 240)
        }
      }
      options.onOutcome?.(outcome)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker()))

  const finishedAt = now()
  return finalizeResult({ options, batchId, action, target, risk: options.risk, selectedHostIds, outcomes, startedAt, finishedAt, confirmed: true })
}

function finalizeResult<T>(input: {
  options: RunBatchOperationOptions<T>
  batchId: string
  action: string
  target: string
  risk: OperationRisk
  selectedHostIds: string[]
  outcomes: BatchHostOutcome<T>[]
  startedAt: number
  finishedAt: number
  confirmed: boolean
}): BatchOperationResult<T> {
  const completedCount = input.outcomes.filter((outcome) => outcome.status === 'completed').length
  const failedCount = input.outcomes.filter((outcome) => outcome.status === 'failed').length
  const unknownCount = input.outcomes.filter((outcome) => outcome.status === 'unknown').length
  const cancelledCount = input.outcomes.filter((outcome) => outcome.status === 'cancelled').length
  return {
    batchId: input.batchId,
    action: input.action,
    target: input.target,
    risk: input.risk,
    status: aggregateStatus(input.outcomes, input.confirmed),
    selectedHostIds: input.selectedHostIds,
    outcomes: input.outcomes,
    completedCount,
    failedCount,
    unknownCount,
    cancelledCount,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  }
}

export type BatchServiceAction = 'status' | 'start' | 'stop' | 'restart'
export type BatchDockerAction = 'start' | 'stop' | 'restart'

function safeServiceName(name: string) {
  return /^[A-Za-z0-9_.@:-]+\.service$/.test(name) && name.length <= 160
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function serviceRisk(action: BatchServiceAction): OperationRisk {
  if (action === 'status') return 'read-only'
  return action === 'start' ? 'low' : 'high'
}

/** Convenience entry point used by the host-list service action. */
export function runBatchServiceOperation(options: Omit<RunBatchOperationOptions<CommandRunResult>, 'action' | 'target' | 'risk' | 'paramsSummary' | 'execute'> & {
  serviceName: string
  serviceAction: BatchServiceAction
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  if (!safeServiceName(options.serviceName)) throw new Error('batch_service_name_invalid')
  const command = options.serviceAction === 'status'
    ? `systemctl status --no-pager ${options.serviceName}`
    : `systemctl ${options.serviceAction} ${options.serviceName} && systemctl status --no-pager ${options.serviceName}`
  return runBatchOperation({
    ...options,
    action: `service.${options.serviceAction}`,
    target: options.serviceName,
    risk: serviceRisk(options.serviceAction),
    paramsSummary: command,
    execute: (host) => runWorkspaceRemoteCommand({ host, resolveAuthSecret: options.resolveAuthSecret, command }),
    getResult: (result) => result,
  })
}

function safeDockerTarget(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
}

function dockerRisk(action: BatchDockerAction): OperationRisk {
  return action === 'start' ? 'low' : 'high'
}

/** Convenience entry point for finite, same-container actions across hosts. */
export function runBatchDockerOperation(options: Omit<RunBatchOperationOptions<CommandRunResult>, 'action' | 'target' | 'risk' | 'paramsSummary' | 'execute'> & {
  containerName: string
  dockerAction: BatchDockerAction
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}) {
  if (!safeDockerTarget(options.containerName)) throw new Error('batch_docker_target_invalid')
  const quoted = shellQuote(options.containerName)
  const command = `docker ${options.dockerAction} ${quoted} && docker inspect --format '__SB_DOCKER={{.ID}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.Status}}' ${quoted}`
  return runBatchOperation({
    ...options,
    action: `docker.${options.dockerAction}`,
    target: options.containerName,
    risk: dockerRisk(options.dockerAction),
    paramsSummary: command,
    execute: (host) => runWorkspaceRemoteCommand({ host, resolveAuthSecret: options.resolveAuthSecret, command }),
    getResult: (result) => result,
  })
}
