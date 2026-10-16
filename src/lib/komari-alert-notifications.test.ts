import { describe, expect, it, vi } from 'vitest'
import type { KomariAlertState } from './komari-alerts'
import { dispatchKomariAlertNotifications, komariAlertNotificationEvent } from './komari-alert-notifications'

const state: KomariAlertState = {
  schemaVersion: 1,
  alerts: [{
    schemaVersion: 1,
    source: 'komari',
    alertId: 'alert-1',
    fingerprint: 'prod|node|host|offline',
    integrationId: 'prod',
    nodeId: 'node-1',
    hostId: 'host-1',
    kind: 'offline',
    title: 'Host offline',
    severity: 'critical',
    count: 1,
    status: 'resolved',
    firstSeenAt: 1_000,
    lastSeenAt: 3_000,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: 3_000,
    closedAt: null,
    relatedOperationJobId: 'job-1',
    deduplicatedCount: 1,
  }],
  audit: [
    { auditId: 'audit-open', alertId: 'alert-1', fingerprint: 'prod|node|host|offline', event: 'opened', status: 'active', actor: 'sync', operationJobId: null, at: 1_000 },
    { auditId: 'audit-ack', alertId: 'alert-1', fingerprint: 'prod|node|host|offline', event: 'acknowledged', status: 'acknowledged', actor: 'alice', operationJobId: null, at: 2_000 },
    { auditId: 'audit-resolved', alertId: 'alert-1', fingerprint: 'prod|node|host|offline', event: 'resolved', status: 'resolved', actor: 'sync', operationJobId: null, at: 3_000 },
  ],
  summary: { load: null, offline: 0, total: 0, active: 0, open: 0, acknowledged: 0, resolved: 1, closed: 0, deduplicated: 1, localUpdatedAt: 3_000, updatedAt: 3_000 },
}

describe('Komari alert notifications', () => {
  it('maps lifecycle audit rows to safe notification events', () => {
    const event = komariAlertNotificationEvent(state.alerts[0]!, state.audit[2]!)
    expect(event).toMatchObject({ eventId: 'audit-resolved', source: 'komari', kind: 'alert.resolved', severity: 'critical', hostId: 'host-1', integrationId: 'prod', status: 'resolved', occurredAt: 3_000 })
    expect(event.message).toContain('recovered')
    expect(event.metadata).toMatchObject({ alertId: 'alert-1', lifecycle: 'resolved', relatedOperationJobId: 'job-1' })
  })

  it('maps every supported lifecycle transition to a stable event kind', () => {
    const transitions = ['opened', 'reopened', 'resolved', 'acknowledged', 'closed'] as const
    const kinds = transitions.map((event, index) => komariAlertNotificationEvent(state.alerts[0]!, {
      ...state.audit[0]!,
      auditId: `audit-${event}`,
      event,
      status: event === 'acknowledged' ? 'acknowledged' : event === 'resolved' ? 'resolved' : event === 'closed' ? 'closed' : 'active',
      at: 10_000 + index,
    }).kind)
    expect(kinds).toEqual(transitions.map((event) => `alert.${event}`))
  })

  it('dispatches only bounded lifecycle transitions and returns a summary', async () => {
    const onLocal = vi.fn()
    const result = await dispatchKomariAlertNotifications(state, { policy: { channels: ['local'], cooldownMs: 0 }, onLocal, maxEvents: 2 })
    expect(result.events).toHaveLength(2)
    expect(result.events.map((entry) => entry.payload.kind)).toEqual(['alert.acknowledged', 'alert.resolved'])
    expect(result.summary).toMatchObject({ considered: 2, omitted: 1, delivered: 2, skipped: 0, failed: 0, lastDeliveredAt: 3_000 })
    expect(onLocal).toHaveBeenCalledTimes(2)
  })

  it('deduplicates repeated audit rows and filters non-lifecycle noise', async () => {
    const onLocal = vi.fn()
    const audit = [
      state.audit[0]!,
      state.audit[0]!,
      { ...state.audit[1]!, auditId: 'audit-updated', event: 'updated' as const },
      { ...state.audit[1]!, auditId: 'audit-dedup', event: 'deduplicated' as const },
    ]
    const result = await dispatchKomariAlertNotifications(state, { audit, policy: { channels: ['local'], cooldownMs: 0 }, onLocal })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.payload.kind).toBe('alert.opened')
    expect(result.summary.considered).toBe(1)
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('retains delivery state so the same audit id is suppressed on replay', async () => {
    const onLocal = vi.fn()
    const first = await dispatchKomariAlertNotifications(state, { audit: [state.audit[0]!], policy: { channels: ['local'], cooldownMs: 0 }, onLocal, now: 5_000 })
    const second = await dispatchKomariAlertNotifications(state, { audit: [state.audit[0]!], policy: { channels: ['local'], cooldownMs: 0 }, state: first.state, onLocal, now: 5_001 })
    expect(first.summary.delivered).toBe(1)
    expect(second.summary.delivered).toBe(0)
    expect(second.summary.skipped).toBe(1)
    expect(second.events).toHaveLength(0)
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('does not deliver an audit row without a matching alert record', async () => {
    const onLocal = vi.fn()
    const result = await dispatchKomariAlertNotifications({ ...state, alerts: [] }, { policy: { channels: ['local'] }, onLocal })
    expect(result.events).toHaveLength(0)
    expect(result.summary).toMatchObject({ considered: 3, skipped: 3, delivered: 0 })
    expect(onLocal).not.toHaveBeenCalled()
  })


  it('persists only bounded delivery metadata per integration', async () => {
    localStorage.clear()
    const onLocal = vi.fn()
    const first = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[0]!],
      policy: { channels: ['local'], cooldownMs: 0 },
      onLocal,
      now: 7_000,
    })
    const { saveKomariAlertNotificationState, loadKomariAlertNotificationState } = await import('./komari-alert-notifications')
    saveKomariAlertNotificationState('Prod / Primary', first.state)
    expect(loadKomariAlertNotificationState('Prod / Primary')).toEqual(first.state)
    const raw = localStorage.getItem('shellbeam.komariNotificationState.v1:prod_primary')
    expect(raw).toContain('audit-open')
    expect(raw).not.toContain('Host offline')
    expect(loadKomariAlertNotificationState('missing')).toEqual({ deliveries: [] })
  })

  it('dispatches and persists through the integration helper', async () => {
    localStorage.clear()
    const onLocal = vi.fn()
    const { dispatchAndPersistKomariAlertNotifications, loadKomariAlertNotificationState } = await import('./komari-alert-notifications')
    const result = await dispatchAndPersistKomariAlertNotifications('prod', state, {
      audit: [state.audit[2]!],
      policy: { channels: ['local'], cooldownMs: 0 },
      onLocal,
      now: 8_000,
    })
    expect(result.summary.delivered).toBe(1)
    expect(loadKomariAlertNotificationState('prod').deliveries).toHaveLength(1)
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

})
