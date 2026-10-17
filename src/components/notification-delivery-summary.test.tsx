import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { NotificationDeliverySummary } from './notification-delivery-summary'

describe('NotificationDeliverySummary', () => {
  it('shows aggregate bridge results and channel counters without payloads', () => {
    render(<I18nProvider><NotificationDeliverySummary
      summary={{ considered: 4, delivered: 2, skipped: 1, failed: 1, lastDeliveredAt: 1_000 }}
      state={{ deliveries: [{ key: 'local', fingerprint: 'f', eventKey: 'e', eventId: null, status: 'active', channel: 'local', deliveredAt: 1_000 }] }}
    /></I18nProvider>)
    expect(screen.getByTestId('notification-delivery-summary')).toBeInTheDocument()
    expect(screen.getByText('2 delivered')).toBeInTheDocument()
    expect(screen.getByText('1 skipped · 1 failed')).toBeInTheDocument()
    expect(screen.queryByText(/token|secret/i)).not.toBeInTheDocument()
  })

  it('renders an empty state from persisted metadata', () => {
    render(<I18nProvider><NotificationDeliverySummary state={{ deliveries: [] }} /></I18nProvider>)
    expect(screen.getByText('0 delivered')).toBeInTheDocument()
    expect(screen.getByText('Last delivery: —')).toBeInTheDocument()
  })

  it('shows durable failed and blocked channels with safe reasons after remount', () => {
    render(<I18nProvider><NotificationDeliverySummary state={{ deliveries: [], attempts: [
      { key: 'webhook-1', eventId: 'audit-1', channel: 'webhook', status: 'failed', reason: 'webhook-http-error', attemptedAt: 1_000 },
      { key: 'system-1', eventId: 'audit-1', channel: 'system', status: 'skipped', reason: 'system-permission-required', attemptedAt: 2_000 },
    ] }} /></I18nProvider>)
    expect(screen.getByTestId('notification-channel-webhook')).toHaveTextContent('Failed')
    expect(screen.getByTestId('notification-channel-system')).toHaveTextContent('Blocked')
    expect(screen.getByRole('status')).toHaveTextContent('1')
    expect(screen.queryByText(/audit-1|webhook-1|system-1/)).not.toBeInTheDocument()
  })

  it('removes pending failure status when the same event succeeds', () => {
    render(<I18nProvider><NotificationDeliverySummary state={{ deliveries: [], attempts: [
      { key: 'webhook-1', eventId: 'audit-1', channel: 'webhook', status: 'failed', reason: 'webhook-http-error', attemptedAt: 1_000 },
      { key: 'webhook-1', eventId: 'audit-1', channel: 'webhook', status: 'delivered', attemptedAt: 2_000 },
    ] }} /></I18nProvider>)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByTestId('notification-channel-webhook')).toHaveTextContent('Accepted')
  })

  it('does not report historical deliveries as recent when a replay summary is present', () => {
    render(<I18nProvider><NotificationDeliverySummary
      summary={{ considered: 1, delivered: 0, skipped: 0, failed: 0 }}
      state={{ deliveries: [{ key: 'local', fingerprint: 'f', eventKey: 'e', eventId: null, status: 'active', channel: 'local', deliveredAt: 1_000 }] }}
    /></I18nProvider>)
    expect(screen.getByText('0 delivered in the last 24 hours')).toBeInTheDocument()
  })

})
