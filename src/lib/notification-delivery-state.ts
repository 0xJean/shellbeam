import type { NotificationChannel } from './notification-policy'
import type { NotificationAttemptReason, NotificationAttemptRecord, NotificationDeliveryRecord, NotificationDispatchState } from './notification-dispatch'

/** Local-only state for the notification delivery indicator.
 *
 * Delivery records contain channel, event identity and timestamps only. The
 * payload, webhook URL and provider credentials are intentionally never
 * persisted here. Keeping this state separate from Komari's sync payload also
 * means clearing a provider cache does not make the notification indicator
 * claim that a message was delivered when it was not.
 */
export const NOTIFICATION_DELIVERY_STATE_STORAGE_KEY = 'shellbeam.notificationDeliveryState'
export const NOTIFICATION_DELIVERY_CHANGED_EVENT = 'shellbeam:notification-delivery-changed'

/** Notify mounted status surfaces without putting any delivery data on the event. */
export function notifyNotificationDeliveryChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATION_DELIVERY_CHANGED_EVENT))
}
/** Komari keeps one bounded ledger per integration so one provider cannot
 * overwrite another. Settings aggregates those ledgers through this prefix. */
const KOMARI_NOTIFICATION_STATE_STORAGE_PREFIX = 'shellbeam.komariNotificationState.v1:'
const MAX_DELIVERIES = 1_000

function normalizeRecord(value: unknown): NotificationDeliveryRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<NotificationDeliveryRecord>
  if (typeof record.key !== 'string' || typeof record.fingerprint !== 'string' || typeof record.eventKey !== 'string') return null
  if (record.channel !== 'local' && record.channel !== 'webhook' && record.channel !== 'system') return null
  if (typeof record.deliveredAt !== 'number' || !Number.isFinite(record.deliveredAt) || record.deliveredAt < 0) return null
  return {
    key: record.key.slice(0, 600),
    fingerprint: record.fingerprint.slice(0, 512),
    eventKey: record.eventKey.slice(0, 1_024),
    eventId: typeof record.eventId === 'string' ? record.eventId.slice(0, 240) : null,
    status: typeof record.status === 'string' ? record.status.slice(0, 96) : null,
    channel: record.channel,
    deliveredAt: record.deliveredAt,
  }
}

const ATTEMPT_REASONS = new Set<NotificationAttemptReason>([
  'disabled', 'recovery-disabled', 'below-minimum-severity', 'deduplicated', 'cooldown',
  'channel-unavailable', 'webhook-not-configured', 'system-unavailable',
  'system-permission-required', 'system-permission-denied', 'system-send-failed',
  'webhook-http-error', 'webhook-request-failed', 'delivery-timeout', 'delivery-failed',
])

const BLOCKED_REASONS = new Set<NotificationAttemptReason>([
  'channel-unavailable', 'webhook-not-configured', 'system-unavailable',
  'system-permission-required', 'system-permission-denied',
])

/** Keep only typed delivery facts. Arbitrary sink errors and payload metadata
 * must never be copied into the durable diagnostics journal. */
export function normalizeNotificationAttempts(value: unknown): NotificationAttemptRecord[] {
  if (!Array.isArray(value)) return []
  const records = value.flatMap((item): NotificationAttemptRecord[] => {
    if (!item || typeof item !== 'object') return []
    const row = item as Partial<NotificationAttemptRecord>
    if (typeof row.key !== 'string' || !row.key.trim()) return []
    if (row.channel !== 'local' && row.channel !== 'webhook' && row.channel !== 'system') return []
    if (row.status !== 'delivered' && row.status !== 'failed' && row.status !== 'skipped') return []
    if (typeof row.attemptedAt !== 'number' || !Number.isFinite(row.attemptedAt) || row.attemptedAt < 0) return []
    const reason = row.reason && ATTEMPT_REASONS.has(row.reason) ? row.reason : undefined
    return [{
      key: row.key.slice(0, 128),
      eventId: typeof row.eventId === 'string' ? row.eventId.slice(0, 240) : null,
      channel: row.channel,
      status: row.status,
      ...(reason ? { reason } : {}),
      attemptedAt: row.attemptedAt,
    }]
  }).sort((a, b) => a.attemptedAt - b.attemptedAt)
  const unique = new Map<string, NotificationAttemptRecord>()
  for (const record of records) {
    unique.set(JSON.stringify([record.key, record.channel, record.attemptedAt, record.status]), record)
  }
  return [...unique.values()].slice(-MAX_DELIVERIES)
}

export function normalizeNotificationDeliveryState(value: unknown): NotificationDispatchState {
  const raw = value && typeof value === 'object' ? value as Partial<NotificationDispatchState> : {}
  const deliveryRows = Array.isArray(raw.deliveries)
    ? raw.deliveries.map(normalizeRecord).filter((entry): entry is NotificationDeliveryRecord => entry !== null)
      .sort((a, b) => a.deliveredAt - b.deliveredAt)
    : []
  const uniqueDeliveries = new Map<string, NotificationDeliveryRecord>()
  for (const record of deliveryRows) {
    uniqueDeliveries.set(JSON.stringify([record.key, record.eventKey, record.channel, record.deliveredAt]), record)
  }
  const deliveries = [...uniqueDeliveries.values()].slice(-MAX_DELIVERIES)
  return { deliveries, ...(Array.isArray(raw.attempts) ? { attempts: normalizeNotificationAttempts(raw.attempts) } : {}) }
}

/** Read the standalone journal only; never write an aggregate back into it. */
export function loadOwnNotificationDeliveryState(): NotificationDispatchState {
  if (typeof localStorage === 'undefined') return { deliveries: [] }
  try {
    return normalizeNotificationDeliveryState(JSON.parse(localStorage.getItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY) || 'null'))
  } catch {
    return { deliveries: [] }
  }
}

export function loadNotificationDeliveryState(): NotificationDispatchState {
  if (typeof localStorage === 'undefined') return { deliveries: [] }
  try {
    const states: NotificationDispatchState[] = []
    const own = localStorage.getItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY)
    if (own) {
      try { states.push(normalizeNotificationDeliveryState(JSON.parse(own))) } catch { /* ignore a corrupt optional ledger */ }
    }
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(KOMARI_NOTIFICATION_STATE_STORAGE_PREFIX)) continue
      const value = localStorage.getItem(key)
      if (value) {
        try { states.push(normalizeNotificationDeliveryState(JSON.parse(value))) } catch { /* ignore a corrupt optional ledger */ }
      }
    }
    return normalizeNotificationDeliveryState({
      deliveries: states.flatMap((state) => state.deliveries),
      ...(states.some((state) => state.attempts) ? { attempts: states.flatMap((state) => state.attempts ?? []) } : {}),
    })
  } catch {
    return { deliveries: [] }
  }
}

export function saveNotificationDeliveryState(value: NotificationDispatchState): NotificationDispatchState {
  const state = normalizeNotificationDeliveryState(value)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY, JSON.stringify(state)) } catch { /* storage is optional */ }
  }
  notifyNotificationDeliveryChanged()
  return state
}

export function clearNotificationDeliveryState() {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY) } catch { /* storage is optional */ }
  }
  notifyNotificationDeliveryChanged()
}

export interface NotificationChannelOutcome {
  status: NotificationAttemptRecord['status']
  reason?: NotificationAttemptReason
  attemptedAt: number
}

export interface NotificationDeliverySummary {
  delivered: number
  recentDelivered: number
  lastDeliveredAt: number | null
  byChannel: Record<NotificationChannel, number>
  failed: number
  blocked: number
  lastAttemptedAt: number | null
  byChannelOutcome: Record<NotificationChannel, NotificationChannelOutcome | null>
}

/** Summarize successful deliveries without exposing payloads or provider data. */
export function summarizeNotificationDeliveries(state: NotificationDispatchState, now = Date.now(), windowMs = 24 * 60 * 60 * 1_000): NotificationDeliverySummary {
  const byChannel: Record<NotificationChannel, number> = { local: 0, webhook: 0, system: 0 }
  let lastDeliveredAt: number | null = null
  let recentDelivered = 0
  const normalized = normalizeNotificationDeliveryState(state)
  const byChannelOutcome: NotificationDeliverySummary['byChannelOutcome'] = { local: null, webhook: null, system: null }
  for (const delivery of normalized.deliveries) {
    byChannel[delivery.channel] += 1
    byChannelOutcome[delivery.channel] = { status: 'delivered', attemptedAt: delivery.deliveredAt }
    if (lastDeliveredAt === null || delivery.deliveredAt > lastDeliveredAt) lastDeliveredAt = delivery.deliveredAt
    if (delivery.deliveredAt <= now && now - delivery.deliveredAt <= Math.max(0, windowMs)) recentDelivered += 1
  }
  let lastAttemptedAt: number | null = null
  const latestByKey = new Map<string, NotificationAttemptRecord>()
  for (const attempt of normalized.attempts ?? []) {
    lastAttemptedAt = Math.max(lastAttemptedAt ?? 0, attempt.attemptedAt)
    // A policy or dedupe decision says nothing about whether a previous
    // attempt reached its destination. Preserve unresolved failures until a
    // successful retry (or a newer actionable outcome) supersedes them.
    if (attempt.status === 'skipped' && (!attempt.reason || !BLOCKED_REASONS.has(attempt.reason))) continue
    latestByKey.set(`${attempt.channel}:${attempt.key}`, attempt)
    const previous = byChannelOutcome[attempt.channel]
    if (!previous || attempt.attemptedAt >= previous.attemptedAt) {
      byChannelOutcome[attempt.channel] = {
        status: attempt.status,
        ...(attempt.reason ? { reason: attempt.reason } : {}),
        attemptedAt: attempt.attemptedAt,
      }
    }
  }
  let failed = 0
  let blocked = 0
  for (const attempt of latestByKey.values()) {
    if (attempt.status === 'delivered') continue
    if (attempt.reason && BLOCKED_REASONS.has(attempt.reason)) blocked += 1
    else if (attempt.status === 'failed') failed += 1
  }
  return {
    delivered: Object.values(byChannel).reduce((sum, count) => sum + count, 0),
    recentDelivered, lastDeliveredAt, byChannel, failed, blocked, lastAttemptedAt, byChannelOutcome,
  }
}
