import { useMemo, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { Search } from 'lucide-react'

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

interface WorkspaceServerListProps {
  hosts: HostProfile[]
  totalCount?: number
  selectedKey: string
  onSelect: (key: string, host?: HostProfile) => void
  getHostKey: (host: HostProfile) => string
  allOption?: ServerListAllOption
  emptyText?: ReactNode
  renderStatusIcon?: (host: HostProfile) => ReactNode
  getStatusBadge?: (host: HostProfile) => ServerListBadge | undefined
  getPrimaryBadge?: (host: HostProfile) => ServerListBadge | undefined
  renderNetworkLine?: (host: HostProfile) => ReactNode
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

export function getWorkspaceServerSearchText(host: HostProfile, searchData?: WorkspaceServerSearchData) {
  return [
    host.name,
    host.address,
    host.username,
    host.group,
    host.authType,
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
  getHostKey,
  allOption,
  emptyText = '没有匹配的服务器。',
  renderStatusIcon,
  getStatusBadge,
  getPrimaryBadge,
  renderNetworkLine,
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
            const isInaccessible = statusBadge?.tone === 'bad'
            return (
              <button
                key={key}
                type="button"
                data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-${key}` : undefined}
                onClick={() => onSelect(key, host)}
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
                      {statusBadge && <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>}
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{host.username}@{host.address}</div>
                    {renderNetworkLine?.(host)}
                  </div>
                  {primaryBadge && <Badge tone={primaryBadge.tone}>{primaryBadge.label}</Badge>}
                </div>
                {renderMetrics?.(host)}
                {isInaccessible ? (
                  <div className="mt-2 text-[11px] text-red-200">无法访问</div>
                ) : (
                  renderFooter?.(host)
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
