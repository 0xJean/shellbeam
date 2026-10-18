import { invoke } from '@tauri-apps/api/core'
import type { ServerMonitorSnapshot } from './server-monitor'
import type { ProbeConfidence, ProbeObservation, ProbeProviderKind } from './probe-provider'
export const PROVIDER_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export interface ProviderMetricHistoryPoint {
  providerKind: ProbeProviderKind
  providerId: string
  hostId: string
  nodeId: string
  sampledAt: number
  receivedAt: number
  expiresAt: number
  metrics: ServerMonitorSnapshot
  confidence: ProbeConfidence
  historyPartial?: boolean
  totalSeries?: number
  gapBefore?: Array<'cpuPercent' | 'memoryPercent' | 'diskPercent'>
}
export interface ProviderMetricHistoryQuery { vaultId: string; hostId: string; providerId?: string; from?: number; to?: number; limit?: number }
export function observationToMetricHistoryPoint(observation: ProbeObservation<ServerMonitorSnapshot>, hostId: string): ProviderMetricHistoryPoint {
  return { providerKind: observation.source.kind, providerId: observation.source.id, hostId, nodeId: observation.source.nodeId ?? '', sampledAt: observation.freshness.sampledAt, receivedAt: observation.freshness.receivedAt, expiresAt: observation.freshness.expiresAt, metrics: observation.data, confidence: observation.confidence }
}
export async function appendProviderMetricHistory(vaultId: string, points: ProviderMetricHistoryPoint[]) {
  if (!vaultId.trim()) throw new Error('history_scope_invalid')
  if (points.length === 0) return
  // Native persistence also validates scope/fields and drops unknown metadata.
  for (let offset = 0; offset < points.length; offset += 1000) await invoke<void>('append_provider_metric_history', { payload: { vaultId, points: points.slice(offset, offset + 1000) } })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('provider-metric-history-changed', { detail: { vaultId } }))
}
export async function listProviderMetricHistory(query: ProviderMetricHistoryQuery) {
  if (!query.vaultId.trim() || !query.hostId.trim()) throw new Error('history_scope_invalid')
  return invoke<ProviderMetricHistoryPoint[]>('list_provider_metric_history', { query })
}
export async function clearProviderMetricHistory(query: ProviderMetricHistoryQuery) {
  return invoke<void>('clear_provider_metric_history', { query })
}

/** Break lines at null observations rather than drawing fabricated zeros. */
export function metricHistoryPaths(points: ProviderMetricHistoryPoint[], key: 'cpuPercent' | 'memoryPercent' | 'diskPercent', from: number, to: number) {
  const paths: string[] = []
  let path = ''
  let previousExpiry: number | null = null
  for (const point of points) {
    const value = point.metrics[key]
    if (point.gapBefore?.includes(key) || previousExpiry !== null && point.sampledAt > previousExpiry) { if (path) paths.push(path); path = '' }
    previousExpiry = point.expiresAt
    if (value === null || !Number.isFinite(value)) { if (path) paths.push(path); path = ''; continue }
    const x = 20 + (point.sampledAt - from) / Math.max(1, to - from) * 760
    const y = 140 - Math.min(100, Math.max(0, value)) / 100 * 120
    path += `${path ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  }
  if (path) paths.push(path)
  return paths
}
