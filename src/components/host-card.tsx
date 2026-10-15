import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { getResourceUsageFillClassName, getResourceUsageTextClassName } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import type { WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import { AlertTriangle, Clock, Cpu, HardDrive, KeyRound, Laptop, LockKeyhole, MemoryStick, Pencil, RefreshCw, Route, Server, Tag, Terminal, Trash2, User } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { HostMetadataLine, HostRegionMeta } from './host-display-meta'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'

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

export function statusConfig(status: string | undefined, t: TFn) {
  if (status === 'online') return { label: t('hostCard.online'), dot: 'bg-[color:var(--workspace-status-good)]', text: 'text-[color:var(--workspace-status-good-text)]', bg: 'bg-[var(--workspace-status-good-bg)]', border: 'border-[color:var(--workspace-status-good-border)]' }
  if (status === 'offline') return { label: t('hostCard.offline'), dot: 'bg-[color:var(--workspace-status-bad)]', text: 'text-[color:var(--workspace-status-bad-text)]', bg: 'bg-[var(--workspace-status-bad-bg)]', border: 'border-[color:var(--workspace-status-bad-border)]' }
  return null
}

export function groupIconConfig(group: string) {
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

function formatJumpHost(host: HostProfile) {
  if (!host.jumpHost?.trim()) return ''
  const user = host.jumpUser?.trim() ? `${host.jumpUser.trim()}@` : ''
  const port = host.jumpPort ? `:${host.jumpPort}` : ''
  return `${user}${host.jumpHost.trim()}${port}`
}

interface HostGridCardProps {
  host: HostProfile
  isSelected: boolean
  status?: 'online' | 'offline' | 'checking'
  resource?: WorkspaceInventoryResource
  network?: HostNetworkDisplay
  onConnect: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSelect: (id: string) => void
}

export function HostGridCard({ host, isSelected, status, resource, network, onConnect, onEdit, onDelete }: HostGridCardProps) {
  const { t } = useT()
  const { icon, bg } = groupIconConfig(host.group || 'Custom')
  const sc = statusConfig(status, t)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const groupLabel = getDisplayGroupLabel(host.group, t)
  const jumpHost = formatJumpHost(host)

  return (
    <>
      <div
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
        </div>

        <div className="border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-10 flex-1 gap-1.5 text-sm md:h-8 md:text-xs" onClick={() => onConnect(host.id)}>
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
  status?: 'online' | 'offline' | 'checking'
  resource?: WorkspaceInventoryResource
  network?: HostNetworkDisplay
  onSelect: (id: string) => void
  onConnect: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

function HostStatusPill({ status, sc, t }: { status?: 'online' | 'offline' | 'checking'; sc: ReturnType<typeof statusConfig>; t: TFn }) {
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

function HostResourceSummary({ resource, t }: { resource?: WorkspaceInventoryResource; t: TFn }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-2 xl:border-0 xl:bg-transparent xl:p-0">
      <HostResourceMetric icon={Cpu} iconKey="cpu" label={t('workspace.common.cpu')} value={resource?.cpuPercent} detail={resource?.uptime} t={t} />
      <HostResourceMetric icon={MemoryStick} iconKey="memory" label={t('workspace.common.memoryShort')} value={resource?.memoryPercent} detail={resource?.memoryText} t={t} />
      <HostResourceMetric icon={HardDrive} iconKey="disk" label={t('workspace.common.diskShort')} value={resource?.diskPercent} detail={resource?.diskText} t={t} />
    </div>
  )
}

function HostGroupTagsMeta({ host, t }: { host: HostProfile; t: TFn }) {
  const groupLabel = getDisplayGroupLabel(host.group, t)
  const tags = host.tags ?? []
  const jumpHost = formatJumpHost(host)

  if (!groupLabel && tags.length === 0 && !jumpHost) return null

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

export function HostListItem({ index, host, isSelected, status, resource, network, onSelect, onConnect, onEdit, onDelete }: HostListItemProps) {
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
          'xl:grid-cols-[3.25rem_minmax(14rem,1.14fr)_minmax(12rem,0.92fr)_minmax(10rem,0.75fr)_7rem_minmax(15rem,1.02fr)_7rem_6.5rem] xl:items-center xl:gap-4',
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
            <HostGroupTagsMeta host={host} t={t} />
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

        <HostResourceSummary resource={resource} t={t} />

        <div className="flex items-center">
          <HostStatusPill status={status} sc={sc} t={t} />
        </div>

        <div className="flex items-center justify-start gap-1 xl:justify-end xl:opacity-0 xl:transition-opacity xl:group-hover:opacity-100">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-accent-text)] md:h-8 md:w-8"
            onClick={(e) => { e.stopPropagation(); onConnect(host.id) }} title={t('hostCard.connect')}>
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
