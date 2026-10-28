import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import { KOMARI_NOTIFICATION_EVENT } from '@/lib/komari-alert-notifications'
import type { NotificationPayload } from '@/lib/notification-dispatch'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const MAX_VISIBLE = 4
/** Critical alerts stay until dismissed; others fade after this long. */
const AUTO_DISMISS_MS = 8_000

interface Toast { key: number; payload: NotificationPayload }

/**
 * Shows notifications delivered through the "in app" channel. The dispatcher
 * already emitted `shellbeam:notification` for that channel, but nothing was
 * listening, so these alerts were silently dropped.
 */
export function InAppNotifications() {
  const { t, locale } = useT()
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = (key: number) => {
    const timer = timers.current.get(key)
    if (timer) clearTimeout(timer)
    timers.current.delete(key)
    setToasts((list) => list.filter((toast) => toast.key !== key))
  }

  useEffect(() => {
    const scheduled = timers.current
    const onNotification = (event: Event) => {
      const payload = (event as CustomEvent<NotificationPayload>).detail
      if (!payload?.title) return
      const key = ++next.current
      setToasts((list) => [...list.filter((toast) => toast.payload.fingerprint !== payload.fingerprint || !payload.fingerprint), { key, payload }].slice(-MAX_VISIBLE))
      if (payload.severity !== 'critical') scheduled.set(key, setTimeout(() => { scheduled.delete(key); setToasts((list) => list.filter((toast) => toast.key !== key)) }, AUTO_DISMISS_MS))
    }
    window.addEventListener(KOMARI_NOTIFICATION_EVENT, onNotification)
    return () => {
      window.removeEventListener(KOMARI_NOTIFICATION_EVENT, onNotification)
      for (const timer of scheduled.values()) clearTimeout(timer)
      scheduled.clear()
    }
  }, [])

  if (toasts.length === 0 || typeof document === 'undefined') return null
  return createPortal(
    <div aria-live="polite" className="pointer-events-none fixed right-4 top-4 z-[70] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map(({ key, payload }) => {
        const Icon = payload.severity === 'critical' ? CircleAlert : payload.severity === 'warning' ? TriangleAlert : Info
        return (
          <div key={key} role={payload.severity === 'critical' ? 'alert' : 'status'} data-testid="in-app-notification" data-severity={payload.severity}
            className={cn('sb-card pointer-events-auto flex gap-3 p-3 shadow-lg',
              payload.severity === 'critical' && 'shadow-[inset_3px_0_0_var(--workspace-status-bad)]',
              payload.severity === 'warning' && 'shadow-[inset_3px_0_0_var(--workspace-status-warn)]')}>
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', payload.severity === 'critical' ? 'text-[var(--workspace-status-bad)]' : payload.severity === 'warning' ? 'text-[var(--workspace-status-warn)]' : 'text-[var(--workspace-accent-text)]')} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--workspace-text-strong)]">{payload.title}</p>
              {payload.message && <p className="mt-0.5 line-clamp-3 break-words text-xs text-[var(--workspace-text-muted)]">{payload.message}</p>}
              <p className="mt-1 text-[11px] text-[var(--workspace-text-subtle)]">{[payload.hostName, new Date(payload.occurredAt).toLocaleTimeString(locale)].filter(Boolean).join(' · ')}</p>
            </div>
            <button type="button" aria-label={t('common.close')} className="-m-1 h-6 w-6 shrink-0 rounded-md p-1 text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]" onClick={() => dismiss(key)}><X className="h-4 w-4" /></button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
