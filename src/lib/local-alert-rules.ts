import type { NotificationEvent, NotificationSeverity } from './notification-policy'

export type LocalAlertMetric = 'cpu' | 'memory' | 'disk' | 'service' | 'health-check'
export type LocalAlertStatus = 'active' | 'acknowledged' | 'resolved' | 'closed'
export interface LocalAlertRule {
  id: string
  hostId: string
  name: string
  metric: LocalAlertMetric
  target?: string
  threshold: number
  recoveryThreshold: number
  durationMs: number
  recoveryDurationMs: number
  freshnessMs: number
  severity: NotificationSeverity
  enabled: boolean
}
export interface LocalAlertObservation {
  ruleId: string
  value: number | null
  sampledAt: number
  source: string
  transport: 'direct' | 'proxy-jump'
}
export interface LocalAlertRecord {
  ruleId: string
  hostId: string
  name: string
  metric: LocalAlertMetric
  status: LocalAlertStatus
  severity: NotificationSeverity
  openedAt: number
  updatedAt: number
  resolvedAt: number | null
  value: number | null
  source: string
  transport: 'direct' | 'proxy-jump'
  operationJobId?: string
}
export interface LocalAlertEvaluation {
  ruleId: string
  sampledAt: number
  pendingSince: number | null
  recoverySince: number | null
  state: 'healthy' | 'pending' | 'firing' | 'recovering' | 'unknown' | 'disabled'
  value: number | null
}
export interface LocalAlertAudit {
  id: string
  ruleId: string
  hostId: string
  event: 'opened' | 'reopened' | 'resolved' | 'acknowledged' | 'closed'
  at: number
  actor: string
  status: LocalAlertStatus
  name: string
  severity: NotificationSeverity
  operationJobId?: string
}
export interface LocalAlertState {
  version: 1
  alerts: LocalAlertRecord[]
  evaluations: LocalAlertEvaluation[]
  audit: LocalAlertAudit[]
}
export const EMPTY_LOCAL_ALERT_STATE: LocalAlertState = { version: 1, alerts: [], evaluations: [], audit: [] }
const METRICS: LocalAlertMetric[] = ['cpu', 'memory', 'disk', 'service', 'health-check']
export function localAlertText(value: unknown): string {
  return typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('').trim().slice(0, 120) : ''
}
function bounded(value: unknown, fallback: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : fallback
}
export function normalizeLocalAlertRule(value: unknown): LocalAlertRule {
  const raw = value as Partial<LocalAlertRule> | null
  if (!raw || !METRICS.includes(raw.metric as LocalAlertMetric) || !localAlertText(raw.id) || !localAlertText(raw.hostId) || !localAlertText(raw.name)) throw new Error('local_alert_invalid_rule')
  const metric = raw.metric as LocalAlertMetric
  const binary = metric === 'service' || metric === 'health-check'
  const target = localAlertText(raw.target)
  if (binary && (!target || (metric === 'service' && !/^[A-Za-z0-9@_.:-]+$/.test(target)))) throw new Error('local_alert_invalid_target')
  const threshold = binary ? 1 : bounded(raw.threshold, 90, 100)
  const recoveryThreshold = binary ? 0 : Math.min(threshold, bounded(raw.recoveryThreshold, Math.max(0, threshold - 5), 100))
  return {
    id: localAlertText(raw.id), hostId: localAlertText(raw.hostId), name: localAlertText(raw.name), metric,
    ...(binary ? { target } : {}), threshold, recoveryThreshold,
    durationMs: bounded(raw.durationMs, 60_000, 86_400_000), recoveryDurationMs: bounded(raw.recoveryDurationMs, 30_000, 86_400_000),
    freshnessMs: Math.max(5_000, bounded(raw.freshnessMs, 180_000, 86_400_000)),
    severity: raw.severity === 'critical' || raw.severity === 'info' ? raw.severity : 'warning', enabled: raw.enabled !== false,
  }
}
function appendAudit(state: LocalAlertState, alert: LocalAlertRecord, event: LocalAlertAudit['event'], now: number, actor: string) {
  state.audit.push({ id: `${alert.ruleId.slice(0, 80)}:${event}:${now}:${crypto.randomUUID()}`, ruleId: alert.ruleId, hostId: alert.hostId, event, at: now, actor, status: alert.status, name: alert.name, severity: alert.severity, ...(alert.operationJobId ? { operationJobId: alert.operationJobId } : {}) })
  state.audit = state.audit.slice(-500)
}
/** A repeated cached sample never advances either sustain timer. Missing/stale
 * data breaks the evidence interval and preserves any currently firing alert. */
export function evaluateLocalAlertRules(previous: LocalAlertState, rules: LocalAlertRule[], observations: LocalAlertObservation[], now = Date.now()): LocalAlertState {
  const state: LocalAlertState = { version: 1, alerts: previous.alerts.map((r) => ({ ...r })), evaluations: previous.evaluations.map((r) => ({ ...r })), audit: [...previous.audit] }
  for (const rule of rules) {
    const observation = observations.find((row) => row.ruleId === rule.id)
    let evaluation = state.evaluations.find((row) => row.ruleId === rule.id)
    if (!evaluation) { evaluation = { ruleId: rule.id, sampledAt: 0, pendingSince: null, recoverySince: null, state: 'unknown', value: null }; state.evaluations.push(evaluation) }
    if (!rule.enabled) { Object.assign(evaluation, { state: 'disabled', pendingSince: null, recoverySince: null }); continue }
    const known = observation && Number.isFinite(observation.value) && observation.value !== null && observation.sampledAt <= now && now - observation.sampledAt <= rule.freshnessMs
    if (!known) { Object.assign(evaluation, { state: 'unknown', pendingSince: null, recoverySince: null, value: null }); continue }
    if (observation.sampledAt <= evaluation.sampledAt) continue
    if (observation.sampledAt - evaluation.sampledAt > rule.freshnessMs) { evaluation.pendingSince = null; evaluation.recoverySince = null }
    evaluation.sampledAt = observation.sampledAt
    evaluation.value = observation.value
    let alert = state.alerts.find((row) => row.ruleId === rule.id)
    const firing = alert?.status === 'active' || alert?.status === 'acknowledged'
    if (firing) {
      evaluation.pendingSince = null
      if ((observation.value as number) <= rule.recoveryThreshold) {
        evaluation.recoverySince ??= observation.sampledAt
        evaluation.state = 'recovering'
        if (observation.sampledAt - evaluation.recoverySince >= rule.recoveryDurationMs) {
          Object.assign(alert!, { status: 'resolved', resolvedAt: now, updatedAt: now, value: observation.value })
          appendAudit(state, alert!, 'resolved', now, 'local-ops-runtime')
          evaluation.recoverySince = null; evaluation.state = 'healthy'
        }
      } else { evaluation.recoverySince = null; evaluation.state = 'firing' }
      Object.assign(alert!, { value: observation.value, updatedAt: now, source: localAlertText(observation.source), transport: observation.transport })
    } else {
      evaluation.recoverySince = null
      if ((observation.value as number) >= rule.threshold) {
        evaluation.pendingSince ??= observation.sampledAt
        evaluation.state = 'pending'
        if (observation.sampledAt - evaluation.pendingSince >= rule.durationMs) {
          const reopened = Boolean(alert)
          if (!alert) { alert = { ruleId: rule.id, hostId: rule.hostId, name: rule.name, metric: rule.metric, status: 'active', severity: rule.severity, openedAt: now, updatedAt: now, resolvedAt: null, value: observation.value, source: localAlertText(observation.source), transport: observation.transport }; state.alerts.push(alert) }
          else Object.assign(alert, { name: rule.name, severity: rule.severity, status: 'active', openedAt: now, updatedAt: now, resolvedAt: null, value: observation.value, source: localAlertText(observation.source), transport: observation.transport })
          appendAudit(state, alert, reopened ? 'reopened' : 'opened', now, 'local-ops-runtime')
          evaluation.pendingSince = null; evaluation.state = 'firing'
        }
      } else { evaluation.pendingSince = null; evaluation.state = 'healthy' }
    }
  }
  return state
}
export function actOnLocalAlert(previous: LocalAlertState, ruleId: string, action: 'acknowledge' | 'close', now = Date.now(), operationJobId?: string): LocalAlertState {
  const state = { ...previous, alerts: previous.alerts.map((r) => ({ ...r })), audit: [...previous.audit] }
  const alert = state.alerts.find((row) => row.ruleId === ruleId)
  if (!alert || (action === 'acknowledge' && alert.status !== 'active') || (action === 'close' && alert.status === 'closed')) return state
  if (operationJobId) alert.operationJobId = localAlertText(operationJobId)
  alert.status = action === 'acknowledge' ? 'acknowledged' : 'closed'; alert.updatedAt = now
  appendAudit(state, alert, action === 'acknowledge' ? 'acknowledged' : 'closed', now, 'local-user')
  return state
}
export function localAlertNotificationEvent(audit: LocalAlertAudit): NotificationEvent {
  return { eventId: audit.id, fingerprint: `local-ops:${audit.hostId}:${audit.ruleId}`, source: 'local-ops', kind: `alert.${audit.event}`, severity: audit.severity, title: audit.name, message: `${audit.name}: ${audit.event}`, hostId: audit.hostId, status: audit.status, occurredAt: audit.at, metadata: { ruleId: audit.ruleId, auditId: audit.id, operationJobId: audit.operationJobId, recovered: audit.event === 'resolved' } }
}
