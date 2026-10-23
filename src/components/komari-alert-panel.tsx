import { monitoringAlertTitle, monitoringDiagnostic } from '@/lib/monitoring-presentation'
import { groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import { AlertTriangle, Check, CheckCircle2, ChevronRight, CircleAlert, Clock3, ExternalLink, History, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '@/lib/i18n'
import type {
  KomariAlertAuditEntry,
  KomariAlertRecord,
  KomariAlertState,
  KomariAlertStatus,
} from '@/lib/komari-alerts'
import { cn } from '@/lib/utils'

export interface KomariAlertPanelProps {
  /** A local lifecycle state loaded from the Komari sync cache. */
  state?: KomariAlertState | null
  /** Actions are deliberately controlled by the host/workspace owner so that
   * acknowledgement and close are persisted together with their audit rows. */
  onAcknowledge?: (alert: KomariAlertRecord) => Promise<void> | void
  onClose?: (alert: KomariAlertRecord) => Promise<void> | void
  onOpenHost?: (hostId: string) => void
  onOpenOperation?: (operationJobId: string) => void
  loading?: boolean
  error?: string | null
  compact?: boolean
  className?: string
}

const statusOrder: KomariAlertStatus[] = ['active', 'acknowledged', 'resolved', 'closed']

function formatTime(value: number, locale: string) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusColor(status: KomariAlertStatus) {
  switch (status) {
    case 'active': return 'border-[color:var(--workspace-status-bad)]/40 bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]'
    case 'acknowledged': return 'border-[color:var(--workspace-status-warn)]/40 bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]'
    case 'resolved': return 'border-[color:var(--workspace-status-good)]/40 bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]'
    default: return 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]'
  }
}

function severityIcon(severity: KomariAlertRecord['severity']) {
  if (severity === 'critical') return CircleAlert
  if (severity === 'warning') return AlertTriangle
  return CheckCircle2
}

function statusLabel(t: (key: string) => string, status: KomariAlertStatus) {
  return t(`komariAlerts.status.${status}`)
}

function sortAlerts(alerts: KomariAlertRecord[]) {
  return [...alerts].sort((a, b) => {
    const status = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
    return status || b.lastSeenAt - a.lastSeenAt
  })
}

export function KomariAlertPanel({
  state,
  onAcknowledge,
  onClose,
  onOpenHost,
  onOpenOperation,
  loading = false,
  error = null,
  compact = false,
  className,
}: KomariAlertPanelProps) {
  const { t, locale } = useT()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const incidents = useMemo(() => groupKomariAlertIncidents(state?.alerts ?? []), [state?.alerts])
  const alerts = useMemo(() => sortAlerts(incidents.map((incident) => incident.alert)), [incidents])
  const localOnly = locale === 'zh-CN' ? '确认和归档仅更新 ShellBeam 本地记录，不会修改监控服务的异常事实或停止服务端通知。' : 'Acknowledging or archiving updates ShellBeam records only; remote health and server notifications are unchanged.'
  const open = alerts.filter((alert) => !alert.evidenceStatus && (alert.status === 'active' || alert.status === 'acknowledged')).length
  const audit = state?.audit ?? []

  async function runAction(alert: KomariAlertRecord, action: 'acknowledge' | 'close') {
    setPending(`${action}:${alert.alertId}`)
    try {
      if (action === 'acknowledge') await onAcknowledge?.(alert)
      else await onClose?.(alert)
    } finally {
      setPending(null)
    }
  }

  return (
    <section
      data-testid="komari-alert-panel"
      className={cn('min-w-0 rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-card)]', className)}
    >
      <header className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--workspace-border-soft)]', compact ? 'px-3 py-2.5' : 'px-4 py-3')}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]">
            <AlertTriangle className="h-4 w-4 text-[color:var(--workspace-status-warn-text)]" />
            {locale === 'zh-CN' ? '告警' : 'Alerts'}
          </div>
          <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{localOnly}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full border border-[color:var(--workspace-status-bad)]/40 bg-[var(--workspace-status-bad-bg)] px-2 py-1 font-medium text-[color:var(--workspace-status-bad-text)]">
            {t('komariAlerts.openCount', { count: open })}
          </span>
          <span className="rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 py-1 text-[var(--workspace-text-muted)]">
            {t('komariAlerts.totalCount', { count: alerts.length })}
          </span>
        </div>
      </header>

      {error && <p role="alert" className="border-b border-[color:var(--workspace-border-soft)] px-4 py-2 text-xs text-[color:var(--workspace-status-bad-text)]">{monitoringDiagnostic(error, locale)}</p>}
      {loading && <div className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{t('komariAlerts.loading')}</div>}
      {!loading && alerts.length === 0 && (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <CheckCircle2 className="h-7 w-7 text-[color:var(--workspace-status-good-text)]" />
          <p className="mt-2 text-sm font-medium text-[var(--workspace-text-strong)]">{t('komariAlerts.empty')}</p>
          <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{t('komariAlerts.emptyHint')}</p>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="divide-y divide-[color:var(--workspace-border-soft)]">
          {alerts.map((alert) => {
            const Icon = severityIcon(alert.severity)
            const isExpanded = expanded === alert.alertId
            const members = incidents.find((incident) => incident.alert.alertId === alert.alertId)?.members ?? [alert]
            const canAcknowledge = !alert.evidenceStatus && alert.status === 'active' && !!onAcknowledge
            const canClose = (alert.status === 'active' || alert.status === 'acknowledged' || alert.status === 'resolved') && !!onClose
            return (
              <article key={alert.alertId} data-testid={`komari-alert-${alert.alertId}`} className={cn(compact ? 'px-3 py-2.5' : 'px-4 py-3')}>
                <div className="flex min-w-0 items-start gap-2.5">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', alert.severity === 'critical' ? 'text-[color:var(--workspace-status-bad-text)]' : alert.severity === 'warning' ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[color:var(--workspace-status-info-text)]')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--workspace-text-strong)]">{monitoringAlertTitle(alert, locale)}</span>
                      <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', statusColor(alert.status))}>{statusLabel(t, alert.status)}</span>
                      {members.length > 1 && <span className="text-xs text-[var(--workspace-text-muted)]">{locale === 'zh-CN' ? `${members.length} 条关联诊断` : `${members.length} related diagnostics`}</span>}
                      {alert.count != null && members.length === 1 && <span className="text-xs text-[var(--workspace-text-muted)]">×{alert.count}</span>}
                    </div>
                    {alert.evidenceStatus && <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '缺少事件证据 · 仅保留历史与审计' : 'No event evidence · history and audit retained'}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--workspace-text-subtle)]">
                      <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatTime(alert.lastSeenAt, locale)}</span>
                      {alert.hostId && onOpenHost ? (
                        <button type="button" onClick={() => onOpenHost(alert.hostId!)} className="inline-flex items-center gap-1 text-[var(--workspace-accent-text)] hover:underline">
                          {t('komariAlerts.host', { host: alert.hostId })}<ExternalLink className="h-3 w-3" />
                        </button>
                      ) : alert.hostId ? <span>{t('komariAlerts.host', { host: alert.hostId })}</span> : null}
                      {alert.nodeId && <span>{t('komariAlerts.node', { node: alert.nodeId })}</span>}
                      {alert.relatedOperationJobId && (
                        onOpenOperation ? (
                          <button type="button" onClick={() => onOpenOperation(alert.relatedOperationJobId!)} className="inline-flex items-center gap-1 text-[var(--workspace-accent-text)] hover:underline">
                            {t('komariAlerts.operation', { id: alert.relatedOperationJobId })}<ChevronRight className="h-3 w-3" />
                          </button>
                        ) : <span>{t('komariAlerts.operation', { id: alert.relatedOperationJobId })}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canAcknowledge && <button type="button" data-testid={`komari-alert-ack-${alert.alertId}`} onClick={() => void runAction(alert, 'acknowledge')} disabled={pending !== null} className="rounded-md border border-[color:var(--workspace-border-soft)] px-2 py-1 text-[11px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50">{pending === `acknowledge:${alert.alertId}` ? '…' : <><Check className="mr-1 inline h-3 w-3" />{t('komariAlerts.acknowledge')}</>}</button>}
                    {canClose && <button type="button" data-testid={`komari-alert-close-${alert.alertId}`} onClick={() => void runAction(alert, 'close')} disabled={pending !== null} className="rounded-md border border-[color:var(--workspace-border-soft)] px-2 py-1 text-[11px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50">{pending === `close:${alert.alertId}` ? '…' : <><X className="mr-1 inline h-3 w-3" />{t('komariAlerts.close')}</>}</button>}
                    <button type="button" aria-label={isExpanded ? t('komariAlerts.hideDetails') : t('komariAlerts.showDetails')} onClick={() => setExpanded(isExpanded ? null : alert.alertId)} className="rounded-md p-1 text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
                      <ChevronRight className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')} />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="mt-3 ml-6 space-y-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 py-2 text-[11px] text-[var(--workspace-text-muted)]">
                    <div className="flex justify-between gap-3"><span>{t('komariAlerts.firstSeen')}</span><span className="font-mono">{formatTime(alert.firstSeenAt, locale)}</span></div>
                    <div className="flex justify-between gap-3"><span>{t('komariAlerts.lastSeen')}</span><span className="font-mono">{formatTime(alert.lastSeenAt, locale)}</span></div>
                    <div className="flex justify-between gap-3"><span>{t('komariAlerts.deduplicated')}</span><span className="font-mono">{alert.deduplicatedCount}</span></div>
                    {alert.acknowledgedBy && <div className="flex justify-between gap-3"><span>{t('komariAlerts.acknowledgedBy')}</span><span>{alert.acknowledgedBy}</span></div>}
                    {alert.resolvedAt && <div className="flex justify-between gap-3"><span>{t('komariAlerts.recoveredAt')}</span><span className="font-mono">{formatTime(alert.resolvedAt, locale)}</span></div>}
                    {alert.closedAt && <div className="flex justify-between gap-3"><span>{t('komariAlerts.closedAt')}</span><span className="font-mono">{formatTime(alert.closedAt, locale)}</span></div>}
                    {members.length > 1 && members.map((member) => <div key={member.alertId} className="border-t border-[color:var(--workspace-border-soft)] pt-1.5"><div>{monitoringAlertTitle(member, locale)}</div><div className="break-all font-mono text-[10px]">{member.alertId} · {statusLabel(t, member.status)}</div></div>)}
                    <div className="break-all pt-1 font-mono text-[10px] text-[var(--workspace-text-subtle)]">{alert.fingerprint}</div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}

      {audit.length > 0 && (
        <details className="border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]">
            <History className="h-3.5 w-3.5" />{t('komariAlerts.auditTitle', { count: audit.length })}
          </summary>
          <div className="mt-2 space-y-1.5">
            {audit.slice(-8).reverse().map((entry: KomariAlertAuditEntry) => (
              <div key={entry.auditId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--workspace-text-subtle)]">
                <span className="font-medium text-[var(--workspace-text-muted)]">{t(`komariAlerts.event.${entry.event}`)}</span>
                <span>{entry.actor}</span>
                <span className="font-mono">{formatTime(entry.at, locale)}</span>
                {entry.operationJobId && <span className="font-mono text-[var(--workspace-accent-text)]">#{entry.operationJobId}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}

export default KomariAlertPanel
