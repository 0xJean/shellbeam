import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { loadNotificationPolicy } from '@/lib/notification-policy'
import { NotificationSettingsSection } from './notification-settings-section'

describe('NotificationSettingsSection', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
  })

  it('saves bounded channel and severity settings without webhook credentials', () => {
    render(<I18nProvider><NotificationSettingsSection /></I18nProvider>)
    fireEvent.click(screen.getByLabelText('Webhook'))
    fireEvent.change(screen.getByLabelText('Minimum severity'), { target: { value: 'critical' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://alerts.example/hooks/abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification policy' }))
    expect(loadNotificationPolicy()).toMatchObject({ minimumSeverity: 'critical', webhookUrl: 'https://alerts.example/hooks/abc', channels: ['local', 'webhook'] })
    expect(screen.getByRole('status')).toHaveTextContent('Notification policy saved')
  })

  it('persists recovery notification controls and bounded alert summaries', () => {
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
  })
})
