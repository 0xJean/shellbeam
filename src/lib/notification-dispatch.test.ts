import { describe, expect, it, vi } from 'vitest'
import { dispatchNotification, redactNotificationText, createNotificationDispatcher, NOTIFICATION_DELIVERY_TIMEOUT_MS } from './notification-dispatch'
import type { NotificationEvent } from './notification-policy'

const event: NotificationEvent = {
  eventId: 'event-1',
  source: 'komari',
  kind: 'offline',
  severity: 'critical',
  title: 'Host offline',
  message: 'probe token=secret-value; password: hunter2',
  fingerprint: 'komari|integration|host|offline',
  hostId: 'host-1',
  hostName: 'production',
  integrationId: 'integration-1',
  status: 'active',
  occurredAt: 10_000,
  metadata: { node: 'node-1', apiToken: 'secret-value', nested: { password: 'hunter2', count: 2 } },
}

describe('notification dispatch', () => {
  it('delivers the system channel through the browser notification surface with redacted text', async () => {
    const shown: Array<{ title: string; options?: NotificationOptions }> = []
    class MockNotification {
      static permission: NotificationPermission = 'granted'
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, options })
      }
    }
    vi.stubGlobal('Notification', MockNotification as unknown as typeof Notification)
    try {
      const result = await dispatchNotification(event, {
        now: 10_000,
        policy: { channels: ['system'] },
      })
      expect(result.deliveries).toEqual([{ channel: 'system', status: 'delivered', deliveredAt: 10_000 }])
      expect(shown).toEqual([{
        title: 'Host offline',
        options: { body: 'probe token=<redacted>; password: <redacted>' },
      }])
      expect(JSON.stringify(shown)).not.toContain('secret-value')
      expect(JSON.stringify(shown)).not.toContain('hunter2')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records missing permission without prompting during background delivery', async () => {
    const shown: string[] = []
    class MockNotification {
      static permission: NotificationPermission = 'default'
      static requestPermission = vi.fn(async () => {
        MockNotification.permission = 'granted'
        return 'granted' as NotificationPermission
      })
      constructor(title: string) {
        shown.push(title)
      }
    }
    vi.stubGlobal('Notification', MockNotification as unknown as typeof Notification)
    try {
      const result = await dispatchNotification(event, { policy: { channels: ['system'] }, now: 10_100 })
      expect(result.deliveries[0]).toMatchObject({ channel: 'system', status: 'failed', reason: 'system-permission-required' })
      expect(result.state.attempts).toEqual([expect.objectContaining({ channel: 'system', status: 'failed', reason: 'system-permission-required', attemptedAt: 10_100 })])
      expect(MockNotification.requestPermission).not.toHaveBeenCalled()
      expect(shown).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records a denied system permission as a failed delivery without exposing payload data', async () => {
    class MockNotification {
      static permission: NotificationPermission = 'denied'
      static requestPermission = vi.fn(async () => 'denied' as NotificationPermission)
      constructor() {
        throw new Error('constructor should not be called when permission is denied')
      }
    }
    const logger = vi.fn()
    vi.stubGlobal('Notification', MockNotification as unknown as typeof Notification)
    try {
      const result = await dispatchNotification(event, { policy: { channels: ['system'] }, logger: { warn: logger }, now: 10_200 })
      expect(result.deliveries[0]).toMatchObject({ channel: 'system', status: 'failed', error: 'system-permission-denied' })
      expect(logger).toHaveBeenCalledWith('Notification system delivery failed: system-permission-denied')
      expect(JSON.stringify(logger.mock.calls)).not.toContain('secret-value')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('delivers a redacted payload to local, webhook and system channels', async () => {
    const onLocal = vi.fn()
    const onSystem = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
    const result = await dispatchNotification(event, {
      now: 10_000,
      policy: { channels: ['local', 'webhook', 'system'], webhookUrl: 'https://alerts.example.test/hook' },
      onLocal,
      onSystem,
      fetchImpl,
    })
    expect(result.deliveries.map((entry) => entry.status)).toEqual(['delivered', 'delivered', 'delivered'])
    expect(onLocal).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('<redacted>') }))
    expect(onLocal.mock.calls[0]?.[0].metadata).toEqual({ node: 'node-1', nested: { count: 2 } })
    expect(onSystem).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = fetchImpl.mock.calls[0]?.[1]
    expect(request?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    expect(body.message).toContain('<redacted>')
    expect(JSON.stringify(body)).not.toContain('secret-value')
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it('deduplicates the same event and applies cooldown to repeated lifecycle state', async () => {
    const onLocal = vi.fn()
    const policy = { channels: ['local'] as const, dedupeWindowMs: 60_000, cooldownMs: 300_000 }
    const first = await dispatchNotification(event, { policy, now: 10_000, onLocal })
    const second = await dispatchNotification(event, { policy, now: 10_500, onLocal, state: first.state })
    const changedEvent = { ...event, eventId: 'event-2', message: 'same condition, updated count' }
    const third = await dispatchNotification(changedEvent, { policy, now: 11_000, onLocal, state: second.state })
    const recovered = await dispatchNotification({ ...event, eventId: 'event-3', status: 'resolved', message: 'host recovered' }, { policy, now: 11_500, onLocal, state: third.state })
    expect(first.deliveries[0]).toMatchObject({ status: 'delivered' })
    expect(second.deliveries[0]).toMatchObject({ status: 'skipped', reason: 'deduplicated' })
    expect(third.deliveries[0]).toMatchObject({ status: 'skipped', reason: 'cooldown' })
    expect(recovered.deliveries[0]).toMatchObject({ status: 'delivered' })
    expect(onLocal).toHaveBeenCalledTimes(2)
  })

  it('routes recovery events through their dedicated channels', async () => {
    const onLocal = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
    const result = await dispatchNotification({
      ...event,
      kind: 'alert.resolved',
      eventId: 'event-recovered',
      status: 'resolved',
      metadata: { recovered: true },
    }, {
      policy: {
        channels: ['local'],
        recoveryChannels: ['webhook'],
        webhookUrl: 'https://alerts.example.test/recovery',
        cooldownMs: 0,
      },
      onLocal,
      fetchImpl,
    })
    expect(result.deliveries).toEqual([{ channel: 'webhook', status: 'delivered', deliveredAt: expect.any(Number) }])
    expect(onLocal).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not record unavailable channels or failed deliveries as successful sends', async () => {
    const logger = vi.fn()
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }))
    const result = await dispatchNotification(event, {
      policy: { channels: ['local', 'webhook', 'system'], webhookUrl: 'https://alerts.example.test/hook' },
      fetchImpl: failedFetch,
      logger: { warn: logger },
    })
    expect(result.deliveries).toEqual([
      { channel: 'local', status: 'skipped', reason: 'channel-unavailable' },
      { channel: 'webhook', status: 'failed', reason: 'webhook-http-error', error: 'webhook returned HTTP 500' },
      { channel: 'system', status: 'failed', reason: 'system-unavailable', error: 'system-unavailable' },
    ])
    expect(result.state.deliveries).toHaveLength(0)
    expect(logger).toHaveBeenCalledWith('Notification webhook delivery failed: webhook returned HTTP 500')
  })

  it('respects disabled and severity policies without calling sinks', async () => {
    const onLocal = vi.fn()
    const disabled = await dispatchNotification(event, { policy: { enabled: false, channels: ['local'] }, onLocal })
    const below = await dispatchNotification({ ...event, severity: 'info' }, { policy: { channels: ['local'], minimumSeverity: 'warning' }, onLocal })
    expect(disabled.deliveries[0]).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(below.deliveries[0]).toMatchObject({ status: 'skipped', reason: 'below-minimum-severity' })
    expect(onLocal).not.toHaveBeenCalled()
  })

  it('keeps state in a dispatcher and redacts diagnostic text', async () => {
    const onLocal = vi.fn()
    const dispatcher = createNotificationDispatcher({ policy: { channels: ['local'], cooldownMs: 0 }, onLocal })
    await dispatcher.dispatch(event)
    expect(dispatcher.getState().deliveries).toHaveLength(1)
    dispatcher.reset()
    expect(dispatcher.getState().deliveries).toHaveLength(0)
    expect(redactNotificationText('Authorization: Bearer abc password=hunter2')).toBe('Authorization: <redacted> <redacted> password=<redacted>')
    expect(redactNotificationText('https://example.test/hook?token=secret-value&ok=1')).toContain('token=<redacted>')
    expect(redactNotificationText('POST https://user:password@example.test/hook')).toContain('https://<redacted>@example.test')
  })
  it('bounds a hanging webhook request and continues to other channels', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}))
      const onSystem = vi.fn()
      const pending = dispatchNotification(event, {
        policy: { channels: ['webhook', 'system'], webhookUrl: 'https://alerts.example.test/hook' },
        fetchImpl, onSystem, now: 5_000,
      })
      await vi.advanceTimersByTimeAsync(NOTIFICATION_DELIVERY_TIMEOUT_MS)
      const result = await pending
      expect(result.deliveries).toEqual([
        expect.objectContaining({ channel: 'webhook', status: 'failed', reason: 'delivery-timeout' }),
        expect.objectContaining({ channel: 'system', status: 'delivered' }),
      ])
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      expect(onSystem).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('persists fixed diagnostics and opaque fallback keys without sink error bodies', async () => {
    const result = await dispatchNotification({ ...event, eventId: undefined }, {
      policy: { channels: ['webhook'], webhookUrl: 'https://alerts.example.test/hook' },
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('raw provider response password=hunter2 https://user:secret@example.test/path')),
      now: 50,
    })
    expect(result.state.attempts).toEqual([{
      key: expect.stringMatching(/^[0-9a-f]+-[0-9a-f]+$/), eventId: null, channel: 'webhook',
      status: 'failed', reason: 'webhook-request-failed', attemptedAt: 50,
    }])
    expect(JSON.stringify(result.state)).not.toMatch(/hunter2|secret-value|provider response|Host offline/)
  })

  it('deduplicates events without ids without persisting their titles or messages', async () => {
    const onLocal = vi.fn()
    const first = await dispatchNotification({ ...event, eventId: undefined }, {
      policy: { channels: ['local'] }, onLocal, now: 1_000,
    })
    const second = await dispatchNotification({ ...event, eventId: undefined }, {
      policy: { channels: ['local'] }, onLocal, now: 2_000, state: first.state,
    })
    expect(second.deliveries[0]?.reason).toBe('deduplicated')
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first.state)).not.toMatch(/Host offline|probe token|secret-value|hunter2/)
  })

})
