import type { HostOpsCapability, HostOpsProvider, HostOpsView } from './host-ops-view'
import type { NotificationSeverity } from './notification-policy'
export interface HostOpsFilters {
  provider: 'all' | HostOpsProvider
  os: string
  severity: 'all' | 'none' | 'unknown' | NotificationSeverity
  capability: 'all' | HostOpsCapability
  resource: 'none' | 'cpu' | 'memory' | 'disk'
  minPercent: number
  freshness: 'all' | 'fresh' | 'stale' | 'unknown' | 'older'
  olderThanMinutes: number
}
export const DEFAULT_HOST_OPS_FILTERS: HostOpsFilters = { provider: 'all', os: '', severity: 'all', capability: 'all', resource: 'none', minPercent: 80, freshness: 'all', olderThanMinutes: 5 }
/** Missing metrics never behave like zero; missing freshness/severity have
 * explicit filters rather than silently matching an apparently healthy host. */
export function matchesHostOpsFilters(view: HostOpsView | undefined, filters: HostOpsFilters, now = Date.now()): boolean {
  if (filters.provider !== 'all' && (view?.health.provider ?? 'unknown') !== filters.provider) return false
  const os = (view?.metrics?.os || view?.resource?.os || '').toLowerCase()
  if (filters.os.trim() && (filters.os === '__unknown__' ? Boolean(os) : !os.includes(filters.os.trim().toLowerCase()))) return false
  if (filters.capability !== 'all' && !view?.capabilities?.includes(filters.capability)) return false
  if (filters.severity !== 'all') {
    const count = view?.alertOpenCount
    if (filters.severity === 'none' && count !== 0) return false
    if (filters.severity === 'unknown' && (count === 0 || view?.highestAlertSeverity)) return false
    if (filters.severity !== 'none' && filters.severity !== 'unknown' && view?.highestAlertSeverity !== filters.severity) return false
  }
  if (filters.resource !== 'none') {
    const key = filters.resource === 'cpu' ? 'cpuPercent' : filters.resource === 'memory' ? 'memoryPercent' : 'diskPercent'
    const value = view?.metrics ? view.metrics[key] : view?.resource?.[key]
    if (value == null || !Number.isFinite(value) || value < (Number.isFinite(filters.minPercent) ? Math.min(100, Math.max(0, filters.minPercent)) : 80)) return false
  }
  if (filters.freshness !== 'all') {
    const sampledAt = view?.health.freshness.sampledAt
    const age = sampledAt == null || sampledAt > now ? null : now - sampledAt
    const ttl = view?.health.freshness.ttlMs
    const stale = age === null ? null : ttl == null ? view?.health.freshness.stale : age > ttl
    if (filters.freshness === 'unknown' && age !== null) return false
    if (filters.freshness === 'fresh' && (age === null || stale !== false)) return false
    if (filters.freshness === 'stale' && stale !== true) return false
    if (filters.freshness === 'older' && (age === null || age <= (Number.isFinite(filters.olderThanMinutes) ? Math.max(0, filters.olderThanMinutes) : 5) * 60_000)) return false
  }
  return true
}
export function activeHostOpsFilterCount(filters: HostOpsFilters) {
  return Number(filters.provider !== 'all') + Number(Boolean(filters.os.trim())) + Number(filters.severity !== 'all') + Number(filters.capability !== 'all') + Number(filters.resource !== 'none') + Number(filters.freshness !== 'all')
}
