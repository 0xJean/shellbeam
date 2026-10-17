import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationAttemptRecord } from './notification-dispatch'
import {
  clearNotificationDeliveryState,
  loadNotificationDeliveryState,
  loadOwnNotificationDeliveryState,
  normalizeNotificationDeliveryState,
  NOTIFICATION_DELIVERY_CHANGED_EVENT,
  NOTIFICATION_DELIVERY_STATE_STORAGE_KEY,
  saveNotificationDeliveryState,
  summarizeNotificationDeliveries,
} from './notification-delivery-state'

describe('notification delivery state', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('drops malformed records and bounds secret-bearing metadata', () => {
    const state = normalizeNotificationDeliveryState({ deliveries: [
      { key: 'k', fingerprint: 'f', eventKey: 'e', channel: 'webhook', deliveredAt: 10, eventId: 'a', status: 'active' },
      { key: 'invalid', channel: 'webhook', deliveredAt: 10 },
      { key: 'bad-time', fingerprint: 'f', eventKey: 'e', channel: 'local', deliveredAt: Number.NaN },
    ] })
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0]).toMatchObject({ key: 'k', channel: 'webhook' })
  })

  it('persists and summarizes redacted delivery metadata only', () => {
    const state = saveNotificationDeliveryState({ deliveries: [
      { key: 'local', fingerprint: 'a', eventKey: '1', eventId: null, status: 'active', channel: 'local', deliveredAt: 1_000 },
      { key: 'webhook', fingerprint: 'a', eventKey: '1', eventId: null, status: 'active', channel: 'webhook', deliveredAt: 2_000 },
    ] })
    expect(loadNotificationDeliveryState()).toEqual(state)
    expect(summarizeNotificationDeliveries(state, 3_000, 1_500)).toMatchObject({
      delivered: 2,
      recentDelivered: 1,
      lastDeliveredAt: 2_000,
      byChannel: { local: 1, webhook: 1, system: 0 },
    })
    clearNotificationDeliveryState()
    expect(loadNotificationDeliveryState()).toEqual({ deliveries: [] })
  })

  it('aggregates per-Komari integration ledgers for settings', () => {
    localStorage.setItem('shellbeam.komariNotificationState.v1:prod', JSON.stringify({ deliveries: [
      { key: 'local', fingerprint: 'f', eventKey: 'e', channel: 'local', deliveredAt: 3_000 },
    ] }))
    localStorage.setItem('shellbeam.komariNotificationState.v1:staging', JSON.stringify({ deliveries: [
      { key: 'webhook', fingerprint: 'g', eventKey: 'h', channel: 'webhook', deliveredAt: 4_000 },
    ] }))
    localStorage.setItem('shellbeam.komariNotificationState.v1:broken', '{')
    expect(loadNotificationDeliveryState().deliveries).toHaveLength(2)
  })

  it('retains failed and blocked attempts across reload and clears a failure after a successful retry', () => {
    const failed: NotificationAttemptRecord = { key: 'attempt-webhook', eventId: 'audit-1', channel: 'webhook', status: 'failed', reason: 'webhook-http-error', attemptedAt: 10 }
    const blocked: NotificationAttemptRecord = { key: 'attempt-system', eventId: 'audit-1', channel: 'system', status: 'skipped', reason: 'system-permission-required', attemptedAt: 11 }
    saveNotificationDeliveryState({ deliveries: [], attempts: [failed, blocked] })
    expect(summarizeNotificationDeliveries(loadNotificationDeliveryState())).toMatchObject({
      failed: 1, blocked: 1, lastAttemptedAt: 11,
      byChannelOutcome: {
        webhook: { status: 'failed', reason: 'webhook-http-error', attemptedAt: 10 },
        system: { status: 'skipped', reason: 'system-permission-required', attemptedAt: 11 },
      },
    })
    saveNotificationDeliveryState({ deliveries: [], attempts: [failed, blocked, { ...failed, status: 'delivered', reason: undefined, attemptedAt: 20 }] })
    expect(summarizeNotificationDeliveries(loadNotificationDeliveryState())).toMatchObject({
      failed: 0, blocked: 1, lastAttemptedAt: 20,
      byChannelOutcome: { webhook: { status: 'delivered', attemptedAt: 20 } },
    })
  })

  it('does not let policy or dedupe skips erase an unresolved delivery failure', () => {
    const attempt: NotificationAttemptRecord = { key: 'event-system', eventId: 'audit-1', channel: 'system', status: 'failed', reason: 'system-send-failed', attemptedAt: 10 }
    const state = { deliveries: [], attempts: [
      attempt,
      { ...attempt, status: 'skipped' as const, reason: 'disabled' as const, attemptedAt: 20 },
      { ...attempt, status: 'skipped' as const, reason: 'deduplicated' as const, attemptedAt: 30 },
    ] }
    expect(summarizeNotificationDeliveries(state)).toMatchObject({
      failed: 1, blocked: 0, lastAttemptedAt: 30,
      byChannelOutcome: { system: { status: 'failed', reason: 'system-send-failed', attemptedAt: 10 } },
    })
  })

  it('deduplicates integration attempts and keeps the newest bounded journal irrespective of storage order', () => {
    const attempts: NotificationAttemptRecord[] = Array.from({ length: 1_001 }, (_, index) => ({
      key: `event-${index}`, eventId: null, channel: 'local', status: 'delivered', attemptedAt: index,
    }))
    localStorage.setItem('shellbeam.komariNotificationState.v1:new', JSON.stringify({ deliveries: [], attempts: [attempts.at(-1), attempts.at(-1)] }))
    localStorage.setItem('shellbeam.komariNotificationState.v1:old', JSON.stringify({ deliveries: [], attempts: attempts.slice(0, -1).reverse() }))
    const loaded = loadNotificationDeliveryState()
    expect(loaded.attempts).toHaveLength(1_000)
    expect(loaded.attempts?.[0].attemptedAt).toBe(1)
    expect(loaded.attempts?.at(-1)?.attemptedAt).toBe(1_000)
  })

  it('persists only approved attempt fields and reason codes', () => {
    const state = normalizeNotificationDeliveryState({ deliveries: [], attempts: [
      { key: 'safe-key', eventId: 'audit-1', channel: 'system', status: 'failed', reason: 'token=SECRET', attemptedAt: 10, error: 'password=SECRET', payload: { token: 'SECRET' }, webhookUrl: 'https://secret.example' },
      { key: 'invalid-time', channel: 'system', status: 'failed', attemptedAt: -1 },
      { key: 'invalid-channel', channel: 'mail', status: 'failed', attemptedAt: 1 },
    ] })
    saveNotificationDeliveryState(state)
    expect(state.attempts).toEqual([{ key: 'safe-key', eventId: 'audit-1', channel: 'system', status: 'failed', attemptedAt: 10 }])
    expect(localStorage.getItem(NOTIFICATION_DELIVERY_STATE_STORAGE_KEY)).not.toMatch(/SECRET|password|webhookUrl|payload/)
  })

  it('emits payload-free same-window refresh events on save and clear', () => {
    const listener = vi.fn()
    window.addEventListener(NOTIFICATION_DELIVERY_CHANGED_EVENT, listener)
    try {
      saveNotificationDeliveryState({ deliveries: [] })
      clearNotificationDeliveryState()
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener.mock.calls[0][0]).not.toHaveProperty('detail')
    } finally {
      window.removeEventListener(NOTIFICATION_DELIVERY_CHANGED_EVENT, listener)
    }
  })


  it('keeps standalone writes separate from integration journals and deduplicates aggregate deliveries', () => {
    const delivery = { key: 'local', fingerprint: 'f', eventKey: 'audit-1', eventId: 'audit-1', status: 'active', channel: 'local' as const, deliveredAt: 1_000 }
    localStorage.setItem('shellbeam.komariNotificationState.v1:prod', JSON.stringify({ deliveries: [delivery] }))
    expect(loadOwnNotificationDeliveryState()).toEqual({ deliveries: [] })
    saveNotificationDeliveryState({ deliveries: [delivery] })
    expect(loadNotificationDeliveryState().deliveries).toEqual([delivery])
  })

})
