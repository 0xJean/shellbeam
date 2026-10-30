import { monitoringOperationTarget } from '@/lib/monitoring-presentation'
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { useVault } from '@/contexts/vault-context'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import {
  Clock,
  Server,
  Plug,
  PlugZap,
  KeyRound,
  Terminal,
  RefreshCw,
  AlertTriangle,
  Search,
} from 'lucide-react'
import { listActivityLog, type ActivityEntry } from '@/lib/activity-log'
import { listOperationAudit } from '@/lib/operation-job'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from './host-display-meta'
import OperationsAuditCenter from './operations-audit-center'
import { Input } from '@/components/ui/input'
import { BarList, ChartCard, SegmentedTabs, Sparkline } from '@/components/charts/chart-primitives'
import { buildActivityHeatmap, dailyCounts, groupEntriesByDay, heatmapLevel, rankHosts, withinDays } from '@/lib/activity-timeline'
import { historyV3Copy } from '@/lib/locales/known-history-v3'
import { fill } from '@/lib/locales/probe-install'

const ACTIVITY_RETENTION = 500
const AUDIT_LIMIT = 100
const HEATMAP_WEEKS = 12

const EVENT_ICONS: Record<string, { Icon: typeof Plug; tone: string }> = {
  connect: { Icon: Plug, tone: 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]' },
  disconnect: { Icon: PlugZap, tone: 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]' },
  reconnect: { Icon: RefreshCw, tone: 'bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]' },
  auth_fail: { Icon: AlertTriangle, tone: 'bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]' },
  local_terminal: { Icon: Terminal, tone: 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]' },
  operation: { Icon: Server, tone: 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' },
}
const FALLBACK_ICON = { Icon: Server, tone: 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]' }

const HEAT_FILL = [
  'var(--workspace-surface-700)',
  'color-mix(in srgb, var(--workspace-primary-400) 28%, var(--workspace-surface-800))',
  'color-mix(in srgb, var(--workspace-primary-400) 50%, var(--workspace-surface-800))',
  'color-mix(in srgb, var(--workspace-primary-400) 74%, var(--workspace-surface-800))',
  'var(--workspace-primary-400)',
]

type EventFilter = 'all' | 'connection' | 'auth_fail' | 'local_terminal' | 'operation'
type HistoryTab = 'events' | 'audit'
type TimelineEntry = ActivityEntry & { operationStatus?: string }

const CONNECTION_EVENTS = new Set(['connect', 'disconnect', 'reconnect'])

function matchesFilter(entry: TimelineEntry, filter: EventFilter) {
  if (filter === 'all') return true
  if (filter === 'connection') return CONNECTION_EVENTS.has(entry.event)
  return entry.event === filter
}

interface ActivityLogPanelProps {
  hosts?: HostProfile[]
}

export function ActivityLogPanel({ hosts = [] }: ActivityLogPanelProps) {
  const { t, locale } = useT()
  const c = historyV3Copy[locale]
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(0)
  const [tab, setTab] = useState<HistoryTab>('events')
  const [filter, setFilter] = useState<EventFilter>('all')
  const [search, setSearch] = useState('')
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  // Activity and audit are scoped to the active vault; a late reply for a previous vault is dropped.
  const { activeVaultId } = useVault()
  const requestRef = useRef(0)

  const refresh = useCallback(() => {
    const request = ++requestRef.current
    setLoading(true)
    Promise.allSettled([listActivityLog(activeVaultId), listOperationAudit({ vaultId: activeVaultId, limit: AUDIT_LIMIT })])
      .then(([activityResult, auditResult]) => {
        if (request !== requestRef.current) return
        const activity = activityResult.status === 'fulfilled' ? activityResult.value : []
        const audit = auditResult.status === 'fulfilled' ? auditResult.value : []
        const operationEntries: TimelineEntry[] = audit.map((entry) => ({
          id: entry.auditId,
          event: 'operation',
          hostId: entry.hostId ?? undefined,
          hostName: entry.hostName || entry.hostAddress || 'Unknown host',
          hostAddress: entry.hostAddress || '',
          username: undefined,
          authType: undefined,
          detail: `${entry.action} ${monitoringOperationTarget(entry.target, entry.action, locale)} · ${entry.status} · audit ${entry.auditId}`,
          createdAt: entry.createdAt,
          operationStatus: entry.status,
        }))
        setNow(Date.now())
        setEntries([...activity, ...operationEntries].sort((a, b) => b.createdAt - a.createdAt))
      })
      .finally(() => { if (request === requestRef.current) setLoading(false) })
  }, [activeVaultId, locale])

  useEffect(() => { refresh() }, [refresh])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((entry) => matchesFilter(entry, filter) && (!q || [entry.hostName, entry.hostAddress, entry.username, entry.detail]
      .some((value) => value?.toLowerCase().includes(q))))
  }, [entries, filter, search])
  const grouped = useMemo(() => groupEntriesByDay(visible, now), [visible, now])

  const stats = useMemo(() => {
    const times = entries.map((entry) => entry.createdAt)
    const week = entries.filter((entry) => withinDays(entry.createdAt, now, 7))
    const lastFortnight = entries.filter((entry) => withinDays(entry.createdAt, now, 14)).length
    return {
      heatmap: buildActivityHeatmap(times, now, HEATMAP_WEEKS),
      daily: dailyCounts(times, now, 7),
      weekTotal: week.length,
      previousWeek: lastFortnight - week.length,
      topHosts: rankHosts(week, (entry) => entry.event === 'connect' ? (entry.hostName || entry.hostAddress) : null),
      authFails: week.filter((entry) => entry.event === 'auth_fail').length,
      opsFailed: week.filter((entry) => entry.operationStatus === 'failed').length,
      opsUnknown: week.filter((entry) => entry.operationStatus === 'unknown').length,
    }
  }, [entries, now])

  const dayLabel = (dayStart: number, daysAgo: number) => {
    const date = new Date(dayStart).toLocaleDateString(locale, { month: 'short', day: 'numeric', weekday: 'short' })
    if (daysAgo === 0) return `${c.today} · ${date}`
    if (daysAgo === 1) return `${c.yesterday} · ${date}`
    return date
  }
  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  const tabButton = (value: HistoryTab, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      data-testid={`history-tab-${value}`}
      aria-selected={tab === value}
      onClick={() => setTab(value)}
      className={cn(
        '-mb-px border-b-2 px-0.5 pb-2 text-[13px] font-medium transition-colors',
        tab === value
          ? 'border-[color:var(--workspace-primary-500)] text-[var(--workspace-text-strong)]'
          : 'border-transparent text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
      )}
    >
      {label}
    </button>
  )

  return (
    <div data-tour="history-page" className="flex w-full flex-col gap-4 px-6 py-6 text-[var(--workspace-text)]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">
            {t('activity.title')}
            <span className="font-mono text-xs font-normal text-[var(--workspace-text-subtle)]">({entries.length})</span>
          </h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{c.summary}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md p-1.5 text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </header>

      <div data-tour="history-tabs" role="tablist" aria-label={c.tabsLabel} className="flex gap-6 border-b border-[color:var(--workspace-border-soft)]">
        {tabButton('events', c.tabEvents)}
        {tabButton('audit', <>{c.tabAudit} <span className="ml-1 text-[10px] text-[var(--workspace-text-subtle)]">{c.tabAuditBadge}</span></>)}
      </div>

      {tab === 'audit' ? (
        <OperationsAuditCenter />
      ) : (
        <>
          {loading && entries.length === 0 && (
            <div className="py-8 text-center text-sm text-[var(--workspace-text-muted)]">{t('common.loading')}</div>
          )}

          {!loading && entries.length === 0 && (
            <div className="py-12 text-center">
              <Clock className="mx-auto h-10 w-10 text-[var(--workspace-text-subtle)] opacity-40" />
              <p className="mt-3 text-sm text-[var(--workspace-text-muted)]">{t('activity.empty')}</p>
            </div>
          )}

          {entries.length > 0 && (
            <>
              <div data-tour="history-filters" className="flex flex-wrap items-center gap-3">
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={c.search} className="h-9 pl-9 text-sm" />
                </div>
                <SegmentedTabs<EventFilter>
                  label={c.filterLabel}
                  size="md"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: c.all },
                    { value: 'connection', label: c.connection },
                    { value: 'auth_fail', label: t('activity.event.auth_fail') },
                    { value: 'local_terminal', label: t('activity.event.local_terminal') },
                    { value: 'operation', label: t('activity.event.operation') },
                  ]}
                />
              </div>

              <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <section data-tour="history-timeline" className="sb-card min-w-0 p-0">
                  {grouped.length === 0 && (
                    <p className="px-4 py-10 text-center text-sm text-[var(--workspace-text-muted)]">{c.noMatch}</p>
                  )}
                  {grouped.map((group) => (
                    <div key={group.dayStart}>
                      <div className="flex items-center justify-between px-4 pb-1 pt-3 text-[11px] font-medium text-[var(--workspace-text-subtle)]">
                        <span>{dayLabel(group.dayStart, group.daysAgo)}</span>
                        <span className="font-mono">{fill(c.count, { n: group.items.length })}</span>
                      </div>
                      <ol>
                        {group.items.map((entry) => {
                          const meta = EVENT_ICONS[entry.event] ?? FALLBACK_ICON
                          const host = resolveHostForDisplay(hosts, entry.hostId, entry.hostAddress)
                          return (
                            <li
                              key={entry.id}
                              className="flex items-start gap-3 px-4 py-2 transition-colors hover:bg-[var(--workspace-surface-800)]"
                            >
                              <span className="w-10 shrink-0 pt-1.5 font-mono text-[11px] tabular-nums text-[var(--workspace-text-subtle)]">
                                {formatTime(entry.createdAt)}
                              </span>
                              <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md', meta.tone)}>
                                <meta.Icon className="h-3.5 w-3.5" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="shrink-0 text-[13px] font-medium text-[var(--workspace-text-strong)]">{t(`activity.event.${entry.event}`)}</span>
                                  <span className="truncate text-[13px] font-medium text-[var(--workspace-accent-text)]">
                                    {entry.hostName || entry.hostAddress}
                                  </span>
                                  {host && (
                                    <HostMetadataLine
                                      network={networkByAddress[host.address]}
                                      resource={getHostInventoryResource(host, inventoryStates)}
                                      showLocationText={false}
                                      showSystemText={false}
                                      className="gap-x-1"
                                      iconClassName="h-3 w-3"
                                    />
                                  )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--workspace-text-muted)]">
                                  {entry.username && <span>{entry.username}@{entry.hostAddress}</span>}
                                  {host && (
                                    <HostMetadataLine
                                      network={networkByAddress[host.address]}
                                      resource={getHostInventoryResource(host, inventoryStates)}
                                      className="flex-nowrap"
                                      itemClassName="max-w-[8rem]"
                                      iconClassName="h-3 w-3"
                                    />
                                  )}
                                  {entry.authType && (
                                    <span className="flex items-center gap-0.5">
                                      <KeyRound className="h-2.5 w-2.5" />
                                      {entry.authType}
                                    </span>
                                  )}
                                </div>
                                {entry.detail && (
                                  <p className="mt-0.5 truncate text-[11px] text-[var(--workspace-text-subtle)]">{entry.detail}</p>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    </div>
                  ))}
                </section>

                <aside className="flex min-w-0 flex-col gap-4">
                  <ChartCard testId="history-heatmap" title={c.heatmap} actions={<span className="text-[11px] text-[var(--workspace-text-subtle)]">{fill(c.heatmapSub, { weeks: HEATMAP_WEEKS })}</span>}>
                    <div className="flex gap-1.5">
                      <div className="grid grid-rows-7 gap-[3px] text-[9px] leading-none text-[var(--workspace-text-subtle)]">
                        {c.weekdays.map((day, index) => (
                          <span key={day} className="flex h-3 items-center">{index % 2 === 0 ? day : ''}</span>
                        ))}
                      </div>
                      <div className="grid flex-1 grid-flow-col grid-rows-7 gap-[3px]" role="img" aria-label={`${c.heatmap} · ${fill(c.heatmapTotal, { n: stats.heatmap.total })}`}>
                        {stats.heatmap.columns.flat().map((cell) => (
                          <span
                            key={cell.dayStart}
                            data-count={cell.count}
                            title={cell.future ? undefined : fill(c.heatmapCell, { date: new Date(cell.dayStart).toLocaleDateString(locale), n: cell.count })}
                            className="h-3 rounded-[3px]"
                            style={{ background: cell.future ? 'transparent' : HEAT_FILL[heatmapLevel(cell.count, stats.heatmap.max)] }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--workspace-text-subtle)]">
                      <span>{fill(c.heatmapTotal, { n: stats.heatmap.total })}</span>
                      <span className="flex items-center gap-1">
                        {c.less}
                        {HEAT_FILL.map((color) => <i key={color} className="h-2.5 w-2.5 rounded-[2px]" style={{ background: color }} />)}
                        {c.more}
                      </span>
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-[var(--workspace-text-subtle)]">
                      {fill(c.retention, { activity: ACTIVITY_RETENTION, audit: AUDIT_LIMIT })}
                    </p>
                  </ChartCard>

                  <ChartCard testId="history-week" title={c.week} actions={<span className="text-[11px] text-[var(--workspace-text-subtle)]">{c.weekSub}</span>}>
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <div className="font-mono text-2xl font-semibold tabular-nums text-[var(--workspace-text-strong)]">{fill(c.weekTotal, { n: stats.weekTotal })}</div>
                        <div className="mt-1 text-[11px] text-[var(--workspace-text-muted)]">{fill(c.weekDelta, { n: stats.previousWeek })}</div>
                      </div>
                      <Sparkline values={stats.daily} kind="bars" width={112} height={36} />
                    </div>
                  </ChartCard>

                  <ChartCard testId="history-top-hosts" title={c.topHosts} actions={<span className="text-[11px] text-[var(--workspace-text-subtle)]">{c.topHostsSub}</span>}>
                    {stats.topHosts.length === 0
                      ? <p className="text-xs text-[var(--workspace-text-muted)]">{c.topHostsEmpty}</p>
                      : <BarList rows={stats.topHosts.map((row) => ({ key: row.name, label: row.name, value: row.count }))} max={stats.topHosts[0].count} format={(v) => String(v)} />}
                  </ChartCard>

                  <ChartCard testId="history-attention" title={c.attention} actions={<span className="text-[11px] text-[var(--workspace-text-subtle)]">{c.attentionSub}</span>}>
                    <ul className="space-y-2.5 text-[13px]">
                      {([
                        [c.authFails, stats.authFails, 'warn'],
                        [c.opsFailed, stats.opsFailed, 'bad'],
                        [c.opsUnknown, stats.opsUnknown, 'bad'],
                      ] as const).map(([label, value, tone]) => (
                        <li key={label} className="flex items-center justify-between gap-3">
                          <span className="text-[var(--workspace-text)]">{label}</span>
                          <span className={cn(
                            'min-w-[1.5rem] rounded px-1.5 py-0.5 text-center font-mono text-[11px]',
                            value === 0
                              ? 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]'
                              : tone === 'warn'
                                ? 'bg-[var(--workspace-status-warn-bg)] text-[var(--workspace-status-warn-text)]'
                                : 'bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]',
                          )}>{value}</span>
                        </li>
                      ))}
                    </ul>
                  </ChartCard>
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
