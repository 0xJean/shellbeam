import { describe, expect, it } from 'vitest'
import type { ProviderMetricHistoryPoint } from '@/lib/provider-history'
import { averageBuckets, bucketize, dailyAlertCounts, DAY_MS, formatBytesRate, primarySourcePoints, seriesOf, sumBuckets } from './metric-series'

const point = (sampledAt: number, cpuPercent: number | null, providerId = 'ssh'): ProviderMetricHistoryPoint => ({
  providerKind: 'ssh-agentless', providerId, hostId: 'h', nodeId: '', sampledAt, receivedAt: sampledAt, expiresAt: sampledAt + 60_000, confidence: 'high',
  metrics: { cpuPercent } as ProviderMetricHistoryPoint['metrics'],
}) as unknown as ProviderMetricHistoryPoint

describe('metric series', () => {
  it('follows the most recently reporting source', () => {
    const points = [point(1, 10, 'a'), point(2, 20, 'b'), point(3, 30, 'a')]
    expect(primarySourcePoints(points).map((p) => p.sampledAt)).toEqual([1, 3])
  })

  it('averages buckets and keeps gaps empty instead of zero', () => {
    const series = seriesOf([point(0, 10), point(5, 30), point(25, null), point(35, 50)], 'cpuPercent')
    expect(bucketize(series, 0, 40, 4)).toEqual([20, null, null, 50])
  })

  it('combines hosts per bucket only where they reported', () => {
    expect(averageBuckets([[10, null, 30], [20, null, null]])).toEqual([15, null, 30])
    expect(sumBuckets([[1, null], [2, 5]])).toEqual([3, 5])
  })

  it('counts alerts per day by severity', () => {
    const now = new Date(2026, 9, 28, 15).getTime()
    const today = new Date(2026, 9, 28, 9).getTime()
    const rows = dailyAlertCounts([{ openedAt: today, severity: 'critical' }, { openedAt: today - DAY_MS, severity: 'warning' }, { openedAt: today - 9 * DAY_MS, severity: 'info' }], 7, now)
    expect(rows).toHaveLength(7)
    expect(rows[6]).toMatchObject({ critical: 1, warning: 0 })
    expect(rows[5]).toMatchObject({ warning: 1 })
    expect(rows.reduce((sum, row) => sum + row.info, 0)).toBe(0)
  })

  it('formats rates', () => {
    expect(formatBytesRate(null)).toBe('—')
    expect(formatBytesRate(1536)).toBe('1.5 KB/s')
  })
})
