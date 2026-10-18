import { queueLocalOpsDocument, registerLocalOpsAdapter } from './local-ops-persistence'
import { dispatchNotification, type NotificationDispatchOptions } from './notification-dispatch'
import { emitKomariAlertNotification, loadKomariAlertNotificationState, saveKomariAlertNotificationState } from './komari-alert-notifications'
import { loadNotificationPolicy } from './notification-policy'
import { EMPTY_LOCAL_ALERT_STATE, localAlertNotificationEvent, localAlertText, normalizeLocalAlertRule, type LocalAlertAudit, type LocalAlertEvaluation, type LocalAlertRecord, type LocalAlertRule, type LocalAlertState } from './local-alert-rules'

export const LOCAL_OPS_CHANGED_EVENT = 'shellbeam:local-ops-changed'
const PREFIX = 'shellbeam.localOps.v1'
export function localOpsStorageKey(vaultId: string | undefined, hostId: string, section: string) {
  return `${PREFIX}:${encodeURIComponent(vaultId || 'default')}:${encodeURIComponent(hostId)}:${section}`
}
export function notifyLocalOpsChanged() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_OPS_CHANGED_EVENT)) }
function load(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
export function loadLocalAlertRules(vaultId: string | undefined, hostId: string): LocalAlertRule[] {
  const rows = load(localOpsStorageKey(vaultId, hostId, 'rules'))
  return Array.isArray(rows) ? rows.slice(0, 32).flatMap((row) => { try { const rule = normalizeLocalAlertRule(row); return rule.hostId === hostId ? [rule] : [] } catch { return [] } }) : []
}
export function saveLocalAlertRules(vaultId: string | undefined, hostId: string, values: LocalAlertRule[]) {
  const rules = values.slice(0, 32).map(normalizeLocalAlertRule)
  if (rules.some((row) => row.hostId !== hostId) || new Set(rules.map((r) => r.id)).size !== rules.length) throw new Error('local_alert_invalid_scope')
  const previous = loadLocalAlertRules(vaultId, hostId)
  const state = loadLocalAlertState(vaultId, hostId)
  const unchanged = new Set(rules.filter((row) => previous.some((old) => JSON.stringify(old) === JSON.stringify(row))).map((row) => row.id))
  state.evaluations = state.evaluations.filter((row) => row.ruleId.startsWith('check:') || row.ruleId.startsWith('probe:') || unchanged.has(row.ruleId))
  localStorage.setItem(localOpsStorageKey(vaultId, hostId, 'rules'), JSON.stringify(rules))
  void queueLocalOpsDocument(vaultId, hostId, 'alert-rules', rules)
  saveLocalAlertState(vaultId, hostId, state)
  return rules
}
function time(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function number(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null }
const statuses = ['active', 'acknowledged', 'resolved', 'closed']
export function parseLocalAlertState(value: unknown, hostId: string): LocalAlertState {
  if (!value || typeof value !== 'object') return { ...EMPTY_LOCAL_ALERT_STATE, alerts: [], evaluations: [], audit: [] }
  const raw = value as Partial<LocalAlertState>
  const alerts: LocalAlertRecord[] = Array.isArray(raw.alerts) ? raw.alerts.slice(-100).flatMap((r) => {
    if (!r || r.hostId !== hostId || !localAlertText(r.ruleId) || !statuses.includes(r.status) || !['cpu', 'memory', 'disk', 'service', 'health-check', 'probe-provider'].includes(r.metric)) return []
    return [{ ruleId: localAlertText(r.ruleId), hostId, name: localAlertText(r.name), metric: r.metric, status: r.status, severity: r.severity === 'critical' || r.severity === 'info' ? r.severity : 'warning', openedAt: time(r.openedAt), updatedAt: time(r.updatedAt), resolvedAt: r.resolvedAt === null ? null : time(r.resolvedAt), value: number(r.value), source: localAlertText(r.source), transport: r.transport === 'proxy-jump' ? 'proxy-jump' : 'direct', ...(localAlertText(r.operationJobId) ? { operationJobId: localAlertText(r.operationJobId) } : {}) }]
  }) : []
  const evaluations: LocalAlertEvaluation[] = Array.isArray(raw.evaluations) ? raw.evaluations.slice(-100).flatMap((r) => {
    if (!r || !localAlertText(r.ruleId) || !['healthy', 'pending', 'firing', 'recovering', 'unknown', 'disabled'].includes(r.state)) return []
    // Sustain timers are session-local evidence. Restart requires fresh samples.
    return [{ ruleId: localAlertText(r.ruleId), sampledAt: time(r.sampledAt), pendingSince: null, recoverySince: null, state: r.state === 'disabled' ? 'disabled' : 'unknown', value: number(r.value) }]
  }) : []
  const audit: LocalAlertAudit[] = Array.isArray(raw.audit) ? raw.audit.slice(-500).flatMap((r) => {
    if (!r || r.hostId !== hostId || !localAlertText(r.id) || !localAlertText(r.ruleId) || !['opened', 'reopened', 'resolved', 'acknowledged', 'closed'].includes(r.event) || !statuses.includes(r.status)) return []
    return [{ id: String(r.id).slice(0, 240), ruleId: localAlertText(r.ruleId), hostId, event: r.event, at: time(r.at), actor: localAlertText(r.actor), status: r.status, name: localAlertText(r.name), severity: r.severity === 'critical' || r.severity === 'info' ? r.severity : 'warning', ...(localAlertText(r.operationJobId) ? { operationJobId: localAlertText(r.operationJobId) } : {}) }]
  }) : []
  return { version: 1, alerts, evaluations, audit }
}
// Cache holds live sustain timers; persisted loads deliberately reset them.
const liveStates = new Map<string, LocalAlertState>()
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (!event.key) liveStates.clear()
  else if (event.key.startsWith(PREFIX)) liveStates.delete(event.key)
})
export function loadLocalAlertState(vaultId: string | undefined, hostId: string) {
  const key = localOpsStorageKey(vaultId, hostId, 'alerts')
  let state = liveStates.get(key)
  if (!state) { state = parseLocalAlertState(load(key), hostId); liveStates.set(key, state) }
  return state
}
export function clearLocalOpsMemory() { liveStates.clear() }
export function saveLocalAlertState(vaultId: string | undefined, hostId: string, state: LocalAlertState) {
  const key = localOpsStorageKey(vaultId, hostId, 'alerts')
  state = { ...state, alerts: state.alerts.slice(-100), audit: state.audit.slice(-500) }
  liveStates.set(key, state)
  localStorage.setItem(key, JSON.stringify(state))
  void queueLocalOpsDocument(vaultId, hostId, 'alert-state', state)
  notifyLocalOpsChanged()
  return state
}
const dispatchQueues = new Map<string, Promise<void>>()
/** The shared delivery ledger is diagnostics-only; payloads stay in memory.
 * Immutable lifecycle ids prevent repeated/cross-session delivery. */
export async function dispatchLocalAlertNotifications(vaultId: string | undefined, hostId: string, state: LocalAlertState, options: NotificationDispatchOptions = {}) {
  const scope = `local-ops:${encodeURIComponent(vaultId || 'default')}:${encodeURIComponent(hostId)}`
  const previous = dispatchQueues.get(scope) ?? Promise.resolve()
  const work = previous.catch(() => undefined).then(async () => {
    let ledger = loadKomariAlertNotificationState(scope)
    const now = options.now ?? Date.now()
    const policy = options.policy ?? loadNotificationPolicy()
    const latest = new Map<string, LocalAlertAudit>()
    for (const row of state.audit) latest.set(row.ruleId, row)
    for (const row of [...latest.values()].slice(-32)) {
      if (now < row.at || now - row.at > 86_400_000) continue
      const attempts = (ledger.attempts ?? []).filter((a) => a.eventId === row.id)
      const configured = row.event === 'resolved' ? policy.recoveryChannels ?? policy.channels ?? ['local'] : policy.channels ?? ['local']
      const channels = configured.filter((channel) => {
        if (ledger.deliveries.some((d) => d.eventId === row.id && d.channel === channel)) return false
        const old = attempts.filter((a) => a.channel === channel)
        if (old.length === 0) return attempts.length === 0
        const last = old[old.length - 1]
        return old.length < 4 && now - last.attemptedAt >= 60_000 && (last.status === 'failed' || ['system-unavailable', 'system-permission-required', 'system-permission-denied', 'channel-unavailable', 'webhook-not-configured'].includes(last.reason || ''))
      })
      if (!channels.length) continue
      const result = await dispatchNotification(localAlertNotificationEvent(row), { ...options, now, policy: { ...policy, channels, ...(row.event === 'resolved' ? { recoveryChannels: channels } : {}) }, state: ledger, onLocal: options.onLocal ?? emitKomariAlertNotification })
      ledger = result.state
      saveKomariAlertNotificationState(scope, ledger)
    }
    return ledger
  })
  const settled = work.then(() => undefined, () => undefined)
  dispatchQueues.set(scope, settled)
  try { return await work } finally { if (dispatchQueues.get(scope) === settled) dispatchQueues.delete(scope) }
}


registerLocalOpsAdapter('alert-rules', {
  readCache: (vault, host) => load(localOpsStorageKey(vault, host, 'rules')),
  writeCache: (vault, host, payload) => {
    if (!Array.isArray(payload)) throw new Error('LOCAL_OPS_INVALID_RULES')
    const rules = payload.slice(0, 32).map(normalizeLocalAlertRule)
    if (rules.some((rule) => rule.hostId !== host)) throw new Error('LOCAL_OPS_HOST_MISMATCH')
    localStorage.setItem(localOpsStorageKey(vault, host, 'rules'), JSON.stringify(rules)); notifyLocalOpsChanged()
  },
})
registerLocalOpsAdapter('alert-state', {
  readCache: (vault, host) => load(localOpsStorageKey(vault, host, 'alerts')),
  writeCache: (vault, host, payload) => {
    const state = parseLocalAlertState(payload, host)
    const key = localOpsStorageKey(vault, host, 'alerts')
    liveStates.set(key, state); localStorage.setItem(key, JSON.stringify(state)); notifyLocalOpsChanged()
  },
})
