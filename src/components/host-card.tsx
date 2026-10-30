import { monitoringAlertTitle, monitoringDiagnostic, monitoringOperationTarget, monitoringProviderLabel } from '@/lib/monitoring-presentation'
import { ProbeInstallEntry } from '@/components/probe-install-entry'
import { SegmentedMeter } from '@/components/ui/segmented-meter'
import { NativeSelect } from '@/components/ui/select'
import { hasSshConnection, hostConnections } from '@/lib/hosts'
import { requestHostSftp } from '@/lib/navigation-request'
import { osBrandColor } from '@/lib/os-brand'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { WorkspaceAppId } from '@/lib/workspace'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { monitoringModeCopy } from '@/lib/locales/monitoring-mode'
import { monitoringSourcesCopy } from '@/lib/locales/monitoring-sources'
import { hostPresentationCopy } from '@/lib/locales/host-presentation'
import { hostMoveCopy } from '@/lib/locales/host-move'
import { fill } from '@/lib/locales/probe-install'
import { hostsOverviewCopy } from '@/lib/locales/hosts-overview'
import { getResourceUsageTextClassName, getResourceUsageTone } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import type { OperationAuditEntry } from '@/lib/operation-job'
import type { KomariProbeLink } from '@/lib/komari-probe-link'
import type { KomariAlertAuditEntry, KomariAlertRecord } from '@/lib/komari-alerts'
import { isHistoricalKomariAlert, groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import { loadEvidenceCopy } from '@/lib/monitoring-load-evidence'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import { hostProbeEvaluations, validHostOpsSampleTime, type HostOpsCapability, type HostOpsProbeEvaluation } from '@/lib/host-ops-view'
import type { ProbeProviderTelemetry } from '@/lib/probe-provider'
import { AlertTriangle, Activity, ArrowRightLeft, Bot, Check, ChevronDown, Clock, Cpu, FolderOpen, HardDrive, Laptop, MemoryStick, Network, Pencil, RefreshCw, Route, Server, ShieldCheck, Tag, Terminal, Trash2, Wrench, X } from 'lucide-react'
import { useEffect, useId, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { HostRegionMeta } from './host-display-meta'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'
import { KomariProbeOpsView } from './komari-probe-ops-view'
import { CompatibleAgentTools } from './compatible-agent-panel'
import { HOST_CONNECTION_COLUMNS, HOST_LIST_COLUMNS, HOST_RESOURCE_COLUMNS } from './host-list-layout'

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

function statusConfig(status: string | undefined, t: TFn, provider: string | undefined, copy: typeof hostPresentationCopy[keyof typeof hostPresentationCopy]) {
  if (status === 'unsupported') return { label: t('hostCard.unsupported'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'online') return { label: t('hostCard.online'), dot: 'bg-[color:var(--workspace-status-good)]', text: 'text-[color:var(--workspace-status-good-text)]', bg: 'bg-[var(--workspace-status-good-bg)]', border: 'border-[color:var(--workspace-status-good-border)]' }
  if (status === 'stale') return { label: provider === 'komari' ? copy.monitoringStale : t('hostCard.stale'), dot: 'bg-[color:var(--workspace-status-warn)]', text: 'text-[color:var(--workspace-status-warn-text)]', bg: 'bg-[var(--workspace-status-warn-bg)]', border: 'border-[color:var(--workspace-status-warn-border)]' }
  if (status === 'offline') return { label: provider === 'komari' ? copy.monitoringOffline : t('hostCard.offline'), dot: 'bg-[color:var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]', bg: 'bg-[var(--workspace-status-bad-bg)]', border: 'border-[color:var(--workspace-status-bad-border)]' }
  if (status === 'unknown') return { label: t('hostCard.unknown'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'paused') return { label: t('hostCard.paused'), dot: 'bg-[color:var(--workspace-text-subtle)]', text: 'text-[var(--workspace-text-muted)]', bg: 'bg-[var(--workspace-surface-800)]', border: 'border-[color:var(--workspace-border-soft)]' }
  if (status === 'jump-unavailable') return { label: t('hostCard.jumpUnavailable'), dot: 'bg-[color:var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]', bg: 'bg-[var(--workspace-status-bad-bg)]', border: 'border-[color:var(--workspace-status-bad-border)]' }
  return null
}

type HostHealthStatus = 'online' | 'stale' | 'offline' | 'checking' | 'unknown' | 'paused' | 'unsupported' | 'jump-unavailable'

export interface HostOperationalSummary {
  /** Vault verified by the active dashboard's observation scope. */
  vaultId?: string
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
  localAlertEvaluations?: HostOpsProbeEvaluation[]
  /** Local lifecycle actions have their own confirmed job and persistence path. */
  onLocalAlertAction?: (alert: LocalAlertRecord, action: 'acknowledge' | 'close') => Promise<void> | void
  localAlertBusy?: string | null
  localAlertError?: boolean
  localAlertPersistenceError?: boolean
  probeAlertLifecycleError?: boolean
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
  if (!onOpenWorkspace || !hasSshConnection(host)) return null
  return <>
    <button
      type="button"
      data-testid="host-services-open"
      aria-label={`${t('workspace.app.services')} · ${host.name}`}
      onClick={(event) => { event.stopPropagation(); onOpenWorkspace(host.id, 'services') }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="order-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)]"
    ><Wrench className="h-3 w-3" aria-hidden="true" />{t('workspace.app.services')}</button>
    <NativeSelect data-testid="host-ops-open" aria-label={t('hostOps.openForHost', { host: host.name })} value="" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => {
    event.stopPropagation()
    if (event.target.value === 'refresh') onRefresh?.(host.id)
    else if (event.target.value) onOpenWorkspace(host.id, event.target.value as WorkspaceAppId)
  }} className="h-8 max-w-24 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 text-xs text-[var(--workspace-text-muted)]">
    <option value="">{t('hostOps.open')}</option>
    <option value="overview">{t('workspace.app.overview')}</option>
    <option value="fileSystem">{t('workspace.app.fileSystem')}</option>
    <option value="services">{t('workspace.app.services')}</option>
    <option value="logs">{t('workspace.app.logs')}</option>
    <option value="network">{t('hostOps.alertsAndChecks')}</option>
    {onRefresh && <option value="refresh">{t('hostOps.refreshProbe')}</option>}
    </NativeSelect>
  </>
}

interface HostGridCardProps {
  monitoring?: boolean
  batchSelection?: { selected: boolean; disabled: boolean; onChange: () => void }
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
  /** Present only when another Vault exists to move the host into. */
  onMoveToVault?: (id: string) => void
  onSelect: (id: string) => void
}

/**
 * Right-hand drawer with a host's full operations detail (v3 "hostops" overlay).
 * It stays inside the card's DOM so the card keeps owning its id and toggle.
 */
function HostOpsDrawer({ id, host, summary, open, onClose, dot, groupLabel, network, jumpHost, actions, children }: {
  id: string; host: HostProfile; summary: HostOperationalSummary; open: boolean; onClose: () => void; dot?: string; groupLabel?: string
  network?: HostNetworkDisplay; jumpHost?: string | null; actions: ReactNode; children: ReactNode
}) {
  const { t, locale } = useT()
  const copy = hostsOverviewCopy[locale]
  const formatCount = (value: number | null | undefined) => value == null ? '—' : String(value)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  const connections = hostConnections(host).length
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  return <>
    {open && <div aria-hidden="true" data-testid="host-ops-drawer-backdrop" className="fixed inset-0 z-[60] bg-black/45" onClick={(event) => { event.stopPropagation(); onClose() }} />}
    <section id={id} data-testid="host-ops-details" role="region" aria-label={`${t('hosts.columnOperations')} · ${host.name}`} hidden={!open}
      onClick={stop} onDoubleClick={stop} onKeyDown={stop}
      className={cn('fixed inset-y-0 right-0 z-[61] w-[min(50rem,100vw)] cursor-default flex-col border-l border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] text-left shadow-[var(--workspace-shadow-overlay)]', open ? 'flex' : 'hidden')}>
      {open && <header className="flex items-start gap-3 border-b border-[color:var(--workspace-border-soft)] px-5 pb-4 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-[var(--workspace-text-strong)]">
            {dot && <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dot)} />}
            <span className="truncate">{host.name}</span>
            {groupLabel && <span className="shrink-0 rounded-md bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--workspace-text-muted)]">{groupLabel}</span>}
          </h2>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-[var(--workspace-text-muted)]">
            <span className="font-mono">{hasSshConnection(host) ? `${host.username || 'root'}@${host.address}:${host.port}` : t('hostDirectory.monitoringOnly')}</span>
            {jumpHost && <span>· {t('hosts.jumpHost')} {jumpHost}</span>}
            {connections > 1 && <span>· {t('hostDirectory.connectionCount', { count: connections })}</span>}
            {network && <span className="inline-flex items-center gap-1">· <HostRegionMeta network={network} /></span>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">{actions}</div>
        </div>
        <button data-testid="host-ops-drawer-close" type="button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"><X className="h-4 w-4" /></button>
      </header>}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {open && <div data-testid="host-ops-drawer-stats" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {([
            [t('hosts.opsServicesShort'), summary.serviceTotal == null ? '—' : `${formatCount(summary.serviceActive)} / ${formatCount(summary.serviceTotal)}`, (summary.serviceFailed ?? 0) > 0 ? `${summary.serviceFailed} ${t('hosts.opsFailed')}` : undefined, (summary.serviceFailed ?? 0) > 0],
            [t('hosts.opsProcessesShort'), formatCount(summary.processRunning ?? summary.processTotal), summary.processTotal != null ? `/ ${formatCount(summary.processTotal)}` : undefined, false],
            [copy.drawerAlerts, String(summary.alertOpen ?? summary.alertActive ?? 0), summary.highestAlertSeverity ? t(`hosts.opsFilters.${summary.highestAlertSeverity}`) : undefined, (summary.alertOpen ?? summary.alertActive ?? 0) > 0],
            [copy.drawerLocal, String(summary.localAlertOpen ?? 0), undefined, (summary.localAlertOpen ?? 0) > 0],
            [copy.drawerSource, summary.provider ? monitoringProviderLabel(summary.provider, locale) : '—', summary.sampledAt ? formatRelativeTime(summary.sampledAt, t) : undefined, false],
            [copy.drawerTasks, String(summary.auditActive ?? 0), summary.auditUnknown ? `${summary.auditUnknown} ${hostPresentationCopy[locale].needsVerification}` : undefined, (summary.auditUnknown ?? 0) > 0],
          ] as const).map(([label, value, hint, warn]) => (
            <div key={label} className="min-w-0 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2.5">
              <div className="truncate text-[11px] text-[var(--workspace-text-muted)]">{label}</div>
              <div className={cn('mt-0.5 truncate text-base font-semibold', warn ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-strong)]')}>{value}</div>
              {hint && <div className="truncate text-[11px] text-[var(--workspace-text-subtle)]">{hint}</div>}
            </div>
          ))}
        </div>}
        {children}
      </div>
    </section>
  </>
}

// Environment tag colours for the common group names; anything else stays neutral.
function envTone(group: string | undefined) {
  const value = (group ?? '').toLowerCase()
  if (/prod|生产/.test(value)) return 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]'
  if (/stag|预发|test|测试/.test(value)) return 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]'
  if (/dev|开发/.test(value)) return 'bg-[var(--workspace-status-info-bg)] text-[color:var(--workspace-status-info-text)]'
  return 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]'
}

/** The card's one-line reason for attention: an open alert first, otherwise the busiest resource. */
function hostAttention(hostId: string, summary: HostOperationalSummary | undefined, resource: WorkspaceInventoryResource | undefined, metrics: ServerMonitorSnapshot | undefined, t: TFn, locale: 'en' | 'zh-CN'): string | null {
  const local = (summary?.localAlerts ?? []).find((alert) => alert.hostId === hostId && (alert.status === 'active' || alert.status === 'acknowledged'))
  if (local) return `${local.name} · ${t(`localOps.metric.${local.metric}`)}${local.value != null ? ` ${Math.round(local.value)}%` : ''}`
  const incident = groupKomariAlertIncidents(summary?.komariAlerts ?? []).map(({ alert }) => alert).find((alert) => !isHistoricalKomariAlert(alert) && (alert.status === 'active' || alert.status === 'acknowledged'))
  if (incident) return monitoringAlertTitle(incident, locale)
  const readings: Array<[string, number | null | undefined]> = [
    [t('workspace.common.cpu'), metrics ? metrics.cpuPercent : resource?.cpuPercent],
    [t('workspace.common.memoryShort'), metrics ? metrics.memoryPercent : resource?.memoryPercent],
    [t('workspace.common.diskShort'), metrics ? metrics.diskPercent : resource?.diskPercent],
  ]
  const worst = readings.filter(([, value]) => getResourceUsageTone(value) === 'bad').sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]
  return worst ? t('hostCard.usageHigh', { resource: worst[0], value: Math.round(worst[1] ?? 0) }) : null
}

export function HostGridCard({ host, isSelected, status, resource, metrics, operations, network, agentDeploymentCount = 0, agentDeploymentStatus, onConnect, onOpenWorkspace, onRefresh, onEdit, onDelete, onMoveToVault, monitoring = true, batchSelection }: HostGridCardProps) {
  const { t, locale } = useT()
  const detailsId = useId()
  const owner = JSON.stringify([host.id, host.vaultId, operations?.vaultId, monitoring])
  const [disclosure, setDisclosure] = useState({ owner, expanded: false })
  if (disclosure.owner !== owner) setDisclosure({ owner, expanded: false })
  const detailsOpen = disclosure.owner === owner && disclosure.expanded
  const toggleDetails = () => setDisclosure({ owner, expanded: !detailsOpen })
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t, operations?.provider, hostPresentationCopy[locale])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const groupLabel = getDisplayGroupLabel(host.group, t)
  const jumpHost = formatJumpHost(host, operations)
  const ssh = hasSshConnection(host)
  const attention = monitoring ? hostAttention(host.id, operations, resource, metrics, t, locale) : null
  const offline = status === 'offline' || status === 'jump-unavailable'
  const endpoint = ssh ? `${host.username ? `${host.username}@` : ''}${host.address}${host.port !== 22 ? `:${host.port}` : ''}` : t('hostDirectory.monitoringOnly')

  return (
    <>
      <div
        data-testid="host-card" data-host-id={host.id} data-host-name={host.name} data-host-health={status ?? 'unknown'} data-vault-id={host.vaultId ?? operations?.vaultId}
        data-attention={attention ? 'true' : undefined}
        className={cn('sb-card sb-host-card group relative flex flex-col', isSelected && 'outline outline-2 outline-offset-0 outline-primary/50')}
      >
        <div className="flex items-start gap-3 px-4 pb-3 pt-4">
          {batchSelection && <input type="checkbox" className="mt-2" aria-label={`${hostPresentationCopy[locale].selectHost} · ${host.name}`} checked={batchSelection.selected} disabled={batchSelection.disabled} onChange={batchSelection.onChange} />}
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', resource?.os ? 'sb-os-badge' : bg)} style={resource?.os ? { '--os': osBrandColor(resource.os) } as CSSProperties : undefined}>
            {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-[18px] w-[18px]" /> : icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-[var(--workspace-text-strong)]">
              {sc ? <span data-testid="host-card-status" title={sc.label} className={cn('h-2 w-2 shrink-0 rounded-full', sc.dot)} />
                : status === 'checking' ? <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-[var(--workspace-text-muted)]" aria-label={t('hostCard.checking')} /> : null}
              <span className="truncate">{host.name}</span>
            </p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-xs text-[var(--workspace-text-muted)]">
              {network && <span className="flex shrink-0 items-center"><HostRegionMeta network={network} /></span>}
              {network && <span className="text-[var(--workspace-text-subtle)]">·</span>}
              <span className="truncate font-mono text-[11.5px]">{endpoint}</span>
              {hostConnections(host).length > 1 && <span className="shrink-0">· {t('hostDirectory.connectionCount', { count: hostConnections(host).length })}</span>}
            </p>
          </div>
          {host.group && <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium', envTone(host.group))}>{groupLabel}</span>}
        </div>

        {attention && (
          <div data-testid="host-card-attention" className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-[var(--workspace-status-warn-bg)] px-3 py-2 text-xs font-medium text-[color:var(--workspace-status-warn-text)]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{attention}</span>
            {operations && <button type="button" onClick={toggleDetails} className="shrink-0 rounded px-1 text-[color:var(--workspace-status-warn-text)] hover:underline">{t('hostCard.viewDetails')} →</button>}
          </div>
        )}

        <div className="flex-1 space-y-2 px-4 pb-3">
          {status && status !== 'online' && !(offline && !metrics && !resource) && <HostStatusPill status={status} sc={sc} t={t} />}
          {offline && !metrics && !resource ? (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2.5 text-xs text-[var(--workspace-text-muted)]">
              <Network className="h-3.5 w-3.5" />{sc?.label}{host.updatedAt > 0 ? ` · ${formatRelativeTime(host.updatedAt, t)}` : ''}
            </div>
          ) : (metrics || resource) ? <HostResourceSummary resource={resource} metrics={metrics} t={t} /> : null}
          {(host.tags?.length ?? 0) > 0 && (
            <div className="flex items-center gap-1 overflow-hidden">
              <Tag className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" />
              {host.tags.slice(0, 3).map((tag) => <span key={tag} className="shrink-0 rounded bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]">{tag}</span>)}
              {host.tags.length > 3 && <span className="shrink-0 text-[10px] text-[var(--workspace-text-subtle)]">+{host.tags.length - 3}</span>}
            </div>
          )}
        </div>

        {operations && <div className="border-t border-[color:var(--workspace-border-soft)] px-4 py-2">
          <HostOperationsCell host={host} summary={operations} expanded={detailsOpen} detailsId={detailsId} compactOnly={!monitoring} onToggle={toggleDetails} />
        </div>}
        {operations && <HostOpsDrawer id={detailsId} host={host} summary={operations} open={detailsOpen} onClose={() => setDisclosure({ owner, expanded: false })} dot={sc?.dot} groupLabel={host.group ? groupLabel : undefined} network={network} jumpHost={jumpHost}
          actions={<>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => ssh ? onConnect(host.id) : onEdit(host.id)}><Terminal className="h-3.5 w-3.5" />{ssh ? t('hostCard.connect') : t('hostDirectory.addSsh')}</Button>
            {ssh && <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => requestHostSftp({ vaultId: host.vaultId, hostId: host.id, path: '' })}><FolderOpen className="h-3.5 w-3.5" />SFTP</Button>}
            <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
          </>}>
          <HostOperationalMeta key={JSON.stringify([host.id, host.vaultId, operations.vaultId])} host={host} summary={operations} t={t} expanded />
        </HostOpsDrawer>}

        <div className="relative border-t border-[color:var(--workspace-border-soft)] px-4 py-2.5">
          {/* Resting footer: uptime and route; actions take over on hover, focus or selection. */}
          <div className={cn('flex min-h-8 items-center gap-2 text-xs text-[var(--workspace-text-muted)] transition-opacity', 'sm:group-hover:pointer-events-none sm:group-hover:opacity-0 sm:group-focus-within:pointer-events-none sm:group-focus-within:opacity-0', isSelected && 'sm:pointer-events-none sm:opacity-0', 'max-sm:hidden')}>
            {jumpHost && <span className="inline-flex min-w-0 items-center gap-1 truncate" title={`${t('hosts.jumpHost')}: ${jumpHost}`}><Route className="h-3 w-3 shrink-0" />{t('hosts.jumpHost')}</span>}
            {agentDeploymentCount > 0 && <span className="truncate text-[color:var(--workspace-status-info-text)]">{t('workspace.agentDeployments.summary', { count: agentDeploymentCount })}{agentDeploymentStatus ? ` · ${t(`workspace.agentDeployments.status.${['deployed', 'deploying', 'planned', 'failed', 'unknown', 'retired'].includes(agentDeploymentStatus) ? agentDeploymentStatus : 'unknown'}`)}` : ''}</span>}
            {!jumpHost && agentDeploymentCount === 0 && host.updatedAt > 0 && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatRelativeTime(host.updatedAt, t)}</span>}
            <span className="flex-1" />
            <ProbeInstallEntry host={host} os={resource?.os} enabled={monitoring} onOpenDetails={operations ? () => setDisclosure({ owner, expanded: true }) : undefined} />
          </div>
          <div className={cn('flex items-center gap-1.5 transition-opacity', 'sm:absolute sm:inset-x-4 sm:top-1/2 sm:-translate-y-1/2', 'sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100', isSelected && 'sm:pointer-events-auto sm:opacity-100')}>
            <Button data-testid="host-connect" size="sm" className="h-10 gap-1.5 text-sm md:h-8 md:text-xs" onClick={() => ssh ? onConnect(host.id) : onEdit(host.id)}>
              <Terminal className="h-4 w-4 md:h-3.5 md:w-3.5" />{ssh ? t('hostCard.connect') : t('hostDirectory.addSsh')}
            </Button>
            {ssh && <Button size="sm" variant="ghost" className="h-10 gap-1.5 text-sm md:h-8 md:text-xs" onClick={() => requestHostSftp({ vaultId: host.vaultId, hostId: host.id, path: '' })}><FolderOpen className="h-3.5 w-3.5" />SFTP</Button>}
            <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
            <span className="flex-1" />
            <button type="button" title={t('hostCard.edit')} aria-label={t('hostCard.edit')} onClick={() => onEdit(host.id)} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"><Pencil className="h-3.5 w-3.5" /></button>
            {onMoveToVault && <button type="button" data-testid="host-move-to-vault" title={fill(hostMoveCopy[locale].actionHost, { name: host.name })} aria-label={fill(hostMoveCopy[locale].actionHost, { name: host.name })} onClick={() => onMoveToVault(host.id)} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"><ArrowRightLeft className="h-3.5 w-3.5" /></button>}
            <button type="button" title={t('hostCard.delete')} aria-label={t('hostCard.delete')} onClick={() => setConfirmOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"><Trash2 className="h-3.5 w-3.5" /></button>
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
  monitoring?: boolean
  resources?: boolean
  batchSelection?: { selected: boolean; disabled: boolean; onChange: () => void }
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
  /** Present only when another Vault exists to move the host into. */
  onMoveToVault?: (id: string) => void
}

function HostStatusPill({ status, sc, t }: { status?: HostHealthStatus; sc: ReturnType<typeof statusConfig>; t: TFn }) {
  if (sc) {
    return (
      <span className={cn('inline-flex h-6 items-center justify-center gap-1.5 rounded-full border px-2 text-[11px] font-medium', sc.bg, sc.text, sc.border)}>
        <span className={cn('h-1.5 w-1.5 rounded-full', sc.dot)} />
        {sc.label}
      </span>
    )
  }
  if (status === 'checking') {
    return (
      <span className="inline-flex h-6 items-center justify-center gap-1.5 rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 text-[11px] font-medium text-[var(--workspace-text-muted)]">
        <RefreshCw className="h-3 w-3 animate-spin" />
        {t('hostCard.checking')}
      </span>
    )
  }
  return (
    <span className="inline-flex h-6 items-center justify-center rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 text-[11px] font-medium text-[var(--workspace-text-subtle)]">
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
  const tone = getResourceUsageTone(value)

  return (
    <div
      role="meter"
      aria-label={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : percent}
      title={title}
      data-tone={tone ?? 'unknown'}
      className="min-w-0"
    >
      <span className="flex items-center gap-1 text-[10px] font-medium text-[var(--workspace-text-muted)]">
        <span data-resource-metric-icon={iconKey} className={cn('flex h-3 w-3 shrink-0 items-center justify-center', getResourceUsageTextClassName(value))} aria-hidden="true">
          <Icon className="h-3 w-3" />
        </span>
        <span className="truncate">{label}</span>
      </span>
      <span className={cn('mt-0.5 block font-mono text-[17px] font-semibold leading-tight tabular-nums', tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : tone === 'warn' ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-strong)]')}>
        {value == null ? displayValue : <>{percent}<small className="ml-px text-[10px] font-medium text-[var(--workspace-text-muted)]">%</small></>}
      </span>
      <SegmentedMeter kind={iconKey} value={value} className="mt-1.5" />
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
    <div data-testid="host-resource-summary" className="min-w-0 space-y-2.5">
      <div className="grid grid-cols-3 gap-3">
      <HostResourceMetric icon={Cpu} iconKey="cpu" label={t('workspace.common.cpu')} value={metrics ? metrics.cpuPercent : resource?.cpuPercent} t={t} />
      <HostResourceMetric icon={MemoryStick} iconKey="memory" label={t('workspace.common.memoryShort')} value={metrics ? metrics.memoryPercent : resource?.memoryPercent} detail={metrics ? undefined : resource?.memoryText} t={t} />
      <HostResourceMetric icon={HardDrive} iconKey="disk" label={t('workspace.common.diskShort')} value={metrics ? metrics.diskPercent : resource?.diskPercent} detail={metrics ? undefined : resource?.diskText} t={t} />
      </div>
      <dl className="space-y-1.5 text-[10px] text-[var(--workspace-text-muted)]">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <dt className="inline-flex shrink-0 items-center gap-1.5"><Network className="h-3 w-3" aria-hidden="true" /><span className="sr-only">{t('workspace.monitor.network')}</span></dt>
          <dd data-testid="host-resource-throughput" className="min-w-0 break-words font-mono text-[var(--workspace-text-muted)]">{metrics ? <>
            <span title={t('workspace.monitor.receive')}>↓ {formatThroughput(metrics.networkRxBytesPerSec, t)}</span>
            {' · '}
            <span title={t('workspace.monitor.transmit')}>↑ {formatThroughput(metrics.networkTxBytesPerSec, t)}</span>
          </> : resource?.network?.trim() || t('hosts.opsFilters.unknown')}</dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <dt className="inline-flex shrink-0 items-center gap-1.5"><Clock className="h-3 w-3" aria-hidden="true" />{t('workspace.monitor.uptime')}</dt>
          <dd data-testid="host-resource-uptime" className="min-w-0 break-words font-mono text-[var(--workspace-text-muted)]">{uptime}</dd>
        </div>
      </dl>
    </div>
  )
}

function formatSummaryAge(ts: number | undefined, t: TFn) {
  if (!ts) return t('hosts.opsNoSample')
  return formatRelativeTime(ts, t)
}

function HostLocalAlertRows({ host, summary, t }: { host: HostProfile; summary: HostOperationalSummary; t: TFn }) {
  const { locale } = useT()
  if (summary.vaultId && host.vaultId && summary.vaultId !== host.vaultId) return null
  const alerts = (summary.localAlerts ?? []).filter((alert) => alert.hostId === host.id)
    .sort((left, right) => Number(left.status === 'closed' || left.status === 'resolved') - Number(right.status === 'closed' || right.status === 'resolved') || right.updatedAt - left.updatedAt)
  if (!alerts.length && !summary.localAlertError && !summary.localAlertPersistenceError && !summary.probeAlertLifecycleError) return null
  const act = (event: React.MouseEvent, alert: LocalAlertRecord, action: 'acknowledge' | 'close') => {
    event.stopPropagation()
    if (summary.localAlertBusy || !summary.onLocalAlertAction || (action === 'acknowledge' ? alert.status !== 'active' : !['active', 'acknowledged', 'resolved'].includes(alert.status))) return
    void summary.onLocalAlertAction(alert, action)
  }
  return <div data-testid="host-local-alerts" className="space-y-1.5 border-t border-[color:var(--workspace-border-soft)] pt-1.5">
    <span className="text-[10px] text-[var(--workspace-text-subtle)]">{hostPresentationCopy[locale].localEvents}</span>
    {alerts.slice(0, 3).map((alert) => <div key={alert.ruleId} data-testid="host-local-alert" data-rule-id={alert.ruleId} data-vault-id={summary.vaultId} data-host-id={alert.hostId} data-alert-status={alert.status} data-metric={alert.metric} data-job-id={alert.operationJobId} data-updated-at={validHostOpsSampleTime(alert.updatedAt)} data-resolved-at={validHostOpsSampleTime(alert.resolvedAt)} data-source={alert.source} data-transport={alert.transport} className="space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 basis-full break-words sm:basis-0"><strong>{alert.name}</strong> · {t(`localOps.metric.${alert.metric}`)} · {t(`localOps.status.${alert.status}`)}</span>
        {summary.onLocalAlertAction && alert.status === 'active' && <button type="button" data-testid={`local-host-alert-ack-${alert.ruleId}`} disabled={!!summary.localAlertBusy} onClick={(event) => act(event, alert, 'acknowledge')} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="shrink-0 rounded-md border px-1.5 py-1 disabled:opacity-50">{t('localOps.acknowledge')}</button>}
        {summary.onLocalAlertAction && ['active', 'acknowledged', 'resolved'].includes(alert.status) && <button type="button" data-testid={`local-host-alert-close-${alert.ruleId}`} disabled={!!summary.localAlertBusy} onClick={(event) => act(event, alert, 'close')} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="shrink-0 rounded-md border px-1.5 py-1 disabled:opacity-50">{t('localOps.close')}</button>}
      </div>
      <p className="break-words text-[var(--workspace-text-subtle)]">{alert.source ? monitoringProviderLabel(alert.source, locale) : t('hosts.opsNoProvider')} · {alert.transport === 'proxy-jump' ? t('hosts.opsProxyJump') : t('hosts.opsDirect')}{alert.operationJobId ? ` · job=${alert.operationJobId}` : ''}</p>
    </div>)}
    {alerts.length > 3 && <span>+{alerts.length - 3}</span>}
    {summary.localAlertError && <p role="alert" className="text-[color:var(--workspace-status-bad-text)]">{t('localOps.actionFailed')}</p>}
    {summary.localAlertPersistenceError && <p role="alert" className="text-[color:var(--workspace-status-bad-text)]">{t('localOps.persistenceFailed')}</p>}
    {summary.probeAlertLifecycleError && <p role="alert" className="text-[color:var(--workspace-status-bad-text)]">{t('localOps.probeLifecycleUnavailable')}</p>}
  </div>
}

function HostProbeEvaluationRows({ host, summary, t }: { host: HostProfile; summary: HostOperationalSummary; t: TFn }) {
  if (!summary.vaultId || host.vaultId && host.vaultId !== summary.vaultId) return null
  const evaluations = hostProbeEvaluations(summary.localAlertEvaluations ?? [])
  if (!evaluations.length) return null
  return <div className="space-y-1 border-t border-[color:var(--workspace-border-soft)] pt-1.5">
    {evaluations.map((evaluation) => <div key={evaluation.ruleId} data-testid="host-probe-evaluation" data-rule-id={evaluation.ruleId} data-vault-id={summary.vaultId} data-host-id={host.id} data-state={evaluation.state} data-sampled-at={evaluation.sampledAt ?? undefined} title={evaluation.sampledAt === null ? undefined : new Date(evaluation.sampledAt).toISOString()} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t('localOps.metric.probe-provider')} · {t(`localOps.probeSection.${evaluation.section}`)}</span>
      <strong>{t(`localOps.state.${evaluation.state}`)}</strong>
      <span className="ml-auto text-[var(--workspace-text-subtle)]">{formatSummaryAge(evaluation.sampledAt ?? undefined, t)}</span>
    </div>)}
  </div>
}

/** A list cell is a bounded summary. Detailed journals belong below the row. */
function HostOperationsCell({ host, summary, expanded, detailsId, onToggle, compactOnly = false }: {
  host: HostProfile; summary?: HostOperationalSummary; expanded: boolean; detailsId: string; onToggle: () => void; compactOnly?: boolean
}) {
  const { t, locale } = useT()
  const copy = monitoringSourcesCopy[locale]
  const presentation = hostPresentationCopy[locale]
  if (!summary) return <span className="text-xs text-[var(--workspace-text-subtle)]">—</span>
  const scopeVault = summary.vaultId && (!host.vaultId || host.vaultId === summary.vaultId) ? summary.vaultId : undefined
  const incidents = groupKomariAlertIncidents(summary.komariAlerts ?? []).map(({ alert }) => alert)
  const local = (summary.localAlerts ?? []).filter((alert) => alert.hostId === host.id)
  const localOpen = summary.localAlertOpen ?? local.filter((alert) => alert.status === 'active' || alert.status === 'acknowledged').length
  const komariOpen = summary.alertOpen ?? (incidents.length > 0
    ? incidents.filter((alert) => !isHistoricalKomariAlert(alert) && (alert.status === 'active' || alert.status === 'acknowledged')).length
    : summary.alertUnsupported ? undefined : summary.alertActive)
  const open = (komariOpen ?? 0) + localOpen
  const hasCounts = komariOpen != null || localOpen > 0 || (!summary.alertUnsupported
    && (summary.komariAlerts !== undefined || summary.localAlerts !== undefined || summary.localAlertOpen !== undefined))
  const formatCount = (value: number | null | undefined) => value == null ? '—' : String(value)
  const attention = summary.komariProbe && (summary.komariProbe.komari.waitingForFirstReport || summary.komariProbe.komari.state !== 'online' || summary.komariProbe.status !== 'linked') ? summary.komariProbe : null
  const failed = summary.localAlertError || summary.localAlertPersistenceError || summary.probeAlertLifecycleError
  return <div data-testid="host-ops-summary" data-host-ops-summary data-vault-id={scopeVault} data-host-id={host.id} data-sampled-at={validHostOpsSampleTime(summary.sampledAt)} className="min-w-0 space-y-1 text-[11px] leading-relaxed text-[var(--workspace-text-muted)]">
    {!compactOnly && (summary.serviceTotal != null || summary.processTotal != null) && <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{t('hosts.opsServicesShort')} <strong className="font-mono text-[var(--workspace-text-strong)]">{formatCount(summary.serviceActive)}/{formatCount(summary.serviceTotal)}</strong></span>
      <span>{t('hosts.opsProcessesShort')} <strong className="font-mono text-[var(--workspace-text-strong)]">{formatCount(summary.processRunning)}/{formatCount(summary.processTotal)}</strong></span>
      {(summary.serviceFailed ?? 0) > 0 && <span className="text-[color:var(--workspace-status-bad-text)]">{summary.serviceFailed} {t('hosts.opsFailed')}</span>}
    </div>}
    <div data-testid="host-ops-alert-summary" data-total={summary.alertTotal ?? undefined} data-active={summary.alertActive ?? undefined} data-open={summary.alertOpen ?? undefined} className="flex flex-wrap items-center gap-1.5">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{copy.operationsAlerts} <strong>{hasCounts ? open : '—'}</strong></span>
      {(summary.highestAlertSeverity || localOpen > 0) && <span data-testid="host-ops-local-alerts" data-open-count={localOpen} data-severity={summary.highestAlertSeverity ?? 'unknown'} className="text-[color:var(--workspace-status-warn-text)]">
        {summary.highestAlertSeverity ? t(`hosts.opsFilters.${summary.highestAlertSeverity}`) : t('hosts.opsFilters.unknown')}{localOpen > 0 ? ` · ${t('hosts.opsFilters.localAlerts')}: ${localOpen}` : ''}
      </span>}
    </div>
    {!compactOnly && summary.provider && <div data-testid="host-ops-compact-source" className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--workspace-text-subtle)]">
      <span className="truncate" title={monitoringProviderLabel(summary.provider, locale)}>{monitoringProviderLabel(summary.provider, locale)}</span>
      {summary.sampledAt && <span className="shrink-0">{formatSummaryAge(summary.sampledAt, t)}</span>}
    </div>}
    {attention && <div data-testid="host-monitoring-source-attention" data-source="komari" data-state={attention.komari.waitingForFirstReport ? 'waiting' : attention.komari.state} className={cn('text-[11px]', attention.komari.waitingForFirstReport ? 'text-[var(--workspace-text-subtle)]' : 'text-[color:var(--workspace-status-warn-text)]')}>
      {copy.komariSource} · {attention.komari.waitingForFirstReport ? copy.waitingForFirstReport : t(`workspace.komariProbe.state.${attention.komari.state}`)}
      {attention.status !== 'linked' ? ` · ${t(`workspace.komariProbe.mapping.${attention.status}`)}` : ''}
    </div>}
    {failed && <div data-testid="host-ops-attention" className="flex items-center gap-1 text-[color:var(--workspace-status-bad-text)]"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{copy.reviewRequired}</div>}
    {(summary.auditActive || summary.auditUnknown) ? <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
      {summary.auditActive ? <span>{summary.auditActive} {presentation.runningTasks}</span> : null}
      {summary.auditUnknown ? <span className="text-[color:var(--workspace-status-warn-text)]">{summary.auditUnknown} {presentation.needsVerification}</span> : null}
    </div> : null}
    <button type="button" data-testid="host-ops-details-toggle" aria-label={`${copy.expandOperations} · ${host.name}`} aria-expanded={expanded} aria-controls={detailsId} onClick={(event) => { event.stopPropagation(); onToggle() }} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} className="inline-flex min-h-7 items-center gap-1 rounded-md text-[11px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-accent-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
      {expanded ? copy.collapseOperations : copy.expandOperations}<ChevronDown className={cn('h-3.5 w-3.5', expanded && 'rotate-180')} aria-hidden="true" />
    </button>
  </div>
}

function HostOperationalMeta({ host, summary, t, expanded = false, stacked = false }: { host: HostProfile; summary?: HostOperationalSummary; t: TFn; expanded?: boolean; stacked?: boolean }) {
  const { locale } = useT()
  const sourceCopy = monitoringSourcesCopy[locale]
  const presentation = hostPresentationCopy[locale]
  if (!summary) return null
  const operations = summary
  const scopeVault = summary.vaultId && (!host.vaultId || host.vaultId === summary.vaultId) ? summary.vaultId : undefined

  const latest = summary.latestAudit
  const latestLabel = latest
    ? `${latest.action}${latest.target ? ` ${monitoringOperationTarget(latest.target, latest.action, locale)}` : ''} · ${latest.status}`
    : t('hosts.opsNoAudit')
  const actionNames: Record<string, string> = {
    'probe.collect': latest?.target === 'host metrics' ? presentation.collectMetrics : latest?.target === 'host inventory' ? presentation.collectInventory : presentation.collectProbe,
    'service.restart': presentation.serviceRestart, 'service.start': presentation.serviceStart,
    'service.stop': presentation.serviceStop, 'service.status': presentation.serviceStatus,
  }
  const taskName = latest ? (actionNames[latest.action] ?? latest.action) : t('hosts.opsNoAudit')
  const transportLabel = summary.transport === 'proxy-jump' ? t('hosts.opsProxyJump') : t('hosts.opsDirect')
  const formatCount = (value: number | null) => value == null ? '—' : String(value)
  const lifecycleStatuses = ['not-installed', 'installing', 'installed', 'upgrading', 'uninstalling', 'offline', 'unsupported', 'unknown', 'failed', 'retired']
  const lifecycleStatus = lifecycleStatuses.includes(summary.agentStatus ?? '') ? summary.agentStatus : 'unknown'
  const healthStatuses = ['online', 'offline', 'stale', 'unsupported', 'unknown']
  const agentHealth = healthStatuses.includes(summary.agentHealth ?? '') ? summary.agentHealth : 'unknown'
  const actionableAlerts = groupKomariAlertIncidents(summary.komariAlerts ?? []).map(({ alert }) => alert).filter((alert) => (
    alert.status === 'active' || alert.status === 'acknowledged' || alert.status === 'resolved'
  ))
  const latestAlertAudit = [...(summary.komariAlertAudits ?? [])].sort((left, right) => right.at - left.at)[0]
  const hasSourceDetails = Boolean(summary.agentStatus || summary.probeState || summary.komariProbe
    || summary.capabilities?.length || summary.ttlMs != null || summary.expiryReason)
  const komariAttention = summary.komariProbe && (
    summary.komariProbe.komari.waitingForFirstReport || summary.komariProbe.komari.state !== 'online' || summary.komariProbe.status !== 'linked'
  ) ? summary.komariProbe : null

  async function runAlertAction(action: 'acknowledge' | 'close', alert: KomariAlertRecord) {
    if (!operations.onKomariAlertAction || operations.komariAlertBusy) return
    await operations.onKomariAlertAction(action, alert)
  }

  return (
    <div data-testid={expanded ? 'host-ops-details-summary' : 'host-ops-summary'} data-host-ops-summary={!expanded || undefined} data-vault-id={scopeVault} data-host-id={host.id} data-sampled-at={validHostOpsSampleTime(summary.sampledAt)} className={cn('min-w-0 text-[var(--workspace-text-muted)]', expanded ? (stacked ? 'space-y-3 text-xs leading-relaxed' : 'grid items-start gap-3 text-xs leading-relaxed md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr]') : 'mt-2 space-y-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 text-[10px]')}>
      <div data-testid="host-alerts-panel" className="order-1 min-w-0 space-y-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3.5">
      {expanded && <h4 className="flex items-center gap-2 font-semibold text-[var(--workspace-text-strong)]"><AlertTriangle className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" aria-hidden="true" />{sourceCopy.operationsAlerts}</h4>}
      {!actionableAlerts.length && !(summary.localAlerts ?? []).some(alert => alert.hostId === host.id) && <p className="py-1 text-[var(--workspace-text-subtle)]">{presentation.alertEmpty}</p>}
      {actionableAlerts.length > 0 && (
        <div data-testid="host-ops-alert-actions" className="space-y-3">
          {actionableAlerts.slice(0, 3).map((alert) => {
            const busy = summary.komariAlertBusy === alert.alertId
            const canAcknowledge = alert.status === 'active' && !!summary.onKomariAlertAction
            const canClose = !!summary.onKomariAlertAction
            return (
              <div key={alert.alertId} className={cn('flex min-w-0 gap-1.5', expanded ? 'flex-wrap items-start' : 'items-center')}>
                <span className={cn('min-w-0 flex-1', expanded ? 'basis-full break-words [overflow-wrap:anywhere] sm:basis-0' : 'truncate')} title={monitoringAlertTitle(alert, locale)}>
                  <span className="font-medium text-[var(--workspace-text-strong)]">{monitoringAlertTitle(alert, locale)}</span>
                  <span className="ml-1 text-[var(--workspace-text-subtle)]">· {t(`komariAlerts.status.${alert.status}`)}</span>
                  {expanded && alert.loadEvidence && <span className="mt-1 block text-[var(--workspace-text-subtle)]">{loadEvidenceCopy(alert.loadEvidence, locale)}</span>}
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
        <div data-testid={expanded ? 'host-ops-details-alert-summary' : 'host-ops-alert-summary'} data-total={summary.alertTotal ?? undefined} data-active={summary.alertActive ?? undefined} data-open={summary.alertOpen ?? undefined} className="flex min-w-0 items-center gap-2">
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1" title={t('hosts.opsAlerts')}>
            <span className="text-[var(--workspace-text-subtle)]">{presentation.alertEvents}</span>
            <strong className="font-mono text-[var(--workspace-text-strong)]">
              {summary.alertUnsupported ? t('hosts.opsUnsupported') : formatCount(summary.alertTotal ?? null)}
            </strong>
            {summary.alertActive != null && <span className={summary.alertActive > 0 ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[var(--workspace-text-subtle)]'}>· {summary.alertActive} {t('hosts.opsActive')}</span>}
            {summary.alertOpen != null && summary.alertOpen !== summary.alertActive && <span className="text-[color:var(--workspace-status-warn-text)]">· {summary.alertOpen} {t('hosts.alert.active')}</span>}
            {summary.alertAcknowledged ? <span className="text-[color:var(--workspace-status-warn-text)]">· {t('hosts.alert.acknowledged')}: {summary.alertAcknowledged}</span> : null}
            {summary.alertClosed ? <span className="text-[color:var(--workspace-status-good-text)]">· {t('hosts.alert.closed')}: {summary.alertClosed}</span> : null}
            {summary.alertLinkedJobId && <span className="min-w-0 break-all font-mono">{t('hosts.alert.linkedOperation', { jobId: summary.alertLinkedJobId })}</span>}
          </span>
        </div>
      )}
      {!expanded && (summary.highestAlertSeverity || summary.localAlertOpen) ? <div data-testid="host-ops-local-alerts" data-open-count={summary.localAlertOpen ?? 0} data-severity={summary.highestAlertSeverity ?? 'unknown'} className="text-[color:var(--workspace-status-warn-text)]">{t('hosts.opsFilters.highest')}: {summary.highestAlertSeverity ? t(`hosts.opsFilters.${summary.highestAlertSeverity}`) : t('hosts.opsFilters.unknown')} · {t('hosts.opsFilters.localAlerts')}: {summary.localAlertOpen ?? 0}</div> : null}
      <HostLocalAlertRows host={host} summary={summary} t={t} />
      </div>
      <div data-testid="host-services-panel" className="order-2 min-w-0 space-y-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3.5">
      {expanded && <h4 className="flex items-center gap-2 font-semibold text-[var(--workspace-text-strong)]"><Wrench className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" aria-hidden="true" />{sourceCopy.operationsOverview}</h4>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
      <div className="space-y-1 border-t border-[color:var(--workspace-border-soft)] pt-2.5">
        <span className="text-[10px] text-[var(--workspace-text-subtle)]">{presentation.latestTask}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 break-words text-[var(--workspace-text-strong)]">{taskName}{latest?.target && latest.action !== 'probe.collect' ? ` · ${monitoringOperationTarget(latest.target, latest.action, locale)}` : ''}</span>
          {latest && <span className="rounded bg-[var(--workspace-surface-800)] px-1.5 py-0.5 text-[10px]">{t(`operations.status.${latest.status}`)}</span>}
        </div>
        {summary.auditActive ? <p className="text-[11px] text-[var(--workspace-text-muted)]">{summary.auditActive} {presentation.runningTasks}</p> : null}
        {(!!summary.auditUnknown || latest?.status === 'unknown') && <div className="space-y-1 rounded-md bg-[var(--workspace-status-warn-bg)] px-2 py-1.5 text-[11px] text-[color:var(--workspace-status-warn-text)]">
          <p>{t('hosts.opsAuditUnknown')}{summary.auditUnknown ? `: ${summary.auditUnknown}` : ''}</p>
          <p>{presentation.recoveryHint}</p>
        </div>}
      </div>
      <details data-testid="host-audit-details" className="border-t border-[color:var(--workspace-border-soft)] pt-2.5" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <summary className="cursor-pointer text-[11px] text-[var(--workspace-text-muted)]">{presentation.auditDetails} <span className="text-[var(--workspace-text-subtle)]">({summary.auditCount})</span></summary>
        <div className="mt-2 space-y-2 text-[11px]">
          <p>{presentation.auditHistory}: {summary.auditCount}{summary.auditFailed ? ` · ${presentation.historicalFailures}: ${summary.auditFailed}` : ''}</p>
          <p className="break-words font-mono text-[10px]">{latestLabel}</p>
      {latest?.auditId && <div className="break-all font-mono text-[10px] text-[var(--workspace-text-subtle)]" title={latest.auditId}>{latest.source} · job={latest.jobId} · audit={latest.auditId}</div>}
      {latestAlertAudit && (
        <div data-testid="host-ops-alert-audit" className="break-words text-[10px] text-[var(--workspace-text-subtle)]" title={`${latestAlertAudit.auditId} · ${latestAlertAudit.actor}`}>
          {t('hosts.alert.auditLatest', { event: t(`komariAlerts.event.${latestAlertAudit.event}`), actor: latestAlertAudit.actor })}
          {latestAlertAudit.operationJobId ? ` · job=${latestAlertAudit.operationJobId}` : ''}
        </div>
      )}
        </div>
      </details>
      </div>
      <div data-testid="host-monitoring-panel" className="order-3 min-w-0 space-y-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-3.5 md:col-span-2 xl:col-span-1">
      {expanded && <h4 className="flex items-center gap-2 font-semibold text-[var(--workspace-text-strong)]"><Activity className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)]" aria-hidden="true" />{sourceCopy.operationsSource}</h4>}
      {expanded && host.monitoringMode && <p data-testid="host-monitoring-mode" className="text-xs font-medium">{monitoringModeCopy[locale].title} · {monitoringModeCopy[locale][host.monitoringMode]}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[var(--workspace-text-subtle)]" data-testid="host-current-source">
        <span className="inline-flex min-w-0 items-center gap-1 truncate" title={summary.provider ? monitoringProviderLabel(summary.provider, locale) : t('hosts.opsNoProvider')}>
          <ShieldCheck className="h-3 w-3 shrink-0" />
          <span className="truncate">{summary.provider ? monitoringProviderLabel(summary.provider, locale) : t('hosts.opsNoProvider')}</span>
        </span>
        <span className="min-w-0 break-words">{transportLabel}{summary.jumpHostName ? ` · ${summary.jumpHostName}` : ''}</span>
        <span className="ml-auto shrink-0">{formatSummaryAge(summary.sampledAt, t)}</span>
      </div>
      {expanded && summary.provider === 'ssh-agentless' && <p data-testid="host-agentless-explanation" className="text-xs leading-relaxed text-[var(--workspace-text-subtle)]">{sourceCopy.agentlessHint}</p>}
      {!expanded && komariAttention && <div data-testid="host-monitoring-source-attention" data-source="komari" data-state={komariAttention.komari.waitingForFirstReport ? 'waiting' : komariAttention.komari.state} className={cn('flex items-center gap-1.5', komariAttention.komari.waitingForFirstReport ? 'text-[var(--workspace-text-subtle)]' : 'text-[color:var(--workspace-status-warn-text)]')}>
        <Activity className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{sourceCopy.komariSource} · {komariAttention.komari.waitingForFirstReport
          ? sourceCopy.waitingForFirstReport
          : t(`workspace.komariProbe.state.${komariAttention.komari.state}`)}{komariAttention.status !== 'linked' ? ` · ${t(`workspace.komariProbe.mapping.${komariAttention.status}`)}` : ''}</span>
      </div>}
      <HostProbeEvaluationRows host={host} summary={summary} t={t} />
      {hasSourceDetails && <details data-testid="host-data-source-details" className="space-y-1.5 border-t border-[color:var(--workspace-border-soft)] pt-1.5" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <summary className="cursor-pointer font-medium text-[var(--workspace-text-muted)]">{sourceCopy.details}</summary>
      {summary.agentStatus && !summary.komariProbe?.probe.record && (
        <div className="flex min-w-0 flex-wrap items-center gap-2" title={t('workspace.agentProbe.description')}>
          <Bot className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" />
          <span className="shrink-0">{t('workspace.agentProbe.title')}</span>
          <strong className="truncate font-medium text-[var(--workspace-text-strong)]">
            {t(`workspace.agentProbe.lifecycle.${lifecycleStatus}`)}
          </strong>
          {summary.agentHealth && <span className="shrink-0 text-[var(--workspace-text-subtle)]">· {t(`workspace.agentProbe.${agentHealth === 'online' ? 'online' : agentHealth === 'offline' ? 'offline' : 'unknown'}`)}</span>}
          {summary.agentVersion && <span className="min-w-0 break-all font-mono">v{summary.agentVersion}</span>}
          {summary.agentHeartbeatAt && <span className="ml-auto shrink-0">{formatSummaryAge(summary.agentHeartbeatAt, t)}</span>}
        </div>
      )}
      {summary.probeState && (
        <div className={cn(
          'flex min-w-0 flex-wrap items-center gap-1.5',
          summary.probeState === 'fresh' ? 'text-[color:var(--workspace-status-good-text)]' :
            summary.probeState === 'error' ? 'text-[color:var(--workspace-status-bad-text)]' :
              'text-[color:var(--workspace-status-warn-text)]',
        )} title={summary.probeError ? monitoringDiagnostic(summary.probeError, locale) : t('hosts.opsProbeState')}>
          <ShieldCheck className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{t('hosts.opsProbeState')}</span>
          <strong className="truncate font-medium">{t(`hosts.opsProbe.${summary.probeState}`)}</strong>
          {summary.probeProviderId && <span className="truncate font-mono text-[var(--workspace-text-subtle)]">· {summary.probeProviderId}</span>}
          {summary.probeTelemetry && (
            <span className="min-w-0 break-words text-[var(--workspace-text-subtle)]" title={t('hosts.opsProbe.telemetryHint')}>
              · {t('hosts.opsProbe.attempts', { count: summary.probeTelemetry.attempts })}
              {summary.probeTelemetry.exhausted ? ` · ${t('hosts.opsProbe.exhausted')}` : ''}
              {` · ${t('hosts.opsProbe.duration', { ms: summary.probeTelemetry.durationMs })}`}
            </span>
          )}
          {summary.probeErrorCode && <span className="min-w-0 break-all font-mono text-[var(--workspace-text-subtle)]">· {summary.probeErrorCode}</span>}
          {summary.probeError && <span className="min-w-0 break-words text-[var(--workspace-text-subtle)]" title={monitoringDiagnostic(summary.probeError, locale)}>· {monitoringDiagnostic(summary.probeError, locale)}</span>}
        </div>
      )}
      <div data-testid="host-ops-capabilities" className="flex flex-wrap gap-1" title={t('hosts.opsFilters.capabilitiesHint')}>
        {(summary.capabilities ?? []).map((capability) => <span key={capability} className="rounded border border-border/50 px-1 py-0.5">{t(`hosts.opsFilters.capability.${capability}`)}</span>)}
        {summary.ttlMs != null && <span className="rounded border border-border/50 px-1 py-0.5" title={summary.expiresAt ? new Date(summary.expiresAt).toLocaleString() : undefined}>TTL {Math.round(summary.ttlMs / 1_000)}s</span>}
        {summary.expiryReason === 'ttl-expired' && <span data-testid="host-ops-expiry-reason" className="rounded border border-border/50 px-1 py-0.5 text-[color:var(--workspace-status-warn-text)]">{t('hosts.opsExpiryReason.ttl-expired')}</span>}
      </div>
      {summary.komariProbe && (
        <KomariProbeOpsView
          host={host}
          link={summary.komariProbe}
          operationAudits={summary.audits}
          onAction={summary.onKomariProbeAction}
          busy={summary.komariProbeBusy}
        />
      )}
      </details>}
      <CompatibleAgentTools host={host} integrationId={summary.komariProbe?.status === 'linked' ? summary.komariProbe.integrationId : undefined} bindingKey={summary.komariProbe?.nodeId} />
      </div>
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

export function HostListItem({ resources, index, host, isSelected, status, resource, metrics, operations, network, agentDeploymentCount = 0, agentDeploymentStatus, onSelect, onConnect, onOpenWorkspace, onRefresh, onEdit, onDelete, onMoveToVault, monitoring = true, batchSelection }: HostListItemProps) {
  const { t, locale } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t, operations?.provider, hostPresentationCopy[locale])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const detailsId = useId()
  const detailsOwner = JSON.stringify([host.id, host.vaultId ?? '', operations?.vaultId ?? '', monitoring])
  const [detailsState, setDetailsState] = useState({ owner: detailsOwner, expanded: false })
  const detailsOpen = detailsState.owner === detailsOwner && detailsState.expanded
  if (detailsState.owner !== detailsOwner) {
    setDetailsState({ owner: detailsOwner, expanded: false })
  }
  const showResources = monitoring || (resources ?? !!(resource || metrics))
  const updatedAt = host.updatedAt > 0
    ? new Date(host.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : t('hosts.noActivity')
  const locationLabel = getNetworkLocationLabel(network, t)
  const scopeLabel = getNetworkScopeLabel(network, t)

  return (
    <>
      <div
        data-testid="host-card" data-host-id={host.id} data-host-name={host.name} data-host-health={status ?? 'unknown'}
        data-vault-id={host.vaultId ?? operations?.vaultId}
        className={cn(
          'group w-full min-w-0 text-left transition-colors',
          isSelected || batchSelection?.selected
            ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_var(--workspace-primary-500)]'
            : 'hover:bg-[var(--workspace-surface-800)]',
        )}
      >
        <div data-testid="host-list-primary" role="button" tabIndex={0}
          onClick={() => onSelect(host.id)} onDoubleClick={() => hasSshConnection(host) ? onConnect(host.id) : onEdit(host.id)}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              onSelect(host.id)
            }
          }}
          className={cn('grid min-w-0 cursor-pointer gap-4 px-4 py-3 sm:grid-cols-2 xl:items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--workspace-border-glow)]', monitoring ? HOST_LIST_COLUMNS : showResources ? HOST_RESOURCE_COLUMNS : HOST_CONNECTION_COLUMNS)}>
        <div className={cn('font-mono text-xs tabular-nums text-[var(--workspace-text-subtle)]', !batchSelection && 'hidden xl:block')}>
          {batchSelection ? <input type="checkbox" aria-label={`${hostPresentationCopy[locale].selectHost} · ${host.name}`} checked={batchSelection.selected} disabled={batchSelection.disabled} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onChange={batchSelection.onChange} /> : String(index).padStart(2, '0')}
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', resource?.os ? 'sb-os-badge' : bg)} style={resource?.os ? { '--os': osBrandColor(resource.os) } as CSSProperties : undefined}>
            {resource?.os ? <WorkspaceOsIcon os={resource.os} className="h-4 w-4" /> : icon}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{host.name}</p>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--workspace-text-muted)]">
              {!hasSshConnection(host) ? t('hostDirectory.monitoringOnly') : `${host.username || 'root'}@${host.address}${host.port !== 22 ? `:${host.port}` : ''}`}
              {hostConnections(host).length > 1 && <span className="ml-2">{t('hostDirectory.connectionCount', { count: hostConnections(host).length })}</span>}
            </p>
            <HostGroupTagsMeta operations={operations} host={host} t={t} agentDeploymentCount={agentDeploymentCount} agentDeploymentStatus={agentDeploymentStatus} />
          </div>
        </div>

        <div className="min-w-0 xl:self-center">
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--workspace-text-muted)]">
            <HostRegionMeta
              network={network}
              label={locationLabel}
              iconClassName="h-3.5 w-3.5"
              textClassName="text-xs text-[var(--workspace-text-muted)]"
            />
            {network?.locationStatus === 'loading' && <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-[var(--workspace-text-subtle)]" />}
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">{resource?.os || scopeLabel}</div>
        </div>

        <div className="min-w-0 xl:self-center">
          <div className="truncate font-mono text-xs text-[var(--workspace-text-muted)]">{host.address || '—'}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--workspace-text-subtle)]">
            {hasSshConnection(host) ? host.port !== 22 ? t('hosts.portValue', { port: host.port }) : t('hosts.defaultSshPort') : t('hostDirectory.addSsh')}
          </div>
        </div>

        {monitoring && <div className="text-xs text-[var(--workspace-text-muted)]" title={host.updatedAt > 0 ? new Date(host.updatedAt).toLocaleString() : undefined}>
          <span className="whitespace-nowrap font-mono text-sm font-semibold text-[var(--workspace-text-strong)]">{updatedAt}</span>
        </div>}

        {showResources && (resource || metrics ? <HostResourceSummary resource={resource} metrics={metrics} t={t} />
          : <span className="text-xs text-[var(--workspace-text-subtle)]">—</span>)}

        {monitoring && <HostOperationsCell host={host} summary={operations} expanded={detailsOpen} detailsId={detailsId} onToggle={() => setDetailsState({ owner: detailsOwner, expanded: !detailsOpen })} />}

        <div className="flex flex-col items-start gap-2">
          <HostStatusPill status={status} sc={sc} t={t} />
          {!monitoring && operations && <HostOperationsCell host={host} summary={operations} expanded={detailsOpen} detailsId={detailsId} compactOnly onToggle={() => setDetailsState({ owner: detailsOwner, expanded: !detailsOpen })} />}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 xl:justify-end [&>button]:shrink-0">
          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-[var(--workspace-accent-subtle)] px-3 text-xs font-medium text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-primary-500)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid="host-connect" onClick={(e) => { e.stopPropagation(); if (hasSshConnection(host)) onConnect(host.id); else onEdit(host.id) }} title={hasSshConnection(host) ? t('hostCard.connect') : t('hostDirectory.addSsh')}>
            <Terminal className="h-3.5 w-3.5" />{hasSshConnection(host) ? t('hostCard.connect') : t('hostDirectory.addSsh')}
          </button>
          <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
          <button
            type="button"
            className="order-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
            onClick={(e) => { e.stopPropagation(); onEdit(host.id) }} title={t('hostCard.edit')}>
            <Pencil className="h-4 w-4" />
          </button>
          {onMoveToVault && <button
            type="button" data-testid="host-move-to-vault"
            className="order-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
            onClick={(e) => { e.stopPropagation(); onMoveToVault(host.id) }} title={fill(hostMoveCopy[locale].actionHost, { name: host.name })} aria-label={fill(hostMoveCopy[locale].actionHost, { name: host.name })}>
            <ArrowRightLeft className="h-4 w-4" />
          </button>}
          <button
            type="button"
            className="order-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
            onClick={(e) => { e.stopPropagation(); setConfirmOpen(true) }} title={t('hostCard.delete')}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        </div>
        {operations && <HostOpsDrawer id={detailsId} host={host} summary={operations} open={detailsOpen} onClose={() => setDetailsState({ owner: detailsOwner, expanded: false })} dot={sc?.dot} groupLabel={host.group ? getDisplayGroupLabel(host.group, t) : undefined} network={network} jumpHost={formatJumpHost(host, operations)}
          actions={<>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => hasSshConnection(host) ? onConnect(host.id) : onEdit(host.id)}><Terminal className="h-3.5 w-3.5" />{hasSshConnection(host) ? t('hostCard.connect') : t('hostDirectory.addSsh')}</Button>
            {hasSshConnection(host) && <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => requestHostSftp({ vaultId: host.vaultId, hostId: host.id, path: '' })}><FolderOpen className="h-3.5 w-3.5" />SFTP</Button>}
            <HostOpsQuickActions host={host} onOpenWorkspace={onOpenWorkspace} onRefresh={onRefresh} />
          </>}>
          <HostOperationalMeta key={JSON.stringify([host.id, host.vaultId, operations.vaultId])} host={host} summary={operations} t={t} expanded />
        </HostOpsDrawer>}
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
