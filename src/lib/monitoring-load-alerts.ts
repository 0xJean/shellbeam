import { normalizeKomariEndpoint, requestKomari, type KomariClient, type KomariConnectionConfig, type KomariFetch } from './komari'
import { summarizeKomariAlertState, type KomariAlertAuditEntry, type KomariAlertRecord, type KomariAlertState } from './komari-alerts'
import type { HostProfile } from './hosts'
import type { KomariHostMapping } from './komari-mapping'
import { isHistoricalLoadEvidence, type MonitoringLoadEvidence } from './monitoring-load-evidence'
import type { LoadRule } from './monitoring-policy'

interface LoadRead { identity: string; rules: LoadRule[]; evaluations: Record<string, unknown> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) && !['__proto__', 'prototype', 'constructor'].includes(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 120 && [...v].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
function rule(v: unknown): v is LoadRule {
  if (!object(v)) return false
  return id(v.id) && text(v.name) && id(v.nodeId) && text(v.nodeCreatedAt)
    && ['cpu', 'memory', 'disk', 'load1'].includes(String(v.metric)) && typeof v.enabled === 'boolean'
    && typeof v.threshold === 'number' && Number.isFinite(v.threshold) && v.threshold > 0 && v.threshold <= (v.metric === 'load1' ? 100000 : 100)
    && typeof v.recovery === 'number' && Number.isFinite(v.recovery) && v.recovery >= 0 && v.recovery < v.threshold
    && [v.durationSeconds, v.recoverySeconds].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 86400)
}
/** Three bounded GETs establish a consistent policy/status revision. Absence,
 * permission errors, HTML fallbacks and a concurrent edit are not recovery. */
export async function readMonitoringLoad(config: KomariConnectionConfig, fetchImpl?: KomariFetch): Promise<LoadRead | null> {
  try {
    const before = await requestKomari(config, { path: '/api/shellbeam-alerts/v1/policy' }, fetchImpl)
    if (!object(before) || typeof before.extension_identity !== 'string' || !/^[a-f0-9]{48}$/.test(before.extension_identity)
      || !Number.isSafeInteger(before.revision) || Number(before.revision) < 1 || !Array.isArray(before.rules) || before.rules.length > 64
      || !before.rules.every(rule) || new Set(before.rules.map(r => r.id)).size !== before.rules.length) return null
    const status = await requestKomari(config, { path: '/api/shellbeam-alerts/v1/status' }, fetchImpl)
    if (!object(status) || status.scope !== 'extension-load-notifications' || status.revision !== before.revision || !object(status.evaluations)) return null
    const after = await requestKomari(config, { path: '/api/shellbeam-alerts/v1/policy' }, fetchImpl)
    if (!object(after) || after.extension_identity !== before.extension_identity || after.revision !== before.revision
      || JSON.stringify(after.rules) !== JSON.stringify(before.rules)) return null
    return { identity: before.extension_identity, rules: before.rules, evaluations: status.evaluations }
  } catch { return null }
}
async function identity(parts: unknown[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(parts))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

/** Project current evaluator facts, not rule counts or unscoped historical
 * delivery rows. Existing local handling and immutable audit IDs survive. */
export async function reconcileMonitoringLoad(options: {
  integrationId: string; endpoint: string; hosts: HostProfile[]; clients: KomariClient[]; mappings: KomariHostMapping[]
  state: KomariAlertState; read: LoadRead | null; now: number
}): Promise<{ state: KomariAlertState; audit: KomariAlertAuditEntry[] }> {
  const { integrationId, now, read } = options
  const endpoint = normalizeKomariEndpoint(options.endpoint)
  const alerts = options.state.alerts.map(row => ({ ...row, ...(row.loadEvidence ? { loadEvidence: { ...row.loadEvidence } } : {}) }))
  const audit: KomariAlertAuditEntry[] = []
  const seen = new Set<string>()
  function transition(row: KomariAlertRecord, event: KomariAlertAuditEntry['event']) {
    audit.push({ auditId: `${row.alertId}:${event}:${row.loadEvidence!.sampledAt}:${now}`, alertId: row.alertId,
      fingerprint: row.fingerprint, event, status: row.status, actor: 'monitoring-load-sync', operationJobId: row.relatedOperationJobId, at: now })
  }
  for (const r of read?.rules ?? []) {
    const nodes = options.clients.filter(n => n.uuid === r.nodeId && n.raw.created_at === r.nodeCreatedAt)
    if (nodes.length !== 1) continue
    const links = options.mappings.filter(m => m.nodeId === r.nodeId)
    // Ambiguous mappings never attach a server event to an arbitrary connection.
    if (links.length !== 1) continue
    const host = options.hosts.find(h => h.id === links[0].hostId)
    if (!host || !Number.isFinite(host.createdAt)) continue
    const key = await identity([integrationId, endpoint, read!.identity, r.nodeId, r.nodeCreatedAt, host.id, host.createdAt,
      r.id, r.metric, r.threshold, r.recovery, r.durationSeconds, r.recoverySeconds])
    const fingerprint = `monitoring-load:${key}`
    seen.add(fingerprint)
    const prior = alerts.find(a => a.fingerprint === fingerprint && a.loadEvidence)
    const raw = Object.hasOwn(read!.evaluations, r.id) ? read!.evaluations[r.id] : null
    const e = object(raw) ? raw : {}
    const sampledAt = typeof e.sampledAt === 'number' && Number.isSafeInteger(e.sampledAt) && e.sampledAt > 0 && e.sampledAt <= now ? e.sampledAt : 0
    const valid = sampledAt > 0 && now - sampledAt <= 180000 && typeof e.firing === 'boolean' && typeof e.value === 'number'
      && Number.isFinite(e.value) && e.value >= 0 && (r.metric === 'load1' || e.value <= 100)
      && (e.firing ? ['firing', 'silenced'].includes(String(e.status)) : ['healthy', 'pending'].includes(String(e.status)))
    // Missing, regressing or stale evidence may not open or recover an event.
    const newer = valid && (!prior || sampledAt > prior.loadEvidence!.sampledAt)
    const fact = !r.enabled ? 'disabled' : !valid ? 'unknown' : e.firing ? 'firing' : e.status === 'healthy' ? 'healthy' : 'pending'
    const evidence: MonitoringLoadEvidence = {
      endpoint, extensionIdentity: read!.identity, ruleId: r.id, nodeCreatedAt: r.nodeCreatedAt, hostCreatedAt: host.createdAt,
      metric: r.metric, sampledAt: prior && !newer ? prior.loadEvidence!.sampledAt : sampledAt, observedAt: now, state: fact,
      notification: e.status === 'silenced' ? 'silenced' : e.suppressionRecorded === 'channel-disabled' ? 'channel-disabled' : 'server-managed',
      value: valid ? e.value as number : null,
    }
    if (!prior) {
      if (!r.enabled || !valid || !e.firing) continue
      const row: KomariAlertRecord = { schemaVersion: 1, source: 'komari', alertId: fingerprint, fingerprint, integrationId,
        nodeId: r.nodeId, hostId: host.id, kind: 'server-load', title: r.name, severity: 'warning', count: 1, status: 'active',
        firstSeenAt: sampledAt, lastSeenAt: sampledAt, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null,
        closedAt: null, relatedOperationJobId: null, deduplicatedCount: 0, loadEvidence: evidence }
      alerts.push(row); transition(row, 'opened'); continue
    }
    if (prior.loadEvidence!.observedAt > now || (valid && (sampledAt < prior.loadEvidence!.sampledAt
      || (sampledAt === prior.loadEvidence!.sampledAt && Number(e.firing) !== prior.count)))) continue
    prior.loadEvidence = evidence
    prior.title = r.name
    if (!newer || !r.enabled || fact === 'pending') continue
    const wasFiring = prior.count === 1
    prior.lastSeenAt = sampledAt
    prior.count = e.firing ? 1 : 0
    if (!e.firing) {
      prior.resolvedAt = sampledAt
      if (prior.status !== 'closed' && prior.status !== 'resolved') { prior.status = 'resolved'; transition(prior, 'resolved') }
      else if (wasFiring) transition(prior, 'resolved') // Archived handling remains archived; recovery is a separate fact.
    } else if (!wasFiring) {
      prior.status = 'active'; prior.resolvedAt = prior.closedAt = prior.acknowledgedAt = null; prior.acknowledgedBy = null
      transition(prior, 'reopened')
    }
  }
  for (const row of alerts) {
    if (row.integrationId !== integrationId || !row.loadEvidence || seen.has(row.fingerprint) || row.loadEvidence.observedAt > now) continue
    // A failed read cannot reactivate disabled/retired rules from history.
    if (!read && isHistoricalLoadEvidence(row.loadEvidence)) continue
    row.loadEvidence = { ...row.loadEvidence, state: read ? 'retired' : 'unavailable', observedAt: now }
  }
  return { state: { ...options.state, alerts, audit: [...options.state.audit, ...audit].slice(-1000),
    summary: summarizeKomariAlertState(alerts, now, options.state.summary) }, audit }
}
