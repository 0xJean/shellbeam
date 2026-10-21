import { describe, expect, it, vi } from 'vitest'
import type { KomariAlertState } from './komari-alerts'
import { dispatchAndPersistKomariAlertNotifications, dispatchKomariAlertNotifications, komariAlertNotificationEvent, loadKomariAlertNotificationState, saveKomariAlertNotificationState } from './komari-alert-notifications'

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
    kind: 'probe-offline',
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
    probeTelemetry: {
      status: 'recovered', attempts: 1, maxRetries: 2, durationMs: 125,
      recovered: true, exhausted: false, lastErrorCode: 'timeout',
    },
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
    expect(event.metadata).toMatchObject({
      alertId: 'alert-1', lifecycle: 'resolved', recovered: true, relatedOperationJobId: 'job-1',
      probeTelemetry: { status: 'recovered', attempts: 1, durationMs: 125, lastErrorCode: 'timeout' },
    })
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

  it('marks resolved rows as recovery notifications and emits the default in-app event', async () => {
    const received: unknown[] = []
    const listener = (event: Event) => received.push((event as CustomEvent).detail)
    window.addEventListener('shellbeam:notification', listener)
    try {
      const result = await dispatchKomariAlertNotifications(state, {
        audit: [state.audit[2]!],
        policy: { channels: ['local'], cooldownMs: 0 },
        now: 3_000,
      })
      expect(result.summary).toMatchObject({ delivered: 1, failed: 0 })
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        kind: 'alert.resolved',
        status: 'resolved',
        metadata: { lifecycle: 'resolved', recovered: true },
      })
    } finally {
      window.removeEventListener('shellbeam:notification', listener)
    }
  })

  it('routes recovery notifications through configured channels and includes a bounded summary', async () => {
    const onLocal = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
    const result = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!],
      policy: {
        channels: ['local'],
        recoveryChannels: ['webhook'],
        webhookUrl: 'https://alerts.example.test/hook',
        includeAlertSummary: true,
        cooldownMs: 0,
      },
      onLocal,
      fetchImpl,
      now: 3_000,
    })
    expect(result.events[0]?.deliveries).toEqual([{ channel: 'webhook', status: 'delivered', deliveredAt: 3_000 }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onLocal).not.toHaveBeenCalled()
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { metadata?: { alertSummary?: Record<string, unknown> } }
    expect(body.metadata?.alertSummary).toMatchObject({ total: 0, active: 0, resolved: 1 })
  })

  it('suppresses recovery rows when the persisted policy disables them', async () => {
    const onLocal = vi.fn()
    const result = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!],
      policy: { channels: ['local'], notifyOnRecovery: false, cooldownMs: 0 },
      onLocal,
    })
    expect(result.events).toHaveLength(0)
    expect(result.summary).toMatchObject({ considered: 1, skipped: 1, delivered: 0 })
    expect(onLocal).not.toHaveBeenCalled()
  })

  it('retries only failed channels after a partial recovery notification delivery', async () => {
    const onLocal = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    const policy = { channels: ['local', 'webhook'] as const, webhookUrl: 'https://alerts.example.test/hook', cooldownMs: 0, dedupeWindowMs: 0 }
    const first = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!], policy, onLocal, fetchImpl, now: 3_000,
    })
    expect(first.events[0]?.deliveries.map((delivery) => delivery.status)).toEqual(['delivered', 'failed'])
    const second = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!], policy, state: first.state, onLocal, fetchImpl, now: 90_000,
    })
    expect(second.events[0]?.deliveries.map((delivery) => delivery.channel)).toEqual(['webhook'])
    expect(second.events[0]?.deliveries[0]?.status).toBe('delivered')
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('dispatches only bounded lifecycle transitions and returns a summary', async () => {
    const onLocal = vi.fn()
    const result = await dispatchKomariAlertNotifications(state, { policy: { channels: ['local'], cooldownMs: 0 }, onLocal, maxEvents: 2, now: 3_000 })
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

  it('retries only the failed channel from persisted attempts on a refresh with no new audit', async () => {
    localStorage.clear()
    const onLocal = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    const policy = { channels: ['local', 'webhook'] as const, webhookUrl: 'https://alerts.example.test/hook', cooldownMs: 0, dedupeWindowMs: 0 }
    const first = await dispatchAndPersistKomariAlertNotifications('prod', state, {
      audit: [state.audit[2]!], policy, onLocal, fetchImpl, now: 10_000,
    })
    expect(first.state.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'audit-resolved', channel: 'webhook', status: 'failed', attemptedAt: 10_000 }),
    ]))
    const retry = await dispatchAndPersistKomariAlertNotifications('prod', state, {
      audit: [], retryPending: true, policy, onLocal, fetchImpl, now: 70_000,
    })
    expect(retry.summary.delivered).toBe(1)
    expect(retry.events[0]?.deliveries.map((delivery) => delivery.channel)).toEqual(['webhook'])
    expect(loadKomariAlertNotificationState('prod').deliveries).toHaveLength(2)
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const settled = await dispatchAndPersistKomariAlertNotifications('prod', state, {
      audit: [], retryPending: true, policy, onLocal, fetchImpl, now: 130_000,
    })
    expect(settled.events).toHaveLength(0)
  })

  it('retries a persisted unavailable channel once a sink becomes available', async () => {
    const policy = { channels: ['webhook'] as const, cooldownMs: 0 }
    const first = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!], policy, now: 10_000,
    })
    expect(first.events[0]?.deliveries[0]).toMatchObject({ status: 'skipped', reason: 'webhook-not-configured' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
    const retry = await dispatchKomariAlertNotifications(state, {
      audit: [], retryPending: true, state: first.state,
      policy: { ...policy, webhookUrl: 'https://alerts.example.test/hook' }, fetchImpl, now: 70_000,
    })
    expect(retry.summary.delivered).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('delivers a recent persisted MCP acknowledgement once without backfilling new channels', async () => {
    localStorage.clear()
    const persistedMcpState: KomariAlertState = {
      ...state,
      audit: state.audit.slice(0, 2),
      summary: { ...state.summary, localUpdatedAt: 2_000 },
    }
    const onLocal = vi.fn()
    const onSystem = vi.fn()
    const options = { audit: [], retryPending: true, includeRecent: true, onLocal, onSystem, now: 70_000 }
    const first = await dispatchAndPersistKomariAlertNotifications('mcp', persistedMcpState, {
      ...options, policy: { channels: ['local'], cooldownMs: 0 },
    })
    expect(first.events.map((event) => event.payload.eventId)).toEqual(['audit-ack'])
    expect(first.summary.delivered).toBe(1)
    const reloaded = await dispatchAndPersistKomariAlertNotifications('mcp', persistedMcpState, {
      ...options, policy: { channels: ['local', 'system'], cooldownMs: 0 }, now: 130_000,
    })
    expect(reloaded.events).toHaveLength(0)
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(onSystem).not.toHaveBeenCalled()
  })

  it('does not discover expired, future, or earlier-than-sync lifecycle facts', async () => {
    const onLocal = vi.fn()
    for (const [now, localUpdatedAt] of [
      [3_001 + 24 * 60 * 60 * 1_000, 3_000],
      [2_999, 3_000],
      [4_000, 3_001],
    ]) {
      const result = await dispatchKomariAlertNotifications({ ...state, summary: { ...state.summary, localUpdatedAt: localUpdatedAt! } }, {
        audit: [], retryPending: true, includeRecent: true,
        policy: { channels: ['local'], cooldownMs: 0 }, onLocal, now,
      })
      expect(result.events).toHaveLength(0)
    }
    expect(onLocal).not.toHaveBeenCalled()
  })

  it('never replays history without failures or sends newly configured channels on retry', async () => {
    const onLocal = vi.fn()
    const onSystem = vi.fn()
    const policy = { channels: ['local', 'system'] as const, cooldownMs: 0 }
    const noHistory = await dispatchKomariAlertNotifications(state, { audit: [], retryPending: true, policy, onLocal, onSystem })
    expect(noHistory.events).toHaveLength(0)
    const failed = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!], policy: { channels: ['local'], cooldownMs: 0 },
      onLocal: () => { throw new Error('temporarily unavailable') }, now: 10_000,
    })
    const retry = await dispatchKomariAlertNotifications(state, {
      audit: [], retryPending: true, state: failed.state, policy, onLocal, onSystem, now: 70_000,
    })
    expect(retry.summary.delivered).toBe(1)
    expect(onSystem).not.toHaveBeenCalled()
  })

  it('bounds automatic retries by minimum interval, count and age', async () => {
    const onLocal = vi.fn(() => { throw new Error('temporarily unavailable') })
    const policy = { channels: ['local'] as const, cooldownMs: 0 }
    let result = await dispatchKomariAlertNotifications(state, {
      audit: [state.audit[2]!], policy, onLocal, now: 10_000,
    })
    const early = await dispatchKomariAlertNotifications(state, {
      audit: [], retryPending: true, state: result.state, policy, onLocal, now: 69_999,
    })
    expect(early.events).toHaveLength(0)
    const expired = await dispatchKomariAlertNotifications(state, {
      audit: [], retryPending: true, state: result.state, policy, onLocal, now: 10_001 + 24 * 60 * 60 * 1_000,
    })
    expect(expired.events).toHaveLength(0)
    for (const now of [70_000, 130_000, 190_000, 250_000]) {
      result = await dispatchKomariAlertNotifications(state, {
        audit: [], retryPending: true, state: result.state, policy, onLocal, now,
      })
    }
    expect(onLocal).toHaveBeenCalledTimes(4)
    expect(result.events).toHaveLength(0)
  })

  it('does not retry an obsolete lifecycle row or a disabled channel', async () => {
    const onLocal = vi.fn(() => { throw new Error('temporarily unavailable') })
    const policy = { channels: ['local'] as const, cooldownMs: 0 }
    const first = await dispatchKomariAlertNotifications({ ...state, audit: [state.audit[0]!] }, {
      audit: [state.audit[0]!], policy, onLocal, now: 10_000,
    })
    const obsolete = await dispatchKomariAlertNotifications(state, {
      audit: [], retryPending: true, state: first.state, policy, onLocal, now: 70_000,
    })
    expect(obsolete.events).toHaveLength(0)
    const disabled = await dispatchKomariAlertNotifications({ ...state, audit: [state.audit[0]!] }, {
      audit: [], retryPending: true, state: first.state,
      policy: { channels: ['system'] }, onLocal, now: 70_000,
    })
    expect(disabled.events).toHaveLength(0)
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('serializes integration delivery so concurrent consumers do not duplicate a channel', async () => {
    localStorage.clear()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const onLocal = vi.fn(async () => gate)
    const options = { audit: [state.audit[2]!], policy: { channels: ['local'] as const, cooldownMs: 0 }, onLocal, now: 10_000 }
    const first = dispatchAndPersistKomariAlertNotifications('prod', state, options)
    const second = dispatchAndPersistKomariAlertNotifications('prod', state, options)
    await Promise.resolve()
    release()
    const results = await Promise.all([first, second])
    expect(results.map((result) => result.summary.delivered)).toEqual([1, 0])
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(loadKomariAlertNotificationState('prod').deliveries).toHaveLength(1)
  })

  it('uses dispatch time for attempts and notifies mounted delivery indicators after saving', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(50_000)
    const onLocal = vi.fn()
    const listener = vi.fn()
    window.addEventListener('shellbeam:notification-delivery-changed', listener)
    try {
      const result = await dispatchKomariAlertNotifications(state, {
        audit: [state.audit[2]!], policy: { channels: ['local'], cooldownMs: 0 }, onLocal,
      })
      expect(result.state.attempts?.[0]?.attemptedAt).toBe(50_000)
      expect(result.events[0]?.payload.occurredAt).toBe(3_000)
      saveKomariAlertNotificationState('prod', result.state)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      window.removeEventListener('shellbeam:notification-delivery-changed', listener)
    }
  })

})
