import {
  acknowledgeKomariAlert,
  closeKomariAlert,
  summarizeKomariAlertState,
  type KomariAlertRecord,
  type KomariAlertState,
} from './komari-alerts'
import { persistKomariAlertState } from './komari-persistence'

export type KomariAlertAction = 'acknowledge' | 'close'

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
