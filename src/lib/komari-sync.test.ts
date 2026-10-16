import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KOMARI_SYNC_CONCURRENCY,
  isKomariSyncFresh,
  syncKomariIntegration,
} from './komari-sync'
import type { HostProfile } from './hosts'

const host: HostProfile = {
  id: 'host-1', name: 'prod', address: '10.0.0.1', port: 22, username: 'ops', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0,
}

describe('Komari sync orchestration', () => {
  it('discovers, maps and probes metrics through the shared provider contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/admin/client/list')) {
        return new Response(JSON.stringify([{ uuid: 'node-1', name: 'prod', ipv4: '10.0.0.1' }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ time: 1_710_000_000, cpu: 33 }]), { status: 200 })
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
      return new Response(JSON.stringify([{ time: 1_710_000_000, cpu: 33 }]), { status: 200 })
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
      return new Response(JSON.stringify([{ time: 1_710_000_000, cpu: 33 }]), { status: 200 })
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
