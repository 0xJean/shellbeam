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
  if (alert.relatedOperationJobId === operationJobId) {
    return { state: options.state, alert }
  }
  const now = options.now ?? Date.now()
  const result = linkKomariAlertOperation(alert, operationJobId, options.actor ?? 'local-user', now)
  const alerts = options.state.alerts.map((candidate) => candidate.alertId === alert.alertId ? result.alert : candidate)
  const state: KomariAlertState = {
    schemaVersion: 1,
    alerts,
    audit: [...options.state.audit, result.audit].slice(-1000),
    summary: summarizeKomariAlertState(alerts, now, options.state.summary),
  }
  await persistKomariAlertState({
    integrationId: options.integrationId,
    state,
    lastSyncedAt: options.lastSyncedAt,
    ttlMs: options.ttlMs,
    updatedAt: now,
  })
  return { state, alert: result.alert }
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
  // A retry after a lost MCP/UI response must not append another lifecycle
  // event when the requested transition already happened. Keep this guard in
  // the persistence boundary (rather than only in the panel) so repeated
  // requests from another session remain audit-idempotent as well.
  if ((action === 'acknowledge' && alert.status !== 'active')
    || (action === 'close' && alert.status === 'closed')) {
    return { state: options.state, alert }
  }
  const now = options.now ?? Date.now()
  const actor = options.actor ?? 'local-user'
  const result = action === 'acknowledge'
    ? acknowledgeKomariAlert(alert, actor, now)
    : closeKomariAlert(alert, actor, now)
  const alerts = options.state.alerts.map((candidate) => candidate.alertId === alert.alertId ? result.alert : candidate)
  const audit = [...options.state.audit, result.audit].slice(-1000)
  const state: KomariAlertState = {
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
  return { state, alert: result.alert }
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
    confirmMessage: options.confirmMessage ?? `Confirm ${action} for Komari alert ${options.alertId}?`,
    onJob: (nextJob) => { operationJobId = nextJob.jobId },
    execute: async () => {
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
