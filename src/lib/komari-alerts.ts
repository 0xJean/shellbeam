import { hasOnlyKomariMissingReport } from './komari-first-report'
import { groupKomariAlertIncidents, normalizeKomariAlertIncidents, isUnverifiedKomariRuleAlert } from './komari-alert-incidents'
import type { KomariAlertSummary } from './komari'
import type { ProbeProviderTelemetry, ProbeSnapshot } from './probe-provider'

/** The local lifecycle deliberately stays smaller than a notification system.
 * Komari remains the source of truth for whether a rule is firing; ShellBeam
 * owns acknowledgement, recovery and the audit trail used to connect the
 * notification to an OperationJob. */
export type KomariAlertStatus = 'active' | 'acknowledged' | 'resolved' | 'closed'
export type KomariAlertSeverity = 'info' | 'warning' | 'critical'
export type KomariAlertKind = 'load' | 'offline' | 'unknown' | string
export type KomariAlertAuditEvent =
  | 'opened'
  | 'updated'
  | 'deduplicated'
  | 'acknowledged'
  | 'resolved'
  | 'reopened'
  | 'closed'
  | 'operation-linked'

export interface KomariAlertObservation {
  integrationId: string
  nodeId?: string | null
  hostId?: string | null
  kind: KomariAlertKind
  count: number | null
  active?: number | null
  title?: string | null
  severity?: KomariAlertSeverity
  updatedAt: number
  /** Safe scheduler telemetry attached to ProbeProvider lifecycle rows.  The
   * alert journal stores only bounded counters/codes, never provider output. */
  probeTelemetry?: KomariProbeAlertTelemetry
  /** A dated observation must follow the failure before it can resolve it. */
  recoverySampledAt?: number
}

export interface KomariProbeAlertTelemetry {
  status: ProbeProviderTelemetry['status']
  attempts: number
  maxRetries: number
  durationMs: number
  recovered: boolean
  exhausted: boolean
  lastErrorCode?: string
}

export interface KomariAlertRecord {
  schemaVersion: 1
  evidenceStatus?: 'unverified-rule-count'
  source: 'komari'
  alertId: string
  fingerprint: string
  integrationId: string
  nodeId: string | null
  hostId: string | null
  kind: KomariAlertKind
  title: string
  severity: KomariAlertSeverity
  count: number | null
  status: KomariAlertStatus
  firstSeenAt: number
  lastSeenAt: number
  acknowledgedAt: number | null
  acknowledgedBy: string | null
  resolvedAt: number | null
  closedAt: number | null
  relatedOperationJobId: string | null
  deduplicatedCount: number
  /** Related diagnostics retain their IDs and share one local incident. */
  incidentKey?: string
  /** Latest safe ProbeProvider collection outcome for this lifecycle row. */
  probeTelemetry?: KomariProbeAlertTelemetry
}

export interface KomariAlertAuditEntry {
  auditId: string
  alertId: string
  fingerprint: string
  event: KomariAlertAuditEvent
  status: KomariAlertStatus
  actor: string
  operationJobId: string | null
  at: number
  /** Snapshot of ProbeProvider telemetry at this immutable transition. */
  probeTelemetry?: KomariProbeAlertTelemetry
}

export interface KomariProbeBaseline {
  integrationId: string
  endpoint?: string
  nodeId: string
  hostId: string
  lastHealthySampledAt: number
}

export interface KomariAlertState {
  schemaVersion: 1
  alerts: KomariAlertRecord[]
  audit: KomariAlertAuditEntry[]
  summary: KomariAlertLifecycleSummary
  /** Only real, fresh samples establish this durable per-node/host baseline. */
  probeBaselines?: KomariProbeBaseline[]
}

export interface KomariAlertLifecycleSummary extends KomariAlertSummary {
  /** Open means active or acknowledged in the local lifecycle. */
  open: number
  acknowledged: number
  resolved: number
  closed: number
  deduplicated: number
  localUpdatedAt: number
}

export interface KomariAlertScope {
  integrationId: string
  nodeId?: string | null
  hostId?: string | null
}

export interface ReconcileKomariAlertsOptions {
  now?: number
  actor?: string
  complete?: boolean
  auditLimit?: number
  /** Keep Komari's aggregate counts alongside local lifecycle counters. */
  baseSummary?: KomariAlertSummary | null
}

/** Stable lifecycle kinds emitted for a Komari-linked Probe observation.  The
 * section suffix on `probe-error:*` is part of the fingerprint so a metrics
 * collector failure cannot hide an independent inventory failure. */
export type KomariProbeAlertKind = 'probe-offline' | 'probe-stale' | 'probe-unknown' | `probe-error:${string}`

function required(value: string | null | undefined, field: string): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) throw new Error(`Komari alert ${field} is required`)
  return normalized
}

function safeText(value: string | null | undefined, fallback: string): string {
  const normalized = value === undefined || value === null
    ? undefined
    : [...value.trim()].map((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f ? ' ' : character
    }).join('').replace(/\s+/g, ' ')
  return (normalized || fallback).slice(0, 200)
}

function boundedCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

function boundedInteger(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(10_000_000, Math.floor(number))) : fallback
}

function normalizeProbeTelemetry(value: unknown): KomariProbeAlertTelemetry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<KomariProbeAlertTelemetry>
  if (raw.status !== 'success' && raw.status !== 'recovered' && raw.status !== 'failed') return undefined
  const lastErrorCode = typeof raw.lastErrorCode === 'string'
    ? safeText(raw.lastErrorCode, '').slice(0, 120) || undefined
    : undefined
  return {
    status: raw.status,
    attempts: boundedInteger(raw.attempts),
    maxRetries: boundedInteger(raw.maxRetries),
    durationMs: boundedInteger(raw.durationMs),
    recovered: raw.recovered === true,
    exhausted: raw.exhausted === true,
    ...(lastErrorCode ? { lastErrorCode } : {}),
  }
}

function boundedTime(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? value as number : fallback
}

function severityFor(kind: KomariAlertKind): KomariAlertSeverity {
  return kind === 'offline' ? 'critical' : kind === 'load' ? 'warning' : 'info'
}

/** Stable, non-secret identity used for deduplication. It deliberately does
 * not include a remote message or count, so changing wording/counts updates
 * one alert instead of opening a new alert every sync. */
export function komariAlertFingerprint(input: Pick<KomariAlertObservation, 'integrationId' | 'nodeId' | 'hostId' | 'kind'>): string {
  return [input.integrationId, input.nodeId ?? '', input.hostId ?? '', input.kind]
    .map((value) => value.trim().toLowerCase())
    .join('|')
}

function alertIdFor(fingerprint: string): string {
  // FNV-1a gives a short deterministic identifier while keeping the original
  // fingerprint available for diagnostics and future migrations.
  let hash = 2166136261
  for (const char of fingerprint) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `komari-alert-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function auditIdFor(alertId: string, event: KomariAlertAuditEvent, at: number, index: number): string {
  return `${alertId}:${event}:${at}:${index}`
}

function normalizeObservation(observation: KomariAlertObservation): KomariAlertObservation {
  const integrationId = required(observation.integrationId, 'integration id')
  const kind = required(observation.kind, 'kind')
  const probeTelemetry = normalizeProbeTelemetry(observation.probeTelemetry)
  return {
    ...observation,
    integrationId,
    nodeId: observation.nodeId?.trim() || null,
    hostId: observation.hostId?.trim() || null,
    kind,
    count: boundedCount(observation.count),
    active: boundedCount(observation.active),
    title: safeText(observation.title, `${kind} alert`),
    severity: observation.severity ?? severityFor(kind),
    updatedAt: boundedTime(observation.updatedAt, Date.now()),
    ...(probeTelemetry ? { probeTelemetry } : {}),
  }
}

function newRecord(observation: KomariAlertObservation, now: number): KomariAlertRecord {
  const normalized = normalizeObservation(observation)
  const fingerprint = komariAlertFingerprint(normalized)
  return {
    schemaVersion: 1,
    source: 'komari',
    alertId: alertIdFor(fingerprint),
    fingerprint,
    integrationId: normalized.integrationId,
    nodeId: normalized.nodeId ?? null,
    hostId: normalized.hostId ?? null,
    kind: normalized.kind,
    title: normalized.title ?? `${normalized.kind} alert`,
    severity: normalized.severity ?? severityFor(normalized.kind),
    count: normalized.count,
    status: 'active',
    firstSeenAt: now,
    lastSeenAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    closedAt: null,
    relatedOperationJobId: null,
    deduplicatedCount: 0,
    ...(normalized.probeTelemetry ? { probeTelemetry: normalized.probeTelemetry } : {}),
  }
}

function auditFor(
  record: KomariAlertRecord,
  event: KomariAlertAuditEvent,
  now: number,
  actor: string,
  operationJobId: string | null,
  index = 0,
  probeTelemetry = record.probeTelemetry,
): KomariAlertAuditEntry {
  return {
    auditId: auditIdFor(record.alertId, event, now, index),
    alertId: record.alertId,
    fingerprint: record.fingerprint,
    event,
    status: record.status,
    actor: safeText(actor, 'local-user'),
    operationJobId,
    at: now,
    ...(probeTelemetry ? { probeTelemetry } : {}),
  }
}

/** Notification collections are configuration statistics. Even an aggregate
 * active count has no stable event identity, host or recovery timestamp. */
export function komariAlertObservationsFromSummary(
  _summary: KomariAlertSummary | null | undefined,
  _scope: KomariAlertScope,
): KomariAlertObservation[] {
  void _summary; void _scope // Keep the read API compatible; rule counts cannot identify incidents.
  return []
}

/** One source failure becomes one incident. Unknown health and scheduler retry
 * exhaustion are diagnostics of that failure, not separate notifications.
 * A newly installed node with no reports waits for its first sample. */
export function komariAlertObservationsFromProbeSnapshot(
  snapshot: Pick<ProbeSnapshot, 'provider' | 'host' | 'health' | 'receivedAt' | 'metrics' | 'inventory' | 'errors' | 'telemetry'>,
  scope: KomariAlertScope,
  now = Date.now(),
  lastHealthySampledAt?: number,
): KomariAlertObservation[] {
  const integrationId = required(scope.integrationId, 'integration id')
  const nodeId = snapshot.provider.nodeId?.trim() || scope.nodeId?.trim() || null
  const hostId = snapshot.host.hostId?.trim() || scope.hostId?.trim() || null
  const updatedAt = boundedTime(snapshot.receivedAt, now)
  const observations: KomariAlertObservation[] = []
  const probeTelemetry = normalizeProbeTelemetry(snapshot.telemetry)
  const add = (kind: KomariProbeAlertKind, count: number, title: string, severity: KomariAlertSeverity, recoverySampledAt?: number) => observations.push({
    integrationId, nodeId, hostId, kind, count, active: count > 0 ? 1 : 0,
    title, severity, updatedAt,
    ...(probeTelemetry ? { probeTelemetry } : {}),
    ...(recoverySampledAt === undefined ? {} : { recoverySampledAt }),
  })
  const actualErrors = snapshot.errors.filter((error) => error.code !== 'recovery-retry-exhausted' && error.code !== 'stale-cache-fallback')
  const metricError = actualErrors.find((error) => error.section === 'metrics')
  const metric = snapshot.metrics
  const metricExpired = Boolean(metric && (metric.freshness.expired || now > metric.freshness.expiresAt))
  const freshMetric = metric && !metricExpired && snapshot.health === 'online'
    && !snapshot.errors.some((error) => error.section === 'metrics' || error.section === 'provider')
    && Number.isFinite(metric.freshness.sampledAt) && metric.freshness.sampledAt > 0 && metric.freshness.sampledAt <= now
  const waiting = !lastHealthySampledAt && hasOnlyKomariMissingReport(snapshot)
  if (snapshot.health === 'offline') {
    add('probe-error:metrics', 1, 'Komari monitoring source is offline', 'critical')
  } else if (metricError && !waiting) {
    add('probe-error:metrics', 1, `Komari Probe metrics error: ${safeText(metricError.message, 'collection failed')}`, 'warning')
  } else if (snapshot.health === 'stale' || metricExpired) {
    add('probe-error:metrics', 1, 'Komari monitoring data is stale', 'warning')
  } else if (!metric && lastHealthySampledAt && !actualErrors.length) {
    add('probe-error:metrics', 1, 'Komari returned no dated metric observations', 'warning')
  }
  // Independent inventory/provider faults remain independent incidents. The
  // scheduler's exhausted retry marker has already been removed above.
  for (const section of ['provider', 'inventory'] as const) {
    const error = actualErrors.find((candidate) => candidate.section === section)
    if (error) add(`probe-error:${section}`, 1, `Komari Probe ${section} error: ${safeText(error.message, 'collection failed')}`, section === 'provider' ? 'critical' : 'warning')
  }
  if (freshMetric) {
    for (const kind of ['probe-offline', 'probe-stale', 'probe-unknown', 'probe-error:provider', 'probe-error:metrics'] as const) {
      add(kind, 0, 'Komari monitoring data recovered', 'warning', metric.freshness.sampledAt)
    }
  }
  const inventory = snapshot.inventory
  if (inventory && !inventory.freshness.expired && now <= inventory.freshness.expiresAt
    && !snapshot.errors.some((error) => error.section === 'inventory' || error.section === 'provider')) {
    add('probe-error:inventory', 0, 'Komari inventory recovered', 'warning', inventory.freshness.sampledAt)
  }
  return observations
}

/** Merge a sync result into the local lifecycle. Duplicate observations in a
 * single response are coalesced; acknowledged alerts stay acknowledged until
 * Komari reports recovery, and a recovered alert is retained for audit. */
export function reconcileKomariAlerts(
  existing: KomariAlertRecord[] = [],
  observations: KomariAlertObservation[],
  options: ReconcileKomariAlertsOptions = {},
): { alerts: KomariAlertRecord[]; audit: KomariAlertAuditEntry[]; summary: KomariAlertLifecycleSummary } {
  const now = options.now ?? Date.now()
  const actor = options.actor ?? 'komari-sync'
  const byFingerprint = new Map<string, KomariAlertObservation>()
  const duplicateCounts = new Map<string, number>()
  for (const raw of observations) {
    if (isUnverifiedKomariRuleAlert(raw)) continue
    const observation = normalizeObservation(raw)
    const fingerprint = komariAlertFingerprint(observation)
    const previous = byFingerprint.get(fingerprint)
    if (previous) {
      duplicateCounts.set(fingerprint, (duplicateCounts.get(fingerprint) ?? 0) + 1)
      byFingerprint.set(fingerprint, {
        ...previous,
        count: Math.max(previous.count ?? 0, observation.count ?? 0),
        active: Math.max(previous.active ?? 0, observation.active ?? 0),
        updatedAt: Math.max(previous.updatedAt, observation.updatedAt),
        ...(observation.probeTelemetry ? { probeTelemetry: observation.probeTelemetry } : {}),
      })
    } else {
      byFingerprint.set(fingerprint, observation)
    }
  }

  const alerts = normalizeKomariAlertIncidents(existing)
  const audit: KomariAlertAuditEntry[] = []
  const seen = new Set<string>()
  for (const [fingerprint, observation] of byFingerprint) {
    seen.add(fingerprint)
    const duplicateCount = duplicateCounts.get(fingerprint) ?? 0
    let record = alerts.find((candidate) => candidate.fingerprint === fingerprint)
    if (!record) {
      if ((observation.count ?? 0) <= 0) continue
      record = newRecord(observation, now)
      alerts.push(record)
      audit.push(auditFor(record, 'opened', now, actor, null, audit.length))
    } else {
      // Cached/missing data cannot resolve an incident opened by a newer
      // failure. The healthy sample must be newer than that failure evidence.
      if ((observation.count ?? 0) <= 0 && record.kind.startsWith('probe-')
        && (observation.recoverySampledAt === undefined || observation.recoverySampledAt <= record.lastSeenAt)) continue
      const wasClosed = record.status === 'closed' || record.status === 'resolved'
      const hasSignal = (observation.count ?? 0) > 0
      const countChanged = record.count !== observation.count
      const titleChanged = observation.title !== null && observation.title !== record.title
      record.count = observation.count
      if (hasSignal) {
        record.title = observation.title ?? record.title
        record.severity = observation.severity ?? record.severity
      }
      if (observation.probeTelemetry) record.probeTelemetry = observation.probeTelemetry
      record.lastSeenAt = Math.max(record.lastSeenAt, now)
      if (hasSignal && wasClosed) {
        record.status = 'active'
        record.resolvedAt = null
        record.closedAt = null
        record.acknowledgedAt = null
        record.acknowledgedBy = null
        audit.push(auditFor(record, 'reopened', now, actor, record.relatedOperationJobId, audit.length))
      } else if (!hasSignal && (record.status === 'active' || record.status === 'acknowledged')) {
        record.status = 'resolved'
        record.resolvedAt = now
        audit.push(auditFor(record, 'resolved', now, actor, record.relatedOperationJobId, audit.length))
      } else if (hasSignal && (countChanged || titleChanged)) {
        audit.push(auditFor(record, 'updated', now, actor, record.relatedOperationJobId, audit.length))
      }
    }
    if (record && duplicateCount > 0) {
      record.deduplicatedCount += duplicateCount
      audit.push(auditFor(record, 'deduplicated', now, actor, record.relatedOperationJobId, audit.length))
    }
  }

  if (options.complete) {
    for (const record of alerts) {
      if (isUnverifiedKomariRuleAlert(record) || record.kind.startsWith('probe-') || seen.has(record.fingerprint) || record.status === 'resolved' || record.status === 'closed') continue
      record.status = 'resolved'
      record.resolvedAt = now
      audit.push(auditFor(record, 'resolved', now, actor, record.relatedOperationJobId, audit.length))
    }
  }

  const mergedAudit = [...audit].slice(-Math.max(1, options.auditLimit ?? 500))
  const normalizedAlerts = normalizeKomariAlertIncidents(alerts)
  return { alerts: normalizedAlerts, audit: mergedAudit, summary: summarizeKomariAlertState(normalizedAlerts, now, options.baseSummary) }
}

export function acknowledgeKomariAlert(
  alert: KomariAlertRecord,
  actor = 'local-user',
  now = Date.now(),
): { alert: KomariAlertRecord; audit: KomariAlertAuditEntry } {
  if (alert.status !== 'active') return { alert: { ...alert }, audit: auditFor(alert, 'acknowledged', now, actor, alert.relatedOperationJobId) }
  const next = { ...alert, status: 'acknowledged' as const, acknowledgedAt: now, acknowledgedBy: safeText(actor, 'local-user') }
  return { alert: next, audit: auditFor(next, 'acknowledged', now, actor, next.relatedOperationJobId) }
}

export function closeKomariAlert(
  alert: KomariAlertRecord,
  actor = 'local-user',
  now = Date.now(),
): { alert: KomariAlertRecord; audit: KomariAlertAuditEntry } {
  const next = { ...alert, status: 'closed' as const, closedAt: now }
  return { alert: next, audit: auditFor(next, 'closed', now, actor, next.relatedOperationJobId) }
}

export function linkKomariAlertOperation(
  alert: KomariAlertRecord,
  operationJobId: string,
  actor = 'local-user',
  now = Date.now(),
): { alert: KomariAlertRecord; audit: KomariAlertAuditEntry } {
  const id = required(operationJobId, 'operation job id')
  const next = { ...alert, relatedOperationJobId: id }
  return { alert: next, audit: auditFor(next, 'operation-linked', now, actor, id) }
}

export function summarizeKomariAlertState(
  alerts: KomariAlertRecord[],
  now = Date.now(),
  baseSummary?: KomariAlertSummary | null,
): KomariAlertLifecycleSummary {
  const incidents = groupKomariAlertIncidents(alerts).map((incident) => incident.alert).filter(alert => !isUnverifiedKomariRuleAlert(alert))
  const acknowledged = incidents.filter((alert) => alert.status === 'acknowledged').length
  const active = incidents.filter((alert) => alert.status === 'active').length
  const resolved = incidents.filter((alert) => alert.status === 'resolved').length
  const closed = incidents.filter((alert) => alert.status === 'closed').length
  const total = incidents.length
  const deduplicated = alerts.reduce((sum, alert) => sum + alert.deduplicatedCount, 0)
  return {
    load: baseSummary?.load ?? null,
    offline: baseSummary?.offline ?? null,
    total,
    active,
    open: active + acknowledged,
    acknowledged,
    resolved,
    closed,
    deduplicated,
    localUpdatedAt: now,
    updatedAt: baseSummary?.updatedAt ?? now,
  }
}

export function toKomariAlertStatePayload(state: KomariAlertState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    alerts: state.alerts,
    audit: state.audit,
    summary: state.summary,
    ...(state.probeBaselines ? { probeBaselines: state.probeBaselines } : {}),
  }
}

/** Parse the JSON object held in komari_sync_state.alertSummary. Invalid or
 * legacy count-only summaries are ignored so stale input cannot create local
 * lifecycle records. */
export function parseKomariAlertState(value: unknown): KomariAlertState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.alerts) || !Array.isArray(raw.audit)) return null
  const alerts = raw.alerts.flatMap((item): KomariAlertRecord[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (record.schemaVersion !== 1 || record.source !== 'komari' || typeof record.alertId !== 'string'
      || typeof record.fingerprint !== 'string' || typeof record.integrationId !== 'string'
      || !['active', 'acknowledged', 'resolved', 'closed'].includes(String(record.status))) return []
    const telemetry = normalizeProbeTelemetry(record.probeTelemetry)
    const sanitizedRecord = { ...record } as unknown as KomariAlertRecord
    delete sanitizedRecord.probeTelemetry
    return [{ ...sanitizedRecord, ...(telemetry ? { probeTelemetry: telemetry } : {}) }]
  }).slice(-500)
  const audit = raw.audit.flatMap((item): KomariAlertAuditEntry[] => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    if (typeof entry.auditId !== 'string' || typeof entry.alertId !== 'string'
      || typeof entry.fingerprint !== 'string' || typeof entry.event !== 'string') return []
    const telemetry = normalizeProbeTelemetry(entry.probeTelemetry)
    const sanitizedEntry = { ...entry } as unknown as KomariAlertAuditEntry
    delete sanitizedEntry.probeTelemetry
    return [{ ...sanitizedEntry, ...(telemetry ? { probeTelemetry: telemetry } : {}) }]
  }).slice(-1000)
  const summary = raw.summary && typeof raw.summary === 'object'
    ? raw.summary as KomariAlertLifecycleSummary
    : summarizeKomariAlertState(alerts)
  const probeBaselines = Array.isArray(raw.probeBaselines) ? raw.probeBaselines.flatMap((value): KomariProbeBaseline[] => {
    if (!value || typeof value !== 'object') return []
    const row = value as Partial<KomariProbeBaseline>
    if (typeof row.integrationId !== 'string' || typeof row.nodeId !== 'string' || typeof row.hostId !== 'string'
      || !Number.isFinite(row.lastHealthySampledAt) || (row.lastHealthySampledAt ?? 0) <= 0) return []
    return [{ integrationId: row.integrationId, nodeId: row.nodeId, hostId: row.hostId, lastHealthySampledAt: row.lastHealthySampledAt!, ...(typeof row.endpoint === 'string' && row.endpoint ? { endpoint: row.endpoint } : {}) }]
  }).slice(-500) : undefined
  const normalized = normalizeKomariAlertIncidents(alerts)
  return { schemaVersion: 1, alerts: normalized, audit, summary: summarizeKomariAlertState(normalized, summary.localUpdatedAt, summary), ...(probeBaselines ? { probeBaselines } : {}) }
}
