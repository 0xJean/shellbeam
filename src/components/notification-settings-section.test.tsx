import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { loadNotificationPolicy } from '@/lib/notification-policy'
import { NotificationSettingsSection } from './notification-settings-section'
import { loadNotificationDeliveryState, saveNotificationDeliveryState } from '@/lib/notification-delivery-state'
import { saveKomariAlertNotificationState } from '@/lib/komari-alert-notifications'

const native = vi.hoisted(() => ({ permission: vi.fn(), request: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/system-notifications', async (original) => ({
  ...await original<typeof import('@/lib/system-notifications')>(),
  getSystemNotificationPermission: native.permission,
  requestSystemNotificationPermission: native.request,
  sendSystemNotification: native.send,
}))

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
    vi.clearAllMocks()
    native.permission.mockResolvedValue('default')
    native.request.mockResolvedValue('granted')
    native.send.mockResolvedValue(undefined)
  })

  it('saves bounded channel and severity settings without webhook credentials', async () => {
    render(<I18nProvider><NotificationSettingsSection /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Webhook'))
    fireEvent.change(screen.getByLabelText('Minimum severity'), { target: { value: 'critical' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://alerts.example/hooks/abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification policy' }))
    expect(loadNotificationPolicy()).toMatchObject({ minimumSeverity: 'critical', webhookUrl: 'https://alerts.example/hooks/abc', channels: ['local', 'webhook'] })
    expect(screen.getByRole('status')).toHaveTextContent('Notification policy saved')
    await waitFor(() => expect(native.permission).toHaveBeenCalled())
  })

  it('persists recovery notification controls and bounded alert summaries', async () => {
    render(<I18nProvider><NotificationSettingsSection /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Send recovery notifications'))
    fireEvent.click(screen.getByLabelText('Recovery: Webhook'))
    fireEvent.click(screen.getByLabelText('Include the bounded alert summary in notification metadata'))
    fireEvent.click(screen.getByRole('button', { name: 'Save notification policy' }))
    expect(loadNotificationPolicy()).toMatchObject({
      notifyOnRecovery: false,
      recoveryChannels: ['local', 'webhook'],
      includeAlertSummary: false,
    })
    await waitFor(() => expect(native.permission).toHaveBeenCalled())
  })
  it('requests permission only on user action and journals a test notification', async () => {
    render(<I18nProvider><NotificationSettingsSection /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('System'))
    await waitFor(() => expect(native.permission).toHaveBeenCalled())
    expect(native.request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow system notifications' }))
    await waitFor(() => expect(native.request).toHaveBeenCalledTimes(1))
    native.permission.mockResolvedValue('granted')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
    await waitFor(() => expect(native.send).toHaveBeenCalledWith({ title: 'ShellBeam notification test', body: 'The system notification channel accepted this test.' }))
    await waitFor(() => expect(screen.getByText(/Submitted to the system/)).toBeInTheDocument())
    expect(loadNotificationDeliveryState().attempts).toEqual([expect.objectContaining({ channel: 'system', status: 'delivered' })])
    expect(localStorage.getItem('shellbeam.notificationDeliveryState')).not.toContain('notification test')
  })

  it('refreshes diagnostics from same-session Komari saves and cross-session storage events', async () => {
    render(<I18nProvider><NotificationSettingsSection /></I18nProvider>)
    await waitFor(() => expect(native.permission).toHaveBeenCalled())
    await act(async () => { saveKomariAlertNotificationState('prod', { deliveries: [], attempts: [
      { key: 'k', eventId: 'audit-1', channel: 'system', status: 'failed', reason: 'system-permission-denied', attemptedAt: 10 },
    ] }); })
    expect(screen.getByText('1 blocked deliveries')).toBeInTheDocument()
    localStorage.setItem('shellbeam.komariNotificationState.v1:prod', JSON.stringify({ deliveries: [], attempts: [
      { key: 'k', eventId: 'audit-1', channel: 'system', status: 'delivered', attemptedAt: 20 },
    ] }))
    await act(async () => { window.dispatchEvent(new StorageEvent('storage')) })
    expect(screen.queryByText('1 blocked deliveries')).not.toBeInTheDocument()
    await act(async () => { saveNotificationDeliveryState({ deliveries: [], attempts: [
      { key: 'network', eventId: 'audit-2', channel: 'webhook', status: 'failed', reason: 'delivery-timeout', attemptedAt: 30 },
    ] }); })
    expect(screen.getByText('1 notifications last failed')).toBeInTheDocument()
  })

})
