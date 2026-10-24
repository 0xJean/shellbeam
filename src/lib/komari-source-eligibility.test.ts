import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isCurrentKomariAlert, isCurrentKomariSnapshot, loadCurrentKomariSource, type CurrentKomariSource } from './komari-source-eligibility'
import { buildHostOpsViews, hasHostOpsEvidence, loadHostOpsViews } from './host-ops-view'
import { buildWorkspaceProviderState } from './workspace-provider-state'
import { createProbeObservation, type ProbeSnapshot } from './probe-provider'
import { reconcileKomariAlerts } from './komari-alerts'
import { getServerMonitorHostKey, type ServerMonitorLatest } from './server-monitor'
import type { HostProfile } from './hosts'
import type { PersistedProbeSnapshotRecord } from './probe-persistence'
import type { OperationAuditEntry } from './operation-job'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const now = 10_000
const host: HostProfile = { id: 'host-a', vaultId: 'vault-a', name: 'App', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', group: 'Default', tags: [], createdAt: 1, updatedAt: 1 }
const other = { ...host, id: 'host-b' }
function source(): CurrentKomariSource {
  return { integration: { id: 'komari-a', vaultId: 'vault-a', name: 'Monitor', endpoint: 'https://monitor.test', credentialRef: 'private-ref', enabled: true, createdAt: 1, updatedAt: 1 },
    state: { snapshots: [], mappings: [{ integrationId: 'komari-a', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: 2 }], syncState: null, lastSyncedAt: null }, mappingRevision: 1, error: false }
}
function snapshot(target = host): ProbeSnapshot {
  const provider = { kind: 'komari' as const, id: 'komari-a', nodeId: 'node-a', endpoint: 'https://monitor.test', capabilities: ['metrics' as const] }
  const metrics = { hostname: target.name, os: 'Linux', kernel: '6', uptimeSeconds: 10, cpuPercent: 70, load1: 1, load5: 1, load15: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, memoryPercent: 50, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null, sampledAt: now }
  return { schemaVersion: 1, host: { hostId: target.id, address: target.address, port: target.port, username: target.username }, provider, transport: 'direct', health: 'online', receivedAt: now,
    metrics: createProbeObservation({ data: metrics, source: provider, sampledAt: now, receivedAt: now, ttlMs: 1000 }), inventory: null, errors: [] }
}
function row(value = snapshot()): PersistedProbeSnapshotRecord {
  return { vaultId: host.vaultId!, hostId: value.host.hostId, providerKind: value.provider.kind, providerId: value.provider.id, snapshot: value, sampledAt: now, receivedAt: now, expiresAt: now + 1000, updatedAt: now }
}
function sshMonitor(): ServerMonitorLatest {
  return { hostKey: getServerMonitorHostKey(host), hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port,
    status: 'online', snapshot: { ...snapshot().metrics!.data, cpuPercent: 15 }, lastAttemptAt: now, lastSuccessAt: now, updatedAt: now }
}
const audit: OperationAuditEntry = { auditId: 'audit-old', jobId: 'job-old', hostId: host.id, hostName: host.name, hostAddress: host.address, source: 'workspace', actor: 'local-user', action: 'komari.alert.acknowledge', target: 'alert-old', risk: 'low', provider: 'komari', transport: 'direct', event: 'updated', status: 'completed', confirmationStatus: 'confirmed', createdAt: now - 20, resultSummary: 'Acknowledged' }
const alertState = () => ({ schemaVersion: 1 as const, ...reconcileKomariAlerts([], [{ integrationId: 'komari-a', hostId: host.id, nodeId: 'node-a', kind: 'probe-offline', count: 1, active: 1, title: 'Metrics interrupted', updatedAt: now }], { now }) })

beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('current Komari source eligibility', () => {
  it.each(['disabled', 'deleted', 'unmapped', 'foreign-vault', 'endpoint-changed', 'mapping-unreadable'] as const)('rejects %s observations in both host and Workspace projections while keeping SSH usable and history intact', (reason) => {
    const entry = source()
    let sources = [entry]
    if (reason === 'disabled') entry.integration.enabled = false
    if (reason === 'deleted') sources = []
    if (reason === 'unmapped') { entry.state!.mappings = []; entry.mappingRevision = 2 }
    if (reason === 'foreign-vault') entry.integration.vaultId = 'vault-b'
    if (reason === 'endpoint-changed') { entry.integration.endpoint = 'https://replacement.test'; entry.integration.updatedAt = now + 1 }
    if (reason === 'mapping-unreadable') entry.error = true
    const stored = row()
    const alerts = alertState()
    const original = JSON.stringify({ stored, alerts, audit })
    const hostView = buildHostOpsViews({ hosts: [host], probeSnapshots: [stored.snapshot], komariSnapshots: [stored.snapshot], komariSources: sources, komariAlertStates: [alerts], monitorLatest: [sshMonitor()], audits: [audit], now })[host.id]
    const workspace = buildWorkspaceProviderState({ host, vaultId: host.vaultId, data: { rows: [stored], komari: sources, monitors: [sshMonitor()], inventoryCache: {}, inventoryStates: {}, agents: [] }, now })
    for (const view of [hostView, workspace.view!]) {
      expect(view.metrics?.cpuPercent).toBe(15)
      expect(view.health.provider).toBe('ssh-agentless')
      expect(view.health.fallbackProvider).toBeUndefined()
      expect(view.komariAlerts).toEqual([])
      expect(view.alertOpenCount).toBe(0)
    }
    expect(workspace.sources.some((value) => value.kind === 'komari')).toBe(false)
    expect(hostView.audits).toEqual([audit])
    expect(JSON.stringify({ stored, alerts, audit })).toBe(original)
  })

  it('accepts only the associated host in a mixed fleet and never uses an old audit as a current provider', () => {
    const current = source()
    const views = buildHostOpsViews({ hosts: [host, other], probeSnapshots: [snapshot(), snapshot(other)], komariSources: [current], komariAlertStates: [alertState()], now })
    expect(views[host.id].metrics?.cpuPercent).toBe(70)
    expect(views[host.id].alertOpenCount).toBe(1)
    expect(views[other.id].metrics).toBeNull()
    expect(hasHostOpsEvidence(views[other.id])).toBe(false)
    const detached = buildHostOpsViews({ hosts: [host], audits: [audit], komariSources: [], now })[host.id]
    expect(detached.health.provider).toBe('unknown')
    expect(detached.audits).toEqual([audit])
    expect(hasHostOpsEvidence(detached)).toBe(true)
  })

  it('allows an untouched canonical-only legacy cache, but never interprets missing revision or explicit unbinding as legacy', () => {
    const current = source()
    current.state!.mappings = []
    const legacy = snapshot()
    delete legacy.provider.endpoint
    for (const revision of [undefined, 1, 2]) {
      current.mappingRevision = revision
      expect(isCurrentKomariSnapshot(legacy, host, [current])).toBe(false)
    }
    current.mappingRevision = 0
    expect(isCurrentKomariSnapshot(legacy, host, [current])).toBe(true)
    current.integration.updatedAt = now + 1
    expect(isCurrentKomariSnapshot(legacy, host, [current])).toBe(false)
  })

  it('keeps a fresh eligible observation preferred and falls back to fresh SSH after Komari expiry', () => {
    const current = source()
    const fresh = buildHostOpsViews({ hosts: [host], probeSnapshots: [snapshot()], komariSources: [current], monitorLatest: [sshMonitor()], now })[host.id]
    expect(fresh.health).toMatchObject({ provider: 'komari', fallbackProvider: 'ssh-agentless', state: 'online' })
    const expired = buildHostOpsViews({ hosts: [host], probeSnapshots: [snapshot()], komariSources: [current], monitorLatest: [sshMonitor()], now: now + 1001 })[host.id]
    expect(expired.health).toMatchObject({ provider: 'ssh-agentless', fallbackProvider: 'komari', state: 'online' })
  })

  it.each(['active', 'acknowledged', 'resolved', 'closed'] as const)('retains an older %s incident and audit after a metadata edit while still rejecting an endpoint change', (status) => {
    const current = source()
    current.integration.name = 'Renamed monitoring source'
    current.integration.updatedAt = now + 100
    const lifecycle = alertState()
    lifecycle.alerts[0].status = status
    const original = JSON.stringify(lifecycle)
    const input = { hosts: [host], komariSources: [current], probeSnapshots: [snapshot()], komariAlertStates: [lifecycle], now: now + 2000 }
    const view = buildHostOpsViews(input)[host.id]
    expect(view.komariAlerts).toEqual(lifecycle.alerts)
    expect(view.komariAlertAudits).toEqual(lifecycle.audit)
    expect(view.alertOpenCount).toBe(status === 'active' || status === 'acknowledged' ? 1 : 0)
    current.integration.endpoint = 'https://replacement.test'
    expect(buildHostOpsViews(input)[host.id].komariAlerts).toEqual([])
    expect(JSON.stringify(lifecycle)).toBe(original)
  })

  it.each(['baseline', 'persisted-snapshot'] as const)('does not let a replacement endpoint snapshot revive an older incident with %s provenance', (provenance) => {
    const current = source()
    const oldSnapshot = snapshot()
    const lifecycle = alertState()
    const oldEndpoint = current.integration.endpoint
    current.integration.endpoint = 'https://replacement.test'
    current.integration.updatedAt = now + 1000
    const replacement: ProbeSnapshot = { ...snapshot(), receivedAt: now + 2000, provider: { ...snapshot().provider, endpoint: current.integration.endpoint } }
    if (provenance === 'persisted-snapshot') current.state!.snapshots = [{
      integrationId: 'komari-a', nodeId: 'node-a', hostId: host.id, snapshot: oldSnapshot,
      sampledAt: now, receivedAt: now, expiresAt: now + 1000, updatedAt: now,
    }]
    current.state!.syncState = {
      integrationId: 'komari-a', lastSyncedAt: now + 3000, lastSuccessfulSyncAt: now + 3000, ttlMs: 60_000, updatedAt: now + 3000,
      alertSummary: { ...lifecycle, probeBaselines: provenance === 'baseline'
        ? [{ integrationId: 'komari-a', endpoint: oldEndpoint, nodeId: 'node-a', hostId: host.id, lastHealthySampledAt: now - 100 }]
        : [] },
    }
    const original = JSON.stringify({ current, lifecycle, replacement })
    expect(isCurrentKomariSnapshot(replacement, host, [current])).toBe(true)
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [replacement])).toBe(false)
    const view = buildHostOpsViews({ hosts: [host], komariSources: [current], probeSnapshots: [replacement], komariAlertStates: [lifecycle], audits: [audit], now: now + 3000 })[host.id]
    expect(view.komariAlerts).toEqual([])
    expect(view.audits).toEqual([audit])
    expect(JSON.stringify({ current, lifecycle, replacement })).toBe(original)
  })

  it('accepts a newly observed replacement-source failure only after its real sync commits, including later cache reconciliation', () => {
    const current = source()
    const lifecycle = alertState()
    const oldEndpoint = current.integration.endpoint
    current.integration.endpoint = 'https://replacement.test'
    current.integration.updatedAt = now + 1000
    const failed: ProbeSnapshot = {
      ...snapshot(), provider: { ...snapshot().provider, endpoint: current.integration.endpoint }, receivedAt: now + 2000,
      metrics: null, health: 'offline', errors: [{ section: 'provider', code: 'unavailable', message: 'Monitoring unavailable' }],
    }
    // The sync completes after collection. No healthy sample for B exists,
    // and A's historical baseline must remain in the same durable journal.
    lifecycle.alerts[0].lastSeenAt = now + 3000
    current.state!.syncState = {
      integrationId: 'komari-a', lastSyncedAt: now + 3000, lastSuccessfulSyncAt: null, ttlMs: 60_000, updatedAt: now + 3000,
      alertSummary: { ...lifecycle, probeBaselines: [{ integrationId: 'komari-a', endpoint: oldEndpoint, nodeId: 'node-a', hostId: host.id, lastHealthySampledAt: now - 100 }] },
    }
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(false)
    current.state!.syncState.lastSuccessfulSyncAt = now
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(false)
    current.state!.syncState.lastSuccessfulSyncAt = now + 3000
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(true)
    lifecycle.alerts[0].lastSeenAt = now + 4000
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(true)
    current.state!.mappings = []
    current.mappingRevision = 2
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(false)
  })

  it('keeps a replacement-source incident visible after a later rename when an older endpoint baseline is retained', () => {
    const current = source()
    const lifecycle = alertState()
    const oldEndpoint = current.integration.endpoint
    current.integration.endpoint = 'https://replacement.test'
    current.integration.name = 'Renamed replacement'
    current.integration.updatedAt = now + 4000
    lifecycle.alerts[0].lastSeenAt = now + 3000
    const failed: ProbeSnapshot = {
      ...snapshot(), provider: { ...snapshot().provider, endpoint: current.integration.endpoint }, receivedAt: now + 2000,
      metrics: null, health: 'offline', errors: [{ section: 'provider', code: 'unavailable', message: 'Monitoring unavailable' }],
    }
    current.state!.syncState = {
      integrationId: 'komari-a', lastSyncedAt: now + 3000, lastSuccessfulSyncAt: now + 3000, ttlMs: 60_000, updatedAt: now + 3000,
      alertSummary: { ...lifecycle, probeBaselines: [{ integrationId: 'komari-a', endpoint: oldEndpoint, nodeId: 'node-a', hostId: host.id, lastHealthySampledAt: now - 100 }] },
    }
    expect(isCurrentKomariAlert(lifecycle.alerts[0], host, [current], [failed])).toBe(true)
  })

  it('requires matching baseline endpoint, node and host plus a current mapping when no latest snapshot remains', () => {
    const current = source()
    const lifecycle = alertState()
    const alert = lifecycle.alerts[0]
    const baseline = { integrationId: alert.integrationId, endpoint: current.integration.endpoint, nodeId: alert.nodeId!, hostId: host.id, lastHealthySampledAt: now - 100 }
    const setBaseline = (value: typeof baseline) => {
      current.state!.syncState = { integrationId: current.integration.id, lastSyncedAt: now, ttlMs: 60_000, updatedAt: now,
        alertSummary: { ...lifecycle, probeBaselines: [value] } }
    }
    current.integration.updatedAt = now + 1
    setBaseline(baseline)
    expect(isCurrentKomariAlert(alert, host, [current], [])).toBe(true)
    for (const field of ['endpoint', 'integrationId', 'nodeId', 'hostId'] as const) {
      setBaseline({ ...baseline, [field]: 'another-scope' })
      expect(isCurrentKomariAlert(alert, host, [current], [])).toBe(false)
    }
    setBaseline(baseline)
    current.state!.mappings = []
    current.mappingRevision = 2
    expect(isCurrentKomariAlert(alert, host, [current], [])).toBe(false)
  })

  it('loads authoritative empty revision even when the legacy cache still contains a mapping', async () => {
    const current = source()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_mappings') return current.state!.mappings
      if (command === 'get_komari_mapping_state') return { revision: 3, mappings: [] }
      if (command === 'get_komari_sync_state') return null
      return []
    })
    const loaded = await loadCurrentKomariSource(current.integration)
    expect(loaded).toMatchObject({ mappingRevision: 3, error: false, state: { mappings: [] } })
    expect(isCurrentKomariSnapshot(snapshot(), host, [loaded])).toBe(false)
    expect(invoke).toHaveBeenCalledWith('get_komari_mapping_state', { vaultId: 'vault-a', integrationId: 'komari-a' })
  })

  it('host persistence loading cannot resurrect detached canonical rows or cross-vault envelopes', async () => {
    const current = source()
    const stored = row()
    let revision = 2
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [current.integration]
      if (command === 'list_probe_snapshots') return [stored]
      if (command === 'get_komari_mapping_state') return { revision, mappings: [] }
      if (command === 'get_komari_sync_state') return null
      return []
    })
    expect((await loadHostOpsViews([host], { vaultId: host.vaultId, now }))[host.id].metrics).toBeNull()
    revision = 0
    expect((await loadHostOpsViews([host], { vaultId: host.vaultId, now }))[host.id].metrics?.cpuPercent).toBe(70)
    stored.vaultId = 'vault-b'
    expect((await loadHostOpsViews([host], { vaultId: host.vaultId, now }))[host.id].metrics).toBeNull()
    expect(vi.mocked(invoke).mock.calls.every(([command]) => /^(list_|get_|operation_audit_list)/.test(command))).toBe(true)
  })

  it('accepts a just-committed sync projection but rejects that same in-memory result after a mapping edit', async () => {
    const current = source()
    let mapping = { revision: 1, mappings: current.state!.mappings }
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [current.integration]
      if (command === 'get_komari_mapping_state') return mapping
      if (command === 'get_komari_sync_state') return null
      return []
    })
    // The dashboard awaits the transactional sync before calling the loader.
    // Dedicated snapshots can already be in memory before a canonical reread.
    const options = { vaultId: host.vaultId, now, komariSnapshots: [snapshot()], komariAlertStates: [alertState()] }
    const synced = (await loadHostOpsViews([host], options))[host.id]
    expect(synced.metrics?.cpuPercent).toBe(70)
    expect(synced.alertOpenCount).toBe(1)
    mapping = { revision: 2, mappings: [] }
    const detached = (await loadHostOpsViews([host], options))[host.id]
    expect(detached.metrics).toBeNull()
    expect(detached.komariAlerts).toEqual([])
    expect(detached.health.provider).toBe('unknown')
  })

  it('empty/unknown projections do not advertise optional Ops, while real samples and failed collections do', () => {
    const empty = buildHostOpsViews({ hosts: [host], now })[host.id]
    expect(hasHostOpsEvidence(null)).toBe(false)
    expect(hasHostOpsEvidence(empty)).toBe(false)
    expect(hasHostOpsEvidence({ ...empty, localAlertEvaluations: [{ ruleId: 'rule', section: 'metrics', state: 'unknown', sampledAt: null }] })).toBe(false)
    expect(hasHostOpsEvidence({ ...empty, health: { ...empty.health, probe: { state: 'unknown', providerKind: 'komari', providerId: 'pending', persisted: true, sampledAt: null, receivedAt: now } } })).toBe(false)
    expect(hasHostOpsEvidence({ ...empty, health: { ...empty.health, agent: { status: 'not-installed', health: 'unknown', capabilities: [], lastCheckedAt: now } } })).toBe(false)
    expect(hasHostOpsEvidence({ ...empty, metrics: sshMonitor().snapshot })).toBe(true)
    expect(hasHostOpsEvidence({ ...empty, health: { ...empty.health, state: 'offline', error: 'Collection failed' } })).toBe(true)
  })
})
