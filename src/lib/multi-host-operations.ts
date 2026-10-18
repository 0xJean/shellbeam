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
import { remoteOperationStatus, verifiedOperationAudit, type VerifiedOperationResult } from './operation-verification'
import { executeVerifiedServiceAction, safeDiagnosticService } from './workspace-diagnostics'
import { buildDockerCommand, buildDockerVerificationCommand, dockerPostState } from './docker-ops'

/**
 * Multi-host work is deliberately bounded.  A batch is a convenience for a
 * small, explicitly selected set of hosts, rather than an unattended fleet
 * executor.  Keeping these limits here gives Workspace, MCP and future
 * automation callers the same safety envelope.
 */
export const MAX_BATCH_HOSTS = 32
export const MAX_BATCH_CONCURRENCY = 4
export const DEFAULT_BATCH_CONCURRENCY = 2

export type BatchOperationStatus = 'completed' | 'partial' | 'failed' | 'unknown' | 'cancelled'
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
  /** Explicit scope; contextual hosts may supply the same scope themselves. */
  vaultId?: string
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
    errorType?: CommandRunResult['errorType']
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
  for (const id of ids) {
    if (new Set(hosts.filter((host) => host.id === id).map((host) => host.vaultId ?? '')).size > 1) throw new Error('batch_selection_ambiguous_host')
  }
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
  const status = remoteOperationStatus(result)
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
  if (unknown === outcomes.length) return 'unknown'
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
  const selection = selectBatchHosts(options.hosts, options.selectedHostIds)
  const hosts = selection.hosts.map((host) => ({ ...host, vaultId: batchVaultId(host, options.vaultId) }))
  const selectedHostIds = selection.selectedHostIds
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
        vaultId: host.vaultId,
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
        if (summary.result && summary.status !== 'completed') {
          outcome.errorCode = summary.result.errorCode ?? (summary.status === 'unknown' ? 'remote_state_unknown' : `exit_${summary.result.exitCode}`)
          outcome.errorSummary = summary.result.errorSummary ?? (summary.status === 'unknown' ? 'Remote result is unknown; verify before retrying' : 'Remote command exited with a non-zero status')
        }
        outcome.job = await updateJob({
          jobId: outcome.job.jobId,
          status: summary.status,
          resultSummary: outcome.resultSummary,
          ...(outcome.status !== 'completed' ? { errorCode: outcome.errorCode, errorSummary: outcome.errorSummary } : {}),
        })
      } catch (error) {
        const unknown = outcome.status === 'unknown' || isUnknownOperationError(error)
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

function batchVaultId(host: HostProfile, explicitVaultId?: string) {
  const explicit = explicitVaultId?.trim()
  const contextual = host.vaultId?.trim()
  if (explicit && contextual && explicit !== contextual) throw new Error('batch_vault_scope_mismatch')
  const vaultId = explicit || contextual
  if (!vaultId) throw new Error('batch_vault_scope_required')
  return vaultId
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
  if (!safeDiagnosticService(options.serviceName)) throw new Error('batch_service_name_invalid')
  const command = options.serviceAction === 'status'
    ? `systemctl show --property=LoadState --property=ActiveState --property=UnitFileState -- ${options.serviceName}`
    : `systemctl ${options.serviceAction} -- ${options.serviceName}`
  return runBatchOperation({
    ...options,
    action: `service.${options.serviceAction}`,
    target: options.serviceName,
    risk: serviceRisk(options.serviceAction),
    paramsSummary: command,
    execute: async (host) => {
      const run = (command: string) => runWorkspaceRemoteCommand({ host, vaultId: batchVaultId(host, options.vaultId), resolveAuthSecret: options.resolveAuthSecret, command })
      if (options.serviceAction === 'status') {
        const result = await run(command)
        if (remoteOperationStatus(result) !== 'completed') return result
        const active = result.stdout.match(/^ActiveState=([a-z-]+)$/m)?.[1]
        return active ? { ...result, resultSummary: `status=observed; active=${active}` } : { ...result, exitCode: -1, errorCode: 'remote_state_unknown', resultSummary: 'status=unobservable', errorSummary: 'Service state could not be observed' }
      }
      let mutation: CommandRunResult | undefined
      let observation: CommandRunResult | undefined
      try {
        const verified = await executeVerifiedServiceAction(async (next) => {
          const result = await run(next)
          if (!mutation) mutation = result
          else observation = result
          return result
        }, options.serviceName, options.serviceAction)
        return verified.errorCode === 'remote_state_unknown' && observation && remoteOperationStatus(observation) === 'unknown'
          ? { ...verified, errorCode: observation.errorCode ?? 'remote_state_unknown', errorType: 'unknown' as const }
          : verified
      } catch (error) {
        if (!mutation || mutation.exitCode !== 0) throw error
        return { ...mutation, exitCode: -1, errorCode: 'remote_state_unknown', resultSummary: `action=${options.serviceAction}; verification=unknown`, errorSummary: 'Service action was sent but its post-state is unavailable; verify before retrying' }
      }
    },
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
  const command = `resolve container id; docker ${options.dockerAction}; verify state`
  return runBatchOperation({
    ...options,
    action: `docker.${options.dockerAction}`,
    target: options.containerName,
    risk: dockerRisk(options.dockerAction),
    paramsSummary: command,
    execute: async (host): Promise<VerifiedOperationResult> => {
      const run = (command: string) => runWorkspaceRemoteCommand({ host, vaultId: batchVaultId(host, options.vaultId), resolveAuthSecret: options.resolveAuthSecret, command })
      // Resolution happens only after the one batch confirmation. A stable
      // full id prevents later name reuse from redirecting the accepted write.
      const resolved = await run(`docker inspect --format '__SB_DOCKER_ID={{.Id}}' ${quoted}`)
      if (remoteOperationStatus(resolved) !== 'completed') return { ...resolved, verification: { status: 'not-run', summary: 'Container identity could not be resolved; no mutation executed.' } }
      const ids = resolved.stdout.split('\n').filter((line) => line.startsWith('__SB_DOCKER_ID=')).map((line) => line.slice('__SB_DOCKER_ID='.length).trim())
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) return { ...resolved, verification: { status: 'unknown', summary: 'Container immutable identity is unavailable; no mutation executed.' } }
      const id = ids[0]
      const result = await run(buildDockerCommand(options.dockerAction, id))
      if (remoteOperationStatus(result) !== 'completed') return { ...result, durationMs: resolved.durationMs + result.durationMs, verification: { status: 'not-run', summary: 'Docker command did not complete; no post-state was claimed.' } }
      try {
        const observed = await run(buildDockerVerificationCommand(id))
        const state = remoteOperationStatus(observed) === 'completed' ? dockerPostState(observed.stdout, { id, name: options.containerName, image: '', status: '', ports: '', running: false }) : null
        const verified = state && !state.paused && !state.restarting && (options.dockerAction === 'stop' ? !state.running && ['exited', 'created'].includes(state.status) : state.running && state.status === 'running')
        return { ...result, ...(remoteOperationStatus(observed) === 'unknown' ? { errorCode: observed.errorCode, errorType: observed.errorType } : {}), durationMs: resolved.durationMs + result.durationMs + observed.durationMs, verification: { status: verified ? 'verified' : 'unknown', summary: state ? `action=${options.dockerAction}; observed=${state.status}; running=${state.running}; paused=${state.paused}; restarting=${state.restarting}` : 'Docker post-state is unavailable; verify before retrying.' } }
      } catch {
        return { ...result, verification: { status: 'unknown', summary: 'Docker command returned successfully, but its post-state is unavailable; verify before retrying.' } }
      }
    },
    getResult: verifiedOperationAudit,
  })
}
