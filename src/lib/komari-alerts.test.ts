import { describe, expect, it } from 'vitest'
import {
  acknowledgeKomariAlert,
  closeKomariAlert,
  komariAlertObservationsFromSummary,
  linkKomariAlertOperation,
  parseKomariAlertState,
  reconcileKomariAlerts,
  toKomariAlertStatePayload,
} from './komari-alerts'

const summary = { load: 2, offline: 1, total: 3, active: 1, updatedAt: 1_000 }

describe('Komari alert lifecycle', () => {
  it('deduplicates observations by integration/node/host/kind and keeps an audit trail', () => {
    const observations = komariAlertObservationsFromSummary(summary, {
      integrationId: 'prod', nodeId: 'node-1', hostId: 'host-1',
    })
    const duplicate = [...observations, observations[0]!]
    const result = reconcileKomariAlerts([], duplicate, { now: 1_100, baseSummary: summary })

    expect(result.alerts).toHaveLength(2)
    expect(result.alerts.find((alert) => alert.kind === 'load')).toMatchObject({ status: 'active', count: 2, deduplicatedCount: 1 })
    expect(result.audit.map((entry) => entry.event)).toEqual(expect.arrayContaining(['opened', 'deduplicated']))
    expect(result.summary.open).toBe(2)
    expect(result.summary.deduplicated).toBe(1)
    expect(result.summary).toMatchObject({ load: 2, offline: 1, total: 3, active: 1, updatedAt: 1_000 })
    const unchanged = reconcileKomariAlerts(result.alerts, observations, { now: 1_200 })
    expect(unchanged.audit).toHaveLength(0)
  })

  it('preserves acknowledgement, resolves on zero and reopens on a later signal', () => {
    const initial = reconcileKomariAlerts([], komariAlertObservationsFromSummary(summary, { integrationId: 'prod', hostId: 'host-1' }), { now: 1_000 })
    const load = initial.alerts.find((alert) => alert.kind === 'load')!
    const acknowledged = acknowledgeKomariAlert(load, 'alice', 1_100)
    const acknowledgedAlerts = initial.alerts.map((alert) => alert.alertId === load.alertId ? acknowledged.alert : alert)
    const recovered = reconcileKomariAlerts(acknowledgedAlerts, [{ integrationId: 'prod', hostId: 'host-1', kind: 'load', count: 0, updatedAt: 1_200 }], { now: 1_200 })
    expect(recovered.alerts.find((alert) => alert.alertId === load.alertId)).toMatchObject({ status: 'resolved', acknowledgedBy: 'alice' })
    const reopened = reconcileKomariAlerts(recovered.alerts, [{ integrationId: 'prod', hostId: 'host-1', kind: 'load', count: 3, updatedAt: 1_300 }], { now: 1_300 })
    expect(reopened.alerts.find((alert) => alert.alertId === load.alertId)).toMatchObject({ status: 'active', resolvedAt: null })
    expect(reopened.audit.map((entry) => entry.event)).toContain('reopened')
  })

  it('does not resolve a local alert when Komari withholds the count', () => {
    expect(komariAlertObservationsFromSummary({ load: null, offline: null, total: null, active: null, updatedAt: 1_000 }, { integrationId: 'prod' })).toEqual([])
  })

  it('associates a confirmed operation job and supports explicit close', () => {
    const { alerts } = reconcileKomariAlerts([], [{ integrationId: 'prod', hostId: 'host-1', kind: 'offline', count: 1, updatedAt: 1_000 }], { now: 1_000 })
    const alert = alerts[0]!
    const linked = linkKomariAlertOperation(alert, 'job-1', 'alice', 1_100)
    expect(linked.alert.relatedOperationJobId).toBe('job-1')
    expect(linked.audit).toMatchObject({ event: 'operation-linked', operationJobId: 'job-1' })
    const closed = closeKomariAlert(linked.alert, 'alice', 1_200)
    expect(closed.alert).toMatchObject({ status: 'closed', closedAt: 1_200, relatedOperationJobId: 'job-1' })
  })

  it('round-trips bounded persisted state and ignores legacy count-only summaries', () => {
    const { alerts, audit, summary: lifecycleSummary } = reconcileKomariAlerts([], [{ integrationId: 'prod', hostId: 'host-1', kind: 'load', count: 1, updatedAt: 1_000 }], { now: 1_000 })
    const state = { schemaVersion: 1 as const, alerts, audit, summary: lifecycleSummary }
    expect(parseKomariAlertState(toKomariAlertStatePayload(state))).toMatchObject({ alerts, audit })
    expect(parseKomariAlertState({ load: 1, offline: 0, total: 1 })).toBeNull()
    expect(parseKomariAlertState({ schemaVersion: 2, alerts: [], audit: [] })).toBeNull()
  })
})
