import type { KomariAlertSummary } from './komari'
import type { ProbeSnapshot } from './probe-provider'

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
}

export interface KomariAlertRecord {
  schemaVersion: 1
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
}

export interface KomariAlertState {
  schemaVersion: 1
  alerts: KomariAlertRecord[]
  audit: KomariAlertAuditEntry[]
  summary: KomariAlertLifecycleSummary
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
  const normalized = value?.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
  return (normalized || fallback).slice(0, 200)
}

function boundedCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
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
  }
}

function auditFor(record: KomariAlertRecord, event: KomariAlertAuditEvent, now: number, actor: string, operationJobId: string | null, index = 0): KomariAlertAuditEntry {
  return {
    auditId: auditIdFor(record.alertId, event, now, index),
    alertId: record.alertId,
    fingerprint: record.fingerprint,
    event,
    status: record.status,
    actor: safeText(actor, 'local-user'),
    operationJobId,
    at: now,
  }
}

/** Convert Komari's aggregate notification response to stable local alert
 * observations. Zero values are retained so a later sync can resolve an open
 * alert; unsupported/null values are omitted because they cannot prove a
 * recovery. */
export function komariAlertObservationsFromSummary(
  summary: KomariAlertSummary | null | undefined,
  scope: KomariAlertScope,
): KomariAlertObservation[] {
  if (!summary || summary.unsupported) return []
  const updatedAt = summary.updatedAt
  return (['load', 'offline'] as const)
    .map((kind) => ({
      integrationId: required(scope.integrationId, 'integration id'),
      nodeId: scope.nodeId ?? null,
      hostId: scope.hostId ?? null,
      kind,
      count: boundedCount(summary[kind]),
      active: summary.active,
      severity: severityFor(kind),
      title: kind === 'offline' ? 'Komari offline notifications' : 'Komari load notifications',
      updatedAt,
    }))
    .filter((observation) => observation.count !== null)
}

/**
 * Turn a ProbeProvider result into local Komari lifecycle observations.  This
 * deliberately emits zero-valued recovery observations for every known kind:
 * the next healthy sample can resolve a prior alert even when the provider's
 * error list is empty.  It never treats a missing section as healthy data;
 * freshness and explicit provider errors remain separate lifecycle signals.
 */
export function komariAlertObservationsFromProbeSnapshot(
  snapshot: Pick<ProbeSnapshot, 'provider' | 'host' | 'health' | 'receivedAt' | 'metrics' | 'inventory' | 'errors'>,
  scope: KomariAlertScope,
  now = Date.now(),
): KomariAlertObservation[] {
  const integrationId = required(scope.integrationId, 'integration id')
  const nodeId = snapshot.provider.nodeId?.trim() || scope.nodeId?.trim() || null
  const hostId = snapshot.host.hostId?.trim() || scope.hostId?.trim() || null
  const updatedAt = boundedTime(snapshot.receivedAt, now)
  const observations: KomariAlertObservation[] = []
  const add = (
    kind: KomariProbeAlertKind,
    count: number,
    title: string,
    severity: KomariAlertSeverity,
  ) => observations.push({
    integrationId,
    nodeId,
    hostId,
    kind,
    count,
    active: count > 0 ? 1 : 0,
    title,
    severity,
    updatedAt,
  })

  const metricExpired = Boolean(snapshot.metrics && (snapshot.metrics.freshness.expired || now > snapshot.metrics.freshness.expiresAt))
  const inventoryExpired = Boolean(snapshot.inventory && (snapshot.inventory.freshness.expired || now > snapshot.inventory.freshness.expiresAt))
  const stale = snapshot.health === 'stale' || metricExpired || inventoryExpired
  const offline = snapshot.health === 'offline'
  const unknown = snapshot.health === 'unknown'
  add('probe-offline', offline ? 1 : 0, 'Komari Probe offline', 'critical')
  add('probe-stale', stale && !offline ? 1 : 0, 'Komari Probe data is stale', 'warning')
  add('probe-unknown', unknown ? 1 : 0, 'Komari Probe health is unknown', 'warning')

  const errorSections = new Set(snapshot.errors.map((error) => error.section))
  // Emit recovery rows for the known sections as well as current errors. This
  // keeps a transient error from becoming a permanently open local alert.
  for (const section of new Set(['provider', 'metrics', 'inventory', ...errorSections])) {
    const kind = `probe-error:${section}` as KomariProbeAlertKind
    const error = snapshot.errors.find((candidate) => candidate.section === section)
    add(
      kind,
      error ? 1 : 0,
      error ? `Komari Probe ${section} error: ${safeText(error.message, 'collection failed')}` : `Komari Probe ${section} recovered`,
      section === 'provider' ? 'critical' : 'warning',
    )
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
      })
    } else {
      byFingerprint.set(fingerprint, observation)
    }
  }

  const alerts = existing.map((record) => ({ ...record }))
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
      const wasClosed = record.status === 'closed' || record.status === 'resolved'
      const hasSignal = (observation.count ?? 0) > 0
      const countChanged = record.count !== observation.count
      const titleChanged = observation.title !== null && observation.title !== record.title
      record.count = observation.count
      record.title = observation.title ?? record.title
      record.severity = observation.severity ?? record.severity
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
      if (seen.has(record.fingerprint) || record.status === 'resolved' || record.status === 'closed') continue
      record.status = 'resolved'
      record.resolvedAt = now
      audit.push(auditFor(record, 'resolved', now, actor, record.relatedOperationJobId, audit.length))
    }
  }

  const mergedAudit = [...audit].slice(-Math.max(1, options.auditLimit ?? 500))
  return { alerts, audit: mergedAudit, summary: summarizeKomariAlertState(alerts, now, options.baseSummary) }
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
  const acknowledged = alerts.filter((alert) => alert.status === 'acknowledged').length
  const active = alerts.filter((alert) => alert.status === 'active').length
  const resolved = alerts.filter((alert) => alert.status === 'resolved').length
  const closed = alerts.filter((alert) => alert.status === 'closed').length
  const total = baseSummary?.total ?? alerts.reduce((sum, alert) => sum + (alert.count ?? 0), 0)
  const deduplicated = alerts.reduce((sum, alert) => sum + alert.deduplicatedCount, 0)
  return {
    load: baseSummary?.load ?? null,
    offline: baseSummary?.offline ?? null,
    total,
    active: baseSummary?.active ?? active,
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
  }
}

/** Parse the JSON object held in komari_sync_state.alertSummary. Invalid or
 * legacy count-only summaries are ignored so stale input cannot create local
 * lifecycle records. */
export function parseKomariAlertState(value: unknown): KomariAlertState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.alerts) || !Array.isArray(raw.audit)) return null
  const alerts = raw.alerts.filter((item): item is KomariAlertRecord => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return record.schemaVersion === 1 && record.source === 'komari' && typeof record.alertId === 'string'
      && typeof record.fingerprint === 'string' && typeof record.integrationId === 'string'
      && ['active', 'acknowledged', 'resolved', 'closed'].includes(String(record.status))
  }).slice(-500)
  const audit = raw.audit.filter((item): item is KomariAlertAuditEntry => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Record<string, unknown>
    return typeof entry.auditId === 'string' && typeof entry.alertId === 'string'
      && typeof entry.fingerprint === 'string' && typeof entry.event === 'string'
  }).slice(-1000)
  const summary = raw.summary && typeof raw.summary === 'object'
    ? raw.summary as KomariAlertLifecycleSummary
    : summarizeKomariAlertState(alerts)
  return { schemaVersion: 1, alerts, audit, summary }
}
