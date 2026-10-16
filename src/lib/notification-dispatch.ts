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

export interface NotificationDispatchState {
  deliveries: NotificationDeliveryRecord[]
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
  | 'below-minimum-severity'
  | 'deduplicated'
  | 'cooldown'
  | 'channel-unavailable'
  | 'webhook-not-configured'

export interface NotificationDeliveryResult {
  channel: NotificationChannel
  status: 'delivered' | 'skipped' | 'failed'
  reason?: NotificationSkipReason | string
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

function normalizeState(state: NotificationDispatchState | undefined): NotificationDispatchState {
  const deliveries = Array.isArray(state?.deliveries) ? state.deliveries : []
  return {
    deliveries: deliveries.filter((entry): entry is NotificationDeliveryRecord => Boolean(entry)
      && typeof entry.key === 'string'
      && typeof entry.fingerprint === 'string'
      && typeof entry.eventKey === 'string'
      && (entry.channel === 'local' || entry.channel === 'webhook' || entry.channel === 'system')
      && Number.isFinite(entry.deliveredAt)).slice(-MAX_DELIVERIES).map((entry) => ({
        key: entry.key.slice(0, 600),
        fingerprint: entry.fingerprint.slice(0, 512),
        eventKey: entry.eventKey.slice(0, 1_024),
        eventId: typeof entry.eventId === 'string' ? entry.eventId.slice(0, 240) : null,
        status: typeof entry.status === 'string' ? entry.status.slice(0, 96) : null,
        channel: entry.channel,
        deliveredAt: entry.deliveredAt,
      })),
  }
}

function eventKey(payload: NotificationPayload): string {
  return payload.eventId
    ?? [payload.fingerprint, payload.kind, payload.status ?? '', payload.title, payload.message ?? ''].join('|')
}

function diagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactNotificationText(message).slice(0, 240) || 'notification delivery failed'
}

async function sendWebhook(payload: NotificationPayload, url: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: payload.source,
      kind: payload.kind,
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      fingerprint: payload.fingerprint,
      hostId: payload.hostId,
      hostName: payload.hostName,
      integrationId: payload.integrationId,
      status: payload.status,
      occurredAt: payload.occurredAt,
      metadata: payload.metadata,
    }),
    redirect: 'error',
    credentials: 'omit',
  })
  if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`)
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
  const state = normalizeState(options.state)
  const result: NotificationDispatchResult = { payload, deliveries: [], state }

  if (!policy.enabled) {
    return { ...result, deliveries: policy.channels.map((channel) => ({ channel, status: 'skipped', reason: 'disabled' as const })) }
  }
  if (!notificationMeetsPolicy(payload, policy)) {
    return { ...result, deliveries: policy.channels.map((channel) => ({ channel, status: 'skipped', reason: 'below-minimum-severity' as const })) }
  }

  const keyEvent = eventKey(payload)
  for (const channel of policy.channels) {
    const key = `${payload.fingerprint}|${channel}`
    const previous = latestDelivery(state, key)
    if (previous && previous.eventKey === keyEvent && policy.dedupeWindowMs > 0 && now - previous.deliveredAt < policy.dedupeWindowMs) {
      result.deliveries.push({ channel, status: 'skipped', reason: 'deduplicated' })
      continue
    }
    // A lifecycle transition (for example active -> resolved) is allowed to
    // pass the cooldown. Repeated events with the same status remain quiet.
    if (previous && previous.status === payload.status && policy.cooldownMs > 0 && now - previous.deliveredAt < policy.cooldownMs) {
      result.deliveries.push({ channel, status: 'skipped', reason: 'cooldown' })
      continue
    }

    try {
      if (channel === 'local') {
        if (!options.onLocal) {
          result.deliveries.push({ channel, status: 'skipped', reason: 'channel-unavailable' })
          continue
        }
        await options.onLocal(payload)
      } else if (channel === 'system') {
        if (!options.onSystem) {
          result.deliveries.push({ channel, status: 'skipped', reason: 'channel-unavailable' })
          continue
        }
        await options.onSystem(payload)
      } else {
        if (!policy.webhookUrl) {
          result.deliveries.push({ channel, status: 'skipped', reason: 'webhook-not-configured' })
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
      result.deliveries.push({ channel, status: 'delivered', deliveredAt: now })
    } catch (error) {
      const safeError = diagnosticError(error)
      options.logger?.warn?.(`Notification ${channel} delivery failed: ${safeError}`)
      result.deliveries.push({ channel, status: 'failed', error: safeError })
    }
  }
  return result
}

/** Stateful convenience wrapper for a runtime that emits many observations. */
export function createNotificationDispatcher(options: Omit<NotificationDispatchOptions, 'state' | 'now'> & { policy?: NotificationPolicy | NotificationPolicyInput; state?: NotificationDispatchState }): NotificationDispatcher {
  let state = normalizeState(options.state)
  return {
    async dispatch(event) {
      const result = await dispatchNotification(event, { ...options, state })
      state = result.state
      return result
    },
    getState() {
      return { deliveries: [...state.deliveries] }
    },
    reset() {
      state = { deliveries: [] }
    },
  }
}
