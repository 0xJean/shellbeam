import { useMemo, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { Clock, KeyRound, LockKeyhole, Route, Search, Tags } from 'lucide-react'

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
  getResourceMetrics?: (host: HostProfile) => WorkspaceServerResourceMetrics | undefined
  renderMetrics?: (host: HostProfile) => ReactNode
  renderFooter?: (host: HostProfile) => ReactNode
  getSearchData?: (host: HostProfile) => WorkspaceServerSearchData
  itemTestIdPrefix?: string
}

function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: ServerBadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-lg border px-2 py-1 text-[11px] font-medium',
        tone === 'good' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-200',
        tone === 'bad' && 'border-red-500/30 bg-red-500/10 text-red-200',
        tone === 'info' && 'border-sky-500/30 bg-sky-500/10 text-sky-200',
        tone === 'default' && 'border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.7)] text-[var(--workspace-text)]',
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

function getHostAuthMeta(host: HostProfile) {
  return host.authType === 'privateKey'
    ? { label: '密钥', Icon: KeyRound }
    : { label: '密码', Icon: LockKeyhole }
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
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[rgba(24,35,48,0.42)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--workspace-text-muted)]"
      title={title}
    >
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

function HostConfigMeta({ host }: { host: HostProfile }) {
  const auth = getHostAuthMeta(host)
  const jumpHost = formatJumpHost(host)
  const updatedAt = formatHostUpdatedAt(host.updatedAt)
  const tags = host.tags ?? []

  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
      {host.group && <HostMetaPill title={`分组：${host.group}`}>{host.group}</HostMetaPill>}
      <HostMetaPill icon={auth.Icon} title={`认证方式：${auth.label}`}>{auth.label}</HostMetaPill>
      {tags.slice(0, 2).map((tag) => (
        <HostMetaPill key={tag} icon={Tags} title={`标签：${tag}`}>{tag}</HostMetaPill>
      ))}
      {tags.length > 2 && (
        <HostMetaPill title={`标签：${tags.join(', ')}`}>+{tags.length - 2}</HostMetaPill>
      )}
      {jumpHost && <HostMetaPill icon={Route} title={`跳板机：${jumpHost}`}>跳板 {jumpHost}</HostMetaPill>}
      {updatedAt && <HostMetaPill icon={Clock} title={new Date(host.updatedAt).toLocaleString()}>更新 {updatedAt}</HostMetaPill>}
    </div>
  )
}

function formatPercent(value: number | null | undefined) {
  return value == null ? 'n/a' : `${Math.round(value)}%`
}

function getMetricToneClass(value: number | null | undefined) {
  if (value == null) return 'text-slate-500'
  if (value >= 90) return 'text-red-400'
  if (value >= 75) return 'text-amber-300'
  return 'text-emerald-300'
}

function CompactResourceMetric({
  label,
  value,
  detail,
}: {
  label: string
  value?: number | null
  detail?: ReactNode
}) {
  const percent = value == null ? null : Math.min(100, Math.max(0, Math.round(value)))
  const radius = 13
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (circumference * (percent ?? 0)) / 100
  const title = detail ? `${label} ${formatPercent(value)} · ${detail}` : `${label} ${formatPercent(value)}`

  return (
    <div
      role="img"
      aria-label={title}
      title={title}
      className="flex min-w-0 items-center gap-1.5"
    >
      <span className={cn('relative h-8 w-8 shrink-0', getMetricToneClass(value))}>
        <svg viewBox="0 0 32 32" className="h-8 w-8 -rotate-90" aria-hidden="true">
          <circle cx="16" cy="16" r={radius} fill="none" stroke="rgba(148,163,184,0.22)" strokeWidth="3.5" />
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
        <span className="block truncate text-[10px] font-semibold uppercase text-[var(--workspace-text-muted)]">{label}</span>
        <span className="block truncate font-mono text-[10px] text-[var(--workspace-text-strong)]">{formatPercent(value)}</span>
      </span>
    </div>
  )
}

function ServerResourceMetrics({ metrics }: { metrics: WorkspaceServerResourceMetrics }) {
  return (
    <div className="mt-3 flex min-w-0 items-center justify-between gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.28)] px-2 py-2">
      <CompactResourceMetric label="CPU" value={metrics.cpuPercent} detail={metrics.cpuDetail} />
      <CompactResourceMetric label="MEM" value={metrics.memoryPercent} detail={metrics.memoryDetail} />
      <CompactResourceMetric label="DISK" value={metrics.diskPercent} detail={metrics.diskDetail} />
    </div>
  )
}

export function getWorkspaceServerSearchText(host: HostProfile, searchData?: WorkspaceServerSearchData) {
  return [
    host.name,
    host.address,
    formatHostEndpoint(host),
    host.port,
    host.username,
    host.group,
    host.authType,
    getHostAuthMeta(host).label,
    host.jumpHost,
    formatJumpHost(host),
    host.jumpPort,
    host.jumpUser,
    host.jumpHost && '跳板',
    ...(host.tags ?? []),
    ...(searchData?.network ?? []),
    ...(searchData?.system ?? []),
    ...(searchData?.tools ?? []),
    ...(searchData?.projects ?? []),
  ].map(normalizeSearchValue).filter(Boolean).join(' ').toLowerCase()
}

export function workspaceServerMatchesSearch(host: HostProfile, query: string, searchData?: WorkspaceServerSearchData) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return getWorkspaceServerSearchText(host, searchData).includes(normalizedQuery)
}

export function WorkspaceServerList({
  hosts,
  totalCount = hosts.length,
  selectedKey,
  onSelect,
  onRowDoubleClick,
  getHostKey,
  allOption,
  emptyText = '没有匹配的服务器。',
  renderStatusIcon,
  getStatusBadge,
  getPrimaryBadge,
  renderRegionLine,
  getResourceMetrics,
  renderMetrics,
  renderFooter,
  getSearchData,
  itemTestIdPrefix,
}: WorkspaceServerListProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleHosts = useMemo(() => {
    if (!normalizedQuery) return hosts
    return hosts.filter((host) => workspaceServerMatchesSearch(host, normalizedQuery, getSearchData?.(host)))
  }, [getSearchData, hosts, normalizedQuery])
  const usesResourceSummary = Boolean(getResourceMetrics)

  return (
    <aside className="min-h-0 overflow-hidden rounded-xl border border-[color:var(--workspace-border-strong)] bg-[rgba(8,15,22,0.38)]">
      <div className="border-b border-[color:var(--workspace-border-strong)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">服务器资产索引</div>
        <div className="mt-1 text-xs text-[var(--workspace-text-muted)]">{visibleHosts.length}/{totalCount} 台匹配</div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索服务器、IP、地区、项目、工具..."
            className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[rgba(8,15,22,0.72)] pl-8 pr-3 text-xs text-[var(--workspace-text-strong)] outline-none transition-colors placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-border-glow)]"
          />
        </div>
      </div>
      <div className="max-h-[58vh] overflow-auto p-3">
        {allOption && !normalizedQuery && (
          <button
            type="button"
            onClick={() => onSelect(allOption.key)}
            className={cn(
              'mb-2 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
              selectedKey === allOption.key
                ? 'border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.14)]'
                : 'border-[color:var(--workspace-border-soft)] bg-[rgba(15,23,42,0.48)] hover:bg-[rgba(24,35,48,0.72)]',
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
            const metricsContent = renderMetrics?.(host) ?? (!isInaccessible && metrics ? <ServerResourceMetrics metrics={metrics} /> : null)
            return (
              <button
                key={key}
                type="button"
                data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-${key}` : undefined}
                onClick={() => onSelect(key, host)}
                onDoubleClick={() => onRowDoubleClick?.(host)}
                className={cn(
                  'w-full rounded-xl border px-3 py-3 text-left transition-colors',
                  selectedKey === key
                    ? 'border-[color:var(--workspace-border-glow)] bg-[rgba(19,127,236,0.14)]'
                    : 'border-[color:var(--workspace-border-soft)] bg-[rgba(15,23,42,0.48)] hover:bg-[rgba(24,35,48,0.72)]',
                )}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {renderStatusIcon?.(host)}
                      <span className="truncate text-sm font-semibold text-[var(--workspace-text-strong)]">{host.name}</span>
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
                  <div className="mt-2 text-[11px] text-red-200">无法访问</div>
                ) : (
                  !usesResourceSummary && renderFooter?.(host)
                )}
              </button>
            )
          })}
        </div>

        {visibleHosts.length === 0 && <div className="px-3 py-8 text-center text-sm text-[var(--workspace-text-muted)]">{emptyText}</div>}
      </div>
    </aside>
  )
}
