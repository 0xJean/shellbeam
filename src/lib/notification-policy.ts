/**
 * Local notification policy shared by Komari alerts and future ShellBeam
 * health checks.  The policy only contains routing and timing metadata;
 * credentials, webhook headers and remote payloads are intentionally absent.
 */

export type NotificationChannel = 'local' | 'webhook' | 'system'
export type NotificationSeverity = 'info' | 'warning' | 'critical'

export interface NotificationEvent {
  /** Stable source event id, when the provider exposes one. */
  eventId?: string
  source: string
  kind: string
  severity: NotificationSeverity
  title: string
  message?: string
  /** A provider-owned identity used for deduplication. */
  fingerprint?: string
  hostId?: string
  hostName?: string
  integrationId?: string
  status?: string
  occurredAt?: number
  /** Optional safe, structured context. Sensitive fields are dropped by the dispatcher. */
  metadata?: Record<string, unknown>
}

export interface NotificationPolicy {
  enabled: boolean
  channels: NotificationChannel[]
  minimumSeverity: NotificationSeverity
  /** Suppress a new delivery for the same fingerprint during this window. */
  cooldownMs: number
  /** Suppress a repeated event id during this window. */
  dedupeWindowMs: number
  /** HTTP(S) endpoint for the webhook channel. No credentials are stored here. */
  webhookUrl: string | null
}

export type NotificationPolicyInput = Omit<Partial<NotificationPolicy>, 'channels'> & {
  channels?: readonly NotificationChannel[]
  /** Alias accepted by settings/forms that use the shorter name. */
  minSeverity?: NotificationSeverity
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  enabled: true,
  channels: ['local'],
  minimumSeverity: 'warning',
  cooldownMs: 5 * 60 * 1000,
  dedupeWindowMs: 60 * 1000,
  webhookUrl: null,
}

export const NOTIFICATION_POLICY_STORAGE_KEY = 'shellbeam.notificationPolicy'

const CHANNELS: NotificationChannel[] = ['local', 'webhook', 'system']
const SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical']
const MAX_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
const MAX_URL_LENGTH = 2_048
const SAFE_ID_LENGTH = 240
const SECRET_QUERY_KEY = /^(?:pass(?:word|wd)?|secret|token|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key|refresh[_-]?token)$/i

function safeText(value: unknown, maxLength = SAFE_ID_LENGTH): string {
  if (typeof value !== 'string') return ''
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function normalizeDuration(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_COOLDOWN_MS, Math.max(0, Math.round(number)))
}

function normalizeWebhookUrl(value: unknown): string | null {
  const text = safeText(value, MAX_URL_LENGTH)
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // A URL must never carry credentials.  They are easy to leak through
    // diagnostics and are not needed because auth belongs in the connector.
    if (url.username || url.password) return null
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEY.test(key)) return null
    }
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function normalizeChannels(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value)) return [...DEFAULT_NOTIFICATION_POLICY.channels]
  const result = CHANNELS.filter((channel) => value.includes(channel))
  return result.length > 0 ? result : [...DEFAULT_NOTIFICATION_POLICY.channels]
}

function normalizeSeverity(value: unknown): NotificationSeverity {
  return SEVERITIES.includes(value as NotificationSeverity)
    ? value as NotificationSeverity
    : DEFAULT_NOTIFICATION_POLICY.minimumSeverity
}

/** Normalize untrusted settings into a bounded, credential-free policy. */
export function normalizeNotificationPolicy(input: unknown): NotificationPolicy {
  const raw = input && typeof input === 'object' ? input as NotificationPolicyInput : {}
  return {
    enabled: raw.enabled !== false,
    channels: normalizeChannels(raw.channels),
    minimumSeverity: normalizeSeverity(raw.minimumSeverity ?? raw.minSeverity),
    cooldownMs: normalizeDuration(raw.cooldownMs, DEFAULT_NOTIFICATION_POLICY.cooldownMs),
    dedupeWindowMs: normalizeDuration(raw.dedupeWindowMs, DEFAULT_NOTIFICATION_POLICY.dedupeWindowMs),
    webhookUrl: normalizeWebhookUrl(raw.webhookUrl),
  }
}

export function loadNotificationPolicy(): NotificationPolicy {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_NOTIFICATION_POLICY, channels: [...DEFAULT_NOTIFICATION_POLICY.channels] }
  try {
    const value = localStorage.getItem(NOTIFICATION_POLICY_STORAGE_KEY)
    return value ? normalizeNotificationPolicy(JSON.parse(value)) : normalizeNotificationPolicy(undefined)
  } catch {
    return normalizeNotificationPolicy(undefined)
  }
}

export function saveNotificationPolicy(input: NotificationPolicyInput): NotificationPolicy {
  const policy = normalizeNotificationPolicy(input)
  if (typeof localStorage !== 'undefined') localStorage.setItem(NOTIFICATION_POLICY_STORAGE_KEY, JSON.stringify(policy))
  return policy
}

export function clearNotificationPolicy() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(NOTIFICATION_POLICY_STORAGE_KEY)
}

export function notificationSeverityRank(severity: NotificationSeverity): number {
  return SEVERITIES.indexOf(severity)
}

export function notificationMeetsPolicy(event: Pick<NotificationEvent, 'severity'>, policy: NotificationPolicy): boolean {
  return notificationSeverityRank(event.severity) >= notificationSeverityRank(policy.minimumSeverity)
}

/** Build a stable, non-secret fingerprint for events without a provider key. */
export function notificationFingerprint(event: Pick<NotificationEvent, 'source' | 'kind' | 'fingerprint' | 'hostId' | 'integrationId'>): string {
  const explicit = safeText(event.fingerprint)
  if (explicit) return explicit
  return [event.source, event.integrationId, event.hostId, event.kind]
    .map((value) => safeText(value).toLowerCase())
    .join('|')
}

/** Keep only fields that can safely be shown in a settings summary or audit. */
export function notificationPolicySummary(policy: NotificationPolicy) {
  const normalized = normalizeNotificationPolicy(policy)
  return {
    enabled: normalized.enabled,
    channels: [...normalized.channels],
    minimumSeverity: normalized.minimumSeverity,
    cooldownMs: normalized.cooldownMs,
    dedupeWindowMs: normalized.dedupeWindowMs,
    webhookConfigured: Boolean(normalized.webhookUrl),
  }
}
