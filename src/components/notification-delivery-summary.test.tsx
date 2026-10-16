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
})
