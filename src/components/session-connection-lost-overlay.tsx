import { RotateCw, Unplug } from 'lucide-react'
import { useOptionalSessions } from '@/contexts/sessions-context'
import { useT } from '@/lib/i18n'
import { connectionStatesCopy } from '@/lib/locales/connection-states'
import { fill } from '@/lib/locales/probe-install'
import { requestCloseSession } from '@/lib/navigation-request'
import { Button } from './ui/button'

interface SessionConnectionLostOverlayProps {
  sessionId: string
  hostName: string
  /** Terminal theme background, used for the translucent scrim. */
  backdrop: string
  isDisconnected: boolean
  isReconnecting?: boolean
  onReconnect?: () => void
}

/** Covers the terminal while a session is lost or auto-reconnecting. */
export function SessionConnectionLostOverlay({
  sessionId,
  hostName,
  backdrop,
  isDisconnected,
  isReconnecting,
  onReconnect,
}: SessionConnectionLostOverlayProps) {
  const { t, locale } = useT()
  const copy = connectionStatesCopy[locale] ?? connectionStatesCopy.en
  const progress = useOptionalSessions()?.reconnectProgress?.[sessionId]

  if (isReconnecting) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center px-4 backdrop-blur-[2px]" style={{ background: `${backdrop}99` }}>
        <div role="status" className="sb-card flex w-full max-w-[380px] flex-col items-center px-7 py-6 text-center shadow-lg">
          <span className="mb-3 h-[30px] w-[30px] animate-spin rounded-full border-[3px] border-[color:var(--workspace-border-strong)] border-t-[color:var(--workspace-primary-500)]" aria-hidden />
          <p className="text-[15px] font-semibold text-[color:var(--workspace-text-strong)]">{t('terminal.reconnecting')}</p>
          <p className="mt-1.5 text-xs text-[color:var(--workspace-text-muted)]">
            {progress && !progress.failedAt
              ? fill(copy.reconnectingDetail, { host: hostName, attempt: progress.attempt, max: progress.maxRetries, seconds: Math.round(progress.intervalMs / 100) / 10 })
              : hostName}
          </p>
          <p className="mt-3 text-[11.5px] leading-5 text-[color:var(--workspace-text-subtle)]">{fill(copy.reconnectSettingsHint, { section: t('settings.reconnect') })}</p>
        </div>
      </div>
    )
  }

  if (!isDisconnected || !onReconnect) return null

  const failedAt = progress?.failedAt
  const time = failedAt ? new Date(failedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : null
  const detail = time && progress && progress.attempt > 0
    ? fill(copy.lostDetail, { host: hostName, time, count: progress.attempt })
    : time ? fill(copy.lostDetailNoAttempts, { host: hostName, time }) : hostName

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center px-4 backdrop-blur-[2px]" style={{ background: `${backdrop}cc` }}>
      <div role="alertdialog" aria-label={t('terminal.connectionLost')} className="sb-card flex w-full max-w-[380px] flex-col items-center px-7 py-6 text-center shadow-lg">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]">
          <Unplug className="h-[22px] w-[22px]" />
        </span>
        <p className="text-[15px] font-semibold text-[color:var(--workspace-text-strong)]">{t('terminal.connectionLost')}</p>
        <p className="mt-1.5 text-xs text-[color:var(--workspace-text-muted)]">{detail}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => requestCloseSession(sessionId)}>
            {copy.closeTab}
          </Button>
          <Button type="button" size="sm" onClick={onReconnect} className="gap-1.5">
            <RotateCw className="h-3.5 w-3.5" />
            {t('terminal.reconnect')}
          </Button>
        </div>
        <p className="mt-3 text-[11.5px] leading-5 text-[color:var(--workspace-text-subtle)]">{copy.lostHint}</p>
      </div>
    </div>
  )
}
