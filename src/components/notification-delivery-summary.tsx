import { AlertTriangle, BellRing, CheckCircle2, Clock3, Radio, Webhook } from 'lucide-react'
import { useMemo } from 'react'
import { useT } from '@/lib/i18n'
import type { NotificationChannel } from '@/lib/notification-policy'
import type { NotificationDispatchState } from '@/lib/notification-dispatch'
import { summarizeNotificationDeliveries } from '@/lib/notification-delivery-state'
import { cn } from '@/lib/utils'

/** Optional aggregate returned by the Komari notification bridge. The
 * component intentionally accepts a structural type so settings can render
 * persisted delivery state even when no Komari integration is configured. */
export interface NotificationDispatchSummary {
  considered: number
  delivered: number
  /** Backwards-compatible alias for callers that describe sends as dispatches. */
  dispatched?: number
  skipped: number
  failed: number
  lastDeliveredAt?: number | null
}

export interface NotificationDeliverySummaryProps {
  state?: NotificationDispatchState | null
  summary?: NotificationDispatchSummary | null
  compact?: boolean
  className?: string
}

function formatTime(value: number | null | undefined, locale: string) {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return '—'
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

const CHANNEL_ICONS: Record<NotificationChannel, typeof Radio> = {
  local: BellRing,
  webhook: Webhook,
  system: Radio,
}

/** A small, payload-free delivery indicator shared by settings and alert
 * surfaces. It reports what was delivered, not whether an alert is healthy. */
export function NotificationDeliverySummary({ state, summary, compact = false, className }: NotificationDeliverySummaryProps) {
  const { t, locale } = useT()
  const persisted = useMemo(() => summarizeNotificationDeliveries(state ?? { deliveries: [] }), [state])
  const currentDelivered = summary?.delivered ?? summary?.dispatched
  // A replay normally produces only skipped rows. Preserve the durable
  // ledger's successful count in that case so a refresh does not appear to
  // erase the user's delivery history.
  const delivered = currentDelivered === undefined ? persisted.delivered : Math.max(currentDelivered, persisted.delivered)
  const recent = persisted.recentDelivered
  const lastDeliveredAt = summary?.lastDeliveredAt ?? persisted.lastDeliveredAt
  const channels = Object.entries(persisted.byChannel) as Array<[NotificationChannel, number]>

  return (
    <section data-testid="notification-delivery-summary" className={cn('rounded-lg border border-border/60 bg-muted/10', compact ? 'px-3 py-2.5' : 'px-4 py-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-semibold"><BellRing className="h-4 w-4" />{t('settings.notifications.deliveryTitle')}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.notifications.deliveryDescription')}</p>
        </div>
        <span className={cn('rounded-full border px-2 py-1 text-[10px] font-medium', delivered > 0 ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300' : 'border-border/60 text-muted-foreground')}>
          {t('settings.notifications.deliveryCount', { count: delivered })}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{t('settings.notifications.recentCount', { count: recent })}</div>
        <div className="flex items-center gap-2 text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{t('settings.notifications.lastDelivered', { time: formatTime(lastDeliveredAt, locale) })}</div>
      </div>

      {persisted.lastAttemptedAt !== null && (
        <p className="mt-2 text-xs text-muted-foreground">{t('settings.notifications.lastAttempt', { time: formatTime(persisted.lastAttemptedAt, locale) })}</p>
      )}

      {(persisted.failed > 0 || persisted.blocked > 0) && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          {persisted.failed > 0 && <span>{t('settings.notifications.pendingFailures', { count: persisted.failed })}</span>}
          {persisted.blocked > 0 && <span>{t('settings.notifications.pendingBlocked', { count: persisted.blocked })}</span>}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {channels.map(([channel, count]) => {
          const Icon = CHANNEL_ICONS[channel]
          const outcome = persisted.byChannelOutcome[channel]
          return (
            <div key={channel} data-testid={`notification-channel-${channel}`} className="rounded-md border border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Icon className="h-3 w-3" />{t(`settings.notifications.channel.${channel}`)}: <span data-testid="notification-channel-count">{count}</span></span>
              {outcome && <p className="mt-1"><span data-testid="notification-channel-outcome">{t(`settings.notifications.outcome.${outcome.status === 'skipped' ? 'blocked' : outcome.status}`)}</span>{outcome.reason ? ` · ${t(`settings.notifications.reason.${outcome.reason}`)}` : ''}</p>}
            </div>
          )
        })}
      </div>

      {summary && (summary.failed > 0 || summary.skipped > 0) && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t('settings.notifications.deliveryBreakdown', { skipped: summary.skipped, failed: summary.failed })}</p>
      )}
    </section>
  )
}

export default NotificationDeliverySummary
