import { isKomariWaitingForFirstReport } from './komari-first-report'
import { describe, expect, it, vi } from 'vitest'
import { groupKomariAlertIncidents } from './komari-alert-incidents'
import { parseKomariAlertState, reconcileKomariAlerts, toKomariAlertStatePayload, type KomariAlertRecord, type KomariAlertState } from './komari-alerts'
import { persistKomariAlertAction, persistKomariAlertOperationLink } from './komari-alert-actions'
import { dispatchKomariAlertNotifications, komariAlertNotificationEvent } from './komari-alert-notifications'
import { reconcileKomariProbeAlerts } from './komari-sync'
import type { ProbeSnapshot } from './probe-provider'

vi.mock('./komari-persistence', () => ({ persistKomariAlertState: vi.fn().mockResolvedValue(undefined) }))

function legacyState(): KomariAlertState {
  const scope = { integrationId: 'integration', nodeId: 'node', hostId: 'host', count: 1, updatedAt: 1_000 }
  const state: KomariAlertState = { schemaVersion: 1, ...reconcileKomariAlerts([], [
    { ...scope, kind: 'probe-unknown', title: 'Komari Probe health is unknown', severity: 'warning' },
    { ...scope, kind: 'probe-error:provider', title: 'Komari Probe provider error: Probe recovery failed after 2 retries: Komari returned no dated metric observations', severity: 'critical' },
    { ...scope, kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations', severity: 'warning' },
  ], { now: 1_000 }) }
  return { ...state, alerts: state.alerts.map((alert) => { const legacy = { ...alert }; delete legacy.incidentKey; return legacy }) }
}

function snapshot(now: number, sampledAt?: number): ProbeSnapshot {
  const provider = { kind: 'komari' as const, id: 'integration', nodeId: 'node', capabilities: ['metrics' as const] }
  return {
    schemaVersion: 1, provider,
    host: { hostId: 'host', address: 'example.test', port: 22, username: 'ops' },
    transport: 'direct', health: sampledAt ? 'online' : 'unknown', receivedAt: now,
    inventory: null,
    metrics: sampledAt ? {
      data: { cpuPercent: 1 } as NonNullable<ProbeSnapshot['metrics']>['data'], source: provider, confidence: 'partial',
      freshness: { sampledAt, receivedAt: now, expiresAt: sampledAt + 10_000, ttlMs: 10_000, expired: false, expiryReason: null },
    } : null,
    errors: sampledAt ? [] : [
      { section: 'metrics', code: 'empty', message: 'Komari returned no dated metric observations' },
      { section: 'provider', code: 'recovery-retry-exhausted', message: 'Probe recovery failed after 2 retries: Komari returned no dated metric observations' },
    ],
  }
}

describe('Komari incident compatibility', () => {
  it('groups only the exact legacy fan-out and preserves IDs, audits and unrelated faults', () => {
    const original = legacyState()
    const oldIds = original.alerts.map((alert) => alert.alertId)
    const extra: KomariAlertRecord[] = original.alerts.map((alert) => ({ ...alert, alertId: `${alert.alertId}-other`, nodeId: 'different-node' }))
    extra.push({ ...original.alerts[0], alertId: 'inventory', kind: 'probe-error:inventory', title: 'independent inventory failure' })
    extra.push({ ...original.alerts[0], alertId: 'different-time', firstSeenAt: 900 })
    const restored = parseKomariAlertState(toKomariAlertStatePayload({ ...original, alerts: [...original.alerts, ...extra] }))!
    expect(restored.alerts.map((alert) => alert.alertId)).toEqual([...oldIds, ...extra.map((alert) => alert.alertId)])
    expect(restored.audit).toEqual(original.audit)
    const incidents = groupKomariAlertIncidents(restored.alerts)
    expect(incidents).toHaveLength(4)
    expect(incidents[0].memberAlertIds).toEqual(expect.arrayContaining(oldIds))
    expect(incidents[0].alert).toMatchObject({ kind: 'probe-error:metrics', severity: 'warning', count: 1 })
    expect(original.alerts.some((alert) => alert.incidentKey)).toBe(false)
  })

  it('preserves a later real critical outage in a previously grouped missing-report incident', () => {
    const old = parseKomariAlertState(toKomariAlertStatePayload(legacyState()))!
    const offline: ProbeSnapshot = { ...snapshot(2_000), health: 'offline' }
    const failed = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [offline], alertState: old, now: 2_000 })
    const incidents = groupKomariAlertIncidents(failed.alertState.alerts)
    expect(incidents).toHaveLength(1)
    expect(incidents[0].alert).toMatchObject({ severity: 'critical', title: 'Komari monitoring source is offline' })
    expect(komariAlertNotificationEvent(incidents[0].alert, failed.alertAudit[0]).severity).toBe('critical')
    expect(failed.alertState.alerts.map((row) => row.alertId)).toEqual(old.alerts.map((row) => row.alertId))
  })

  it('detaches a historical retry member when it becomes an independent provider failure, including on cold reads', () => {
    const old = parseKomariAlertState(toKomariAlertStatePayload(legacyState()))!
    const authentication: ProbeSnapshot = { ...snapshot(2_000), errors: [{ section: 'provider', code: 'unauthorized', message: 'authentication failed' }] }
    const failed = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [authentication], alertState: old, now: 2_000 })
    const provider = failed.alertState.alerts.find((alert) => alert.kind === 'probe-error:provider')!
    expect(provider.incidentKey).toBeUndefined()
    const incidents = groupKomariAlertIncidents(failed.alertState.alerts)
    expect(incidents).toHaveLength(2)
    expect(incidents.find((incident) => incident.alert.alertId === provider.alertId)?.alert.severity).toBe('critical')
    expect(incidents.find((incident) => incident.alert.kind === 'probe-error:metrics')?.memberAlertIds).not.toContain(provider.alertId)
    const staleKey = old.alerts.find((alert) => alert.kind === 'probe-error:provider')!.incidentKey
    const cold = parseKomariAlertState(toKomariAlertStatePayload({ ...failed.alertState,
      alerts: failed.alertState.alerts.map((alert) => alert.alertId === provider.alertId ? { ...alert, incidentKey: staleKey } : alert),
    }))!
    expect(groupKomariAlertIncidents(cold.alerts)).toHaveLength(2)
    expect(cold.alerts.find((alert) => alert.alertId === provider.alertId)?.incidentKey).toBeUndefined()
    expect(cold.audit).toEqual(failed.alertState.audit)
  })

  it('keeps all old member action targets, links one job, and remains idempotent across JSON restore', async () => {
    const state = legacyState()
    state.probeBaselines = [{ integrationId: 'integration', nodeId: 'node', hostId: 'host', lastHealthySampledAt: 500 }]
    const linked = await persistKomariAlertOperationLink({ integrationId: 'integration', state, alertId: state.alerts[0].alertId, operationJobId: 'job-one', now: 1_100 })
    const acknowledged = await persistKomariAlertAction('acknowledge', { integrationId: 'integration', state: linked.state, alertId: state.alerts[1].alertId, now: 1_200 })
    expect(acknowledged.state.alerts.every((alert) => alert.status === 'acknowledged' && alert.relatedOperationJobId === 'job-one')).toBe(true)
    expect(acknowledged.state.summary).toMatchObject({ open: 1, acknowledged: 1 })
    expect(acknowledged.state.audit.filter((entry) => entry.event === 'acknowledged')).toHaveLength(3)
    const restored = parseKomariAlertState(toKomariAlertStatePayload(acknowledged.state))!
    expect(restored.probeBaselines).toEqual(state.probeBaselines)
    const repeat = await persistKomariAlertAction('acknowledge', { integrationId: 'integration', state: restored, alertId: state.alerts[2].alertId, now: 1_300 })
    expect(repeat.state.audit).toEqual(restored.audit)
    const closed = await persistKomariAlertAction('close', { integrationId: 'integration', state: repeat.state, alertId: state.alerts[0].alertId, now: 1_400 })
    expect(closed.state.alerts.every((alert) => alert.status === 'closed')).toBe(true)
    expect(closed.state.summary).toMatchObject({ open: 0, closed: 1 })
  })

  it('emits one incident notification and never replays an already delivered legacy member', async () => {
    const state = legacyState()
    const onLocal = vi.fn()
    const first = await dispatchKomariAlertNotifications(state, { onLocal, now: 1_100, policy: { channels: ['local'], cooldownMs: 0 } })
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(first.summary.delivered).toBe(1)
    expect(first.events[0].payload.metadata.memberAlertIds).toHaveLength(3)
    // A previous client delivered only the unknown symptom before upgrading.
    const ledger = { ...first.state, deliveries: first.state.deliveries.map((delivery) => ({ ...delivery, eventId: state.audit[0].auditId })), attempts: [] }
    const reloaded = parseKomariAlertState(toKomariAlertStatePayload(state))!
    const second = await dispatchKomariAlertNotifications(reloaded, { onLocal, state: ledger, now: 100_000, policy: { channels: ['local'], cooldownMs: 0 }, includeRecent: true, retryPending: true })
    expect(second.summary.delivered).toBe(0)
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(second.state.deliveries).toEqual(ledger.deliveries)
  })

  it('recovers legacy member IDs together only from a new sample, with one recovery delivery after restart', async () => {
    const original = legacyState()
    const failed = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(2_000)], alertState: original, now: 2_000 })
    expect(failed.alertAudit).toEqual([])
    expect(failed.alertState.summary.open).toBe(1)
    const badTime = snapshot(2_500)
    badTime.errors = [{ section: 'metrics', code: 'invalid-sample-time', message: 'invalid sample time' }]
    const invalid = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [badTime], alertState: failed.alertState, now: 2_500 })
    expect(invalid.alertAudit.some((row) => row.event === 'resolved')).toBe(false)
    const recovered = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(3_000, 2_900)], alertState: invalid.alertState, now: 3_000 })
    expect(recovered.alertState.alerts.map((row) => row.alertId)).toEqual(original.alerts.map((row) => row.alertId))
    expect(recovered.alertAudit.filter((row) => row.event === 'resolved')).toHaveLength(3)
    expect(recovered.alertState.summary).toMatchObject({ open: 0, resolved: 1 })
    const onLocal = vi.fn()
    const delivered = await dispatchKomariAlertNotifications(recovered.alertState, { audit: recovered.alertAudit, onLocal, policy: { channels: ['local'], cooldownMs: 0 }, now: 3_000 })
    expect(delivered.summary.delivered).toBe(1)
    const restored = parseKomariAlertState(toKomariAlertStatePayload(recovered.alertState))!
    await dispatchKomariAlertNotifications(restored, { audit: [], state: delivered.state, includeRecent: true, retryPending: true, onLocal, policy: { channels: ['local'], cooldownMs: 0 }, now: 100_000 })
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('retains terminal legacy members whose old client replaced the retry title during recovery', async () => {
    const original = parseKomariAlertState(toKomariAlertStatePayload(legacyState()))!
    const recovered = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(3_000, 2_900)], alertState: original, now: 3_000 })
    const oldClientState = { ...recovered.alertState, alerts: recovered.alertState.alerts.map((alert) => alert.kind === 'probe-error:provider'
      ? { ...alert, title: 'Komari monitoring data recovered' } : alert) }
    const restored = parseKomariAlertState(toKomariAlertStatePayload(oldClientState))!
    expect(restored.alerts.every((alert) => alert.status === 'resolved')).toBe(true)
    expect(groupKomariAlertIncidents(restored.alerts)).toHaveLength(1)
    expect(restored.summary).toMatchObject({ open: 0, resolved: 1 })
    const onLocal = vi.fn()
    const result = await dispatchKomariAlertNotifications(restored, { audit: recovered.alertAudit, onLocal, policy: { channels: ['local'], cooldownMs: 0 }, now: 3_000 })
    expect(result.summary.delivered).toBe(1)
    expect(onLocal).toHaveBeenCalledTimes(1)
    const closed = parseKomariAlertState(toKomariAlertStatePayload({ ...restored,
      alerts: restored.alerts.map((alert) => ({ ...alert, status: 'closed' as const })),
    }))!
    expect(groupKomariAlertIncidents(closed.alerts)).toHaveLength(1)
    expect(closed.audit).toEqual(restored.audit)
  })

  it('does not label an offline source or independent provider failure as waiting for its first report', () => {
    const empty = snapshot(1_000)
    expect(isKomariWaitingForFirstReport(empty)).toBe(true)
    const offline: ProbeSnapshot = { ...empty, health: 'offline' }
    expect(isKomariWaitingForFirstReport(offline)).toBe(false)
    expect(reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [offline], now: 1_000 }).alertState.alerts)
      .toEqual([expect.objectContaining({ severity: 'critical', title: 'Komari monitoring source is offline' })])
    const authentication: ProbeSnapshot = { ...empty, errors: [...empty.errors, { section: 'provider', code: 'unauthorized', message: 'authentication failed' }] }
    expect(isKomariWaitingForFirstReport(authentication)).toBe(false)
    expect(reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [authentication], now: 1_000 }).alertState.alerts)
      .toContainEqual(expect.objectContaining({ kind: 'probe-error:provider', severity: 'critical' }))
  })

  it('waits for the first report, persists the baseline, and requires a newer real observation to recover', () => {
    const waiting = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(1_000)], now: 1_000 })
    expect(waiting.alertState.alerts).toEqual([])
    const first = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(2_000, 1_900)], alertState: waiting.alertState, now: 2_000 })
    const restored = parseKomariAlertState(toKomariAlertStatePayload(first.alertState))!
    expect(restored.probeBaselines?.[0].lastHealthySampledAt).toBe(1_900)
    const failed = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(3_000)], alertState: restored, now: 3_000 })
    expect(failed.alertState.alerts).toHaveLength(1)
    expect(failed.alertState.summary.open).toBe(1)
    const cached = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(4_000, 1_900)], alertState: failed.alertState, now: 4_000 })
    expect(cached.alertState.summary.open).toBe(1)
    expect(cached.alertAudit.some((audit) => audit.event === 'resolved')).toBe(false)
    const recovered = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(5_000, 4_900)], alertState: cached.alertState, now: 5_000 })
    expect(recovered.alertState.summary.open).toBe(0)
    expect(recovered.alertAudit.filter((audit) => audit.event === 'resolved')).toHaveLength(1)
    const replay = reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [snapshot(5_500, 4_900)], alertState: recovered.alertState, now: 5_500 })
    expect(replay.alertAudit).toEqual([])
    // Rebinding the same node to another host must not inherit its baseline.
    const rebound = snapshot(6_000); rebound.host.hostId = 'new-host'
    expect(reconcileKomariProbeAlerts({ integrationId: 'integration', snapshots: [rebound], alertState: recovered.alertState, now: 6_000 }).alertAudit).toEqual([])
  })
})
