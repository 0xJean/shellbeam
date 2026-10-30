import { NativeSelect } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import {
  DEFAULT_NOTIFICATION_POLICY,
  loadNotificationPolicy,
  notificationPolicySummary,
  saveNotificationPolicy,
  type NotificationChannel,
  type NotificationPolicy,
  type NotificationSeverity,
} from '@/lib/notification-policy'
import {
  dispatchNotification,
  getSystemNotificationPermission,
  requestSystemNotificationPermission,
  type SystemNotificationPermission,
} from '@/lib/notification-dispatch'
import { Bell, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import NotificationDeliverySummary from './notification-delivery-summary'
import { CardHead, Chip, Note, SettingRow, StatusDot, SwitchInput, checkboxClass, mutedText, primaryButton, softBorder } from './monitor-settings-ui'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { cn } from '@/lib/utils'
import { loadNotificationDeliveryState, loadOwnNotificationDeliveryState, saveNotificationDeliveryState, NOTIFICATION_DELIVERY_CHANGED_EVENT } from '@/lib/notification-delivery-state'

const CHANNELS: NotificationChannel[] = ['local', 'webhook', 'system']
const SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical']

export function NotificationSettingsSection() {
  const { t, locale } = useT()
  const [policy, setPolicy] = useState<NotificationPolicy>(loadNotificationPolicy)
  const [deliveryState, setDeliveryState] = useState(loadNotificationDeliveryState)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [systemPermission, setSystemPermission] = useState<SystemNotificationPermission>('default')
  const [systemBusy, setSystemBusy] = useState(false)
  const [systemTestResult, setSystemTestResult] = useState<'accepted' | 'failed' | null>(null)

  useEffect(() => {
    let active = true
    let permissionRead = 0
    function refresh() {
      setDeliveryState(loadNotificationDeliveryState())
      const read = ++permissionRead
      void getSystemNotificationPermission().then((permission) => {
        if (active && read === permissionRead) setSystemPermission(permission)
      })
    }
    function onVisible() { if (document.visibilityState === 'visible') refresh() }
    refresh()
    window.addEventListener(NOTIFICATION_DELIVERY_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.removeEventListener(NOTIFICATION_DELIVERY_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  function update(patch: Partial<NotificationPolicy>) {
    setPolicy((current) => ({ ...current, ...patch }))
    setSaved(false)
    setError('')
  }

  function toggleChannel(channel: NotificationChannel, enabled: boolean) {
    const next = enabled ? [...new Set([...policy.channels, channel])] : policy.channels.filter((item) => item !== channel)
    update({ channels: next.length > 0 ? next : ['local'] })
  }

  function toggleRecoveryChannel(channel: NotificationChannel, enabled: boolean) {
    const next = enabled
      ? [...new Set([...policy.recoveryChannels, channel])]
      : policy.recoveryChannels.filter((item) => item !== channel)
    update({ recoveryChannels: next.length > 0 ? next : ['local'] })
  }

  function save() {
    try {
      setPolicy(saveNotificationPolicy(policy))
      setSaved(true)
      setError('')
    } catch (cause) {
      setSaved(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function requestSystemPermission() {
    setSystemBusy(true)
    try { setSystemPermission(await requestSystemNotificationPermission()) }
    finally { setSystemBusy(false) }
  }

  async function testSystemNotification() {
    setSystemBusy(true)
    setSystemTestResult(null)
    try {
      const result = await dispatchNotification({
        eventId: `system-test-${crypto.randomUUID()}`,
        source: 'shellbeam', kind: 'notification.test', severity: 'info',
        title: t('settings.notifications.testTitle'),
        message: t('settings.notifications.testBody'),
        fingerprint: 'shellbeam-system-test',
      }, {
        // The explicit test action is independent of unsaved alert policy.
        policy: { enabled: true, channels: ['system'], minimumSeverity: 'info', cooldownMs: 0, dedupeWindowMs: 0 },
        state: loadOwnNotificationDeliveryState(),
      })
      saveNotificationDeliveryState(result.state)
      setSystemTestResult(result.deliveries.some((entry) => entry.status === 'delivered') ? 'accepted' : 'failed')
      setSystemPermission(await getSystemNotificationPermission())
    } finally { setSystemBusy(false) }
  }

  const summary = notificationPolicySummary(policy)
  const v3 = monitorSettingsCopy[locale]
  const chip = (checked: boolean) => cn('flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs text-[color:var(--workspace-text)]', !checked && mutedText)

  return (
    <section className="grid min-w-0 gap-3 xl:grid-cols-2 xl:items-start" data-testid="notification-settings">
      <h3 className="sr-only">{t('settings.notifications.title')}</h3>
      <div className="min-w-0 space-y-3">
        <div className="sb-card overflow-hidden">
          <SettingRow title={t('settings.notifications.enable')} hint={t('settings.notifications.description')}>
            <Chip tone={summary.enabled ? 'good' : undefined}>{summary.enabled ? t('settings.notifications.enabled') : t('settings.notifications.disabled')}</Chip>
            <SwitchInput aria-label={t('settings.notifications.enable')} checked={policy.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          </SettingRow>
          <SettingRow title={t('settings.notifications.channels')} hint={v3.channelsHint}>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {CHANNELS.map((channel) => (
                <label key={channel} className={chip(policy.channels.includes(channel))}>
                  <input type="checkbox" checked={policy.channels.includes(channel)} onChange={(event) => toggleChannel(channel, event.target.checked)} className={checkboxClass} />
                  {t(`settings.notifications.channel.${channel}`)}
                </label>
              ))}
            </div>
          </SettingRow>
          {(policy.channels.includes('system') || policy.recoveryChannels.includes('system')) && (
            <SettingRow title={v3.systemPermission} hint={t('settings.notifications.systemHelp')}>
              <StatusDot tone={systemPermission === 'granted' ? 'good' : systemPermission === 'denied' ? 'bad' : undefined}><span role="status">{t(`settings.notifications.systemPermission.${systemPermission}`)}</span></StatusDot>
              <Button type="button" variant="ghost" size="sm" onClick={requestSystemPermission} disabled={systemBusy || systemPermission !== 'default'}>
                {t('settings.notifications.requestSystemPermission')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={testSystemNotification} disabled={systemBusy}>
                {t('settings.notifications.testSystem')}
              </Button>
              {systemTestResult && <span role="status" className={cn('text-xs', systemTestResult === 'accepted' ? 'text-[color:var(--workspace-status-good-text)]' : 'text-[color:var(--workspace-status-bad-text)]')}>{t(`settings.notifications.testResult.${systemTestResult}`)}</span>}
            </SettingRow>
          )}
          <div className={cn('border-b px-4 py-3 last:border-b-0', softBorder)}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <label className="text-sm font-medium text-[color:var(--workspace-text-strong)]" htmlFor="notification-webhook">{t('settings.notifications.webhookUrl')}</label>
              <Input id="notification-webhook" value={policy.webhookUrl ?? ''} onChange={(event) => update({ webhookUrl: event.target.value || null })} placeholder="https://alerts.example/hooks/..." className="h-8 w-full max-w-xs font-mono text-xs" autoComplete="off" />
            </div>
            <p className={cn('mt-1 text-xs', mutedText)}>{t('settings.notifications.webhookHelp')}</p>
          </div>
        </div>

        <div className="sb-card overflow-hidden" data-testid="notification-recovery-settings">
          <SettingRow title={t('settings.notifications.notifyRecovery')} hint={t('settings.notifications.recoveryDescription')}>
            <SwitchInput data-testid="notification-recovery-enabled" aria-label={t('settings.notifications.notifyRecovery')} checked={policy.notifyOnRecovery} onChange={(event) => update({ notifyOnRecovery: event.target.checked })} />
          </SettingRow>
          <SettingRow title={t('settings.notifications.recoveryChannels')}>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {CHANNELS.map((channel) => (
                <label key={`recovery-${channel}`} className={chip(policy.recoveryChannels.includes(channel))}>
                  <input
                    data-testid={`notification-recovery-channel-${channel}`}
                    type="checkbox"
                    checked={policy.recoveryChannels.includes(channel)}
                    aria-label={t(`settings.notifications.recoveryChannel.${channel}`)}
                    onChange={(event) => toggleRecoveryChannel(channel, event.target.checked)}
                    className={checkboxClass}
                  />
                  {t(`settings.notifications.recoveryChannel.${channel}`)}
                </label>
              ))}
            </div>
          </SettingRow>
          <SettingRow title={t('settings.notifications.includeSummary')}>
            <SwitchInput data-testid="notification-include-alert-summary" aria-label={t('settings.notifications.includeSummary')} checked={policy.includeAlertSummary} onChange={(event) => update({ includeAlertSummary: event.target.checked })} />
          </SettingRow>
        </div>
      </div>

      <div className="min-w-0 space-y-3">
        <div className="sb-card overflow-hidden">
          <SettingRow title={t('settings.notifications.minimumSeverity')}>
            <NativeSelect aria-label={t('settings.notifications.minimumSeverity')} value={policy.minimumSeverity} onChange={(event) => update({ minimumSeverity: event.target.value as NotificationSeverity })} className="h-8 w-32 rounded-md border bg-background px-2 text-xs">
              {SEVERITIES.map((severity) => <option key={severity} value={severity}>{t(`settings.notifications.severity.${severity}`)}</option>)}
            </NativeSelect>
          </SettingRow>
          <SettingRow title={t('settings.notifications.cooldownMinutes')}>
            <Input aria-label={t('settings.notifications.cooldownMinutes')} type="number" min={0} value={Math.round(policy.cooldownMs / 60_000)} onChange={(event) => update({ cooldownMs: Math.max(0, Number(event.target.value) || 0) * 60_000 })} className="h-8 w-20 text-right font-mono text-xs" />
            <span className={cn('text-xs', mutedText)}>{v3.minutes}</span>
          </SettingRow>
          <SettingRow title={t('settings.notifications.dedupeSeconds')}>
            <Input aria-label={t('settings.notifications.dedupeSeconds')} type="number" min={0} value={Math.round(policy.dedupeWindowMs / 1000)} onChange={(event) => update({ dedupeWindowMs: Math.max(0, Number(event.target.value) || 0) * 1000 })} className="h-8 w-20 text-right font-mono text-xs" />
            <span className={cn('text-xs', mutedText)}>{v3.seconds}</span>
          </SettingRow>
          <div className={cn('space-y-1.5 border-t px-4 py-3', softBorder)}>
            <Note icon={ShieldCheck}>{t('settings.notifications.redactionNote')}</Note>
            <Note icon={LockKeyhole}>{t('settings.notifications.storageNote')}</Note>
          </div>
          <div className={cn('flex flex-wrap items-center gap-2 border-t px-4 py-3', softBorder)}>
            {saved && <span role="status" className="text-xs text-[color:var(--workspace-status-good-text)]">{t('settings.notifications.saved')}</span>}
            {error && <span role="alert" className="text-xs text-[color:var(--workspace-status-bad-text)]">{error}</span>}
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPolicy({ ...DEFAULT_NOTIFICATION_POLICY, channels: [...DEFAULT_NOTIFICATION_POLICY.channels], recoveryChannels: [...DEFAULT_NOTIFICATION_POLICY.recoveryChannels] }); setSaved(false); setError('') }}>{t('settings.notifications.reset')}</Button>
            <Button type="button" size="sm" className={primaryButton} onClick={save}>{t('settings.notifications.save')}</Button>
          </div>
        </div>

        <div className="sb-card overflow-hidden">
          <CardHead title={<span className="flex items-center gap-2"><Bell className="h-3.5 w-3.5" aria-hidden="true" />{v3.delivery}</span>} />
          <div className="p-3"><NotificationDeliverySummary state={deliveryState} compact /></div>
        </div>
      </div>
    </section>
  )
}

export default NotificationSettingsSection
