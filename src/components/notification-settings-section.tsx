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
import { Bell, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

const CHANNELS: NotificationChannel[] = ['local', 'webhook', 'system']
const SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical']

export function NotificationSettingsSection() {
  const { t } = useT()
  const [policy, setPolicy] = useState<NotificationPolicy>(loadNotificationPolicy)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  function update(patch: Partial<NotificationPolicy>) {
    setPolicy((current) => ({ ...current, ...patch }))
    setSaved(false)
    setError('')
  }

  function toggleChannel(channel: NotificationChannel, enabled: boolean) {
    const next = enabled ? [...new Set([...policy.channels, channel])] : policy.channels.filter((item) => item !== channel)
    update({ channels: next.length > 0 ? next : ['local'] })
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

  const summary = notificationPolicySummary(policy)

  return (
    <section className="rounded-lg border p-4" data-testid="notification-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Bell className="h-4 w-4" />{t('settings.notifications.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.notifications.description')}</p>
        </div>
        <span className="rounded-full border px-2 py-1 text-[10px] font-medium text-muted-foreground">
          {summary.enabled ? t('settings.notifications.enabled') : t('settings.notifications.disabled')}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={policy.enabled} onChange={(event) => update({ enabled: event.target.checked })} className="rounded" />
          {t('settings.notifications.enable')}
        </label>

        <div>
          <div className="text-sm text-muted-foreground">{t('settings.notifications.channels')}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {CHANNELS.map((channel) => (
              <label key={channel} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <input type="checkbox" checked={policy.channels.includes(channel)} onChange={(event) => toggleChannel(channel, event.target.checked)} className="rounded" />
                {t(`settings.notifications.channel.${channel}`)}
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-muted-foreground">{t('settings.notifications.minimumSeverity')}
            <select value={policy.minimumSeverity} onChange={(event) => update({ minimumSeverity: event.target.value as NotificationSeverity })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-xs">
              {SEVERITIES.map((severity) => <option key={severity} value={severity}>{t(`settings.notifications.severity.${severity}`)}</option>)}
            </select>
          </label>
          <label className="text-sm text-muted-foreground">{t('settings.notifications.cooldownMinutes')}
            <Input type="number" min={0} value={Math.round(policy.cooldownMs / 60_000)} onChange={(event) => update({ cooldownMs: Math.max(0, Number(event.target.value) || 0) * 60_000 })} className="mt-1" />
          </label>
          <label className="text-sm text-muted-foreground">{t('settings.notifications.dedupeSeconds')}
            <Input type="number" min={0} value={Math.round(policy.dedupeWindowMs / 1000)} onChange={(event) => update({ dedupeWindowMs: Math.max(0, Number(event.target.value) || 0) * 1000 })} className="mt-1" />
          </label>
        </div>

        <div>
          <label className="text-sm text-muted-foreground" htmlFor="notification-webhook">{t('settings.notifications.webhookUrl')}</label>
          <Input id="notification-webhook" value={policy.webhookUrl ?? ''} onChange={(event) => update({ webhookUrl: event.target.value || null })} placeholder="https://alerts.example/hooks/..." className="mt-1 font-mono text-xs" autoComplete="off" />
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.notifications.webhookHelp')}</p>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>{t('settings.notifications.redactionNote')}</span>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>{t('settings.notifications.storageNote')}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={save}>{t('settings.notifications.save')}</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setPolicy({ ...DEFAULT_NOTIFICATION_POLICY, channels: [...DEFAULT_NOTIFICATION_POLICY.channels] }); setSaved(false); setError('') }}>{t('settings.notifications.reset')}</Button>
          {saved && <span role="status" className="text-xs text-emerald-600">{t('settings.notifications.saved')}</span>}
          {error && <span role="alert" className="text-xs text-red-500">{error}</span>}
        </div>
      </div>
    </section>
  )
}

export default NotificationSettingsSection
