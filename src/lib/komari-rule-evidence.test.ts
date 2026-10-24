import { describe, expect, it, vi } from 'vitest'
import { getKomariAlertSummary } from './komari'
import { acknowledgeKomariAlert, closeKomariAlert, komariAlertObservationsFromSummary, parseKomariAlertState, reconcileKomariAlerts, type KomariAlertRecord } from './komari-alerts'
import { komariAlertLastObservation } from './komari-alert-incidents'
import { dispatchKomariAlertNotifications } from './komari-alert-notifications'
import { buildHostIncidents } from './host-incidents'

const legacy: KomariAlertRecord = { schemaVersion: 1, source: 'komari', alertId: 'keep-id', fingerprint: 'server|||offline', integrationId: 'server', nodeId: null, hostId: null, kind: 'offline', title: 'Offline notifications', severity: 'critical', count: 1, status: 'active', firstSeenAt: 1, lastSeenAt: 2, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, closedAt: null, relatedOperationJobId: 'keep-job', deduplicatedCount: 0 }

describe('Komari notification rules are not incident evidence', () => {
  it('does not create an incident for disabled rules, rule counts, or a global active count', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/offline') ? new Response(JSON.stringify([{ client: 'node', enable: false, grace_period: 180, last_notified: null }])) : new Response('{}', { status: 404 }))
    const summary = await getKomariAlertSummary({ endpoint: 'https://monitor.example' }, fetcher, 10)
    expect(summary).toMatchObject({ offline: 1, active: null })
    for (const active of [null, 0, 1, 9]) {
      expect(komariAlertObservationsFromSummary({ ...summary, active }, { integrationId: 'server' })).toEqual([])
      const result = reconcileKomariAlerts([], komariAlertObservationsFromSummary({ ...summary, active }, { integrationId: 'server' }), { now: 10, complete: true })
      expect(result.alerts).toEqual([]); expect(result.audit).toEqual([]); expect(result.summary.open).toBe(0)
    }
  })
  it('keeps historical IDs, status, linked jobs and audits without fake recovery or replay', async () => {
    const audit = [{ auditId: 'old-audit', alertId: legacy.alertId, fingerprint: legacy.fingerprint, event: 'opened' as const, status: 'active' as const, actor: 'old-client', operationJobId: 'keep-job', at: 2 }]
    const state = parseKomariAlertState({ schemaVersion: 1, alerts: [legacy], audit })!
    expect(state.alerts[0]).toMatchObject({ ...legacy, evidenceStatus: 'unverified-rule-count' }); expect(state.audit).toEqual(audit)
    const next = reconcileKomariAlerts(state.alerts, [], { now: 20, complete: true })
    expect(next.alerts[0].status).toBe('active'); expect(next.audit).toEqual([]); expect(next.summary.open).toBe(0)
    const local = vi.fn()
    const delivery = await dispatchKomariAlertNotifications(state, { audit, now: 20, policy: { enabled: true, channels: ['local'] }, onLocal: local, retryPending: true, includeRecent: true })
    expect(local).not.toHaveBeenCalled(); expect(delivery.summary.delivered).toBe(0)
    expect(buildHostIncidents([], new Map(), 'v')).toEqual([])
  })
  it('keeps last observation independent from acknowledgement and archiving', () => {
    const observed = reconcileKomariAlerts([], [{ integrationId: 'server', kind: 'probe-offline', count: 1, updatedAt: 2 }], { now: 2 }).alerts[0]
    const acknowledged = acknowledgeKomariAlert(observed, 'test', 10).alert
    const archived = closeKomariAlert(acknowledged, 'test', 20).alert
    expect(komariAlertLastObservation(acknowledged)).toBe('abnormal')
    expect(komariAlertLastObservation(archived)).toBe('abnormal')
    expect(archived.resolvedAt).toBeNull()
    const recovered = reconcileKomariAlerts([archived], [{ integrationId: 'server', kind: 'probe-offline', updatedAt: 30, count: 0, recoverySampledAt: 30 }], { now: 31 }).alerts[0]
    expect(recovered.status).toBe('closed')
    expect(recovered.count).toBe(0)
    expect(komariAlertLastObservation(recovered)).toBe('recovered')
    expect(komariAlertLastObservation(legacy)).toBe('unknown')
  })
})
