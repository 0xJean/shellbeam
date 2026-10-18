import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST_OPS_FILTERS, activeHostOpsFilterCount, matchesHostOpsFilters } from './host-ops-filters'
import { buildHostOpsViews } from './host-ops-view'
import type { HostProfile } from './hosts'
import type { HostOpsView } from './host-ops-view'
const host = { id: 'host', address: '10.0.0.1', username: 'ops' } as HostProfile
const empty = buildHostOpsViews({ hosts: [host], now: 1_000 }).host
const view: HostOpsView = { ...empty, health: { ...empty.health, provider: 'komari', freshness: { ageMs: 10_000, sampledAt: 1_000, updatedAt: 1_000, stale: false, ttlMs: 60_000 } }, resource: { hostname: 'edge', os: 'Ubuntu 24.04', kernel: '', uptime: '', cpuPercent: 95, memoryPercent: null, diskPercent: 82, memoryText: '', diskText: '', network: '' }, capabilities: ['metrics', 'docker'], highestAlertSeverity: 'critical', alertOpenCount: 2 }
describe('host operations filters', () => {
  it('combines provider, OS, severity, capability and resource thresholds', () => {
    const filters = { ...DEFAULT_HOST_OPS_FILTERS, provider: 'komari' as const, os: 'ubuntu', severity: 'critical' as const, capability: 'docker' as const, resource: 'disk' as const, minPercent: 80 }
    expect(matchesHostOpsFilters(view, filters, 11_000)).toBe(true)
    expect(activeHostOpsFilterCount(filters)).toBe(5)
    expect(matchesHostOpsFilters(view, { ...filters, minPercent: 83 }, 11_000)).toBe(false)
    expect(matchesHostOpsFilters(view, { ...filters, capability: 'services' }, 11_000)).toBe(false)
  })
  it('keeps missing metrics unknown even for zero thresholds', () => {
    expect(matchesHostOpsFilters(view, { ...DEFAULT_HOST_OPS_FILTERS, resource: 'memory', minPercent: 0 })).toBe(false)
    expect(matchesHostOpsFilters(empty, { ...DEFAULT_HOST_OPS_FILTERS, resource: 'cpu', minPercent: 0 })).toBe(false)
  })
  it('recomputes freshness from TTL and never matches missing timestamps as fresh or old', () => {
    expect(matchesHostOpsFilters(view, { ...DEFAULT_HOST_OPS_FILTERS, freshness: 'fresh' }, 20_000)).toBe(true)
    expect(matchesHostOpsFilters(view, { ...DEFAULT_HOST_OPS_FILTERS, freshness: 'stale' }, 70_000)).toBe(true)
    expect(matchesHostOpsFilters(view, { ...DEFAULT_HOST_OPS_FILTERS, freshness: 'older', olderThanMinutes: 5 }, 400_000)).toBe(true)
    expect(matchesHostOpsFilters(empty, { ...DEFAULT_HOST_OPS_FILTERS, freshness: 'older', olderThanMinutes: 0 }, 400_000)).toBe(false)
    expect(matchesHostOpsFilters(empty, { ...DEFAULT_HOST_OPS_FILTERS, freshness: 'unknown' })).toBe(true)
  })
  it('distinguishes no open alerts from unknown severity and excludes resolved incidents', () => {
    expect(matchesHostOpsFilters(empty, { ...DEFAULT_HOST_OPS_FILTERS, severity: 'none' })).toBe(true)
    expect(matchesHostOpsFilters({ ...view, highestAlertSeverity: null }, { ...DEFAULT_HOST_OPS_FILTERS, severity: 'unknown' })).toBe(true)
    expect(matchesHostOpsFilters(undefined, { ...DEFAULT_HOST_OPS_FILTERS, severity: 'none' })).toBe(false)
    expect(matchesHostOpsFilters(view, { ...DEFAULT_HOST_OPS_FILTERS, severity: 'unknown' })).toBe(false)
  })
})
