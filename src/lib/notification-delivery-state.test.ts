import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearNotificationDeliveryState,
  loadNotificationDeliveryState,
  normalizeNotificationDeliveryState,
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
    expect(summarizeNotificationDeliveries(state, 3_000, 1_500)).toEqual({
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
})
