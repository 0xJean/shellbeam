import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ClipboardCopy, GitCompareArrows } from 'lucide-react'
import { CHART_COLORS, ChartCard, ChartLegend, Gauge, SegmentedTabs, STATUS_COLORS, TimeSeriesChart } from '@/components/charts/chart-primitives'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { workspaceChartsCopy } from '@/lib/locales/workspace-charts'
import { fill } from '@/lib/locales/probe-install'
import { bucketize, bucketTimes, formatBytes, formatBytesRate, latestValue, mean, peak, primarySourcePoints, seriesOf, shiftSeries, type NumericMetric } from '@/lib/metric-series'
import { monitoringProviderLabel } from '@/lib/monitoring-presentation'
import { listProviderMetricHistory, PROVIDER_HISTORY_RETENTION_MS, type ProviderMetricHistoryPoint } from '@/lib/provider-history'
import { cn } from '@/lib/utils'

type Range = '1' | '6' | '24' | '168'
const RANGES: Range[] = ['1', '6', '24', '168']
const EMPTY: ProviderMetricHistoryPoint[] = []
const BUCKETS: Record<Range, number> = { '1': 60, '6': 72, '24': 96, '168': 84 }

/**
 * Per-host monitoring charts (v3 `ws=charts`). Everything comes from the local
 * metric history, so hosts without a probe show whatever SSH scans recorded.
 */
export function WorkspaceChartsApp({ host, vaultId }: { host: HostProfile; vaultId?: string | null }) {
  const { locale } = useT()
  const c = workspaceChartsCopy[locale]
  const [range, setRange] = useState<Range>('24')
  const [compare, setCompare] = useState(false)
  const [revision, setRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const [loaded, setLoaded] = useState<{ key: string; current: ProviderMetricHistoryPoint[]; previous: ProviderMetricHistoryPoint[]; from: number; to: number; error: boolean } | null>(null)
  const scope = vaultId ?? host.vaultId ?? ''
  const hours = Number(range)
  const canCompare = hours * 2 * 3_600_000 <= PROVIDER_HISTORY_RETENTION_MS
  const comparing = compare && canCompare
  const key = `${scope}:${host.id}:${range}:${comparing}:${revision}`

  useEffect(() => {
    if (!scope) return
    let live = true
    const to = Date.now()
    const span = hours * 3_600_000
    const from = to - span
    void Promise.all([
      listProviderMetricHistory({ vaultId: scope, hostId: host.id, from, to, limit: 4000 }),
      comparing ? listProviderMetricHistory({ vaultId: scope, hostId: host.id, from: from - span, to: from, limit: 4000 }) : Promise.resolve([]),
    ]).then(([current, previous]) => {
      if (live) setLoaded({ key, current: primarySourcePoints(current), previous: primarySourcePoints(previous), from, to, error: false })
    }).catch(() => { if (live) setLoaded({ key, current: [], previous: [], from, to, error: true }) })
    return () => { live = false }
  }, [scope, host.id, hours, comparing, key])

  useEffect(() => {
    const onChange = (event: Event) => { if ((event as CustomEvent<{ vaultId?: string }>).detail?.vaultId === scope) setRevision((value) => value + 1) }
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') setRevision((value) => value + 1) }, 60_000)
    window.addEventListener('provider-metric-history-changed', onChange)
    return () => { window.clearInterval(timer); window.removeEventListener('provider-metric-history-changed', onChange) }
  }, [scope])

  const data = loaded?.key === key ? loaded : null
  const points = data?.current ?? EMPTY
  const from = data?.from ?? 0
  const to = data?.to ?? 0
  const span = to - from
  const count = BUCKETS[range]
  const times = useMemo(() => bucketTimes(from, to, count), [from, to, count])
  const line = (metric: NumericMetric, source: ProviderMetricHistoryPoint[] = points, shift = 0) => bucketize(shift ? shiftSeries(seriesOf(source, metric), shift) : seriesOf(source, metric), from, to, count)
  const previous = (metric: NumericMetric) => comparing && data ? line(metric, data.previous, span) : null
  const latest = points[points.length - 1]
  const formatTime = (time: number) => hours >= 168
    ? new Date(time).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
    : new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const percent = (value: number) => `${Math.round(value)}%`
  const lastOf = (metric: NumericMetric) => latestValue(seriesOf(points, metric))
  const withCompare = (series: Array<{ key: string; label: string; color: string; values: Array<number | null>; area?: boolean }>, metric: NumericMetric, label: string) => {
    const before = previous(metric)
    return before ? [...series, { key: `${metric}:previous`, label: fill(c.previousLabel, { label }), color: 'var(--workspace-text-subtle)', values: before, dashed: true }] : series
  }
  const memoryUsedGb = line('memoryUsedBytes').map((value) => value == null ? null : value / 1024 ** 3)
  const memoryTotal = lastOf('memoryTotalBytes')
  const loads = { load1: lastOf('load1'), load5: lastOf('load5'), load15: lastOf('load15') }
  const loadPeak = peak(line('load1'))

  async function copyCsv() {
    const header = 'time,cpu_percent,memory_percent,disk_percent,load1,load5,load15,net_rx_bytes_per_sec,net_tx_bytes_per_sec,latency_ms'
    const rows = points.map((point) => [new Date(point.sampledAt).toISOString(), point.metrics.cpuPercent, point.metrics.memoryPercent, point.metrics.diskPercent, point.metrics.load1, point.metrics.load5, point.metrics.load15, point.metrics.networkRxBytesPerSec, point.metrics.networkTxBytesPerSec, point.metrics.latencyMs].map((value) => value ?? '').join(','))
    try { await navigator.clipboard.writeText([header, ...rows].join('\n')); setCopied(true); window.setTimeout(() => setCopied(false), 1800) } catch { /* Clipboard denied: nothing to show. */ }
  }

  return (
    <div data-testid="workspace-charts-app" className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 text-[var(--workspace-text)] md:p-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--workspace-text-muted)]">
            <span>{host.name}</span>
            {latest?.metrics.memoryTotalBytes ? <span>· {formatBytes(latest.metrics.memoryTotalBytes)} {c.memoryShort}</span> : null}
            {latest && <span>· {c.source} <span className="rounded bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-text)]">{monitoringProviderLabel(latest.providerKind, locale)}</span></span>}
            {latest && <span>· {fill(c.lastSample, { time: new Date(latest.sampledAt).toLocaleTimeString(locale) })}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs size="md" label={c.range} value={range} onChange={(value) => setRange(value)} options={RANGES.map((value) => ({ value, label: c.ranges[value] }))} />
          <button type="button" data-testid="workspace-charts-compare" aria-pressed={comparing} disabled={!canCompare} title={canCompare ? undefined : c.compareUnavailable} onClick={() => setCompare((value) => !value)}
            className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium disabled:opacity-50', comparing ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]')}>
            <GitCompareArrows className="h-4 w-4" />{c.compare}
          </button>
          <button type="button" data-testid="workspace-charts-copy" disabled={!points.length} onClick={() => void copyCsv()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50">
            {copied ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}{copied ? c.copied : c.copyCsv}
          </button>
        </div>
      </header>

      {!scope ? <Notice>{c.noVault}</Notice> : !data ? <Notice>{c.loading}</Notice> : data.error ? <Notice tone="bad">{c.failed}</Notice> : !points.length ? <Notice>{c.empty}</Notice> : <>
        <div className="grid gap-4 xl:grid-cols-3">
          <ChartCard testId="chart-cpu" className="xl:col-span-2" title={c.cpu} subtitle={fill(c.avgPeak, { avg: fmt(mean(line('cpuPercent')), percent), peak: fmt(peak(line('cpuPercent')), percent) })}>
            <TimeSeriesChart times={times} max={100} threshold={85} formatTime={formatTime} formatValue={percent} height={230}
              series={withCompare([{ key: 'cpu', label: 'CPU', color: CHART_COLORS[0], values: line('cpuPercent'), area: true }], 'cpuPercent', 'CPU')} />
          </ChartCard>
          <ChartCard testId="chart-load" title={c.load} subtitle={c.loadSub}>
            <Gauge value={loads.load1} max={Math.max(1, loadPeak ?? 0, loads.load5 ?? 0, loads.load15 ?? 0)} label={fmt(loads.load1, (v) => v.toFixed(2))} sub={loadPeak != null ? fill(c.loadPeak, { value: loadPeak.toFixed(2) }) : undefined} />
            <div className="mt-4 grid grid-cols-3 gap-2">
              {([['load1', c.load1], ['load5', c.load5], ['load15', c.load15]] as const).map(([metric, label]) => <div key={metric} className="rounded-lg bg-[var(--workspace-surface-800)] px-2.5 py-2">
                <div className="text-[11px] text-[var(--workspace-text-muted)]">{label}</div>
                <div className="font-mono text-base font-semibold text-[var(--workspace-text-strong)]">{fmt(loads[metric], (v) => v.toFixed(2))}</div>
              </div>)}
            </div>
          </ChartCard>
          <ChartCard testId="chart-memory" title={c.memory} subtitle={memoryTotal ? fill(c.memorySub, { total: formatBytes(memoryTotal) }) : c.memoryPercentSub}>
            {memoryTotal
              ? <TimeSeriesChart times={times} max={memoryTotal / 1024 ** 3} formatTime={formatTime} formatValue={(v) => `${v.toFixed(1)}G`} height={190}
                series={[{ key: 'used', label: c.used, color: CHART_COLORS[5], values: memoryUsedGb, area: true }, ...(comparing && data ? [{ key: 'prev', label: fill(c.previousLabel, { label: c.used }), color: 'var(--workspace-text-subtle)', values: line('memoryUsedBytes', data.previous, span).map((v) => v == null ? null : v / 1024 ** 3), dashed: true }] : [])]} />
              : <TimeSeriesChart times={times} max={100} formatTime={formatTime} formatValue={percent} height={190} series={withCompare([{ key: 'memory', label: c.used, color: CHART_COLORS[5], values: line('memoryPercent'), area: true }], 'memoryPercent', c.used)} />}
            <ChartLegend className="mt-2" items={[{ label: c.used, color: CHART_COLORS[5], value: memoryTotal ? formatBytes(lastOf('memoryUsedBytes')) : fmt(lastOf('memoryPercent'), percent) }]} />
          </ChartCard>
          <ChartCard testId="chart-network" title={c.network} subtitle={c.networkSub}>
            <TimeSeriesChart times={times} formatTime={formatTime} formatValue={(v) => formatBytesRate(v).replace(/\/s$/, '')} height={190}
              series={[{ key: 'rx', label: c.inbound, color: CHART_COLORS[4], values: line('networkRxBytesPerSec'), area: true }, { key: 'tx', label: c.outbound, color: '#fb7185', values: line('networkTxBytesPerSec'), area: true },
                ...(comparing && data ? [{ key: 'rx:previous', label: fill(c.previousLabel, { label: c.inbound }), color: 'var(--workspace-text-subtle)', values: line('networkRxBytesPerSec', data.previous, span), dashed: true }] : [])]} />
            <ChartLegend className="mt-2" items={[{ label: c.inbound, color: CHART_COLORS[4], value: formatBytesRate(lastOf('networkRxBytesPerSec')) }, { label: c.outbound, color: '#fb7185', value: formatBytesRate(lastOf('networkTxBytesPerSec')) }]} />
          </ChartCard>
          <ChartCard testId="chart-disk" title={c.disk} subtitle={lastOf('diskTotalBytes') ? fill(c.diskSub, { used: formatBytes(lastOf('diskUsedBytes')), total: formatBytes(lastOf('diskTotalBytes')) }) : undefined}>
            <TimeSeriesChart times={times} max={100} threshold={90} formatTime={formatTime} formatValue={percent} height={190}
              series={withCompare([{ key: 'disk', label: c.diskUsage, color: STATUS_COLORS.good, values: line('diskPercent'), area: true }], 'diskPercent', c.diskUsage)} />
            <ChartLegend className="mt-2" items={[{ label: c.diskUsage, color: STATUS_COLORS.good, value: fmt(lastOf('diskPercent'), percent) }]} />
          </ChartCard>
          <ChartCard testId="chart-latency" className="xl:col-span-3" title={c.latency} subtitle={fill(c.avgPeak, { avg: fmt(mean(line('latencyMs')), (v) => `${Math.round(v)} ms`), peak: fmt(peak(line('latencyMs')), (v) => `${Math.round(v)} ms`) })}>
            <TimeSeriesChart times={times} formatTime={formatTime} formatValue={(v) => `${Math.round(v)}`} height={150} emptyLabel={c.noLatency}
              series={withCompare([{ key: 'latency', label: c.latency, color: CHART_COLORS[1], values: line('latencyMs') }], 'latencyMs', c.latency)} />
          </ChartCard>
        </div>
        {points.some((point) => point.historyPartial) && <p role="status" className="text-xs text-[color:var(--workspace-status-warn-text)]">{c.partial}</p>}
      </>}
    </div>
  )
}

function fmt(value: number | null, format: (value: number) => string) {
  return value == null ? '—' : format(value)
}

function Notice({ children, tone }: { children: ReactNode; tone?: 'bad' }) {
  return <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('sb-card flex min-h-[12rem] items-center justify-center p-6 text-center text-sm', tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : 'text-[var(--workspace-text-muted)]')}>{children}</div>
}

