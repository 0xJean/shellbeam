import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_POLICY,
  NOTIFICATION_POLICY_STORAGE_KEY,
  clearNotificationPolicy,
  loadNotificationPolicy,
  normalizeNotificationPolicy,
  notificationFingerprint,
  notificationMeetsPolicy,
  notificationPolicySummary,
  saveNotificationPolicy,
} from './notification-policy'

describe('notification policy', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('normalizes channels, severity, durations and rejects credential-bearing webhook URLs', () => {
    const policy = normalizeNotificationPolicy({
      enabled: true,
      channels: ['webhook', 'system', 'webhook', 'invalid'],
      minSeverity: 'critical',
      cooldownMs: -20,
      dedupeWindowMs: Number.POSITIVE_INFINITY,
      webhookUrl: 'https://user:password@example.test/hook',
    })
    expect(policy).toMatchObject({
      enabled: true,
      channels: ['webhook', 'system'],
      minimumSeverity: 'critical',
      cooldownMs: 0,
      dedupeWindowMs: DEFAULT_NOTIFICATION_POLICY.dedupeWindowMs,
      webhookUrl: null,
    })
    expect(normalizeNotificationPolicy({ channels: ['webhook'], webhookUrl: 'https://alerts.example.test/hook?token=secret' }).webhookUrl).toBeNull()
  })

  it('persists only the normalized policy and exposes a redacted summary', () => {
    const saved = saveNotificationPolicy({
      channels: ['local', 'webhook'],
      webhookUrl: 'https://alerts.example.test/shellbeam#fragment',
      cooldownMs: 1_000,
    })
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_POLICY_STORAGE_KEY) ?? '{}')).toEqual(saved)
    expect(loadNotificationPolicy()).toEqual(saved)
    expect(notificationPolicySummary(saved)).toMatchObject({ webhookConfigured: true, cooldownMs: 1_000 })
    expect(notificationPolicySummary(saved)).not.toHaveProperty('webhookUrl')
    clearNotificationPolicy()
    expect(loadNotificationPolicy()).toEqual(DEFAULT_NOTIFICATION_POLICY)
  })

  it('uses an explicit fingerprint and severity threshold', () => {
    expect(notificationFingerprint({ source: 'komari', kind: 'offline', fingerprint: 'stable-id' })).toBe('stable-id')
    expect(notificationFingerprint({ source: 'komari', kind: 'offline', hostId: 'h-1', integrationId: 'i-1' })).toBe('komari|i-1|h-1|offline')
    expect(notificationMeetsPolicy({ severity: 'critical' }, { ...DEFAULT_NOTIFICATION_POLICY, minimumSeverity: 'warning' })).toBe(true)
    expect(notificationMeetsPolicy({ severity: 'info' }, { ...DEFAULT_NOTIFICATION_POLICY, minimumSeverity: 'warning' })).toBe(false)
  })
})
