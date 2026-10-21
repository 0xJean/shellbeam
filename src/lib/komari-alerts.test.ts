import { describe, expect, it } from 'vitest'
import {
  acknowledgeKomariAlert,
  closeKomariAlert,
  komariAlertObservationsFromSummary,
  komariAlertObservationsFromProbeSnapshot,
  linkKomariAlertOperation,
  parseKomariAlertState,
  reconcileKomariAlerts,
  toKomariAlertStatePayload,
} from './komari-alerts'
import type { ProbeSnapshot } from './probe-provider'

// These are explicit lifecycle observations, not notification configuration counts.
const observationsFor = (scope: { integrationId: string; nodeId?: string; hostId?: string }) => [
  { ...scope, kind: 'test-threshold', count: 2, updatedAt: 1000 },
  { ...scope, kind: 'test-availability', count: 1, updatedAt: 1000 },
]
const summary = { load: 2, offline: 1, total: 3, active: 1, updatedAt: 1_000 }

describe('Komari alert lifecycle', () => {
  it('deduplicates observations by integration/node/host/kind and keeps an audit trail', () => {
    const observations = observationsFor({
      integrationId: 'prod', nodeId: 'node-1', hostId: 'host-1',
    })
    const duplicate = [...observations, observations[0]!]
    const result = reconcileKomariAlerts([], duplicate, { now: 1_100, baseSummary: summary })

    expect(result.alerts).toHaveLength(2)
    expect(result.alerts.find((alert) => alert.kind === 'test-threshold')).toMatchObject({ status: 'active', count: 2, deduplicatedCount: 1 })
    expect(result.audit.map((entry) => entry.event)).toEqual(expect.arrayContaining(['opened', 'deduplicated']))
    expect(result.summary.open).toBe(2)
    expect(result.summary.deduplicated).toBe(1)
    expect(result.summary).toMatchObject({ load: 2, offline: 1, total: 2, active: 2, updatedAt: 1_000 })
    const unchanged = reconcileKomariAlerts(result.alerts, observations, { now: 1_200 })
    expect(unchanged.audit).toHaveLength(0)
  })

  it('preserves acknowledgement, resolves on zero and reopens on a later signal', () => {
    const initial = reconcileKomariAlerts([], observationsFor({ integrationId: 'prod', hostId: 'host-1' }), { now: 1_000 })
    const load = initial.alerts.find((alert) => alert.kind === 'test-threshold')!
    const acknowledged = acknowledgeKomariAlert(load, 'alice', 1_100)
    const acknowledgedAlerts = initial.alerts.map((alert) => alert.alertId === load.alertId ? acknowledged.alert : alert)
    const recovered = reconcileKomariAlerts(acknowledgedAlerts, [{ integrationId: 'prod', hostId: 'host-1', kind: 'test-threshold', count: 0, updatedAt: 1_200 }], { now: 1_200 })
    expect(recovered.alerts.find((alert) => alert.alertId === load.alertId)).toMatchObject({ status: 'resolved', acknowledgedBy: 'alice' })
    const reopened = reconcileKomariAlerts(recovered.alerts, [{ integrationId: 'prod', hostId: 'host-1', kind: 'test-threshold', count: 3, updatedAt: 1_300 }], { now: 1_300 })
    expect(reopened.alerts.find((alert) => alert.alertId === load.alertId)).toMatchObject({ status: 'active', resolvedAt: null })
    expect(reopened.audit.map((entry) => entry.event)).toContain('reopened')
  })

  it('does not resolve a local alert when Komari withholds the count', () => {
    expect(komariAlertObservationsFromSummary({ load: null, offline: null, total: null, active: null, updatedAt: 1_000 }, { integrationId: 'prod' })).toEqual([])
  })

  it('turns Probe health, freshness and errors into recoverable lifecycle rows', () => {
    const unhealthy = {
      schemaVersion: 1,
      host: { hostId: 'host-1', address: '10.0.0.1', port: 22, username: 'ops' },
      provider: { kind: 'komari', id: 'prod', nodeId: 'node-1', capabilities: ['metrics'] },
      transport: 'direct',
      health: 'unknown',
      receivedAt: 2_000,
      metrics: null,
      inventory: null,
      errors: [{ section: 'metrics', message: 'request timed out', code: 'timeout' }],
      telemetry: {
        status: 'failed', startedAt: 1_900, completedAt: 2_000, durationMs: 100,
        attempts: 2, maxRetries: 2, retryDelayMs: 50, recovered: false, exhausted: true,
        lastErrorCode: 'timeout',
      },
    } as unknown as ProbeSnapshot
    const observations = komariAlertObservationsFromProbeSnapshot(unhealthy, { integrationId: 'prod' }, 2_000)
    expect(observations.filter((item) => (item.count ?? 0) > 0)).toHaveLength(1)
    expect(observations.some((item) => item.kind === 'probe-unknown')).toBe(false)
    expect(observations.find((item) => item.kind === 'probe-error:metrics')).toMatchObject({
      count: 1,
      severity: 'warning',
      probeTelemetry: { status: 'failed', attempts: 2, exhausted: true, lastErrorCode: 'timeout' },
    })

    const stale = {
      ...unhealthy,
      health: 'online',
      errors: [],
      metrics: {
        data: {},
        source: unhealthy.provider,
        freshness: { sampledAt: 1_000, receivedAt: 2_000, ttlMs: 500, expiresAt: 1_500, expired: true, expiryReason: 'ttl-expired' },
        confidence: 'partial',
      },
    } as unknown as ProbeSnapshot
    expect(komariAlertObservationsFromProbeSnapshot(stale, { integrationId: 'prod' }, 2_000)
      .find((item) => item.kind === 'probe-error:metrics')).toMatchObject({ count: 1, title: 'Komari monitoring data is stale' })

    const opened = reconcileKomariAlerts([], observations, { now: 2_000 })
    expect(opened.audit.find((entry) => entry.event === 'opened')?.probeTelemetry).toMatchObject({
      status: 'failed', attempts: 2, exhausted: true, lastErrorCode: 'timeout',
    })
    expect(opened.alerts.find((alert) => alert.kind === 'probe-error:metrics')?.probeTelemetry).toMatchObject({
      status: 'failed', attempts: 2, exhausted: true, lastErrorCode: 'timeout',
    })
    const healthy = {
      ...unhealthy,
      health: 'online',
      errors: [],
      metrics: { ...stale.metrics!, freshness: { ...stale.metrics!.freshness, sampledAt: 2_050, expiresAt: 5_000, expired: false } },
      telemetry: {
        status: 'success', startedAt: 2_050, completedAt: 2_100, durationMs: 50,
        attempts: 0, maxRetries: 2, retryDelayMs: 50, recovered: false, exhausted: false,
      },
    } as unknown as ProbeSnapshot
    const recovered = reconcileKomariAlerts(
      opened.alerts,
      komariAlertObservationsFromProbeSnapshot(healthy, { integrationId: 'prod' }, 2_100),
      { now: 2_100 },
    )
    expect(recovered.alerts.filter((alert) => alert.status === 'resolved')).toHaveLength(1)
    expect(recovered.alerts.find((alert) => alert.kind === 'probe-error:metrics')?.probeTelemetry).toMatchObject({
      status: 'success', attempts: 0, exhausted: false,
    })
    expect(recovered.audit.find((entry) => entry.event === 'resolved')?.probeTelemetry).toMatchObject({
      status: 'success', attempts: 0, exhausted: false,
    })
    expect(recovered.audit.map((entry) => entry.event)).toContain('resolved')
  })

  it('associates a confirmed operation job and supports explicit close', () => {
    const { alerts } = reconcileKomariAlerts([], [{ integrationId: 'prod', hostId: 'host-1', kind: 'test-availability', count: 1, updatedAt: 1_000 }], { now: 1_000 })
    const alert = alerts[0]!
    const linked = linkKomariAlertOperation(alert, 'job-1', 'alice', 1_100)
    expect(linked.alert.relatedOperationJobId).toBe('job-1')
    expect(linked.audit).toMatchObject({ event: 'operation-linked', operationJobId: 'job-1' })
    const closed = closeKomariAlert(linked.alert, 'alice', 1_200)
    expect(closed.alert).toMatchObject({ status: 'closed', closedAt: 1_200, relatedOperationJobId: 'job-1' })
  })

  it('round-trips bounded persisted state and ignores legacy count-only summaries', () => {
    const { alerts, audit, summary: lifecycleSummary } = reconcileKomariAlerts([], [{ integrationId: 'prod', hostId: 'host-1', kind: 'test-threshold', count: 1, updatedAt: 1_000 }], { now: 1_000 })
    const state = { schemaVersion: 1 as const, alerts, audit, summary: lifecycleSummary }
    expect(parseKomariAlertState(toKomariAlertStatePayload(state))).toMatchObject({ alerts, audit })
    expect(parseKomariAlertState({ load: 1, offline: 0, total: 1 })).toBeNull()
    expect(parseKomariAlertState({ schemaVersion: 2, alerts: [], audit: [] })).toBeNull()
  })
})
