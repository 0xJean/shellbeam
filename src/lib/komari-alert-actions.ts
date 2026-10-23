import { komariAlertIncidentMembers, normalizeKomariAlertIncidents } from './komari-alert-incidents'
import {
  acknowledgeKomariAlert,
  closeKomariAlert,
  linkKomariAlertOperation,
  summarizeKomariAlertState,
  type KomariAlertRecord,
  type KomariAlertState,
} from './komari-alerts'
import { persistKomariAlertState } from './komari-persistence'
import type { HostProfile } from './hosts'
import {
  runConfirmedOperation,
  type OperationJob,
} from './operation-job'

export type KomariAlertAction = 'acknowledge' | 'close'

export interface PersistKomariAlertOperationLinkOptions {
  integrationId: string
  state: KomariAlertState
  alertId: string
  operationJobId: string
  actor?: string
  now?: number
  ttlMs?: number
  lastSyncedAt?: number
}

export interface PersistKomariAlertActionOptions {
  integrationId: string
  state: KomariAlertState
  alertId: string
  actor?: string
  now?: number
  ttlMs?: number
  lastSyncedAt?: number
}

export interface PersistKomariAlertActionResult {
  state: KomariAlertState
  alert: KomariAlertRecord
}

export interface RunKomariAlertActionOptions extends PersistKomariAlertActionOptions {
  /** Host context is required so the local journal can be filtered from the
   * host operations view and from the MCP audit surface. */
  host: HostProfile
  vaultId?: string
  requestId?: string
  provider?: string
  confirmMessage?: string
  isCurrent?: () => boolean
}

export interface RunKomariAlertActionResult extends PersistKomariAlertActionResult {
  job: OperationJob
}

/** Persist the relationship between a Komari lifecycle row and the
 * confirmed OperationJob that was started to diagnose or remediate it.
 *
 * The link is deliberately separate from acknowledge/close: a successful SSH
 * or Probe operation does not prove that Komari has recovered, so the next
 * provider sync remains responsible for resolving the alert. Re-linking the
 * same job is idempotent and does not create duplicate audit rows. */
export async function persistKomariAlertOperationLink(
  options: PersistKomariAlertOperationLinkOptions,
): Promise<PersistKomariAlertActionResult> {
  const alert = options.state.alerts.find((candidate) => candidate.alertId === options.alertId)
  if (!alert) throw new Error('Komari alert was not found')
  const operationJobId = options.operationJobId.trim()
  if (!operationJobId) throw new Error('Operation job id is required')
  const members = komariAlertIncidentMembers(options.state.alerts, alert.alertId)
  if (members.every((member) => member.relatedOperationJobId === operationJobId)) {
    return { state: options.state, alert }
  }
  const now = options.now ?? Date.now()
  const results = members.filter((member) => member.relatedOperationJobId !== operationJobId).map((member) => linkKomariAlertOperation(member, operationJobId, options.actor ?? 'local-user', now))
  const alerts = normalizeKomariAlertIncidents(options.state.alerts).map((candidate) => results.find((result) => result.alert.alertId === candidate.alertId)?.alert ?? candidate)
  const state: KomariAlertState = {
    ...options.state,
    schemaVersion: 1,
    alerts,
    audit: [...options.state.audit, ...results.map((result) => result.audit)].slice(-1000),
    summary: summarizeKomariAlertState(alerts, now, options.state.summary),
  }
  await persistKomariAlertState({
    integrationId: options.integrationId,
    state,
    lastSyncedAt: options.lastSyncedAt,
    ttlMs: options.ttlMs,
    updatedAt: now,
  })
  return { state, alert: alerts.find((candidate) => candidate.alertId === alert.alertId)! }
}

/** Apply a local lifecycle action and persist the resulting record and audit
 * entry in the same Komari sync-state JSON payload. Komari remains the source
 * of truth for recovery; the UI only owns acknowledgement and close. */
export async function persistKomariAlertAction(
  action: KomariAlertAction,
  options: PersistKomariAlertActionOptions,
): Promise<PersistKomariAlertActionResult> {
  const alert = options.state.alerts.find((candidate) => candidate.alertId === options.alertId)
  if (!alert) throw new Error('Komari alert was not found')
  const members = komariAlertIncidentMembers(options.state.alerts, alert.alertId)
  const actionable = members.filter((member) => action === 'acknowledge' ? member.status === 'active' : member.status !== 'closed')
  // An old member ID remains a valid action target for the whole incident.
  // Idempotency is checked per member, retaining every original audit ID.
  if (actionable.length === 0) return { state: options.state, alert }
  const now = options.now ?? Date.now()
  const actor = options.actor ?? 'local-user'
  const results = actionable.map((member) => action === 'acknowledge'
    ? acknowledgeKomariAlert(member, actor, now)
    : closeKomariAlert(member, actor, now))
  const alerts = normalizeKomariAlertIncidents(options.state.alerts).map((candidate) => results.find((result) => result.alert.alertId === candidate.alertId)?.alert ?? candidate)
  const audit = [...options.state.audit, ...results.map((result) => result.audit)].slice(-1000)
  const state: KomariAlertState = {
    ...options.state,
    schemaVersion: 1,
    alerts,
    audit,
    summary: summarizeKomariAlertState(alerts, now, options.state.summary),
  }
  await persistKomariAlertState({
    integrationId: options.integrationId,
    state,
    lastSyncedAt: options.lastSyncedAt,
    ttlMs: options.ttlMs,
    updatedAt: now,
  })
  return { state, alert: alerts.find((candidate) => candidate.alertId === alert.alertId)! }
}

/**
 * Execute an acknowledgement/close from a host operations surface.
 *
 * These actions only mutate ShellBeam's local Komari lifecycle, but they are
 * still operational decisions and must be durable in the same OperationJob
 * journal used by MCP. The job is created before mutating the alert, linked to
 * the alert audit, and always moved to a terminal state when the local write
 * succeeds or fails.
 */
export async function runKomariAlertAction(
  action: KomariAlertAction,
  options: RunKomariAlertActionOptions,
): Promise<RunKomariAlertActionResult | null> {
  const alert = options.state.alerts.find((candidate) => candidate.alertId === options.alertId)
  if (!alert) throw new Error('Komari alert was not found')

  const operationAction = `komari.alert.${action}`
  const requestId = options.requestId?.trim() || undefined
  let operationJobId: string | undefined
  const execution = await runConfirmedOperation({
    host: options.host,
    vaultId: options.vaultId,
    actor: options.actor,
    requestId,
    source: 'monitor',
    action: operationAction,
    target: `komari-alert:${options.alertId}`,
    risk: 'low',
    provider: options.provider ?? 'komari-local',
    transport: 'local',
    paramsSummary: `integrationId=${options.integrationId}; alertId=${options.alertId}; action=${action}`,
    isCurrent: options.isCurrent,
    confirmMessage: options.confirmMessage ?? `Confirm ${action} for this local monitoring incident (${options.alertId})? This updates ShellBeam only; remote health and server notifications are unchanged.`,
    onJob: (nextJob) => { operationJobId = nextJob.jobId },
    execute: async (context) => {
      if (!operationJobId) throw new Error('Operation job id was not created')
      // Link first so both the lifecycle event and the alert record carry the
      // canonical OperationJob id, including idempotent/retried transitions.
      const linked = await persistKomariAlertOperationLink({
        integrationId: options.integrationId,
        state: options.state,
        alertId: options.alertId,
        operationJobId,
        actor: options.actor,
        now: options.now,
        ttlMs: options.ttlMs,
        lastSyncedAt: options.lastSyncedAt,
      })
      if (!context.isCurrent()) throw new Error('Operation context changed')
      return persistKomariAlertAction(action, {
        ...options,
        state: linked.state,
      })
    },
    getResult: () => ({
      exitCode: 0,
      durationMs: 0,
      resultSummary: `alertId=${options.alertId}; action=${action}; local-only=true`,
    }),
  })
  if (!execution) return null
  return { ...execution.value, job: execution.job }
}
