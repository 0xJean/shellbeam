import { useMemo, useState, type ReactNode } from 'react'
import { Activity, ArrowDownUp, Cpu, RefreshCw, Server, Siren } from 'lucide-react'
import { BarList, CHART_COLORS, ChartCard, ChartLegend, DonutChart, DonutLegend, Heatmap, ScatterChart, SegmentedTabs, Sparkline, StackedBarChart, STATUS_COLORS, TimeSeriesChart } from '@/components/charts/chart-primitives'
import { HostRegionMeta } from '@/components/host-display-meta'
import { useFleetMetrics, isOpenAlert, type FleetHost } from '@/hooks/use-fleet-metrics'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fleetDashboardCopy } from '@/lib/locales/fleet-dashboard'
import { fill } from '@/lib/locales/probe-install'
import { averageBuckets, bucketize, bucketTimes, dailyAlertCounts, DAY_MS, formatBytes, formatBytesRate, latestValue, mean, peak, seriesOf, sumBuckets, type NumericMetric } from '@/lib/metric-series'
import { cn } from '@/lib/utils'

type Tab = 'resources' | 'ops' | 'assets'
type Range = 1 | 24 | 168
const RANGE_BUCKETS: Record<Range, number> = { 1: 60, 24: 48, 168: 84 }
const HEAT_COLUMNS: Record<Range, number> = { 1: 12, 24: 24, 168: 28 }

interface FleetDashboardProps {
  hosts: HostProfile[]
  vaultId?: string | null
  unlocked: boolean
  /** Opens the host's workspace on its monitoring charts. */
  onOpenHost?: (hostId: string) => void
  onOpenAlerts?: () => void
}

function bucketOf(item: FleetHost): 'online' | 'attention' | 'offline' | 'checking' {
  if (item.status === 'offline' || item.status === 'jump-unavailable') return 'offline'
  if (item.openAlerts > 0 || item.status === 'stale') return 'attention'
  if (item.status === 'online') return 'online'
  return 'checking'
}

const latestMetric = (item: FleetHost, metric: NumericMetric) => {
  const live = item.view?.metrics?.[metric] as number | null | undefined
  if (live != null) return live
  return latestValue(seriesOf(item.history, metric))
}

const osFamily = (os: string | null | undefined) => {
  const name = (os ?? '').trim().split(/[\s/]+/)[0]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : ''
}

export function FleetDashboard({ hosts, vaultId, unlocked, onOpenHost, onOpenAlerts }: FleetDashboardProps) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const [tab, setTab] = useState<Tab>('resources')
  const [range, setRange] = useState<Range>(24)
  const fleet = useFleetMetrics({ hosts, vaultId, unlocked, rangeHours: range })
  const network = useHostNetworkMetadata(hosts.map((host) => host.address))

  const buckets = RANGE_BUCKETS[range]
  const times = useMemo(() => bucketTimes(fleet.from, fleet.to, buckets), [fleet.from, fleet.to, buckets])
  const formatTime = (time: number) => range === 168
    ? new Date(time).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
    : new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const perHost = useMemo(() => fleet.hosts.map((item) => ({
    item,
    cpu: bucketize(seriesOf(item.history, 'cpuPercent'), fleet.from, fleet.to, buckets),
    rx: bucketize(seriesOf(item.history, 'networkRxBytesPerSec'), fleet.from, fleet.to, buckets),
    tx: bucketize(seriesOf(item.history, 'networkTxBytesPerSec'), fleet.from, fleet.to, buckets),
  })), [fleet.hosts, fleet.from, fleet.to, buckets])

  const counts = { online: 0, attention: 0, offline: 0, checking: 0 }
  for (const item of fleet.hosts) counts[bucketOf(item)] += 1
  const reachable = fleet.hosts.filter((item) => bucketOf(item) !== 'offline' && bucketOf(item) !== 'checking').length
  const stale = fleet.hosts.filter((item) => item.status === 'stale').length
  const openAlerts = fleet.alerts.filter(isOpenAlert)
  const alertDays = dailyAlertCounts(fleet.alerts, 7, fleet.to || undefined)
  const dayTotal = (row: (typeof alertDays)[number]) => row.info + row.warning + row.critical
  const alertDelta = dayTotal(alertDays[6]) - dayTotal(alertDays[5])
  const cpuNow = fleet.hosts.map((item) => ({ item, value: latestMetric(item, 'cpuPercent') })).filter((row): row is { item: FleetHost; value: number } => row.value != null)
  const cpuPeak = cpuNow.reduce<{ item: FleetHost; value: number } | null>((best, row) => !best || row.value > best.value ? row : best, null)
  const clusterCpu = averageBuckets(perHost.map((row) => row.cpu))
  const rxSum = sumBuckets(perHost.map((row) => row.rx))
  const txSum = sumBuckets(perHost.map((row) => row.tx))
  const rxNow = fleet.hosts.reduce((sum, item) => sum + (latestMetric(item, 'networkRxBytesPerSec') ?? 0), 0)
  const txNow = fleet.hosts.reduce((sum, item) => sum + (latestMetric(item, 'networkTxBytesPerSec') ?? 0), 0)
  const hasNet = fleet.hosts.some((item) => latestMetric(item, 'networkRxBytesPerSec') != null)

  return (
    <div data-testid="fleet-dashboard" className="flex min-w-0 flex-col gap-4 text-[var(--workspace-text)]">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h1>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">
            {fill(c.summary, { total: fleet.hosts.length, online: reachable })}
            {fleet.refreshedAt && <> · {fill(c.refreshed, { time: new Date(fleet.refreshedAt).toLocaleTimeString(locale) })}</>} · {c.sources}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs size="md" label={c.title} value={tab} onChange={setTab} options={[{ value: 'resources', label: c.tabResources }, { value: 'ops', label: c.tabOps }, { value: 'assets', label: c.tabAssets }]} />
          <SegmentedTabs size="md" label={c.range} value={String(range) as `${Range}`} onChange={(value) => setRange(Number(value) as Range)} options={([1, 24, 168] as Range[]).map((value) => ({ value: String(value) as `${Range}`, label: c.rangeLabel[value] }))} />
          <button type="button" aria-label={c.refresh} title={c.refresh} onClick={fleet.refresh} className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]">
            <RefreshCw className={cn('h-4 w-4', fleet.loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <div data-testid="fleet-kpis" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Server />} label={c.kpiOnline} value={<>{reachable}<small className="text-base font-medium text-[var(--workspace-text-muted)]"> / {fleet.hosts.length}</small></>}
          sub={fill(c.kpiOnlineSub, { offline: counts.offline, stale })}
          visual={<DonutChart size={56} thickness={7} segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]} />} />
        <Kpi icon={<Siren />} label={c.kpiAlerts} onClick={onOpenAlerts} value={<span className={openAlerts.length ? 'text-[color:var(--workspace-status-warn-text)]' : undefined}>{openAlerts.length}</span>}
          sub={<>{c.kpiAlertsSub} <b className={alertDelta > 0 ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[color:var(--workspace-status-good-text)]'}>{alertDelta > 0 ? `+${alertDelta}` : alertDelta}</b></>}
          visual={<Sparkline kind="bars" color={STATUS_COLORS.warn} values={alertDays.map(dayTotal)} width={84} height={34} />} />
        <Kpi icon={<Cpu />} label={c.kpiCpu} value={mean(cpuNow.map((row) => row.value)) == null ? '—' : <>{Math.round(mean(cpuNow.map((row) => row.value))!)}<small className="text-base font-medium">%</small></>}
          sub={cpuPeak ? fill(c.kpiCpuSub, { value: Math.round(cpuPeak.value), host: cpuPeak.item.host.name }) : c.noSamples}
          visual={<Sparkline values={clusterCpu} width={96} height={34} />} />
        <Kpi icon={<ArrowDownUp />} label={c.kpiNet} value={hasNet ? formatBytesRate(rxNow + txNow) : '—'}
          sub={hasNet ? `↓ ${formatBytesRate(rxNow)} · ↑ ${formatBytesRate(txNow)}` : c.noSamples}
          visual={<Sparkline values={sumBuckets([rxSum, txSum])} color={CHART_COLORS[4]} width={96} height={34} />} />
      </div>

      {tab === 'resources' && <ResourcesTab perHost={perHost} times={times} formatTime={formatTime} range={range} counts={counts} fleet={fleet.hosts} onOpenHost={onOpenHost} />}
      {tab === 'ops' && <OpsTab fleetMetrics={fleet} times={times} formatTime={formatTime} rx={rxSum} tx={txSum} />}
      {tab === 'assets' && <AssetsTab fleetMetrics={fleet} network={network} />}
    </div>
  )
}

function Kpi({ icon, label, value, sub, visual, onClick }: { icon: ReactNode; label: string; value: ReactNode; sub: ReactNode; visual?: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('sb-card flex min-w-0 items-center gap-3 p-4 text-left', onClick && 'hover:border-[color:var(--workspace-border-strong)]')}>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-xs text-[var(--workspace-text-muted)] [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}{label}</div>
      <div className="mt-2 text-[28px] font-bold leading-none tracking-tight text-[var(--workspace-text-strong)]">{value}</div>
      <div className="mt-1.5 truncate text-[11px] text-[var(--workspace-text-muted)]">{sub}</div>
    </div>
    {visual && <div className="shrink-0">{visual}</div>}
  </Tag>
}

interface PerHostRow { item: FleetHost; cpu: Array<number | null>; rx: Array<number | null>; tx: Array<number | null> }

function ResourcesTab({ perHost, times, formatTime, range, counts, fleet, onOpenHost }: {
  perHost: PerHostRow[]; times: number[]; formatTime: (time: number) => string; range: Range; counts: Record<'online' | 'attention' | 'offline' | 'checking', number>; fleet: FleetHost[]; onOpenHost?: (hostId: string) => void
}) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const [heatMetric, setHeatMetric] = useState<'cpuPercent' | 'memoryPercent' | 'diskPercent'>('cpuPercent')
  const top = [...perHost].map((row) => ({ row, avg: mean(row.cpu) })).filter((entry) => entry.avg != null).sort((a, b) => b.avg! - a.avg!).slice(0, 5)
  const from = times.length ? times[0] - (times[1] - times[0] || 0) / 2 : 0
  const to = times.length ? times[times.length - 1] + (times[1] - times[0] || 0) / 2 : 0
  const columns = HEAT_COLUMNS[range]
  const columnTimes = bucketTimes(from, to, columns)
  const heatRows = fleet.map((item) => ({ label: item.host.name, cells: bucketize(seriesOf(item.history, heatMetric), from, to, columns) }))
  const diskTop = fleet.map((item) => {
    const metrics = item.view?.metrics
    return { item, value: latestMetric(item, 'diskPercent'), used: metrics?.diskUsedBytes ?? null, total: metrics?.diskTotalBytes ?? null }
  }).filter((row): row is typeof row & { value: number } => row.value != null).sort((a, b) => b.value - a.value).slice(0, 5)
  const serverCount = fleet.filter((item) => item.host.monitoringMode === 'server').length
  const bucketWidth = (to - from) / columns
  const bucketLabel = bucketWidth >= DAY_MS / 4 ? `${Math.round(bucketWidth / 3_600_000)} h` : bucketWidth >= 3_600_000 ? '1 h' : `${Math.round(bucketWidth / 60_000)} min`
  const metricLabel = { cpuPercent: 'CPU', memoryPercent: c.metricMemory, diskPercent: c.metricDisk }

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-cluster-cpu" title={fill(c.clusterCpu, { range: c.rangeLabel[range] })} subtitle={fill(c.clusterCpuSub, { count: top.length || 5 })}>
      <TimeSeriesChart times={times} max={100} threshold={85} formatTime={formatTime} formatValue={(v) => `${Math.round(v)}%`} emptyLabel={c.noData}
        series={top.map(({ row }, index) => ({ key: row.item.host.id, label: row.item.host.name, color: CHART_COLORS[index], values: row.cpu, area: index === 0 }))} />
      {top.length > 0 && <ChartLegend className="mt-2" items={top.map(({ row }, index) => ({ label: row.item.host.name, color: CHART_COLORS[index] }))} />}
    </ChartCard>
    <ChartCard testId="fleet-status" title={c.status} subtitle={fill(c.statusSub, { count: fleet.length })}>
      <div className="flex items-center gap-6 py-2">
        <DonutChart size={150} segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]}
          center={`${counts.online + counts.attention}/${fleet.length}`} sub={c.online} />
        <DonutLegend segments={[{ label: c.online, value: counts.online, color: STATUS_COLORS.good }, { label: c.attention, value: counts.attention, color: STATUS_COLORS.warn }, { label: c.offline, value: counts.offline, color: STATUS_COLORS.bad }, { label: c.checking, value: counts.checking, color: STATUS_COLORS.idle }]} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Tile label={c.viaServer} value={serverCount} unit={c.unit} />
        <Tile label={c.viaSsh} value={fleet.length - serverCount} unit={c.unit} />
      </div>
    </ChartCard>
    <ChartCard testId="fleet-heatmap" title={fill(c.heatmap, { metric: metricLabel[heatMetric] })} subtitle={fill(c.heatmapSub, { bucket: bucketLabel })}
      actions={<SegmentedTabs label={c.heatmap} value={heatMetric} onChange={setHeatMetric} options={(['cpuPercent', 'memoryPercent', 'diskPercent'] as const).map((value) => ({ value, label: metricLabel[value] }))} />}>
      {heatRows.length ? <Heatmap rows={heatRows} columnLabels={columnTimes.map((time) => range === 168 ? new Date(time).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : range === 1 ? new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : String(new Date(time).getHours()).padStart(2, '0'))} /> : <Empty>{c.noData}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-disk-top" title={c.diskTop} subtitle={c.diskTopSub}>
      {diskTop.length ? <BarList rows={diskTop.map((row) => ({
        key: row.item.host.id,
        label: onOpenHost ? <button type="button" title={c.openCharts} className="truncate hover:underline" onClick={() => onOpenHost(row.item.host.id)}>{row.item.host.name}</button> : row.item.host.name,
        value: row.value,
        color: row.value >= 85 ? STATUS_COLORS.bad : row.value >= 70 ? STATUS_COLORS.warn : CHART_COLORS[0],
        hint: row.total ? `${formatBytes(row.used)} / ${formatBytes(row.total)}` : undefined,
      }))} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function OpsTab({ fleetMetrics, times, formatTime, rx, tx }: { fleetMetrics: ReturnType<typeof useFleetMetrics>; times: number[]; formatTime: (time: number) => string; rx: Array<number | null>; tx: Array<number | null> }) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const [days, setDays] = useState<'7' | '30'>('7')
  const rows = dailyAlertCounts(fleetMetrics.alerts, Number(days), fleetMetrics.to)
  const weekday = (start: number, index: number) => index === rows.length - 1 ? c.today : Number(days) === 7 ? new Date(start).toLocaleDateString(locale, { weekday: 'short' }) : new Date(start).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
  const total = rows.reduce((sum, row) => sum + row.info + row.warning + row.critical, 0)
  const sum = (key: 'info' | 'warning' | 'critical') => rows.reduce((value, row) => value + row[key], 0)
  const weekAgo = fleetMetrics.to - 7 * DAY_MS
  const week = fleetMetrics.alerts.filter((alert) => alert.openedAt >= weekAgo)
  const monitoringCount = week.filter((alert) => alert.source === 'monitoring').length
  const minutes = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length / 60_000) : null
  const ack = minutes(fleetMetrics.alerts.filter((alert) => alert.acknowledgedAt).map((alert) => alert.acknowledgedAt! - alert.openedAt).filter((value) => value >= 0))
  const recover = minutes(fleetMetrics.alerts.filter((alert) => alert.resolvedAt).map((alert) => alert.resolvedAt! - alert.openedAt).filter((value) => value >= 0))
  const latency = fleetMetrics.hosts.map((item) => ({ item, value: latestMetric(item, 'latencyMs') })).filter((row): row is { item: FleetHost; value: number } => row.value != null).sort((a, b) => a.value - b.value)
  const latencyMax = Math.max(100, ...latency.map((row) => row.value))
  const rxPeak = peak(sumBuckets([rx, tx]))
  const peakIndex = rxPeak == null ? -1 : sumBuckets([rx, tx]).indexOf(rxPeak)

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-alert-trend" title={fill(c.alertTrend, { days })} subtitle={fill(c.alertTrendSub, { count: total })}
      actions={<SegmentedTabs label={c.alertTrend} value={days} onChange={setDays} options={[{ value: '7', label: c.days7 }, { value: '30', label: c.days30 }]} />}>
      <StackedBarChart highlightLast labels={rows.map((row, index) => weekday(row.start, index))} rows={rows}
        keys={[{ key: 'info', label: c.info, color: '#38bdf8' }, { key: 'warning', label: c.warning, color: STATUS_COLORS.warn }, { key: 'critical', label: c.critical, color: STATUS_COLORS.bad }]} height={220} />
      <ChartLegend className="mt-2" items={[{ label: c.info, color: '#38bdf8', value: sum('info') }, { label: c.warning, color: STATUS_COLORS.warn, value: sum('warning') }, { label: c.critical, color: STATUS_COLORS.bad, value: sum('critical') }]} />
    </ChartCard>
    <ChartCard testId="fleet-alert-sources" title={c.alertSources} subtitle={c.alertSourcesSub}>
      <div className="flex items-center gap-6 py-2">
        <DonutChart size={150} center={week.length} sub={c.thisWeek} segments={[{ label: c.monitoring, value: monitoringCount, color: CHART_COLORS[0] }, { label: c.localRules, value: week.length - monitoringCount, color: STATUS_COLORS.good }]} />
        <DonutLegend segments={[{ label: c.monitoring, value: monitoringCount, color: CHART_COLORS[0] }, { label: c.localRules, value: week.length - monitoringCount, color: STATUS_COLORS.good }]} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Tile label={c.ackTime} value={ack ?? '—'} unit={ack == null ? undefined : c.minuteUnit} />
        <Tile label={c.recoverTime} value={recover ?? '—'} unit={recover == null ? undefined : c.minuteUnit} />
      </div>
    </ChartCard>
    <ChartCard testId="fleet-network" title={c.network} subtitle={c.networkSub}>
      <TimeSeriesChart times={times} formatTime={formatTime} formatValue={(v) => formatBytesRate(v).replace(/\/s$/, '')} emptyLabel={c.noData} height={240}
        series={[{ key: 'rx', label: c.inbound, color: CHART_COLORS[4], values: rx, area: true }, { key: 'tx', label: c.outbound, color: CHART_COLORS[0], values: tx, area: true }]} />
      <ChartLegend className="mt-2" items={[
        { label: c.inbound, color: CHART_COLORS[4], value: formatBytesRate(latestValue(rx.map((v, i) => ({ t: i, v })))) },
        { label: c.outbound, color: CHART_COLORS[0], value: formatBytesRate(latestValue(tx.map((v, i) => ({ t: i, v })))) },
        ...(rxPeak != null ? [{ label: c.peak, color: 'var(--workspace-text-subtle)', value: `${formatBytesRate(rxPeak)} · ${formatTime(times[peakIndex])}` }] : []),
      ]} />
    </ChartCard>
    <ChartCard testId="fleet-latency" title={c.latency} subtitle={c.latencySub}>
      {latency.length ? <BarList max={latencyMax} format={(v) => String(Math.round(v))} rows={latency.map((row) => ({
        key: row.item.host.id, label: row.item.host.name, value: row.value,
        color: row.value >= 150 ? STATUS_COLORS.warn : STATUS_COLORS.good,
        hint: row.item.view?.route.jumpHostName || row.item.view?.route.jumpHost ? fill(c.viaJump, { name: row.item.view?.route.jumpHostName || row.item.view?.route.jumpHost || '' }) : undefined,
      }))} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function AssetsTab({ fleetMetrics, network }: { fleetMetrics: ReturnType<typeof useFleetMetrics>; network: ReturnType<typeof useHostNetworkMetadata> }) {
  const { locale } = useT()
  const c = fleetDashboardCopy[locale]
  const hosts = fleetMetrics.hosts
  const points = hosts.flatMap((item, index) => {
    const cpu = latestMetric(item, 'cpuPercent'); const memory = latestMetric(item, 'memoryPercent')
    if (cpu == null || memory == null) return []
    const disk = latestMetric(item, 'diskPercent') ?? 0
    return [{ key: item.host.id, label: item.host.name, x: cpu, y: memory, size: disk, color: cpu >= 85 || memory >= 85 ? STATUS_COLORS.warn : CHART_COLORS[(index % 4) === 1 ? 3 : 0] }]
  })
  const installed = fleetMetrics.agents.filter((agent) => agent.status !== 'retired' && hosts.some((item) => item.host.id === agent.hostId))
  const versions = new Map<string, number>()
  for (const agent of installed) versions.set(agent.version || c.unknownVersion, (versions.get(agent.version || c.unknownVersion) ?? 0) + 1)
  const probeHosts = new Set(installed.map((agent) => agent.hostId))
  const sshOnly = hosts.filter((item) => !probeHosts.has(item.host.id) && item.host.monitoringMode !== 'server').length
  const serverOnly = hosts.filter((item) => !probeHosts.has(item.host.id) && item.host.monitoringMode === 'server').length
  const probeSegments = [
    ...[...versions.entries()].sort((a, b) => b[1] - a[1]).map(([version, value], index) => ({ label: fill(c.probeVersion, { version }), value, color: index === 0 ? CHART_COLORS[0] : CHART_COLORS[1] })),
    ...(serverOnly ? [{ label: c.serverMode, value: serverOnly, color: CHART_COLORS[3] }] : []),
    { label: c.sshOnly, value: sshOnly, color: STATUS_COLORS.idle },
  ]
  const names = new Map(hosts.map((item) => [item.host.id, item.host.name]))
  const certs = fleetMetrics.certificates.filter((cert) => names.has(cert.hostId) && cert.notAfter != null)
    .map((cert) => ({ cert, days: Math.ceil((cert.notAfter! - fleetMetrics.to) / DAY_MS) })).sort((a, b) => a.days - b.days).slice(0, 8)
  const os = new Map<string, number>()
  for (const item of hosts) {
    const family = osFamily(item.view?.resource?.os || item.view?.metrics?.os || item.history[item.history.length - 1]?.metrics.os)
    if (family) os.set(family, (os.get(family) ?? 0) + 1)
  }
  const osRows = [...os.entries()].sort((a, b) => b[1] - a[1])
  const regions = new Map<string, { count: number; address: string }>()
  for (const item of hosts) {
    const meta = network[item.host.address]
    const label = meta?.resolvedLocationLabel
    if (!label) continue
    const entry = regions.get(label) ?? { count: 0, address: item.host.address }
    entry.count += 1
    regions.set(label, entry)
  }
  const regionRows = [...regions.entries()].sort((a, b) => b[1].count - a[1].count)
  const shownRegions = regionRows.slice(0, 5)
  const rest = regionRows.slice(5)

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
    <ChartCard testId="fleet-capacity" className="xl:row-span-2" title={c.capacity} subtitle={c.capacitySub}>
      {points.length ? <ScatterChart points={points} xLabel="CPU %" yLabel={c.memory} height={540} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-probes" title={c.probes} subtitle={fill(c.probesSub, { count: hosts.length })}>
      <div className="flex items-center gap-5 py-2">
        <DonutChart size={130} center={probeHosts.size + serverOnly} sub={c.serverMode} segments={probeSegments} />
        <DonutLegend segments={probeSegments} />
      </div>
    </ChartCard>
    <ChartCard testId="fleet-certs" title={c.certs} subtitle={c.certsSub}>
      {certs.length ? <BarList max={90} format={(v) => fill(c.days, { value: Math.round(v) })} rows={certs.map(({ cert, days }) => ({
        key: `${cert.hostId}:${cert.path}`, label: cert.domains[0] ?? cert.path, value: Math.max(0, days),
        color: days <= 14 ? STATUS_COLORS.bad : days <= 30 ? STATUS_COLORS.warn : STATUS_COLORS.good,
        hint: `${names.get(cert.hostId)} · ${cert.path}`,
      }))} /> : <Empty>{c.certsEmpty}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-os" title={c.os} subtitle={c.osSub}>
      {osRows.length ? <StackedBarChart labels={osRows.map(([name]) => name)} rows={osRows.map(([, count]) => ({ count }))} keys={[{ key: 'count', label: c.os, color: CHART_COLORS[0] }]} height={200} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
    <ChartCard testId="fleet-regions" title={c.region} subtitle={c.regionSub}>
      {shownRegions.length ? <BarList max={Math.max(1, ...regionRows.map(([, entry]) => entry.count))} format={(v) => `${v} ${c.unit}`} rows={[
        ...shownRegions.map(([label, entry]) => ({ key: label, label: <span className="inline-flex items-center gap-1">{network[entry.address] ? <HostRegionMeta network={network[entry.address]} /> : label}</span>, value: entry.count })),
        ...(rest.length ? [{ key: 'rest', label: fill(c.others, { count: rest.length }), value: rest.reduce((sum, [, entry]) => sum + entry.count, 0) }] : []),
      ]} /> : <Empty>{c.noSamples}</Empty>}
    </ChartCard>
  </div>
}

function Tile({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return <div className="rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2">
    <div className="truncate text-[11px] text-[var(--workspace-text-muted)]">{label}</div>
    <div className="mt-0.5 text-lg font-semibold text-[var(--workspace-text-strong)]">{value}{unit && <small className="ml-0.5 text-xs font-normal text-[var(--workspace-text-muted)]">{unit}</small>}</div>
  </div>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[8rem] items-center justify-center px-4 text-center text-xs text-[var(--workspace-text-subtle)]"><Activity className="mr-1.5 h-3.5 w-3.5 shrink-0" />{children}</div>
}
