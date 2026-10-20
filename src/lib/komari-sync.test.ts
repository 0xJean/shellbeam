import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KOMARI_SYNC_CONCURRENCY,
  isKomariSyncFresh,
  reconcileKomariProbeAlerts,
  syncKomariIntegration,
} from './komari-sync'
import { reconcileKomariAlerts } from './komari-alerts'
import type { HostProfile } from './hosts'
import type { ProbeSnapshot } from './probe-provider'

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
}

function healthyRecoverySnapshot(): ProbeSnapshot {
  return {
    schemaVersion: 1,
    host: { hostId: 'host-1', address: '10.0.0.1', port: 22, username: 'ops' },
    provider: { kind: 'komari', id: 'komari-recovery', nodeId: 'node-1', capabilities: ['metrics'] },
    transport: 'direct',
    health: 'online',
    receivedAt: 2_000,
    metrics: {
      data: {
        hostname: 'prod', os: 'Linux', kernel: '', uptimeSeconds: 100, cpuPercent: 25,
        load1: null, load5: null, load15: null, memoryUsedBytes: null, memoryTotalBytes: null,
        memoryPercent: null, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null,
        networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null, sampledAt: 1_900,
      },
      source: { kind: 'komari', id: 'komari-recovery', nodeId: 'node-1', capabilities: ['metrics'] },
      freshness: { sampledAt: 1_900, receivedAt: 2_000, ttlMs: 60_000, expiresAt: 61_900, expired: false, expiryReason: null },
      confidence: 'partial',
    },
    inventory: null,
    errors: [],
    alerts: { load: 0, offline: 0, total: 0, active: 0, updatedAt: 2_000 },
  }
}

describe('Komari sync orchestration', () => {
  it('discovers, maps and probes metrics through the shared provider contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: '10.0.0.1' }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ time: 1.9, cpu: 33 }]), { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example', token: 'secret' },
      hosts: [host],
      now: 2_000,
      fetchImpl,
    })
    expect(result.mapping.mappings).toHaveLength(1)
    expect(result.snapshots[0]).toMatchObject({ provider: { kind: 'komari', nodeId: 'node-1' }, health: 'online' })
    expect(result.snapshots[0]?.metrics?.data.cpuPercent).toBe(33)
    expect(result.alerts).toEqual({ load: 1, offline: 1, total: 2, active: null, updatedAt: 2_000 })
    expect(result.snapshots[0]?.alerts).toEqual(result.alerts)
    expect(result.alertState?.summary.open).toBe(2)
    expect(result.alertState?.alerts.map((alert) => alert.integrationId)).toEqual(['komari-prod', 'komari-prod'])
  })

  it('reconciles a Probe collection error and resolves it on the next healthy sync', async () => {
    let metricFailure = true
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: '10.0.0.1' }]), { status: 200 })
      }
      if (url.includes('/api/admin/notification/')) return new Response('[]', { status: 200 })
      if (metricFailure) return new Response('temporarily unavailable', { status: 503 })
      return new Response(JSON.stringify([{ time: 2.9, cpu: 33 }]), { status: 200 })
    })

    const failed = await syncKomariIntegration({
      integrationId: 'komari-prod-recovery', config: { endpoint: 'https://komari.example' }, hosts: [host], now: 2_000, fetchImpl,
    })
    expect(failed.alertState?.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'probe-error:metrics', status: 'active' }),
    ]))
    const failedAudit = failed.alertAudit.map((entry) => entry.event)
    expect(failedAudit).toContain('opened')

    metricFailure = false
    const recovered = await syncKomariIntegration({
      integrationId: 'komari-prod-recovery', config: { endpoint: 'https://komari.example' }, hosts: [host], now: 3_000, fetchImpl,
      alertState: failed.alertState,
    })
    expect(recovered.snapshots[0]?.health).toBe('online')
    expect(recovered.alertState?.alerts.find((alert) => alert.kind === 'probe-error:metrics')?.status).toBe('resolved')
    expect(recovered.alertAudit.map((entry) => entry.event)).toContain('resolved')
  })

  it('does not recover prior alerts from future-only reports even when the aggregate summary is complete', async () => {
    const now = Date.parse('2026-10-17T08:30:00Z')
    const integrationId = 'komari-future-alert-regression'
    const previous = reconcileKomariAlerts([], [
      { integrationId, nodeId: 'node-1', hostId: host.id, kind: 'probe-offline', count: 1, updatedAt: now - 1000 },
      { integrationId, nodeId: 'node-1', hostId: host.id, kind: 'probe-stale', count: 1, updatedAt: now - 1000 },
      { integrationId, nodeId: 'node-1', hostId: host.id, kind: 'probe-error:inventory', count: 1, updatedAt: now - 1000 },
    ], { now: now - 1000 })
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: host.address }]))
      if (url.includes('/api/admin/notification/')) return new Response('[]')
      return new Response(JSON.stringify([{ time: now + 1, cpu: 25 }]))
    })
    const result = await syncKomariIntegration({ integrationId, config: { endpoint: 'https://komari.example' }, hosts: [host], now, fetchImpl,
      alertState: { schemaVersion: 1, alerts: previous.alerts, audit: previous.audit, summary: previous.summary },
    })
    expect(result.snapshots[0]).toMatchObject({ health: 'unknown', metrics: null })
    expect(result.snapshots[0].errors).toContainEqual(expect.objectContaining({ code: 'invalid-sample-time' }))
    expect(result.history).toHaveLength(0)
    for (const kind of ['probe-offline', 'probe-stale', 'probe-error:inventory']) {
      expect(result.alertState?.alerts.find((alert) => alert.kind === kind)?.status).toBe('active')
    }
    expect(result.alertAudit.some((entry) => entry.event === 'resolved')).toBe(false)
  })

  it('does not pass the sync start time as the reception clock for live requests', async () => {
    let now = Date.parse('2026-10-17T08:30:00Z')
    const startedAt = now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (String(input).endsWith('/api/admin/client/list')) return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: host.address }]))
        now += 1000
        return new Response(JSON.stringify([{ time: now, cpu: 25 }]))
      })
      const result = await syncKomariIntegration({ integrationId: 'komari-reception-clock-regression', config: { endpoint: 'https://komari.example' }, hosts: [host], fetchImpl, includeAlerts: false })
      expect(result.syncedAt).toBe(startedAt)
      expect(result.snapshots[0]).toMatchObject({ health: 'online', receivedAt: now })
      expect(result.snapshots[0].metrics?.freshness.sampledAt).toBe(now)
    } finally { clock.mockRestore() }
  })


  it('auto-resolves and reopens persisted Probe and aggregate alerts across sessions', () => {
    const initial = reconcileKomariAlerts([], [
      { integrationId: 'komari-recovery', kind: 'load', count: 1, updatedAt: 1_000 },
      { integrationId: 'komari-recovery', nodeId: 'node-1', hostId: 'host-1', kind: 'probe-error:metrics', count: 1, updatedAt: 1_000 },
    ], { now: 1_000 })
    const healthySnapshot = healthyRecoverySnapshot()
    const recovered = reconcileKomariProbeAlerts({
      integrationId: 'komari-recovery',
      snapshots: [healthySnapshot],
      alertState: { schemaVersion: 1, ...initial },
      now: 2_000,
    })
    expect(recovered.alertState.alerts.every((alert) => alert.status === 'resolved')).toBe(true)
    expect(recovered.alertState.summary).toMatchObject({ load: 0, offline: 0, open: 0 })
    expect(recovered.alertAudit.map((entry) => entry.event)).toEqual(['resolved', 'resolved'])
    expect(recovered.alertState.audit.map((entry) => entry.event)).toEqual(['opened', 'opened', 'resolved', 'resolved'])

    const failingSnapshot: ProbeSnapshot = {
      ...healthySnapshot,
      health: 'online',
      receivedAt: 3_000,
      // A partial report can retain a dated, still-fresh observation while
      // reporting a collection error; online is valid only with that evidence.
      errors: [{ section: 'metrics', code: 'partial', message: 'partial metrics report' }],
      alerts: { load: 1, offline: 0, total: 1, active: 1, updatedAt: 3_000 },
    }
    const reopened = reconcileKomariProbeAlerts({
      integrationId: 'komari-recovery',
      snapshots: [failingSnapshot],
      alertState: recovered.alertState,
      now: 3_000,
    })
    expect(reopened.alertState.alerts).toHaveLength(2)
    expect(reopened.alertState.alerts.every((alert) => alert.status === 'active')).toBe(true)
    expect(reopened.alertAudit.map((entry) => entry.event)).toEqual(['reopened', 'reopened'])
    expect(reopened.alertState.audit.map((entry) => entry.event)).toEqual(['opened', 'opened', 'resolved', 'resolved', 'reopened', 'reopened'])
  })

  it('keeps one root-cause alert when a restored online envelope has no observations', () => {
    const initial = reconcileKomariAlerts([], [
      { integrationId: 'komari-recovery', kind: 'load', count: 1, updatedAt: 1_000 },
      { integrationId: 'komari-recovery', nodeId: 'node-1', hostId: host.id, kind: 'probe-error:metrics', count: 1, updatedAt: 1_000 },
    ], { now: 1_000 })
    const healthySnapshot = healthyRecoverySnapshot()
    const recovered = reconcileKomariProbeAlerts({ integrationId: 'komari-recovery', snapshots: [healthySnapshot], alertState: { schemaVersion: 1, ...initial }, now: 2_000 })
    const withoutObservation: ProbeSnapshot = {
      ...healthySnapshot, receivedAt: 3_000, metrics: null, inventory: null,
      // Persisted older clients may have claimed online despite a failed read.
      health: 'online', errors: [{ section: 'metrics', code: 'timeout', message: 'temporary failure' }],
      alerts: { load: 1, offline: 0, total: 1, active: 1, updatedAt: 3_000 },
    }
    const result = reconcileKomariProbeAlerts({ integrationId: 'komari-recovery', snapshots: [withoutObservation], alertState: recovered.alertState, now: 3_000 })
    expect(result.alertAudit.map(({ event, fingerprint }) => ({ event, fingerprint }))).toEqual([
      { event: 'reopened', fingerprint: 'komari-recovery|node-1|host-1|probe-error:metrics' },
      { event: 'reopened', fingerprint: 'komari-recovery|||load' },
    ])
    expect(result.alertState.alerts).toHaveLength(2)
    expect(result.alertState.alerts.every((alert) => alert.status === 'active')).toBe(true)
    expect(result.alertState.alerts.some((alert) => alert.kind === 'probe-unknown')).toBe(false)
    // A repeated hydration must neither open another alert nor append audits.
    const repeated = reconcileKomariProbeAlerts({ integrationId: 'komari-recovery', snapshots: [withoutObservation], alertState: result.alertState, now: 3_100 })
    expect(repeated.alertState.alerts).toHaveLength(2)
    expect(repeated.alertAudit).toEqual([])
  })

  it('uses a matching old healthy cache as first-report evidence without treating it as recovery', async () => {
    const endpoint = 'https://komari.example'
    const previous = healthyRecoverySnapshot()
    previous.provider.endpoint = endpoint
    const fetchImpl = vi.fn<typeof fetch>(async (input) => String(input).endsWith('/api/admin/client/list')
      ? new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: host.address }])) : new Response('[]'))
    const result = await syncKomariIntegration({ integrationId: 'komari-recovery', config: { endpoint }, hosts: [host],
      previousSnapshots: [previous], now: 100_000, fetchImpl })
    expect(result.alertState?.probeBaselines).toEqual([{ integrationId: 'komari-recovery', endpoint, nodeId: 'node-1', hostId: host.id, lastHealthySampledAt: 1_900 }])
    expect(result.alertState?.alerts).toHaveLength(1)
    expect(result.alertState?.alerts[0]).toMatchObject({ kind: 'probe-error:metrics', status: 'active' })
    expect(result.alertAudit.some((row) => row.event === 'resolved')).toBe(false)
    const changedEndpoint = await syncKomariIntegration({ integrationId: 'komari-recovery', config: { endpoint: 'https://other.example' }, hosts: [host],
      previousSnapshots: [previous], alertState: result.alertState, now: 100_000, fetchImpl })
    expect(changedEndpoint.alertState?.probeBaselines).toEqual(result.alertState?.probeBaselines)
    expect(changedEndpoint.alertAudit).toEqual([])
  })

  it('skips a fresh persisted sync and allows an explicit refresh', async () => {
    expect(isKomariSyncFresh(1_000, 1_500, 1_000)).toBe(true)
    expect(isKomariSyncFresh(1_000, 2_000, 1_000)).toBe(false)
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example' },
      hosts: [host],
      now: 1_500,
      lastSyncedAt: 1_000,
      ttlMs: 1_000,
      fetchImpl,
    })
    expect(result).toMatchObject({ skipped: true, skipReason: 'ttl', syncedAt: 1_000 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('retains Komari aggregate counts and does not infer recovery from unknown counters', async () => {
    const previous = {
      schemaVersion: 1 as const,
      alerts: [{
        schemaVersion: 1 as const, source: 'komari' as const, alertId: 'komari-alert-1', fingerprint: 'komari-prod||host-1|load',
        integrationId: 'komari-prod', nodeId: null, hostId: 'host-1', kind: 'load', title: 'load', severity: 'warning' as const,
        count: 2, status: 'active' as const, firstSeenAt: 1_000, lastSeenAt: 1_000, acknowledgedAt: null, acknowledgedBy: null,
        resolvedAt: null, closedAt: null, relatedOperationJobId: null, deduplicatedCount: 0,
      }],
      audit: [],
      summary: { load: 2, offline: 0, total: 2, active: 1, updatedAt: 1_000, open: 1, acknowledged: 0, resolved: 0, closed: 0, deduplicated: 0, localUpdatedAt: 1_000 },
    }
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.includes('/api/admin/notification/')) return new Response(JSON.stringify({ total: null }), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod', config: { endpoint: 'https://komari.example' }, hosts: [], now: 2_000, fetchImpl, alertState: previous,
    })
    expect(result.alertState?.alerts[0]?.status).toBe('active')
    expect(result.alertState?.summary.load).toBeNull()
  })

  it('returns only lifecycle audit rows produced by the current reconciliation', async () => {
    const previous = {
      schemaVersion: 1 as const,
      alerts: [{
        schemaVersion: 1 as const, source: 'komari' as const, alertId: 'komari-alert-load', fingerprint: 'komari-prod|||load',
        integrationId: 'komari-prod', nodeId: null, hostId: null, kind: 'load', title: 'load', severity: 'warning' as const,
        count: 0, status: 'resolved' as const, firstSeenAt: 1_000, lastSeenAt: 1_000, acknowledgedAt: null, acknowledgedBy: null,
        resolvedAt: 1_000, closedAt: null, relatedOperationJobId: null, deduplicatedCount: 0,
      }],
      audit: [{
        auditId: 'old-open', alertId: 'komari-alert-load', fingerprint: 'komari-prod|||load',
        event: 'opened' as const, status: 'active' as const, actor: 'komari-sync', operationJobId: null, at: 1_000,
      }],
      summary: { load: 0, offline: 0, total: 0, active: 0, updatedAt: 1_000, open: 0, acknowledged: 0, resolved: 1, closed: 0, deduplicated: 0, localUpdatedAt: 1_000 },
    }
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) return new Response(JSON.stringify([]), { status: 200 })
      if (url.endsWith('/api/admin/notification/load/')) return new Response(JSON.stringify({ total: 1 }), { status: 200 })
      if (url.endsWith('/api/admin/notification/offline')) return new Response(JSON.stringify({ total: 0 }), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example' },
      hosts: [],
      now: 2_000,
      fetchImpl,
      alertState: previous,
    })
    expect(result.alertAudit.map((entry) => entry.event)).toEqual(['reopened'])
    expect(result.alertAudit).not.toContainEqual(expect.objectContaining({ auditId: 'old-open' }))
    expect(result.alertState?.audit.map((entry) => entry.auditId)).toEqual(['old-open', result.alertAudit[0]?.auditId])
  })

  it('caps concurrent recent-metric requests while preserving all snapshots', async () => {
    const hosts = Array.from({ length: DEFAULT_KOMARI_SYNC_CONCURRENCY + 2 }, (_, index) => ({
      ...host,
      id: `host-${index}`,
      name: `prod-${index}`,
      address: `10.0.0.${index + 1}`,
    }))
    let active = 0
    let peak = 0
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify(hosts.map((item, index) => ({ uuid: `node-${index}`, name: item.name, ipv4: item.address }))), { status: 200 })
      }
      if (url.includes('/api/admin/notification/')) return new Response('[]', { status: 200 })
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return new Response(JSON.stringify([{ time: 1.9, cpu: 33 }]), { status: 200 })
    })
    const result = await syncKomariIntegration({
      integrationId: 'komari-prod',
      config: { endpoint: 'https://komari.example' },
      hosts,
      now: 2_000,
      fetchImpl,
      maxConcurrency: 2,
    })
    expect(result.snapshots).toHaveLength(hosts.length)
    expect(peak).toBeLessThanOrEqual(2)
  })
})
