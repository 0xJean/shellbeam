import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { WorkspaceAppId } from '@/lib/workspace'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { getResourceUsageFillClassName, getResourceUsageTextClassName } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import type { OperationAuditEntry } from '@/lib/operation-job'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { KomariAlertAuditEntry, KomariAlertRecord } from '@/lib/komari-alerts'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import type { HostOpsCapability } from '@/lib/host-ops-view'
import type { ProbeProviderTelemetry } from '@/lib/probe-provider'
import { AlertTriangle, Activity, Bot, Check, Clock, Cpu, HardDrive, KeyRound, Laptop, ListChecks, LockKeyhole, MemoryStick, Network, Pencil, RefreshCw, Route, Server, ShieldCheck, Tag, Terminal, Trash2, User, Wrench, X } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { HostMetadataLine, HostRegionMeta } from './host-display-meta'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'
import { KomariProbeOpsView } from './komari-probe-ops-view'

type TFn = (key: string, params?: Record<string, string | number>) => string

function formatRelativeTime(ts: number, t: TFn): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('hostCard.justNow')
  if (minutes < 60) return t('hostCard.mAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hostCard.hAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('hostCard.dAgo', { n: days })
  return new Date(ts).toLocaleDateString()
}

function statusConfig(status: string | undefined, t: TFn) {
  if (status === 'unsupported') return { label: t('hostCard.unsupported'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'online') return { label: t('hostCard.online'), dot: 'bg-[color:var(--workspace-status-good)]', text: 'text-[color:var(--workspace-status-good-text)]', bg: 'bg-[var(--workspace-status-good-bg)]', border: 'border-[color:var(--workspace-status-good-border)]' }
  if (status === 'stale') return { label: t('hostCard.stale'), dot: 'bg-[color:var(--workspace-status-warn)]', text: 'text-[color:var(--workspace-status-warn-text)]', bg: 'bg-[var(--workspace-status-warn-bg)]', border: 'border-[color:var(--workspace-status-warn-border)]' }
  if (status === 'offline') return { label: t('hostCard.offline'), dot: 'bg-[color:var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]', bg: 'bg-[var(--workspace-status-bad-bg)]', border: 'border-[color:var(--workspace-status-bad-border)]' }
  if (status === 'unknown') return { label: t('hostCard.unknown'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'paused') return { label: t('hostCard.paused'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'jump-unavailable') return { label: t('hostCard.jumpUnavailable'), dot: 'bg-[color:var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]', bg: 'bg-[var(--workspace-status-bad-bg)]', border: 'border-[color:var(--workspace-status-bad-border)]' }
  return null
}

type HostHealthStatus = 'online' | 'stale' | 'offline' | 'checking' | 'unknown' | 'paused' | 'unsupported' | 'jump-unavailable'

export interface HostOperationalSummary {
  serviceTotal: number | null
  serviceActive: number | null
  serviceFailed: number | null
  processTotal: number | null
  processRunning: number | null
  alertTotal?: number | null
  alertActive?: number | null
  alertOpen?: number | null
  alertAcknowledged?: number | null
  alertClosed?: number | null
  alertLinkedJobId?: string | null
  /** Lifecycle rows owned by the local Komari journal for this host. */
  komariAlerts?: KomariAlertRecord[]
  /** Host-scoped lifecycle audit rows loaded from the durable Komari journal.
   * These are separate from OperationAuditEntry because they also include
   * provider recovery and acknowledgement events from another session. */
  komariAlertAudits?: KomariAlertAuditEntry[]
  /** Acknowledge or close one of the host's persisted Komari alerts. */
  onKomariAlertAction?: (action: 'acknowledge' | 'close', alert: KomariAlertRecord) => Promise<void> | void
  /** Alert id currently being persisted; keeps retries scoped to one row. */
  komariAlertBusy?: string | null
  alertUnsupported?: boolean
  auditCount: number
  auditActive?: number
  auditFailed?: number
  auditUnknown?: number
  latestAudit?: Pick<OperationAuditEntry, 'action' | 'target' | 'status' | 'createdAt' | 'transport' | 'provider'> & Partial<Pick<OperationAuditEntry, 'auditId' | 'jobId' | 'source'>>
  audits?: OperationAuditEntry[]
  provider?: string
  jumpHostName?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  probeProviderId?: string
  probeState?: 'fresh' | 'stale' | 'recovered' | 'error' | 'unknown'
  probeError?: string
  probeErrorCode?: string
  probeTelemetry?: ProbeProviderTelemetry | null
  sampledAt?: number
  ttlMs?: number | null
  expiresAt?: number | null
  expiryReason?: 'ttl-expired' | null
  capabilities?: HostOpsCapability[]
  highestAlertSeverity?: 'info' | 'warning' | 'critical' | null
  localAlertOpen?: number
  localAlerts?: LocalAlertRecord[]
  transport: 'direct' | 'proxy-jump'
  agentStatus?: string
  agentHealth?: string
  agentVersion?: string | null
  agentHeartbeatAt?: number | null
  komariProbe?: KomariProbeLink | null
  onKomariProbeAction?: (action: 'check-probe' | 'install-probe', link: KomariProbeLink) => Promise<void> | void
  komariProbeBusy?: boolean
}

function groupIconConfig(group: string) {
  switch (group) {
    case 'Production':
      return { icon: <Server className="h-5 w-5 text-[color:var(--workspace-group-foreground)]" />, bg: 'bg-[color:var(--workspace-group-production)]' }
    case 'Development':
      return { icon: <Laptop className="h-5 w-5 text-[color:var(--workspace-group-foreground)]" />, bg: 'bg-[color:var(--workspace-group-development)]' }
    case 'Staging':
      return { icon: <Server className="h-5 w-5 text-[color:var(--workspace-group-foreground)]" />, bg: 'bg-[color:var(--workspace-group-staging)]' }
    default:
      return { icon: <Server className="h-5 w-5 text-[color:var(--workspace-group-foreground)]" />, bg: 'bg-[color:var(--workspace-group-default)]' }
  }
}

function getDisplayGroupLabel(group: string | undefined, t: TFn) {
  if (!group) return ''
  const translated = t(`group.${group}`)
  return translated !== `group.${group}` ? translated : group
}

function formatJumpHost(host: HostProfile, route?: Pick<HostOperationalSummary, 'jumpHost' | 'jumpPort' | 'jumpUser'>) {
  if (host.jumpHostId) {
    if (!route?.jumpHost) return host.jumpHostId
    return `${route.jumpUser ? `${route.jumpUser}@` : ''}${route.jumpHost}${route.jumpPort ? `:${route.jumpPort}` : ''}`
  }
  if (!host.jumpHost?.trim()) return ''
  const user = host.jumpUser?.trim() ? `${host.jumpUser.trim()}@` : ''
  const port = host.jumpPort ? `:${host.jumpPort}` : ''
  return `${user}${host.jumpHost.trim()}${port}`
}

function HostOpsQuickActions({ host, onOpenWorkspace, onRefresh }: { host: HostProfile; onOpenWorkspace?: (id: string, app: WorkspaceAppId) => void; onRefresh?: (id: string) => void }) {
  const { t } = useT()
  if (!onOpenWorkspace) return null
  return <select data-testid="host-ops-open" aria-label={t('hostOps.openForHost', { host: host.name })} value="" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => {
    event.stopPropagation()
    if (event.target.value === 'refresh') onRefresh?.(host.id)
    else if (event.target.value) onOpenWorkspace(host.id, event.target.value as WorkspaceAppId)
  }} className="h-9 max-w-28 rounded-lg border border-border bg-background px-2 text-xs text-foreground md:h-8">
    <option value="">{t('hostOps.open')}</option>
    <option value="overview">{t('workspace.app.overview')}</option>
    <option value="fileSystem">{t('workspace.app.fileSystem')}</option>
    <option value="services">{t('workspace.app.services')}</option>
    <option value="logs">{t('workspace.app.logs')}</option>
    <option value="network">{t('hostOps.alertsAndChecks')}</option>
    {onRefresh && <option value="refresh">{t('hostOps.refreshProbe')}</option>}
  </select>
}

interface HostGridCardProps {
  host: HostProfile
  isSelected: boolean
  status?: HostHealthStatus
  resource?: WorkspaceInventoryResource
  metrics?: ServerMonitorSnapshot
  operations?: HostOperationalSummary
  network?: HostNetworkDisplay
  agentDeploymentCount?: number
  agentDeploymentStatus?: string
  onConnect: (id: string) => void
  onOpenWorkspace?: (id: string, app: WorkspaceAppId) => void
  onRefresh?: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSelect: (id: string) => void
}

export function HostGridCard({ host, isSelected, status, resource, metrics, operations, network, agentDeploymentCount = 0, agentDeploymentStatus, onConnect, onOpenWorkspace, onRefresh, onEdit, onDelete }: HostGridCardProps) {
  const { t } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const groupLabel = getDisplayGroupLabel(host.group, t)
  const jumpHost = formatJumpHost(host, operations)

  return (
    <>
      <div
        data-testid="host-card" data-host-id={host.id} data-host-name={host.name} data-host-health={status ?? 'unknown'}
        className={cn(
          'group relative flex flex-col rounded-xl border transition-all',
          isSelected
            ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-card)]'
            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] hover:border-[color:var(--workspace-border-strong)] hover:shadow-[var(--workspace-shadow-card-hover)]'
        )}
      >
        <div
          className="absolute right-2.5 top-2.5 flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
          style={isSelected ? { opacity: 1 } : undefined}
        >
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] md:h-7 md:w-7"
            onClick={() => onConnect(host.id)} title={t('hostCard.connect')}>
            <Terminal className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] md:h-7 md:w-7"
            onClick={() => onEdit(host.id)} title={t('hostCard.edit')}>
            <Pencil className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
          <span role="button" tabIndex={0}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)] md:h-7 md:w-7"
            onClick={() => setConfirmOpen(true)} title={t('hostCard.delete')}>
            <Trash2 className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </span>
        </div>

        <div className="flex items-center gap-3 px-4 pt-4 pb-3">
          <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg shadow-[var(--workspace-shadow-card)]', resource?.os ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : bg)}>
            {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-5 w-5" /> : icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{host.name}</p>
            <p className="mt-0.5 truncate text-xs text-[var(--workspace-text-muted)]">
              {resource?.os || `${host.address}${host.port !== 22 ? `:${host.port}` : ''}`}
            </p>
          </div>
        </div>

        <div className="flex-1 space-y-2 border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
              <User className="h-3 w-3" /><span className="truncate">{host.username || 'root'}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
              {host.authType === 'privateKey'
                ? <><KeyRound className="h-3 w-3" /><span>{t('hostCard.sshKey')}</span></>
                : <><LockKeyhole className="h-3 w-3" /><span>{t('hostCard.password')}</span></>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sc ? (
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', sc.bg, sc.text)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', sc.dot)} />{sc.label}
              </span>
            ) : status === 'checking' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--workspace-surface-700)] px-2 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]">
                <RefreshCw className="h-2.5 w-2.5 animate-spin" />{t('hostCard.checking')}
              </span>
            ) : null}
            {host.group && (
              <span className="rounded-full bg-[var(--workspace-surface-700)] px-2 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]">{groupLabel}</span>
            )}
            {jumpHost && (
              <span
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--workspace-accent-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--workspace-accent-text)]"
                title={`${t('hosts.jumpHost')}: ${jumpHost}`}
              >
                <Route className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{t('hosts.jumpHost')}: {jumpHost}</span>
              </span>
            )}
          </div>
          {network && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--workspace-text-muted)]">
              <HostRegionMeta network={network} />
            </div>
          )}
          <HostMetadataLine
            resource={resource}
            showLocation={false}
            showSystem={false}
            className="text-xs text-[var(--workspace-text-muted)]"
            iconClassName="h-3.5 w-3.5"
          />
          <HostResourceSummary resource={resource} metrics={metrics} t={t} />
          <HostOperationalMeta host={host} summary={operations} t={t} />
          <div className="flex items-center gap-1 overflow-hidden">
            {host.tags && host.tags.length > 0 ? (
              <>
                <Tag className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" />
                <div className="flex gap-1 overflow-hidden">
                  {host.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="shrink-0 rounded bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]">{tag}</span>
                  ))}
                  {host.tags.length > 3 && <span className="shrink-0 text-[10px] text-[var(--workspace-text-subtle)]">+{host.tags.length - 3}</span>}
                </div>
              </>
            ) : (
              <span className="text-[10px] text-[var(--workspace-text-subtle)]">&nbsp;</span>
            )}
          </div>
          {agentDeploymentCount > 0 && (
            <div className="truncate text-[10px] font-medium text-[var(--workspace-status-info-text)]">
              {t('workspace.agentDeployments.summary', { count: agentDeploymentCount })}{agentDeploymentStatus ? ` · ${t(`workspace.agentDeployments.status.${['deployed', 'deploying', 'planned', 'failed', 'unknown', 'retired'].includes(agentDeploymentStatus) ? agentDeploymentStatus : 'unknown'}`)}` : ''}
            </div>
          )}
        </div>

        <div className="border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
          <div className="flex items-center gap-2">
            <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
            <Button data-testid="host-connect" size="sm" className="h-10 flex-1 gap-1.5 text-sm md:h-8 md:text-xs" onClick={() => onConnect(host.id)}>
              <Terminal className="h-4 w-4 md:h-3.5 md:w-3.5" />{t('hostCard.connect')}
            </Button>
            {host.updatedAt > 0 && (
              <span className="shrink-0 flex items-center gap-1 text-[10px] text-[var(--workspace-text-subtle)]" title={new Date(host.updatedAt).toLocaleString()}>
                <Clock className="h-3 w-3" />{formatRelativeTime(host.updatedAt, t)}
              </span>
            )}
          </div>
        </div>
      </div>

      <DeleteConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        hostName={host.name} hostAddress={host.address}
        onConfirm={() => { setConfirmOpen(false); onDelete(host.id) }} />
    </>
  )
}

interface HostListItemProps {
  index: number
  host: HostProfile
  isSelected: boolean
  status?: HostHealthStatus
  resource?: WorkspaceInventoryResource
  metrics?: ServerMonitorSnapshot
  operations?: HostOperationalSummary
  network?: HostNetworkDisplay
  agentDeploymentCount?: number
  agentDeploymentStatus?: string
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onOpenWorkspace?: (id: string, app: WorkspaceAppId) => void
  onRefresh?: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

function HostStatusPill({ status, sc, t }: { status?: HostHealthStatus; sc: ReturnType<typeof statusConfig>; t: TFn }) {
  if (sc) {
    return (
      <span className={cn('inline-flex h-9 min-w-[6rem] items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold', sc.bg, sc.text, sc.border)}>
        <span className={cn('h-1.5 w-1.5 rounded-full', sc.dot)} />
        {sc.label}
      </span>
    )
  }
  if (status === 'checking') {
    return (
      <span className="inline-flex h-9 min-w-[6rem] items-center justify-center gap-1.5 rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text-muted)]">
        <RefreshCw className="h-3 w-3 animate-spin" />
        {t('hostCard.checking')}
      </span>
    )
  }
  return (
    <span className="inline-flex h-9 min-w-[6rem] items-center justify-center rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3 text-xs font-semibold text-[var(--workspace-text-subtle)]">
      {t('hosts.noActivity')}
    </span>
  )
}

function formatPercent(value: number | null | undefined, t: TFn) {
  return value == null ? t('workspace.common.notAvailable') : `${Math.round(value)}%`
}

function clampPercent(value: number | null | undefined) {
  if (value == null) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function HostResourceMetric({
  icon: Icon,
  iconKey,
  label,
  value,
  detail,
  t,
}: {
  icon: ComponentType<{ className?: string }>
  iconKey: 'cpu' | 'memory' | 'disk'
  label: string
  value: number | null | undefined
  detail?: string
  t: TFn
}) {
  const percent = clampPercent(value)
  const displayValue = formatPercent(value, t)
  const title = detail ? `${label} ${displayValue} - ${detail}` : `${label} ${displayValue}`
  const activeSegments = value == null ? 0 : Math.max(1, Math.round(percent / 10))

  return (
    <div
      role="meter"
      aria-label={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : percent}
      title={title}
      className="flex min-w-0 items-center gap-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5 shrink-0">
        <span
          data-resource-metric-icon={iconKey}
          className={cn('flex h-4 w-4 shrink-0 items-center justify-center', getResourceUsageTextClassName(value))}
          aria-hidden="true"
        >
          <Icon className="h-3 w-3" />
        </span>
        <span className="truncate whitespace-nowrap text-[10px] font-semibold uppercase tracking-normal text-[var(--workspace-text-muted)]">{label}</span>
      </span>
      <span className="flex h-5 min-w-0 shrink-0 items-center gap-1" aria-hidden="true">
        {Array.from({ length: 10 }).map((_, segmentIndex) => (
          <span
            key={segmentIndex}
            className={cn(
              'h-5 w-1.5 rounded-full transition-colors',
              segmentIndex < activeSegments ? getResourceUsageFillClassName(value) : 'bg-[var(--workspace-meter-track)]',
            )}
          />
        ))}
      </span>
      <span className="shrink-0 font-mono text-xs font-semibold text-[var(--workspace-text-strong)]">{displayValue}</span>
    </div>
  )
}

function formatThroughput(value: number | null | undefined, t: TFn) {
  if (value == null || !Number.isFinite(value) || value < 0) return t('hosts.opsFilters.unknown')
  if (value < 1024) return `${Math.round(value)} B/s`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${(value / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatUptime(seconds: number | null | undefined, t: TFn) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return t('hosts.opsFilters.unknown')
  const totalSeconds = Math.floor(seconds)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor(totalSeconds / 3_600) % 24
  const minutes = Math.floor(totalSeconds / 60) % 60
  if (days > 0) return t('workspace.monitor.uptime.days', { days, hours })
  if (hours > 0) return t('workspace.monitor.uptime.hours', { hours, minutes })
  if (minutes > 0) return t('workspace.monitor.uptime.minutes', { minutes })
  return t('hostCard.uptimeSeconds', { seconds: totalSeconds })
}

function HostResourceSummary({ resource, metrics, t }: { resource?: WorkspaceInventoryResource; metrics?: ServerMonitorSnapshot; t: TFn }) {
  // A current Provider's missing field stays unknown instead of borrowing a
  // possibly older inventory value from a different source.
  const uptime = metrics ? formatUptime(metrics.uptimeSeconds, t) : resource?.uptime?.trim() || t('hosts.opsFilters.unknown')
  return (
    <div data-testid="host-resource-summary" className="min-w-0 space-y-1.5 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 xl:border-0 xl:bg-transparent xl:p-0">
      <HostResourceMetric icon={Cpu} iconKey="cpu" label={t('workspace.common.cpu')} value={metrics ? metrics.cpuPercent : resource?.cpuPercent} t={t} />
      <HostResourceMetric icon={MemoryStick} iconKey="memory" label={t('workspace.common.memoryShort')} value={metrics ? metrics.memoryPercent : resource?.memoryPercent} detail={metrics ? undefined : resource?.memoryText} t={t} />
      <HostResourceMetric icon={HardDrive} iconKey="disk" label={t('workspace.common.diskShort')} value={metrics ? metrics.diskPercent : resource?.diskPercent} detail={metrics ? undefined : resource?.diskText} t={t} />
      <dl className="space-y-1.5 border-t border-[color:var(--workspace-border-soft)] pt-1.5 text-[10px] text-[var(--workspace-text-muted)]">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <dt className="inline-flex shrink-0 items-center gap-1.5"><Network className="h-3 w-3" aria-hidden="true" />{t('workspace.monitor.network')}</dt>
          <dd data-testid="host-resource-throughput" className="min-w-0 break-words font-mono text-[var(--workspace-text-strong)]">{metrics ? <>
            <span title={t('workspace.monitor.receive')}>↓ {formatThroughput(metrics.networkRxBytesPerSec, t)}</span>
            {' · '}
            <span title={t('workspace.monitor.transmit')}>↑ {formatThroughput(metrics.networkTxBytesPerSec, t)}</span>
          </> : resource?.network?.trim() || t('hosts.opsFilters.unknown')}</dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <dt className="inline-flex shrink-0 items-center gap-1.5"><Clock className="h-3 w-3" aria-hidden="true" />{t('workspace.monitor.uptime')}</dt>
          <dd data-testid="host-resource-uptime" className="min-w-0 break-words font-mono text-[var(--workspace-text-strong)]">{uptime}</dd>
        </div>
      </dl>
    </div>
  )
}

function formatSummaryAge(ts: number | undefined, t: TFn) {
  if (!ts) return t('hosts.opsNoSample')
  return formatRelativeTime(ts, t)
}

function HostOperationalMeta({ host, summary, t }: { host: HostProfile; summary?: HostOperationalSummary; t: TFn }) {
  if (!summary) return null
  const operations = summary

  const latest = summary.latestAudit
  const latestLabel = latest
    ? `${latest.action}${latest.target ? ` ${latest.target}` : ''} · ${latest.status}`
    : t('hosts.opsNoAudit')
  const transportLabel = summary.transport === 'proxy-jump' ? t('hosts.opsProxyJump') : t('hosts.opsDirect')
  const formatCount = (value: number | null) => value == null ? '—' : String(value)
  const lifecycleStatuses = ['not-installed', 'installing', 'installed', 'upgrading', 'uninstalling', 'offline', 'unsupported', 'unknown', 'failed', 'retired']
  const lifecycleStatus = lifecycleStatuses.includes(summary.agentStatus ?? '') ? summary.agentStatus : 'unknown'
  const healthStatuses = ['online', 'offline', 'stale', 'unsupported', 'unknown']
  const agentHealth = healthStatuses.includes(summary.agentHealth ?? '') ? summary.agentHealth : 'unknown'
  const actionableAlerts = (summary.komariAlerts ?? []).filter((alert) => (
    alert.status === 'active' || alert.status === 'acknowledged' || alert.status === 'resolved'
  ))
  const latestAlertAudit = [...(summary.komariAlertAudits ?? [])].sort((left, right) => right.at - left.at)[0]

  async function runAlertAction(action: 'acknowledge' | 'close', alert: KomariAlertRecord) {
    if (!operations.onKomariAlertAction || operations.komariAlertBusy) return
    await operations.onKomariAlertAction(action, alert)
  }

  return (
    <div data-testid="host-ops-summary" data-host-ops-summary className="mt-2 space-y-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 text-[10px] text-[var(--workspace-text-muted)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1" title={t('hosts.opsServices')}>
          <Wrench className="h-3 w-3 text-[var(--workspace-accent-text)]" />
          <span>{t('hosts.opsServicesShort')}</span>
          <strong className="font-mono text-[var(--workspace-text-strong)]">{formatCount(summary.serviceActive)}/{formatCount(summary.serviceTotal)}</strong>
          {(summary.serviceFailed ?? 0) > 0 && <span className="text-[color:var(--workspace-status-bad-text)]">· {formatCount(summary.serviceFailed)} {t('hosts.opsFailed')}</span>}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1" title={t('hosts.opsProcesses')}>
          <Activity className="h-3 w-3 text-[var(--workspace-status-info-text)]" />
          <span>{t('hosts.opsProcessesShort')}</span>
          <strong className="font-mono text-[var(--workspace-text-strong)]">{formatCount(summary.processRunning)}/{formatCount(summary.processTotal)}</strong>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1" title={t('hosts.opsAudit')}>
          <ListChecks className="h-3 w-3 shrink-0" />
          <span className="truncate">{latestLabel}</span>
          <span className="shrink-0 font-mono">({summary.auditCount})</span>
        </span>
      </div>
      {(summary.auditActive || summary.auditFailed || summary.auditUnknown) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
          {summary.auditActive ? <span className="text-[color:var(--workspace-status-info-text)]">{t('hosts.opsAuditActive')}: {summary.auditActive}</span> : null}
          {summary.auditFailed ? <span className="text-[color:var(--workspace-status-bad-text)]">{t('hosts.opsAuditFailed')}: {summary.auditFailed}</span> : null}
          {summary.auditUnknown ? <span className="font-medium text-[color:var(--workspace-status-warn-text)]">{t('hosts.opsAuditUnknown')}: {summary.auditUnknown}</span> : null}
        </div>
      ) : null}
      {latest?.auditId && <div className="truncate font-mono text-[10px] text-[var(--workspace-text-subtle)]" title={latest.auditId}>{latest.source} · job={latest.jobId} · audit={latest.auditId}</div>}
      {latest?.status === 'unknown' && <div className="flex items-center gap-1 text-[color:var(--workspace-status-warn-text)]"><AlertTriangle className="h-3 w-3 shrink-0" />{t('hosts.opsRecoveryRequired')}</div>}
      {latestAlertAudit && (
        <div data-testid="host-ops-alert-audit" className="truncate text-[10px] text-[var(--workspace-text-subtle)]" title={`${latestAlertAudit.auditId} · ${latestAlertAudit.actor}`}>
          {t('hosts.alert.auditLatest', { event: t(`komariAlerts.event.${latestAlertAudit.event}`), actor: latestAlertAudit.actor })}
          {latestAlertAudit.operationJobId ? ` · job=${latestAlertAudit.operationJobId}` : ''}
        </div>
      )}
      {actionableAlerts.length > 0 && (
        <div data-testid="host-ops-alert-actions" className="space-y-1.5 border-t border-[color:var(--workspace-border-soft)] pt-1.5">
          {actionableAlerts.slice(0, 3).map((alert) => {
            const busy = summary.komariAlertBusy === alert.alertId
            const canAcknowledge = alert.status === 'active' && !!summary.onKomariAlertAction
            const canClose = !!summary.onKomariAlertAction
            return (
              <div key={alert.alertId} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate" title={alert.title}>
                  <span className="font-medium text-[var(--workspace-text-strong)]">{alert.title}</span>
                  <span className="ml-1 text-[var(--workspace-text-subtle)]">· {t(`komariAlerts.status.${alert.status}`)}</span>
                </span>
                {canAcknowledge && (
                  <button
                    type="button"
                    data-testid={`komari-host-alert-ack-${alert.alertId}`}
                    disabled={busy || !!summary.komariAlertBusy}
                    onClick={(event) => { event.stopPropagation(); void runAlertAction('acknowledge', alert) }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] px-1.5 py-1 text-[10px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" />{busy ? '…' : t('komariAlerts.acknowledge')}
                  </button>
                )}
                {canClose && (
                  <button
                    type="button"
                    data-testid={`komari-host-alert-close-${alert.alertId}`}
                    disabled={busy || !!summary.komariAlertBusy}
                    onClick={(event) => { event.stopPropagation(); void runAlertAction('close', alert) }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] px-1.5 py-1 text-[10px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />{busy ? '…' : t('komariAlerts.close')}
                  </button>
                )}
              </div>
            )
          })}
          {actionableAlerts.length > 3 && <span className="block text-[10px] text-[var(--workspace-text-subtle)]">+{actionableAlerts.length - 3}</span>}
        </div>
      )}
      {(summary.alertTotal !== undefined || summary.alertUnsupported || summary.alertActive != null || summary.alertOpen != null || summary.alertAcknowledged != null || summary.alertClosed != null || summary.alertLinkedJobId != null) && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1" title={t('hosts.opsAlerts')}>
            <AlertTriangle className="h-3 w-3 shrink-0 text-[color:var(--workspace-status-warn-text)]" />
            <span>{t('hosts.opsAlertsShort')}</span>
            <strong className="font-mono text-[var(--workspace-text-strong)]">
              {summary.alertUnsupported ? t('hosts.opsUnsupported') : formatCount(summary.alertTotal ?? null)}
            </strong>
            {summary.alertActive != null && <span className="text-[color:var(--workspace-status-bad-text)]">· {summary.alertActive} {t('hosts.opsActive')}</span>}
            {summary.alertOpen != null && summary.alertOpen !== summary.alertActive && <span className="text-[color:var(--workspace-status-warn-text)]">· {summary.alertOpen} {t('hosts.alert.active')}</span>}
            {summary.alertAcknowledged ? <span className="text-[color:var(--workspace-status-warn-text)]">· {t('hosts.alert.acknowledged')}: {summary.alertAcknowledged}</span> : null}
            {summary.alertClosed ? <span className="text-[color:var(--workspace-status-good-text)]">· {t('hosts.alert.closed')}: {summary.alertClosed}</span> : null}
            {summary.alertLinkedJobId && <span className="shrink-0 font-mono">{t('hosts.alert.linkedOperation', { jobId: summary.alertLinkedJobId })}</span>}
          </span>
        </div>
      )}
      {summary.agentStatus && (
        <div className="flex min-w-0 items-center gap-2" title={t('workspace.agentProbe.description')}>
          <Bot className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" />
          <span className="shrink-0">{t('workspace.agentProbe.title')}</span>
          <strong className="truncate font-medium text-[var(--workspace-text-strong)]">
            {t(`workspace.agentProbe.lifecycle.${lifecycleStatus}`)}
          </strong>
          {summary.agentHealth && <span className="shrink-0 text-[var(--workspace-text-subtle)]">· {t(`workspace.agentProbe.${agentHealth === 'online' ? 'online' : agentHealth === 'offline' ? 'offline' : 'unknown'}`)}</span>}
          {summary.agentVersion && <span className="shrink-0 font-mono">v{summary.agentVersion}</span>}
          {summary.agentHeartbeatAt && <span className="ml-auto shrink-0">{formatSummaryAge(summary.agentHeartbeatAt, t)}</span>}
        </div>
      )}
      {summary.probeState && (
        <div className={cn(
          'flex min-w-0 items-center gap-1.5',
          summary.probeState === 'fresh' ? 'text-[color:var(--workspace-status-good-text)]' :
            summary.probeState === 'error' ? 'text-[color:var(--workspace-status-bad-text)]' :
              'text-[color:var(--workspace-status-warn-text)]',
        )} title={summary.probeError || t('hosts.opsProbeState')}>
          <ShieldCheck className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{t('hosts.opsProbeState')}</span>
          <strong className="truncate font-medium">{t(`hosts.opsProbe.${summary.probeState}`)}</strong>
          {summary.probeProviderId && <span className="truncate font-mono text-[var(--workspace-text-subtle)]">· {summary.probeProviderId}</span>}
          {summary.probeTelemetry && (
            <span className="shrink-0 text-[var(--workspace-text-subtle)]" title={t('hosts.opsProbe.telemetryHint')}>
              · {t('hosts.opsProbe.attempts', { count: summary.probeTelemetry.attempts })}
              {summary.probeTelemetry.exhausted ? ` · ${t('hosts.opsProbe.exhausted')}` : ''}
              {` · ${t('hosts.opsProbe.duration', { ms: summary.probeTelemetry.durationMs })}`}
            </span>
          )}
          {summary.probeErrorCode && <span className="shrink-0 font-mono text-[var(--workspace-text-subtle)]">· {summary.probeErrorCode}</span>}
          {summary.probeError && <span className="truncate text-[var(--workspace-text-subtle)]" title={summary.probeError}>· {summary.probeError}</span>}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 text-[var(--workspace-text-subtle)]">
        <span className="inline-flex min-w-0 items-center gap-1 truncate" title={summary.provider || t('hosts.opsNoProvider')}>
          <ShieldCheck className="h-3 w-3 shrink-0" />
          <span className="truncate">{summary.provider || t('hosts.opsNoProvider')}</span>
        </span>
        <span className="shrink-0">{transportLabel}{summary.jumpHostName ? ` · ${summary.jumpHostName}` : ''}</span>
        <span className="ml-auto shrink-0">{formatSummaryAge(summary.sampledAt, t)}</span>
      </div>
      <div data-testid="host-ops-capabilities" className="flex flex-wrap gap-1" title={t('hosts.opsFilters.capabilitiesHint')}>
        {(summary.capabilities ?? []).map((capability) => <span key={capability} className="rounded border border-border/50 px-1 py-0.5">{t(`hosts.opsFilters.capability.${capability}`)}</span>)}
        {summary.ttlMs != null && <span className="rounded border border-border/50 px-1 py-0.5" title={summary.expiresAt ? new Date(summary.expiresAt).toLocaleString() : undefined}>TTL {Math.round(summary.ttlMs / 1_000)}s</span>}
        {summary.expiryReason === 'ttl-expired' && <span data-testid="host-ops-expiry-reason" className="rounded border border-border/50 px-1 py-0.5 text-[color:var(--workspace-status-warn-text)]">{t('hosts.opsExpiryReason.ttl-expired')}</span>}
      </div>
      {(summary.highestAlertSeverity || summary.localAlertOpen) ? <div data-testid="host-ops-local-alerts" data-open-count={summary.localAlertOpen ?? 0} data-severity={summary.highestAlertSeverity ?? 'unknown'} className="text-[color:var(--workspace-status-warn-text)]">{t('hosts.opsFilters.highest')}: {summary.highestAlertSeverity ? t(`hosts.opsFilters.${summary.highestAlertSeverity}`) : t('hosts.opsFilters.unknown')} · {t('hosts.opsFilters.localAlerts')}: {summary.localAlertOpen ?? 0}</div> : null}
      {summary.komariProbe && (
        <KomariProbeOpsView
          host={host}
          link={summary.komariProbe}
          operationAudits={summary.audits}
          onAction={summary.onKomariProbeAction}
          busy={summary.komariProbeBusy}
        />
      )}
    </div>
  )
}

function HostGroupTagsMeta({ host, t, operations, agentDeploymentCount = 0, agentDeploymentStatus }: { host: HostProfile; t: TFn; operations?: HostOperationalSummary; agentDeploymentCount?: number; agentDeploymentStatus?: string }) {
  const groupLabel = getDisplayGroupLabel(host.group, t)
  const tags = host.tags ?? []
  const jumpHost = formatJumpHost(host, operations)

  if (!groupLabel && tags.length === 0 && agentDeploymentCount === 0 && !jumpHost) return null

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
      {groupLabel && (
        <span
          data-host-group-pill
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-accent-subtle)] px-2 py-1 text-[10px] font-medium text-[var(--workspace-accent-text)]"
          title={t('workspace.serverIndex.groupTitle', { group: groupLabel })}
        >
          <Server className="h-3 w-3 shrink-0" />
          <span className="truncate">{groupLabel}</span>
        </span>
      )}
      {tags.slice(0, 3).map((tag) => (
        <span
          key={tag}
          data-host-tag-pill={tag}
          className="inline-flex max-w-full items-center rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 py-1 text-[10px] font-medium text-[var(--workspace-text-muted)]"
          title={t('workspace.serverIndex.tagTitle', { tag })}
        >
          <span className="truncate">{tag}</span>
        </span>
      ))}
      {tags.length > 3 && (
        <span className="inline-flex items-center rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 py-1 text-[10px] font-medium text-[var(--workspace-text-subtle)]">
          +{tags.length - 3}
        </span>
      )}
      {jumpHost && (
        <span
          data-host-jump-pill
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-accent-subtle)] px-2 py-1 text-[10px] font-medium text-[var(--workspace-accent-text)]"
          title={`${t('hosts.jumpHost')}: ${jumpHost}`}
        >
          <Route className="h-3 w-3 shrink-0" />
          <span className="truncate">{t('hosts.jumpHost')}: {jumpHost}</span>
        </span>
      )}
      {agentDeploymentCount > 0 && (
        <span className="inline-flex max-w-full items-center rounded-md border border-[color:var(--workspace-status-info-border)] bg-[var(--workspace-status-info-bg)] px-2 py-1 text-[10px] font-medium text-[var(--workspace-status-info-text)]" title={t('workspace.agentDeployments.summary', { count: agentDeploymentCount })}>
          <span className="truncate">{t('workspace.agentDeployments.summary', { count: agentDeploymentCount })}{agentDeploymentStatus ? ` · ${t(`workspace.agentDeployments.status.${['deployed', 'deploying', 'planned', 'failed', 'unknown', 'retired'].includes(agentDeploymentStatus) ? agentDeploymentStatus : 'unknown'}`)}` : ''}</span>
        </span>
      )}
    </div>
  )
}

function getNetworkLocationLabel(network: HostNetworkDisplay | undefined, t: TFn) {
  if (!network) return t('hosts.locationUnknown')
  if (network.locationStatus === 'loading') return t('hosts.locationLoading')
  if (network.locationStatus === 'error') return t('hosts.locationUnknown')
  if (network.locationStatus === 'ready') return network.resolvedLocationLabel
  if (network.scope === 'public') return t('hosts.locationPending')
  if (network.scope === 'private') return t('hosts.locationPrivate')
  if (network.scope === 'loopback') return t('hosts.locationLocal')
  if (network.scope === 'linkLocal') return t('hosts.locationLinkLocal')
  if (network.scope === 'carrierNat') return t('hosts.locationCarrierNat')
  if (network.scope === 'domain') return t('hosts.locationDomain')
  if (network.scope === 'reserved' || network.scope === 'multicast') return t('hosts.locationNotLocatable')
  return t('hosts.locationUnknown')
}

function getNetworkScopeLabel(network: HostNetworkDisplay | undefined, t: TFn) {
  if (!network) return t('hosts.networkUnknown')
  if (network.scope === 'public') return t('hosts.networkPublic')
  if (network.scope === 'private') return t('hosts.networkPrivate')
  if (network.scope === 'loopback') return t('hosts.networkLocal')
  if (network.scope === 'linkLocal') return t('hosts.networkLinkLocal')
  if (network.scope === 'carrierNat') return t('hosts.networkCarrierNat')
  if (network.scope === 'domain') return t('hosts.networkDomain')
  if (network.scope === 'reserved') return t('hosts.networkReserved')
  if (network.scope === 'multicast') return t('hosts.networkMulticast')
  return t('hosts.networkUnknown')
}

export function HostListItem({ index, host, isSelected, status, resource, metrics, operations, network, agentDeploymentCount = 0, agentDeploymentStatus, onSelect, onConnect, onOpenWorkspace, onRefresh, onEdit, onDelete }: HostListItemProps) {
  const { t } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const updatedAt = host.updatedAt > 0
    ? new Date(host.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : t('hosts.noActivity')
  const locationLabel = getNetworkLocationLabel(network, t)
  const scopeLabel = getNetworkScopeLabel(network, t)

  return (
    <>
      <div
        data-testid="host-card" data-host-id={host.id} data-host-name={host.name} data-host-health={status ?? 'unknown'}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(host.id)}
        onDoubleClick={() => onConnect(host.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(host.id)
          }
        }}
        className={cn(
          'group grid w-full cursor-pointer gap-4 rounded-2xl border px-4 py-5 text-left transition-[background-color,border-color,box-shadow]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-border-glow)]',
          'xl:grid-cols-[3.25rem_minmax(14rem,1.14fr)_minmax(12rem,0.92fr)_minmax(10rem,0.75fr)_7rem_minmax(15rem,1.02fr)_minmax(14rem,1fr)_7rem_14rem] xl:items-center xl:gap-4',
          isSelected
            ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_var(--workspace-primary-500),var(--workspace-shadow-card)]'
            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] shadow-[var(--workspace-shadow-card)] hover:border-[color:var(--workspace-border-strong)] hover:bg-[var(--workspace-surface-800)]',
        )}
      >
        <div className="hidden font-mono text-lg font-semibold text-[var(--workspace-text-strong)] xl:block">
          {String(index).padStart(2, '0')}
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-[var(--workspace-shadow-card)]', resource?.os ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : bg)}>
            {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-5 w-5" /> : icon}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{host.name}</p>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">
              {resource?.os || `${host.username || 'root'}@${host.address}${host.port !== 22 ? `:${host.port}` : ''}`}
            </p>
            <HostGroupTagsMeta operations={operations} host={host} t={t} agentDeploymentCount={agentDeploymentCount} agentDeploymentStatus={agentDeploymentStatus} />
          </div>
        </div>

        <div className="min-w-0 xl:self-center">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]">
            <HostRegionMeta
              network={network}
              label={locationLabel}
              iconClassName="h-3.5 w-3.5"
              textClassName="text-sm font-semibold text-[var(--workspace-text-strong)]"
            />
            {network?.locationStatus === 'loading' && <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-[var(--workspace-text-subtle)]" />}
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{scopeLabel}</div>
        </div>

        <div className="min-w-0 xl:self-center">
          <div className="truncate font-mono text-sm font-semibold text-[var(--workspace-text-strong)]">{host.address}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">
            {host.port !== 22 ? t('hosts.portValue', { port: host.port }) : t('hosts.defaultSshPort')}
          </div>
        </div>

        <div className="text-xs text-[var(--workspace-text-muted)]" title={host.updatedAt > 0 ? new Date(host.updatedAt).toLocaleString() : undefined}>
          <span className="font-mono text-sm font-semibold text-[var(--workspace-text-strong)]">{updatedAt}</span>
        </div>

        <HostResourceSummary resource={resource} metrics={metrics} t={t} />

        <HostOperationalMeta host={host} summary={operations} t={t} />

        <div className="flex items-center">
          <HostStatusPill status={status} sc={sc} t={t} />
        </div>

        <div className="flex items-center justify-start gap-1 xl:justify-end [&>button]:shrink-0">
          <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)] md:h-8 md:w-8"
            data-testid="host-connect" onClick={(e) => { e.stopPropagation(); onConnect(host.id) }} title={t('hostCard.connect')}>
            <Terminal className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); onEdit(host.id) }} title={t('hostCard.edit')}>
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)] md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} title={t('hostCard.delete')}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <DeleteConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        hostName={host.name} hostAddress={host.address}
        onConfirm={() => { setConfirmOpen(false); onDelete(host.id) }} />
    </>
  )
}

function DeleteConfirmDialog({ open, onOpenChange, hostName, hostAddress, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; hostName: string; hostAddress: string; onConfirm: () => void
}) {
  const { t } = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!h-auto !max-w-[300px] !rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-6 pb-6 pt-7 shadow-[var(--workspace-shadow-overlay)] ring-1 ring-[color:var(--workspace-elevated-ring)]">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/20">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-semibold">{t('hostCard.deleteTitle')}</h3>
            <p className="text-[13px] leading-relaxed text-[var(--workspace-text-muted)]">
              {t('hostCard.deleteDesc', { name: hostName, address: hostAddress })}
            </p>
          </div>
          <div className="flex w-full gap-3 pt-1">
            <button type="button"
              className="h-11 flex-1 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-700)] text-[13px] font-medium text-[var(--workspace-text-strong)] transition-colors active:bg-[var(--workspace-surface-800)]"
              onClick={() => onOpenChange(false)}>
              {t('hostCard.deleteCancel')}
            </button>
            <button type="button"
              className="h-11 flex-1 rounded-xl bg-[color:var(--workspace-primary-500)] text-[13px] font-medium text-[color:var(--workspace-primary-foreground)] transition-colors active:bg-[color:var(--workspace-primary-400)]"
              onClick={onConfirm}>
              {t('hostCard.deleteConfirm')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
