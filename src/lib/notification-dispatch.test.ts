import { describe, expect, it, vi } from 'vitest'
import { dispatchNotification, redactNotificationText, createNotificationDispatcher } from './notification-dispatch'
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
      { channel: 'webhook', status: 'failed', error: 'webhook returned HTTP 500' },
      { channel: 'system', status: 'skipped', reason: 'channel-unavailable' },
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
})
