import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitKomariAlertNotification } from '@/lib/komari-alert-notifications'
import type { NotificationPayload } from '@/lib/notification-dispatch'
import { InAppNotifications } from './in-app-notifications'

const payload = (patch: Partial<NotificationPayload> = {}): NotificationPayload => ({
  eventId: 'e', source: 'komari', kind: 'alert', severity: 'warning', title: 'Disk 91% on db-master', message: 'Above 90% for 5 minutes',
  fingerprint: 'fp-1', hostId: 'h1', hostName: 'db-master', integrationId: 's1', status: 'active', occurredAt: Date.now(), metadata: {}, ...patch,
})

describe('InAppNotifications', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows in-app notifications and fades non-critical ones', () => {
    render(<InAppNotifications />)
    act(() => emitKomariAlertNotification(payload()))
    expect(screen.getByTestId('in-app-notification')).toHaveTextContent('Disk 91% on db-master')
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(screen.queryByTestId('in-app-notification')).not.toBeInTheDocument()
  })

  it('keeps critical alerts until dismissed and replaces repeats of the same alert', () => {
    render(<InAppNotifications />)
    act(() => emitKomariAlertNotification(payload({ severity: 'critical' })))
    act(() => emitKomariAlertNotification(payload({ severity: 'critical', title: 'Disk 95% on db-master' })))
    expect(screen.getAllByTestId('in-app-notification')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Disk 95%')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByTestId('in-app-notification')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('in-app-notification')).not.toBeInTheDocument()
  })

  it('shows at most four at once', () => {
    render(<InAppNotifications />)
    act(() => { for (let i = 0; i < 6; i++) emitKomariAlertNotification(payload({ fingerprint: `fp-${i}`, title: `Alert ${i}` })) })
    const shown = screen.getAllByTestId('in-app-notification')
    expect(shown).toHaveLength(4)
    expect(shown[3]).toHaveTextContent('Alert 5')
  })
})
