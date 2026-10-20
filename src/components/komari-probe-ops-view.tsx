import type { HostProfile } from '@/lib/hosts'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { OperationAuditEntry } from '@/lib/operation-job'
import { komariHostSyncCopy } from '@/lib/locales/komari-host-sync'
import { monitoringSourcesCopy } from '@/lib/locales/monitoring-sources'
import { groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, Clock3, Route, ShieldAlert, Wrench } from 'lucide-react'

type TFn = (key: string, params?: Record<string, string | number>) => string

export interface KomariProbeOpsViewProps {
  host: HostProfile
  link: KomariProbeLink
  /** Host-scoped OperationJob audit rows. MCP alert actions are local jobs;
   * passing these rows lets the host card show their durable outcome next to
   * the Komari lifecycle instead of only displaying a dangling job id. */
  operationAudits?: OperationAuditEntry[]
  /** Actions are deliberately injected by the host dashboard. The card never
   * talks to Komari or executes SSH itself; callers must use the safe bridge. */
  onAction?: (action: Extract<KomariProbeLink['recommendedAction'], 'check-probe' | 'install-probe'>, link: KomariProbeLink) => Promise<void> | void
  busy?: boolean
}

function formatAge(timestamp: number | null | undefined, t: TFn) {
  if (!timestamp) return t('workspace.komariProbe.never')
  const age = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(age / 60000)
  if (minutes < 1) return t('workspace.komariProbe.justNow')
  if (minutes < 60) return t('workspace.komariProbe.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('workspace.komariProbe.hoursAgo', { count: hours })
  return t('workspace.komariProbe.daysAgo', { count: Math.floor(hours / 24) })
}

function isKnownSyncTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Date.now()
}

function stateLabel(state: KomariProbeLink['komari']['state'], t: TFn) {
  const value = t(`workspace.komariProbe.state.${state}`)
  return value === `workspace.komariProbe.state.${state}` ? state : value
}

function mappingLabel(status: KomariProbeLink['status'], t: TFn) {
  const value = t(`workspace.komariProbe.mapping.${status}`)
  return value === `workspace.komariProbe.mapping.${status}` ? status : value
}

function lifecycleLabel(state: KomariProbeLink['probe']['state'], t: TFn) {
  const value = t(`workspace.agentProbe.lifecycle.${state}`)
  return value === `workspace.agentProbe.lifecycle.${state}` ? state : value
}

function statusClass(state: string) {
  if (state === 'online' || state === 'linked' || state === 'installed') return 'text-[color:var(--workspace-status-good-text)]'
  if (state === 'stale' || state === 'acknowledged' || state === 'unknown' || state === 'unmapped') return 'text-[color:var(--workspace-status-warn-text)]'
  if (state === 'offline' || state === 'conflict' || state === 'failed') return 'text-[color:var(--workspace-status-bad-text)]'
  return 'text-[var(--workspace-text-muted)]'
}

function routeLabel(host: HostProfile, t: TFn) {
  if (!host.jumpHost?.trim()) return t('hosts.opsDirect')
  const user = host.jumpUser?.trim() ? `${host.jumpUser.trim()}@` : ''
  const port = host.jumpPort ? `:${host.jumpPort}` : ''
  return `${t('hosts.opsProxyJump')} · ${user}${host.jumpHost.trim()}${port}`
}

/**
 * Compact host-list operations view for the Komari ↔ ShellBeam Probe link.
 * It intentionally exposes source/freshness and mapping state together so an
 * offline Komari node is not mistaken for an SSH failure. Remote actions are
 * delegated to the caller's confirmed OperationJob bridge.
 */
export function KomariProbeOpsView({ host, link, operationAudits = [], onAction, busy = false }: KomariProbeOpsViewProps) {
  const { t, locale } = useT()
  const syncCopy = komariHostSyncCopy[locale]
  const syncAt = link.komari.lastSyncedAt
  const validSync = isKnownSyncTime(syncAt)
  const action = link.recommendedAction === 'check-probe' || link.recommendedAction === 'install-probe'
    ? link.recommendedAction
    : null
  const alertSummary = link.komari.alerts
  const scopedAlerts = link.alertState?.alerts.filter((alert) => alert.nodeId === link.nodeId || alert.hostId === host.id) ?? []
  const incidents = groupKomariAlertIncidents(scopedAlerts).map(({ alert }) => alert)
  const openAlerts = incidents.filter((alert) => (alert.status === 'active' || alert.status === 'acknowledged')
    && (alert.nodeId === link.nodeId || alert.hostId === host.id)) ?? []
  const acknowledgedAlerts = incidents.filter((alert) => alert.status === 'acknowledged')
  const closedAlerts = incidents.filter((alert) => alert.status === 'closed')
  const alertIds = new Set(scopedAlerts.map((alert) => alert.alertId))
  const latestAlertAudit = [...(link.alertState?.audit ?? [])]
    .filter((entry) => alertIds.has(entry.alertId) && entry.operationJobId)
    .sort((left, right) => right.at - left.at)[0]
  const linkedAlert = [...scopedAlerts]
    .filter((alert) => alert.relatedOperationJobId)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0]
  const linkedOperation = latestAlertAudit?.operationJobId ?? linkedAlert?.relatedOperationJobId ?? null
  const linkedOperationAudit = linkedOperation
    ? operationAudits.find((entry) => entry.jobId === linkedOperation) ?? null
    : null
  const probeHealth = link.probe.health ?? 'unknown'

  return (
    <div data-testid="komari-probe-ops-view" className="mt-2 space-y-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 text-[10px] text-[var(--workspace-text-muted)]">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-semibold text-[var(--workspace-text-strong)]">{monitoringSourcesCopy[locale].komariSource}</span>
        <span className={cn('truncate font-medium', statusClass(link.status))}>{mappingLabel(link.status, t)}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1" title={routeLabel(host, t)}>
          <Route className="h-3 w-3" />
          <span>{host.jumpHost?.trim() ? t('hosts.opsProxyJump') : t('hosts.opsDirect')}</span>
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1" title={t('workspace.komariProbe.sourceHint')}>
          {link.komari.state === 'online' ? <CheckCircle2 className="h-3 w-3 text-[color:var(--workspace-status-good-text)]" /> : <ShieldAlert className="h-3 w-3 text-[color:var(--workspace-status-warn-text)]" />}
          <span className="shrink-0">{t('workspace.komariProbe.komari')}</span>
          <strong className={cn('truncate font-medium', statusClass(link.komari.state))}>{link.komari.waitingForFirstReport ? monitoringSourcesCopy[locale].waitingForFirstReport : stateLabel(link.komari.state, t)}</strong>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1" title={t('workspace.komariProbe.sampledAt')}>
          <Clock3 className="h-3 w-3 shrink-0" />
          <span className="truncate">{formatAge(link.komari.sampledAt, t)}</span>
        </span>
        {alertSummary && (
          <span data-testid="komari-remote-alert-summary" className={cn('inline-flex shrink-0 items-center gap-1', (alertSummary.active ?? 0) > 0 && 'text-[color:var(--workspace-status-bad-text)]')} title={monitoringSourcesCopy[locale].remoteAlerts}>
            <AlertTriangle className="h-3 w-3" />
            <span>{monitoringSourcesCopy[locale].remoteAlerts}: {alertSummary.unsupported ? t('hosts.opsUnsupported') : `${alertSummary.active ?? '—'}/${alertSummary.total ?? '—'}`}</span>
          </span>
        )}
        {scopedAlerts.length > 0 && (
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-[color:var(--workspace-status-warn-text)]" title={t('hosts.alert.audit')}>
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {openAlerts.length > 0 && <span className="truncate">{t('workspace.komariProbe.alertsOpen', { count: openAlerts.length })}</span>}
            {acknowledgedAlerts.length > 0 && <span className="shrink-0">{t('hosts.alert.acknowledged')}: {acknowledgedAlerts.length}</span>}
            {closedAlerts.length > 0 && <span className="shrink-0 text-[color:var(--workspace-status-good-text)]">{t('hosts.alert.closed')}: {closedAlerts.length}</span>}
            {linkedOperation && <span className="shrink-0 font-mono">{t('workspace.komariProbe.operationLinked', { id: linkedOperation })}{linkedOperationAudit ? ` · ${linkedOperationAudit.status}` : ''}</span>}
          </span>
        )}
      </div>

      <div data-testid="komari-host-last-sync" className="flex min-w-0 flex-wrap items-center gap-1.5" title={link.integrationId}>
        <Clock3 className="h-3 w-3 shrink-0" />
        <span>{syncCopy.syncedAt}:</span>
        {validSync ? <time dateTime={new Date(syncAt).toISOString()}>{new Date(syncAt).toLocaleString(locale)}</time> : <span>{syncCopy.unknown}</span>}
      </div>

      {link.probe.record && <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1" title={t('workspace.agentProbe.description')}>
          <Wrench className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" />
          <span className="shrink-0">{t('workspace.agentProbe.title')}</span>
          <strong className={cn('truncate font-medium', statusClass(link.probe.state))}>{lifecycleLabel(link.probe.state, t)}</strong>
          {link.probe.health && <span className={cn('shrink-0', statusClass(probeHealth))}>· {t(`workspace.agentProbe.${probeHealth === 'online' ? 'online' : probeHealth === 'offline' ? 'offline' : 'unknown'}`)}</span>}
        </span>
        {link.probe.version && <span className="shrink-0 font-mono">v{link.probe.version}</span>}
        <span className="ml-auto shrink-0">{formatAge(link.probe.lastHeartbeatAt, t)}</span>
      </div>}

      {(link.probe.record || action && onAction) && <div className="flex min-w-0 items-center gap-1.5">
        {link.probe.record && <span className="truncate" title={link.probe.record.capabilities.join(', ') || t('workspace.agentProbe.none')}>
          {t('workspace.agentProbe.capabilities')}: {link.probe.record.capabilities.length ? link.probe.record.capabilities.slice(0, 4).join(', ') : t('workspace.agentProbe.none')}
        </span>}
        {action && onAction && (
          <button
            type="button"
            disabled={busy}
            onClick={(event) => { event.stopPropagation(); void onAction(action, link) }}
            className="ml-auto shrink-0 rounded-md border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] px-2 py-1 font-medium text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-accent-muted)] disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? t('workspace.komariProbe.working') : t(`workspace.komariProbe.action.${action}`)}
          </button>
        )}
      </div>}
    </div>
  )
}

/** A small aggregate for nodes which cannot safely be attached to a host row. */
export function KomariProbeMappingNotice({ links }: { links: KomariProbeLink[] }) {
  const { t } = useT()
  const pending = links.filter((link) => link.status !== 'linked')
  if (pending.length === 0) return null
  const conflicts = pending.filter((link) => link.status === 'conflict').length
  const unmapped = pending.length - conflicts
  return (
    <div data-testid="komari-probe-mapping-notice" className="mb-3 flex min-w-0 items-start gap-2 rounded-xl border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] px-3 py-2 text-xs text-[var(--workspace-status-warn-text)]">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-semibold">{t('workspace.komariProbe.mappingNotice.title')}</div>
        <div className="mt-0.5 truncate">{t('workspace.komariProbe.mappingNotice.description', { unmapped, conflicts })}</div>
        <div className="mt-1 truncate font-mono text-[10px] opacity-80">{pending.map((link) => link.nodeId).join(', ')}</div>
      </div>
    </div>
  )
}
