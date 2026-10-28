import type { ProviderMetricHistoryPoint } from '@/lib/provider-history'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'

export interface SeriesPoint { t: number; v: number | null }
export type NumericMetric = { [K in keyof ServerMonitorSnapshot]: ServerMonitorSnapshot[K] extends number | null ? K : never }[keyof ServerMonitorSnapshot]

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

/**
 * A host can have history from several providers (probe, SSH scan, monitoring
 * service). Mixing them zig-zags a line, so charts follow the source that
 * reported most recently.
 */
export function primarySourcePoints(points: ProviderMetricHistoryPoint[]): ProviderMetricHistoryPoint[] {
  if (points.length === 0) return []
  const key = (point: ProviderMetricHistoryPoint) => `${point.providerKind}:${point.providerId}:${point.nodeId}`
  const latest = points.reduce((best, point) => point.sampledAt > best.sampledAt ? point : best)
  return points.filter((point) => key(point) === key(latest)).sort((a, b) => a.sampledAt - b.sampledAt)
}

export function seriesOf(points: ProviderMetricHistoryPoint[], metric: NumericMetric, scale = 1): SeriesPoint[] {
  return points.map((point) => {
    const value = point.metrics[metric] as number | null
    return { t: point.sampledAt, v: value == null || !Number.isFinite(value) ? null : value * scale }
  })
}

/** Average each of `count` equal buckets over [from, to); empty buckets stay null rather than zero. */
export function bucketize(points: SeriesPoint[], from: number, to: number, count: number): Array<number | null> {
  const sums = new Array<number>(count).fill(0)
  const counts = new Array<number>(count).fill(0)
  const width = Math.max(1, to - from) / count
  for (const point of points) {
    if (point.v == null || point.t < from || point.t >= to) continue
    const index = Math.min(count - 1, Math.floor((point.t - from) / width))
    sums[index] += point.v
    counts[index] += 1
  }
  return sums.map((sum, index) => counts[index] ? sum / counts[index] : null)
}

export function bucketTimes(from: number, to: number, count: number): number[] {
  const width = (to - from) / count
  return Array.from({ length: count }, (_, index) => from + width * (index + 0.5))
}

/** Per-bucket mean across hosts, counting only hosts that reported in that bucket. */
export function averageBuckets(rows: Array<Array<number | null>>): Array<number | null> {
  const length = Math.max(0, ...rows.map((row) => row.length))
  return Array.from({ length }, (_, index) => {
    const values = rows.map((row) => row[index]).filter((value): value is number => value != null)
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  })
}

/** Per-bucket sum across hosts; null when no host reported. */
export function sumBuckets(rows: Array<Array<number | null>>): Array<number | null> {
  const length = Math.max(0, ...rows.map((row) => row.length))
  return Array.from({ length }, (_, index) => {
    const values = rows.map((row) => row[index]).filter((value): value is number => value != null)
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  })
}

export function latestValue(points: SeriesPoint[]): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) if (points[index].v != null) return points[index].v
  return null
}

export function peak(values: Array<number | null>): number | null {
  const real = values.filter((value): value is number => value != null)
  return real.length ? Math.max(...real) : null
}

export function mean(values: Array<number | null>): number | null {
  const real = values.filter((value): value is number => value != null)
  return real.length ? real.reduce((sum, value) => sum + value, 0) / real.length : null
}

export type AlertSeverityBucket = 'info' | 'warning' | 'critical'

/** Alerts opened per local day for the last `days` days (oldest first). */
export function dailyAlertCounts(alerts: Array<{ openedAt: number; severity: string }>, days: number, now = Date.now()) {
  const end = new Date(now); end.setHours(0, 0, 0, 0)
  const starts = Array.from({ length: days }, (_, index) => end.getTime() - (days - 1 - index) * DAY_MS)
  const rows = starts.map((start) => ({ start, info: 0, warning: 0, critical: 0 }))
  for (const alert of alerts) {
    const index = starts.findIndex((start, i) => alert.openedAt >= start && alert.openedAt < (starts[i + 1] ?? start + DAY_MS))
    if (index < 0) continue
    const severity: AlertSeverityBucket = alert.severity === 'critical' ? 'critical' : alert.severity === 'warning' ? 'warning' : 'info'
    rows[index][severity] += 1
  }
  return rows
}

/** Shift last period's points forward so they overlay the current window. */
export function shiftSeries(points: SeriesPoint[], byMs: number): SeriesPoint[] {
  return points.map((point) => ({ t: point.t + byMs, v: point.v }))
}

export function formatBytesRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return '—'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSec
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
