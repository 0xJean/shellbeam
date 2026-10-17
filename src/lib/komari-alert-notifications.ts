import {
  dispatchNotification,
  type NotificationDispatchOptions,
  type NotificationDispatchResult,
  type NotificationDispatchState,
  type NotificationDeliveryRecord,
  type NotificationPayload,
} from './notification-dispatch'
import { normalizeNotificationPolicy, type NotificationEvent, type NotificationPolicy, type NotificationPolicyInput } from './notification-policy'
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
const MAX_STORED_DELIVERIES = 1_000

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

function normalizeDeliveryState(value: unknown): NotificationDispatchState {
  const raw = value && typeof value === 'object' ? value as { deliveries?: unknown } : {}
  const deliveries = Array.isArray(raw.deliveries) ? raw.deliveries : []
  return {
    deliveries: deliveries.flatMap((item): NotificationDeliveryRecord[] => {
      if (!item || typeof item !== 'object') return []
      const row = item as Partial<NotificationDeliveryRecord>
      if (typeof row.key !== 'string' || typeof row.fingerprint !== 'string' || typeof row.eventKey !== 'string') return []
      if (row.channel !== 'local' && row.channel !== 'webhook' && row.channel !== 'system') return []
      if (!Number.isFinite(row.deliveredAt)) return []
      return [{
        key: safeText(row.key, '').slice(0, 600),
        fingerprint: safeText(row.fingerprint, '').slice(0, 512),
        eventKey: safeText(row.eventKey, '').slice(0, 1024),
        eventId: typeof row.eventId === 'string' ? safeText(row.eventId, '').slice(0, 240) || null : null,
        status: typeof row.status === 'string' ? safeText(row.status, '').slice(0, 96) || null : null,
        channel: row.channel,
        deliveredAt: Number(row.deliveredAt),
      }]
    }).filter((row) => row.key && row.fingerprint && row.eventKey).slice(-MAX_STORED_DELIVERIES),
  }
}

/** Load only bounded delivery metadata. Notification payloads and webhook
 * credentials are never persisted here. */
export function loadKomariAlertNotificationState(integrationId: string): NotificationDispatchState {
  if (typeof localStorage === 'undefined') return { deliveries: [] }
  try {
    return normalizeDeliveryState(JSON.parse(localStorage.getItem(storageKey(integrationId)) || 'null'))
  } catch {
    return { deliveries: [] }
  }
}

export function saveKomariAlertNotificationState(integrationId: string, state: NotificationDispatchState): NotificationDispatchState {
  const normalized = normalizeDeliveryState(state)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(storageKey(integrationId), JSON.stringify(normalized)) } catch { /* storage is optional */ }
  }
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
    case 'acknowledged': return `${title} acknowledged`
    case 'closed': return `${title} closed`
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
  const sourceRows = options.audit ?? state.audit
  const candidateRows = uniqueAuditRows(sourceRows)
  const boundedRows = candidateRows.slice(-maxEvents)
  const omitted = Math.max(0, candidateRows.length - boundedRows.length)
  let dispatchState = options.state
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
    const record = recordForAudit(state, audit)
    if (!record) {
      skipped += 1
      continue
    }
    const event = komariAlertNotificationEvent(record, audit)
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
      .filter((delivery) => delivery.eventId === event.eventId)
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
    const pendingChannels = configuredChannels.filter((channel) => !deliveredChannels.has(channel))
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
        now: options.now ?? audit.at,
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
  const result = await dispatchKomariAlertNotifications(state, {
    ...options,
    state: options.state ?? loadKomariAlertNotificationState(integrationId),
  })
  saveKomariAlertNotificationState(integrationId, result.state)
  return result
}
