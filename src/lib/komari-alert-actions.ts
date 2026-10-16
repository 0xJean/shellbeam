import {
  acknowledgeKomariAlert,
  closeKomariAlert,
  linkKomariAlertOperation,
  summarizeKomariAlertState,
  type KomariAlertRecord,
  type KomariAlertState,
} from './komari-alerts'
import { persistKomariAlertState } from './komari-persistence'

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
