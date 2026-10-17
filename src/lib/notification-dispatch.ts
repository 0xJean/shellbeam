import { normalizeNotificationDeliveryState } from './notification-delivery-state'
import { sendSystemNotification, SystemNotificationError } from './system-notifications'
export { getSystemNotificationPermission, requestSystemNotificationPermission } from './system-notifications'
export type { SystemNotificationPermission } from './system-notifications'
import {
  normalizeNotificationPolicy,
  notificationFingerprint,
  notificationMeetsPolicy,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPolicy,
  type NotificationPolicyInput,
  type NotificationSeverity,
} from './notification-policy'

/** Delivery state is intentionally metadata only. It contains no message
 * bodies, webhook URLs, credentials or provider output. */
export interface NotificationDeliveryRecord {
  key: string
  fingerprint: string
  eventKey: string
  eventId: string | null
  status: string | null
  channel: NotificationChannel
  deliveredAt: number
}

/** Diagnostic journal contains fixed reason codes and event identity only. */
export type NotificationAttemptReason = NotificationSkipReason
  | 'system-unavailable' | 'system-permission-required' | 'system-permission-denied' | 'system-send-failed'
  | 'webhook-http-error' | 'webhook-request-failed' | 'delivery-timeout' | 'delivery-failed'

export interface NotificationAttemptRecord {
  key: string
  eventId: string | null
  channel: NotificationChannel
  status: 'delivered' | 'failed' | 'skipped'
  reason?: NotificationAttemptReason
  attemptedAt: number
}

export interface NotificationDispatchState {
  deliveries: NotificationDeliveryRecord[]
  /** Optional for compatibility with successful-delivery-only ledgers. */
  attempts?: NotificationAttemptRecord[]
}

export interface NotificationPayload {
  eventId: string | null
  source: string
  kind: string
  severity: NotificationSeverity
  title: string
  message: string | null
  fingerprint: string
  hostId: string | null
  hostName: string | null
  integrationId: string | null
  status: string | null
  occurredAt: number
  metadata: Record<string, unknown>
}

export type NotificationSkipReason =
  | 'disabled'
  | 'recovery-disabled'
  | 'below-minimum-severity'
  | 'deduplicated'
  | 'cooldown'
  | 'channel-unavailable'
  | 'webhook-not-configured'

export interface NotificationDeliveryResult {
  channel: NotificationChannel
  status: 'delivered' | 'skipped' | 'failed'
  reason?: NotificationAttemptReason
  deliveredAt?: number
  error?: string
}

export interface NotificationDispatchResult {
  payload: NotificationPayload
  deliveries: NotificationDeliveryResult[]
  state: NotificationDispatchState
}

export interface NotificationDispatchOptions {
  policy?: NotificationPolicy | NotificationPolicyInput
  state?: NotificationDispatchState
  now?: number
  fetchImpl?: typeof fetch
  /** In-app/local inbox sink. It receives a redacted payload only. */
  onLocal?: (payload: NotificationPayload) => void | Promise<void>
  /** Native OS notification sink. It receives a redacted payload only. */
  onSystem?: (payload: NotificationPayload) => void | Promise<void>
  /** Diagnostics sink. Messages are redacted and contain no event payload. */
  logger?: { warn?: (message: string) => void }
}

export interface NotificationDispatcher {
  dispatch(event: NotificationEvent): Promise<NotificationDispatchResult>
  getState(): NotificationDispatchState
  reset(): void
}

const MAX_DELIVERIES = 1_000
const MAX_METADATA_DEPTH = 3
const MAX_METADATA_KEYS = 32
const MAX_ARRAY_ITEMS = 32
const SAFE_TEXT_LENGTH = 512
const SENSITIVE_KEY = /(pass(word|wd)?|private[_-]?key|secret|token|credential|authorization|bearer|cookie|api[_-]?key|access[_-]?key|refresh[_-]?token)/i
const SENSITIVE_VALUE = /(bearer\s+)[^\s,;]+/gi

function safeText(value: unknown, fallback = '', maxLength = SAFE_TEXT_LENGTH): string {
  if (typeof value !== 'string') return fallback
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/** Redact common credential forms before they can reach a sink or logger. */
export function redactNotificationText(value: unknown): string {
  return safeText(value)
    .replace(SENSITIVE_VALUE, '$1<redacted>')
    .replace(/((?:password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key)\s*(?:[=:]|\s)\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/([?&](?:password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key)=[^&#\s]+)/gi, (match) => `${match.slice(0, match.indexOf('=') + 1)}<redacted>`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@')
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactNotificationText(value)
  if (depth >= MAX_METADATA_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1))
  if (typeof value !== 'object') return undefined
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS)) {
    if (SENSITIVE_KEY.test(key)) continue
    const safeKey = safeText(key, '', 96)
    if (!safeKey) continue
    const safeChild = sanitizeValue(child, depth + 1)
    if (safeChild !== undefined) result[safeKey] = safeChild
  }
  return result
}

export function sanitizeNotificationMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = sanitizeValue(value ?? {}, 0)
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
}

function validSeverity(value: unknown): NotificationSeverity {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : 'info'
}

function normalizeEvent(input: NotificationEvent, now: number): NotificationPayload {
  const source = safeText(input.source, 'shellbeam')
  const kind = safeText(input.kind, 'event')
  const fingerprint = notificationFingerprint({
    source,
    kind,
    fingerprint: input.fingerprint,
    hostId: input.hostId,
    integrationId: input.integrationId,
  })
  const occurredAt = typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt) && input.occurredAt >= 0
    ? input.occurredAt
    : now
  return {
    eventId: safeText(input.eventId) || null,
    source,
    kind,
    severity: validSeverity(input.severity),
    title: redactNotificationText(input.title) || `${kind} notification`,
    message: redactNotificationText(input.message) || null,
    fingerprint: safeText(fingerprint, 'unknown', 512),
    hostId: safeText(input.hostId) || null,
    hostName: redactNotificationText(input.hostName) || null,
    integrationId: safeText(input.integrationId) || null,
    status: safeText(input.status) || null,
    occurredAt,
    metadata: sanitizeNotificationMetadata(input.metadata),
  }
}

function eventKey(payload: NotificationPayload): string {
  return payload.eventId
    ?? `event-${identityHash(JSON.stringify([payload.fingerprint, payload.kind, payload.status, payload.title, payload.message]))}`
}

function diagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactNotificationText(message).slice(0, 240) || 'notification delivery failed'
}

/** Send only redacted, bounded user-facing text to the native/browser adapter. */
export async function emitSystemNotification(payload: NotificationPayload): Promise<void> {
  const title = redactNotificationText(payload.title).slice(0, 120) || 'ShellBeam alert'
  const body = redactNotificationText(payload.message ?? payload.hostName ?? `${payload.source} alert`).slice(0, 240)
  await sendSystemNotification({ title, body })
}

export const NOTIFICATION_DELIVERY_TIMEOUT_MS = 10_000

class DeliveryError extends Error {
  readonly reason: NotificationAttemptReason
  constructor(reason: NotificationAttemptReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/** Hash the identity so fallback keys cannot persist a message or URL. */
function identityHash(value: string): string {
  let left = 2166136261
  let right = 5381
  for (const char of value) {
    left = Math.imul(left ^ char.charCodeAt(0), 16777619)
    right = Math.imul(right, 33) ^ char.charCodeAt(0)
  }
  return `${(left >>> 0).toString(16)}-${(right >>> 0).toString(16)}`
}

function attemptKey(payload: NotificationPayload, channel: NotificationChannel): string {
  return identityHash(JSON.stringify([payload.fingerprint, eventKey(payload), channel]))
}

function appendAttempt(result: NotificationDispatchResult, delivery: NotificationDeliveryResult, now: number) {
  result.deliveries.push(delivery)
  const attempts = result.state.attempts ?? []
  attempts.push({
    key: attemptKey(result.payload, delivery.channel),
    eventId: result.payload.eventId ? redactNotificationText(result.payload.eventId).slice(0, 240) : null,
    channel: delivery.channel,
    status: delivery.status,
    ...(delivery.reason ? { reason: delivery.reason } : {}),
    attemptedAt: now,
  })
  result.state.attempts = attempts.slice(-MAX_DELIVERIES)
}

async function sendWebhook(payload: NotificationPayload, url: string, fetchImpl: typeof fetch): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeliveryError('delivery-timeout', 'notification delivery timed out'))
      controller.abort()
    }, NOTIFICATION_DELIVERY_TIMEOUT_MS)
  })
  try {
    const response = await Promise.race([fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: payload.source, kind: payload.kind, severity: payload.severity,
        title: payload.title, message: payload.message, fingerprint: payload.fingerprint,
        hostId: payload.hostId, hostName: payload.hostName, integrationId: payload.integrationId,
        status: payload.status, occurredAt: payload.occurredAt, metadata: payload.metadata,
      }),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    }), timeout])
    if (!response.ok) throw new DeliveryError('webhook-http-error', `webhook returned HTTP ${response.status}`)
  } catch (error) {
    if (error instanceof DeliveryError) throw error
    // Raw network errors can include endpoints or provider response bodies.
    throw new DeliveryError('webhook-request-failed', 'webhook request failed')
  } finally {
    clearTimeout(timer)
  }
}

function latestDelivery(state: NotificationDispatchState, key: string) {
  for (let index = state.deliveries.length - 1; index >= 0; index -= 1) {
    if (state.deliveries[index]?.key === key) return state.deliveries[index]
  }
  return undefined
}

/** Dispatch one event through the configured local, webhook and system sinks.
 * Every sink gets the same redacted payload and delivery state stays bounded. */
export async function dispatchNotification(event: NotificationEvent, options: NotificationDispatchOptions = {}): Promise<NotificationDispatchResult> {
  const now = options.now ?? Date.now()
  const policy = normalizeNotificationPolicy(options.policy)
  const payload = normalizeEvent(event, now)
  const state = normalizeNotificationDeliveryState(options.state)
  const result: NotificationDispatchResult = { payload, deliveries: [], state }
  const isRecovery = payload.kind === 'alert.resolved'
    || payload.status === 'resolved'
    || payload.metadata.recovered === true
  const channels = isRecovery ? policy.recoveryChannels : policy.channels

  if (!policy.enabled) {
    for (const channel of channels) appendAttempt(result, { channel, status: 'skipped', reason: 'disabled' }, now)
    return result
  }

  // Recovery notifications are a separate user preference. Keep this guard
  // in the shared dispatcher as well as the Komari adapter so future
  // ProbeProvider implementations cannot accidentally bypass the setting.
  if (isRecovery && !policy.notifyOnRecovery) {
    for (const channel of channels) appendAttempt(result, { channel, status: 'skipped', reason: 'recovery-disabled' }, now)
    return result
  }
  if (!notificationMeetsPolicy(payload, policy)) {
    for (const channel of channels) appendAttempt(result, { channel, status: 'skipped', reason: 'below-minimum-severity' }, now)
    return result
  }

  const keyEvent = eventKey(payload)
  for (const channel of channels) {
    const key = `${payload.fingerprint}|${channel}`
    const previous = latestDelivery(state, key)
    if (previous && previous.eventKey === keyEvent && policy.dedupeWindowMs > 0 && now - previous.deliveredAt < policy.dedupeWindowMs) {
      appendAttempt(result, { channel, status: 'skipped', reason: 'deduplicated' }, now)
      continue
    }
    // A lifecycle transition (for example active -> resolved) is allowed to
    // pass the cooldown. Repeated events with the same status remain quiet.
    if (previous && previous.status === payload.status && policy.cooldownMs > 0 && now - previous.deliveredAt < policy.cooldownMs) {
      appendAttempt(result, { channel, status: 'skipped', reason: 'cooldown' }, now)
      continue
    }

    try {
      if (channel === 'local') {
        if (!options.onLocal) {
          appendAttempt(result, { channel, status: 'skipped', reason: 'channel-unavailable' }, now)
          continue
        }
        await options.onLocal(payload)
      } else if (channel === 'system') {
        await (options.onSystem ?? emitSystemNotification)(payload)
      } else {
        if (!policy.webhookUrl) {
          appendAttempt(result, { channel, status: 'skipped', reason: 'webhook-not-configured' }, now)
          continue
        }
        await sendWebhook(payload, policy.webhookUrl, options.fetchImpl ?? globalThis.fetch)
      }
      state.deliveries.push({
        key,
        fingerprint: payload.fingerprint,
        eventKey: keyEvent,
        eventId: payload.eventId,
        status: payload.status,
        channel,
        deliveredAt: now,
      })
      if (state.deliveries.length > MAX_DELIVERIES) state.deliveries.splice(0, state.deliveries.length - MAX_DELIVERIES)
      appendAttempt(result, { channel, status: 'delivered', deliveredAt: now }, now)
    } catch (error) {
      const safeError = diagnosticError(error)
      options.logger?.warn?.(`Notification ${channel} delivery failed: ${safeError}`)
      const reason = error instanceof SystemNotificationError ? error.code
        : error instanceof DeliveryError ? error.reason : 'delivery-failed'
      appendAttempt(result, { channel, status: 'failed', reason, error: safeError }, now)
    }
  }
  return result
}

/** Stateful convenience wrapper for a runtime that emits many observations. */
export function createNotificationDispatcher(options: Omit<NotificationDispatchOptions, 'state' | 'now'> & { policy?: NotificationPolicy | NotificationPolicyInput; state?: NotificationDispatchState }): NotificationDispatcher {
  let state = normalizeNotificationDeliveryState(options.state)
  return {
    async dispatch(event) {
      const result = await dispatchNotification(event, { ...options, state })
      state = result.state
      return result
    },
    getState() {
      return normalizeNotificationDeliveryState(state)
    },
    reset() {
      state = { deliveries: [] }
    },
  }
}
