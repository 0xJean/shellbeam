import type { NotificationChannel } from './notification-policy'
import type { NotificationDeliveryRecord, NotificationDispatchState } from './notification-dispatch'

/** Local-only state for the notification delivery indicator.
 *
 * Delivery records contain channel, event identity and timestamps only. The
 * payload, webhook URL and provider credentials are intentionally never
 * persisted here. Keeping this state separate from Komari's sync payload also
 * means clearing a provider cache does not make the notification indicator
 * claim that a message was delivered when it was not.
 */
export const NOTIFICATION_DELIVERY_STATE_STORAGE_KEY = 'shellbeam.notificationDeliveryState'
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

export function normalizeNotificationDeliveryState(value: unknown): NotificationDispatchState {
  const raw = value && typeof value === 'object' ? value as Partial<NotificationDispatchState> : {}
  const deliveries = Array.isArray(raw.deliveries)
    ? raw.deliveries.map(normalizeRecord).filter((entry): entry is NotificationDeliveryRecord => entry !== null).slice(-MAX_DELIVERIES)
    : []
  return { deliveries }
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
    return normalizeNotificationDeliveryState({ deliveries: states.flatMap((state) => state.deliveries) })
  } catch {
    return { deliveries: [] }
  }
}

export function saveNotificationDeliveryState(value: NotificationDispatchState): NotificationDispatchState {
  const state = normalizeNotificationDeliveryState(value)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY, JSON.stringify(state)) } catch { /* storage is optional */ }
  }
  return state
}

export function clearNotificationDeliveryState() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY)
}

export interface NotificationDeliverySummary {
  delivered: number
  recentDelivered: number
  lastDeliveredAt: number | null
  byChannel: Record<NotificationChannel, number>
}

/** Summarize successful deliveries without exposing payloads or provider data. */
export function summarizeNotificationDeliveries(state: NotificationDispatchState, now = Date.now(), windowMs = 24 * 60 * 60 * 1_000): NotificationDeliverySummary {
  const byChannel: Record<NotificationChannel, number> = { local: 0, webhook: 0, system: 0 }
  let lastDeliveredAt: number | null = null
  let recentDelivered = 0
  for (const delivery of normalizeNotificationDeliveryState(state).deliveries) {
    byChannel[delivery.channel] += 1
    if (lastDeliveredAt === null || delivery.deliveredAt > lastDeliveredAt) lastDeliveredAt = delivery.deliveredAt
    if (delivery.deliveredAt <= now && now - delivery.deliveredAt <= Math.max(0, windowMs)) recentDelivered += 1
  }
  return { delivered: Object.values(byChannel).reduce((sum, count) => sum + count, 0), recentDelivered, lastDeliveredAt, byChannel }
}
