import { useMemo, useState, type ComponentType, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { getResourceUsageTextClassName } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import { Clock, Cpu, HardDrive, KeyRound, LockKeyhole, MemoryStick, Route, Search, Tags } from 'lucide-react'

type ServerBadgeTone = 'default' | 'good' | 'warn' | 'bad' | 'info'
type ServerSearchValue = string | number | null | undefined | false

interface ServerListBadge {
  label: ReactNode
  tone?: ServerBadgeTone
}

interface ServerListAllOption {
  key: string
  title: string
  subtitle?: ReactNode
  badge?: ServerListBadge
}

export interface WorkspaceServerSearchData {
  network?: ServerSearchValue[]
  system?: ServerSearchValue[]
  tools?: ServerSearchValue[]
  projects?: ServerSearchValue[]
}

export interface WorkspaceServerResourceMetrics {
  cpuPercent?: number | null
  memoryPercent?: number | null
  diskPercent?: number | null
  cpuDetail?: ReactNode
  memoryDetail?: ReactNode
  diskDetail?: ReactNode
}

interface WorkspaceServerListProps {
  hosts: HostProfile[]
  totalCount?: number
  selectedKey: string
  onSelect: (key: string, host?: HostProfile) => void
  onRowDoubleClick?: (host: HostProfile) => void
  getHostKey: (host: HostProfile) => string
  allOption?: ServerListAllOption
  emptyText?: ReactNode
  renderStatusIcon?: (host: HostProfile) => ReactNode
  getStatusBadge?: (host: HostProfile) => ServerListBadge | undefined
  getPrimaryBadge?: (host: HostProfile) => ServerListBadge | undefined
  renderRegionLine?: (host: HostProfile) => ReactNode
  getSystemLabel?: (host: HostProfile) => string | undefined
  getResourceMetrics?: (host: HostProfile) => WorkspaceServerResourceMetrics | undefined
  renderMetrics?: (host: HostProfile) => ReactNode
  renderFooter?: (host: HostProfile) => ReactNode
  getSearchData?: (host: HostProfile) => WorkspaceServerSearchData
  itemTestIdPrefix?: string
  presentation?: 'panel' | 'mobile'
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: ServerBadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-lg border px-2 py-1 text-[11px] font-medium',
        tone === 'good' && 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
        tone === 'warn' && 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
        tone === 'bad' && 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
        tone === 'info' && 'border-[color:var(--workspace-status-info-border)] bg-[var(--workspace-status-info-bg)] text-[color:var(--workspace-status-info-text)]',
        tone === 'default' && 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text)]',
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

function normalizeSearchValue(value: ServerSearchValue) {
  if (value === null || value === undefined || value === false) return ''
  return String(value).trim()
}

function formatHostEndpoint(host: HostProfile) {
  return `${host.username || 'root'}@${host.address}:${host.port || 22}`
}

function formatHostUpdatedAt(updatedAt: number) {
  if (!updatedAt) return ''
  return new Date(updatedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

function getHostAuthMeta(host: HostProfile, t: ReturnType<typeof useT>['t']) {
  return host.authType === 'privateKey'
    ? { label: t('workspace.serverIndex.keyAuth'), Icon: KeyRound }
    : { label: t('workspace.serverIndex.passwordAuth'), Icon: LockKeyhole }
}

function formatJumpHost(host: HostProfile) {
  if (!host.jumpHost) return ''
  const user = host.jumpUser ? `${host.jumpUser}@` : ''
  const port = host.jumpPort ? `:${host.jumpPort}` : ''
  return `${user}${host.jumpHost}${port}`
}

function HostMetaPill({
  children,
  title,
  icon: Icon,
}: {
  children: ReactNode
  title?: string
  icon?: typeof Search
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]"
      title={title}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

function HostConfigMeta({ host }: { host: HostProfile }) {
  const { t } = useT()
  const auth = getHostAuthMeta(host, t)
  const jumpHost = formatJumpHost(host)
  const updatedAt = formatHostUpdatedAt(host.updatedAt)
  const tags = host.tags ?? []

  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
      {host.group && <HostMetaPill title={t('workspace.serverIndex.groupTitle', { group: host.group })}>{host.group}</HostMetaPill>}
      <HostMetaPill icon={auth.Icon} title={t('workspace.serverIndex.authTitle', { auth: auth.label })}>{auth.label}</HostMetaPill>
      {tags.slice(0, 2).map((tag) => (
        <HostMetaPill key={tag} icon={Tags} title={t('workspace.serverIndex.tagTitle', { tag })}>{tag}</HostMetaPill>
      ))}
      {tags.length > 2 && (
        <HostMetaPill title={t('workspace.serverIndex.tagTitle', { tag: tags.join(', ') })}>+{tags.length - 2}</HostMetaPill>
      )}
      {jumpHost && <HostMetaPill icon={Route} title={t('workspace.serverIndex.jumpTitle', { host: jumpHost })}>{t('workspace.serverIndex.jump', { host: jumpHost })}</HostMetaPill>}
      {updatedAt && <HostMetaPill icon={Clock} title={new Date(host.updatedAt).toLocaleString()}>{t('workspace.serverIndex.updated', { date: updatedAt })}</HostMetaPill>}
    </div>
  )
}

function formatPercent(value: number | null | undefined, t: ReturnType<typeof useT>['t']) {
  return value == null ? t('workspace.common.notAvailable') : `${Math.round(value)}%`
}

function CompactResourceMetric({
  icon: Icon,
  label,
  value,
  detail,
  t,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value?: number | null
  detail?: ReactNode
  t: ReturnType<typeof useT>['t']
}) {
  const percent = value == null ? null : Math.min(100, Math.max(0, Math.round(value)))
  const radius = 13
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (circumference * (percent ?? 0)) / 100
  const title = detail ? `${label} ${formatPercent(value, t)} · ${detail}` : `${label} ${formatPercent(value, t)}`

  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className="flex min-w-0 items-center gap-1.5"
    >
      <span className={cn('relative h-8 w-8 shrink-0', getResourceUsageTextClassName(value))}>
        <svg viewBox="0 0 32 32" className="h-8 w-8 -rotate-90" aria-hidden="true">
          <circle cx="16" cy="16" r={radius} fill="none" stroke="var(--workspace-meter-track)" strokeWidth="3.5" />
          <circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="3.5"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] font-semibold text-[var(--workspace-text-strong)]">
          {percent ?? '--'}
        </span>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1 truncate text-[10px] font-semibold uppercase text-[var(--workspace-text-muted)]">
          <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </span>
        <span className="block truncate font-mono text-[10px] text-[var(--workspace-text-strong)]">{formatPercent(value, t)}</span>
      </span>
    </div>
  )
}

function ServerResourceMetrics({ metrics, t }: { metrics: WorkspaceServerResourceMetrics; t: ReturnType<typeof useT>['t'] }) {
  return (
    <div className="mt-3 grid min-w-0 grid-cols-3 gap-2 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 py-2">
      <CompactResourceMetric icon={Cpu} label={t('workspace.common.cpu')} value={metrics.cpuPercent} detail={metrics.cpuDetail} t={t} />
      <CompactResourceMetric icon={MemoryStick} label={t('workspace.common.memoryShort')} value={metrics.memoryPercent} detail={metrics.memoryDetail} t={t} />
      <CompactResourceMetric icon={HardDrive} label={t('workspace.common.diskShort')} value={metrics.diskPercent} detail={metrics.diskDetail} t={t} />
    </div>
  )
}

export function getWorkspaceServerSearchText(host: HostProfile, searchData?: WorkspaceServerSearchData, t?: ReturnType<typeof useT>['t']) {
  const authLabel = t ? getHostAuthMeta(host, t).label : host.authType
  return [
    host.name,
    host.address,
    formatHostEndpoint(host),
    host.port,
    host.username,
    host.group,
    host.authType,
    authLabel,
    host.jumpHost,
    formatJumpHost(host),
    host.jumpPort,
    host.jumpUser,
    host.jumpHost && (t ? t('workspace.serverIndex.jumpSearch') : 'jump'),
    ...(host.tags ?? []),
    ...(searchData?.network ?? []),
    ...(searchData?.system ?? []),
    ...(searchData?.tools ?? []),
    ...(searchData?.projects ?? []),
  ].map(normalizeSearchValue).filter(Boolean).join(' ').toLowerCase()
}

export function workspaceServerMatchesSearch(host: HostProfile, query: string, searchData?: WorkspaceServerSearchData, t?: ReturnType<typeof useT>['t']) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return getWorkspaceServerSearchText(host, searchData, t).includes(normalizedQuery)
}

export function WorkspaceServerList({
  hosts,
  totalCount = hosts.length,
  selectedKey,
  onSelect,
  onRowDoubleClick,
  getHostKey,
  allOption,
  emptyText,
  renderStatusIcon,
  getStatusBadge,
  getPrimaryBadge,
  renderRegionLine,
  getSystemLabel,
  getResourceMetrics,
  renderMetrics,
  renderFooter,
  getSearchData,
  itemTestIdPrefix,
  presentation = 'panel',
}: WorkspaceServerListProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const emptyStateText = emptyText ?? t('workspace.serverIndex.noMatch')
  const isMobile = presentation === 'mobile'
  const visibleHosts = useMemo(() => {
    if (!normalizedQuery) return hosts
    return hosts.filter((host) => workspaceServerMatchesSearch(host, normalizedQuery, getSearchData?.(host), t))
  }, [getSearchData, hosts, normalizedQuery, t])
  const usesResourceSummary = Boolean(getResourceMetrics)

  return (
    <aside
      data-testid="workspace-server-list"
      className={cn(
      'flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-card)]',
      !isMobile && 'h-full min-h-0',
      )}
    >
      <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('workspace.serverIndex.title')}</div>
        <div className="mt-1 text-xs text-[var(--workspace-text-muted)]">{t('workspace.serverIndex.matched', { visible: visibleHosts.length, total: totalCount })}</div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('workspace.serverIndex.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-8 pr-3 text-xs text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
          />
        </div>
      </div>
      <div className={cn(isMobile ? 'p-3 pb-4' : 'min-h-0 flex-1 overflow-auto p-3 pb-4')}>
        {allOption && !normalizedQuery && (
          <button
            type="button"
            onClick={() => onSelect(allOption.key)}
            className={cn(
              'mb-2 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
              selectedKey === allOption.key
                ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-surface-row-selected)]'
                : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] hover:bg-[var(--workspace-surface-800)]',
            )}
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{allOption.title}</div>
              {allOption.subtitle && <div className="truncate text-xs text-[var(--workspace-text-muted)]">{allOption.subtitle}</div>}
            </div>
            {allOption.badge && <Badge tone={allOption.badge.tone}>{allOption.badge.label}</Badge>}
          </button>
        )}

        <div className="space-y-2">
          {visibleHosts.map((host) => {
            const key = getHostKey(host)
            const statusBadge = getStatusBadge?.(host)
            const primaryBadge = getPrimaryBadge?.(host)
            const visibleStatusBadge = statusBadge?.tone === 'bad' ? statusBadge : undefined
            const isInaccessible = visibleStatusBadge?.tone === 'bad'
            const metrics = getResourceMetrics?.(host)
            const metricsContent = renderMetrics?.(host) ?? (!isInaccessible && metrics ? <ServerResourceMetrics metrics={metrics} t={t} /> : null)
            const systemLabel = getSystemLabel?.(host)
            return (
              <button
                key={key}
                type="button"
                data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-${key}` : undefined}
                onClick={() => onSelect(key, host)}
                onDoubleClick={() => onRowDoubleClick?.(host)}
                className={cn(
                  'w-full rounded-2xl border px-3.5 py-3.5 text-left transition-[background-color,border-color,box-shadow]',
                  selectedKey === key
                    ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_var(--workspace-primary-500),var(--workspace-shadow-card)]'
                    : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-row)] hover:border-[color:var(--workspace-border-strong)] hover:bg-[var(--workspace-surface-950)] hover:shadow-[var(--workspace-shadow-card)]',
                )}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {renderStatusIcon?.(host)}
                      <span className="min-w-0 truncate text-sm font-semibold text-[var(--workspace-text-strong)]">
                        {host.name}
                        {systemLabel && <span className="font-medium text-[var(--workspace-text-muted)]"> ({systemLabel})</span>}
                      </span>
                      {visibleStatusBadge && <Badge tone={visibleStatusBadge.tone}>{visibleStatusBadge.label}</Badge>}
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{formatHostEndpoint(host)}</div>
                    {renderRegionLine?.(host)}
                    <HostConfigMeta host={host} />
                  </div>
                  {primaryBadge && <Badge tone={primaryBadge.tone}>{primaryBadge.label}</Badge>}
                </div>
                {metricsContent}
                {isInaccessible ? (
                  <div className="mt-2 text-[11px] text-[color:var(--workspace-status-bad-text)]">{t('workspace.serverIndex.inaccessible')}</div>
                ) : (
                  !usesResourceSummary && renderFooter?.(host)
                )}
              </button>
            )
          })}
        </div>

        {visibleHosts.length === 0 && <div className="px-3 py-8 text-center text-sm text-[var(--workspace-text-muted)]">{emptyStateText}</div>}
      </div>
    </aside>
  )
}
