import { groupKomariAlertIncidents } from './komari-alert-incidents'
import {
  dispatchNotification,
  type NotificationDispatchOptions,
  type NotificationDispatchResult,
  type NotificationDispatchState,
  type NotificationAttemptRecord,
  type NotificationPayload,
} from './notification-dispatch'
import { normalizeNotificationDeliveryState, notifyNotificationDeliveryChanged } from './notification-delivery-state'
import { normalizeNotificationPolicy, type NotificationChannel, type NotificationEvent, type NotificationPolicy, type NotificationPolicyInput } from './notification-policy'
import type {
  KomariAlertAuditEntry,
  KomariAlertAuditEvent,
  KomariAlertRecord,
  KomariAlertState,
} from './komari-alerts'

/** Lifecycle events that represent a user-visible state transition. Repeated
 * provider observations (`updated`/`deduplicated`) are intentionally omitted
 * from delivery to keep a noisy integration from becoming a notification
 * stream. */
export const KOMARI_NOTIFICATION_EVENTS: readonly KomariAlertAuditEvent[] = [
  'opened',
  'reopened',
  'resolved',
  'acknowledged',
  'closed',
]

export interface KomariAlertNotificationOptions extends Omit<NotificationDispatchOptions, 'policy' | 'state' | 'now'> {
  policy?: NotificationPolicy | NotificationPolicyInput
  state?: NotificationDispatchState
  now?: number
  /** Audit rows to deliver. Defaults to all rows in `state.audit`. */
  audit?: readonly KomariAlertAuditEntry[]
  /** Bound work performed by one sync; older rows are retained for audit but
   * never replayed as notifications. */
  maxEvents?: number
  /** Retry only durable failed/unavailable attempts for still-current audit rows. */
  retryPending?: boolean
  /** Discover recent unseen lifecycle rows persisted by other sessions/MCP. */
  includeRecent?: boolean
  /** Override the default lifecycle allow-list for a specialised caller. */
  eventTypes?: readonly KomariAlertAuditEvent[]
}

export interface KomariAlertNotificationSummary {
  considered: number
  delivered: number
  skipped: number
  failed: number
  omitted: number
  lastDeliveredAt: number | null
}

export interface KomariAlertNotificationResult {
  events: NotificationDispatchResult[]
  state: NotificationDispatchState
  summary: KomariAlertNotificationSummary
}

const DEFAULT_MAX_EVENTS = 64
const MAX_EVENTS = 256
const MAX_TEXT_LENGTH = 240

export const KOMARI_NOTIFICATION_STATE_STORAGE_PREFIX = 'shellbeam.komariNotificationState.v1'
const RETRY_INTERVAL_MS = 60_000
const RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_CHANNEL_ATTEMPTS = 4
const integrationDispatchQueues = new Map<string, Promise<void>>()

/** Browser event used by the in-app notification surface. Keeping the sink
 * in this module makes recovery notifications identical whether they were
 * emitted by a foreground sync, a cached cross-session hydration, or the
 * alert dashboard action flow. Consumers may subscribe without coupling to
 * Komari persistence or provider credentials. */
export const KOMARI_NOTIFICATION_EVENT = 'shellbeam:notification'

export function emitKomariAlertNotification(payload: NotificationPayload): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(KOMARI_NOTIFICATION_EVENT, { detail: payload }))
}

function storageKey(integrationId: string) {
  const normalized = safeText(integrationId, 'default').toLowerCase().replace(/[^a-z0-9._:-]+/g, '_').slice(0, 160) || 'default'
  return `${KOMARI_NOTIFICATION_STATE_STORAGE_PREFIX}:${normalized}`
}

/** Load only bounded delivery metadata. Notification payloads and webhook
 * credentials are never persisted here. */
export function loadKomariAlertNotificationState(integrationId: string): NotificationDispatchState {
  if (typeof localStorage === 'undefined') return { deliveries: [] }
  try {
    return normalizeNotificationDeliveryState(JSON.parse(localStorage.getItem(storageKey(integrationId)) || 'null'))
  } catch {
    return { deliveries: [] }
  }
}

export function saveKomariAlertNotificationState(integrationId: string, state: NotificationDispatchState): NotificationDispatchState {
  const normalized = normalizeNotificationDeliveryState(state)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(storageKey(integrationId), JSON.stringify(normalized)) } catch { /* storage is optional */ }
  }
  notifyNotificationDeliveryChanged()
  return normalized
}

function safeText(value: unknown, fallback = '') {
  if (typeof value !== 'string') return fallback
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
}

function recordForAudit(state: KomariAlertState, audit: KomariAlertAuditEntry) {
  return state.alerts.find((record) => record.alertId === audit.alertId)
}

function lifecycleMessage(event: KomariAlertAuditEvent, record: KomariAlertRecord) {
  const title = safeText(record.title, `${record.kind} alert`)
  switch (event) {
    case 'opened': return `${title} opened`
    case 'reopened': return `${title} reopened`
    case 'resolved': return `${title} recovered`
    case 'acknowledged': return `${title} acknowledged in ShellBeam (local only)`
    case 'closed': return `${title} closed in ShellBeam (local only)`
    case 'updated': return `${title} updated`
    case 'deduplicated': return `${title} repeated observation`
    case 'operation-linked': return `${title} linked to an operation`
    default: return title
  }
}

/** Convert one local Komari lifecycle row into a safe dispatcher event. The
 * dispatcher performs the final redaction before any sink receives it. */
export function komariAlertNotificationEvent(
  record: KomariAlertRecord,
  audit: KomariAlertAuditEntry,
): NotificationEvent {
  const event = audit.event
  const title = safeText(record.title, `${record.kind} alert`)
  const probeTelemetry = audit.probeTelemetry ?? record.probeTelemetry
  return {
    eventId: safeText(audit.auditId, `${record.alertId}:${event}:${audit.at}`),
    source: 'komari',
    kind: `alert.${event}`,
    severity: record.severity,
    title,
    message: lifecycleMessage(event, record),
    fingerprint: record.fingerprint,
    hostId: safeText(record.hostId) || undefined,
    integrationId: safeText(record.integrationId) || undefined,
    status: audit.status,
    occurredAt: audit.at,
    metadata: {
      alertId: safeText(record.alertId),
      auditId: safeText(audit.auditId),
      alertKind: safeText(record.kind),
      lifecycle: event,
      // A resolved lifecycle row is the durable recovery transition. Keep the
      // canonical kind as alert.resolved for compatibility while exposing an
      // explicit recovery marker to in-app/webhook consumers.
      recovered: event === 'resolved',
      count: record.count,
      relatedOperationJobId: safeText(record.relatedOperationJobId) || undefined,
      // ProbeProvider telemetry is already reduced to counters and an error
      // code in the alert journal. Include that bounded view in every sink so
      // an operator can correlate a Probe failure/recovery with the lifecycle
      // transition without exposing command output or credentials.
      ...(probeTelemetry ? { probeTelemetry } : {}),
    },
  }
}

function boundedMaxEvents(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_EVENTS
  return Math.max(1, Math.min(MAX_EVENTS, Math.floor(value as number)))
}

function uniqueAuditRows(rows: readonly KomariAlertAuditEntry[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = safeText(row.auditId)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isRetryableAttempt(attempt: NotificationAttemptRecord) {
  return attempt.status === 'failed' || (attempt.status === 'skipped' && (
    attempt.reason === 'channel-unavailable'
    || attempt.reason === 'webhook-not-configured'
    || attempt.reason === 'system-unavailable'
    || attempt.reason === 'system-permission-required'
    || attempt.reason === 'system-permission-denied'
  ))
}

/** Only failed attempts establish pending work. Old audit history, policy
 * skips and a newly enabled channel cannot create a backlog by themselves. */
function retryableChannels(audit: KomariAlertAuditEntry, state: NotificationDispatchState, now: number): Set<NotificationChannel> {
  const eventId = safeText(audit.auditId)
  const channels = new Set<NotificationChannel>()
  for (const channel of ['local', 'webhook', 'system'] as const) {
    if (state.deliveries.some((delivery) => delivery.eventId === eventId && delivery.channel === channel)) continue
    const attempts = (state.attempts ?? []).filter((attempt) => attempt.eventId === eventId
      && attempt.channel === channel && (isRetryableAttempt(attempt) || attempt.status === 'delivered'))
    if (attempts.length === 0 || attempts.length >= MAX_CHANNEL_ATTEMPTS) continue
    const firstAt = Math.min(...attempts.map((attempt) => attempt.attemptedAt))
    const lastAt = Math.max(...attempts.map((attempt) => attempt.attemptedAt))
    if (attempts.some((attempt) => attempt.status === 'delivered')
      || now - firstAt > RETRY_MAX_AGE_MS || now - lastAt < RETRY_INTERVAL_MS) continue
    channels.add(channel)
  }
  return channels
}

function latestLifecycleIds(state: KomariAlertState) {
  const latest = new Map<string, KomariAlertAuditEntry>()
  for (const audit of state.audit) {
    if (!KOMARI_NOTIFICATION_EVENTS.includes(audit.event)) continue
    const previous = latest.get(audit.alertId)
    if (!previous || audit.at >= previous.at) latest.set(audit.alertId, audit)
  }
  return new Set([...latest.values()].map((audit) => audit.auditId))
}

/** Dispatch newly reconciled Komari lifecycle rows through the shared local,
 * webhook and system notification policy. A caller can pass only the audit
 * rows produced by the current sync; when omitted, the newest bounded rows
 * from the lifecycle state are used. */
export async function dispatchKomariAlertNotifications(
  state: KomariAlertState,
  options: KomariAlertNotificationOptions = {},
): Promise<KomariAlertNotificationResult> {
  const maxEvents = boundedMaxEvents(options.maxEvents)
  const eventTypes = new Set(options.eventTypes ?? KOMARI_NOTIFICATION_EVENTS)
  const now = options.now ?? Date.now()
  let dispatchState = normalizeNotificationDeliveryState(options.state)
  const sourceRows = options.audit ?? state.audit
  const latestIds = latestLifecycleIds(state)
  // MCP actions persist lifecycle facts without running a frontend sink. Only
  // the latest recent fact can receive its first delivery during a reload;
  // any recorded attempt prevents channel additions from backfilling history.
  const attemptedIds = new Set([
    ...dispatchState.deliveries.map((delivery) => delivery.eventId),
    ...(dispatchState.attempts ?? []).map((attempt) => attempt.eventId),
  ])
  const recentRows = options.includeRecent
    ? state.audit.filter((audit) => latestIds.has(audit.auditId)
      && audit.at >= state.summary.localUpdatedAt
      && now - audit.at >= 0 && now - audit.at <= RETRY_MAX_AGE_MS
      && !attemptedIds.has(safeText(audit.auditId)))
    : []
  const explicitIds = new Set([...sourceRows, ...recentRows].map((audit) => audit.auditId))
  const pendingRows = options.retryPending
    ? state.audit.filter((audit) => latestIds.has(audit.auditId) && retryableChannels(audit, dispatchState, now).size > 0)
    : []
  const incidents = groupKomariAlertIncidents(state.alerts)
  const incidentByMember = new Map(incidents.flatMap((incident) => incident.memberAlertIds.map((id) => [id, incident] as const)))
  const transitionIds = (audit: KomariAlertAuditEntry) => {
    const incident = incidentByMember.get(audit.alertId)
    return new Set(state.audit.filter((row) => row.event === audit.event && row.at === audit.at
      && (incident?.memberAlertIds ?? [audit.alertId]).includes(row.alertId)).map((row) => row.auditId).concat(audit.auditId))
  }
  const groupedRows = new Map<string, KomariAlertAuditEntry>()
  for (const row of uniqueAuditRows([...pendingRows, ...recentRows, ...sourceRows])) {
    const incident = incidentByMember.get(row.alertId)
    const key = JSON.stringify([incident?.alert.alertId ?? row.alertId, row.event, row.at])
    // Reuse an immutable legacy audit ID, including when an action caller only
    // passed its last member row. No synthetic event can replay old delivery.
    const canonical = state.audit.find((candidate) => candidate.alertId === incident?.alert.alertId && candidate.event === row.event && candidate.at === row.at) ?? row
    groupedRows.set(key, canonical)
  }
  const candidateRows = [...groupedRows.values()].sort((left, right) => left.at - right.at)
  const boundedRows = candidateRows.slice(-maxEvents)
  const omitted = Math.max(0, candidateRows.length - boundedRows.length)
  const events: NotificationDispatchResult[] = []
  let delivered = 0
  let skipped = 0
  let alreadyDelivered = 0
  let failed = 0
  let lastDeliveredAt: number | null = null

  const policy = normalizeNotificationPolicy(options.policy)
  // A foreground sync should produce an in-app event even when its caller
  // does not provide a custom sink. Tests, headless MCP callers and native
  // workers can still opt out naturally when `window` is unavailable.
  const onLocal = options.onLocal ?? (typeof window !== 'undefined' ? emitKomariAlertNotification : undefined)
  for (const audit of boundedRows) {
    if (!eventTypes.has(audit.event)) continue
    const incident = incidentByMember.get(audit.alertId)
    const record = incident?.alert ?? recordForAudit(state, audit)
    if (!record) {
      skipped += 1
      continue
    }
    const event = komariAlertNotificationEvent(record, audit)
    if (incident && incident.members.length > 1) event.metadata = { ...event.metadata, memberAlertIds: incident.memberAlertIds }
    const aliases = transitionIds(audit)
    // Keep the payload compact by default, while allowing operators to opt in
    // to the bounded Komari aggregate in webhook/in-app metadata. The summary
    // contains counts and timestamps only; no provider payload is persisted.
    if (policy.includeAlertSummary) {
      event.metadata = {
        ...event.metadata,
        alertSummary: {
          total: state.summary.total,
          active: state.summary.active,
          open: state.summary.open,
          acknowledged: state.summary.acknowledged,
          resolved: state.summary.resolved,
          closed: state.summary.closed,
          updatedAt: state.summary.updatedAt,
        },
      }
    }
    const isRecovery = audit.event === 'resolved'
    if (isRecovery && !policy.notifyOnRecovery) {
      skipped += 1
      continue
    }
    const configuredChannels = isRecovery ? policy.recoveryChannels : policy.channels
    const deliveredChannels = new Set((dispatchState?.deliveries ?? [])
      .filter((delivery) => aliases.has(delivery.eventId ?? ''))
      .map((delivery) => delivery.channel))
    // Audit ids are immutable lifecycle facts. Once every currently enabled
    // channel has accepted one, do not replay an old row after its cooldown
    // expires when a caller passes the persisted full audit history.
    if (configuredChannels.every((channel) => deliveredChannels.has(channel))) {
      alreadyDelivered += 1
      continue
    }
    // Retry only channels that have not accepted this immutable audit row.
    // If a webhook was unavailable after the in-app event was delivered, a
    // later cross-session refresh must not emit the same local alert again
    // just because the global dedupe window has elapsed.
    const retryState = {
      ...dispatchState,
      deliveries: dispatchState.deliveries.map((delivery) => aliases.has(delivery.eventId ?? '') ? { ...delivery, eventId: audit.auditId } : delivery),
      attempts: dispatchState.attempts?.map((attempt) => aliases.has(attempt.eventId ?? '') ? { ...attempt, eventId: audit.auditId } : attempt),
    }
    const retryChannels = retryableChannels(audit, retryState, now)
    const pendingChannels = configuredChannels.filter((channel) => {
      if (deliveredChannels.has(channel)) return false
      const previousFailure = (dispatchState.attempts ?? []).some((attempt) => aliases.has(attempt.eventId ?? '')
        && attempt.channel === channel && isRetryableAttempt(attempt))
      if (previousFailure) return latestIds.has(audit.auditId) && retryChannels.has(channel)
      return [...aliases].some((id) => explicitIds.has(id))
    })
    if (pendingChannels.length === 0) {
      alreadyDelivered += 1
      continue
    }
    const pendingPolicy = pendingChannels.length === configuredChannels.length
      ? { ...policy, channels: configuredChannels, ...(isRecovery ? { recoveryChannels: configuredChannels } : {}) }
      : { ...policy, channels: pendingChannels, ...(isRecovery ? { recoveryChannels: pendingChannels } : {}) }
    const result = await dispatchNotification(
      event,
      {
        ...options,
        onLocal,
        policy: pendingPolicy,
        state: dispatchState,
        now,
      },
    )
    dispatchState = result.state
    events.push(result)
    for (const delivery of result.deliveries) {
      if (delivery.status === 'delivered') {
        delivered += 1
        if (delivery.deliveredAt !== undefined) lastDeliveredAt = Math.max(lastDeliveredAt ?? 0, delivery.deliveredAt)
      } else if (delivery.status === 'failed') {
        failed += 1
      } else {
        skipped += 1
      }
    }
  }

  return {
    events,
    state: dispatchState ?? { deliveries: [] },
    summary: {
      considered: boundedRows.filter((audit) => eventTypes.has(audit.event)).length,
      delivered,
      skipped: skipped + alreadyDelivered,
      failed,
      omitted,
      lastDeliveredAt,
    },
  }
}


/** Dispatch lifecycle rows and persist only the bounded delivery ledger. */
export async function dispatchAndPersistKomariAlertNotifications(
  integrationId: string,
  state: KomariAlertState,
  options: KomariAlertNotificationOptions = {},
): Promise<KomariAlertNotificationResult> {
  const key = storageKey(integrationId)
  const previous = integrationDispatchQueues.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    // Load inside the integration queue so concurrent host/dashboard refreshes
    // see the preceding delivery before deciding which channel to retry.
    const result = await dispatchKomariAlertNotifications(state, {
      ...options,
      state: options.state ?? loadKomariAlertNotificationState(integrationId),
    })
    result.state = saveKomariAlertNotificationState(integrationId, result.state)
    return result
  })
  const settled = operation.then(() => undefined, () => undefined)
  integrationDispatchQueues.set(key, settled)
  try {
    return await operation
  } finally {
    if (integrationDispatchQueues.get(key) === settled) integrationDispatchQueues.delete(key)
  }
}
