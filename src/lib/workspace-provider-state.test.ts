import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { buildWorkspaceProviderState, useWorkspaceProviderState, WORKSPACE_PROVIDER_POLL_MS, type WorkspaceProviderData, type WorkspaceKomariState } from './workspace-provider-state'
import { createProbeObservation, type ProbeSnapshot, type ProbeProviderKind, type ProbeProviderTelemetry } from './probe-provider'
import type { HostProfile } from './hosts'
import type { PersistedProbeSnapshotRecord } from './probe-persistence'
import { getServerMonitorHostKey, type ServerMonitorLatest, type ServerMonitorSnapshot } from './server-monitor'
import { clearServerMonitorStates, mergeServerMonitorStates } from './server-monitor-state'
import { clearWorkspaceInventoryStates } from './workspace-inventory-state'
import { KOMARI_MAPPING_CHANGED_EVENT } from './komari-persistence'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host: HostProfile = { id: 'host-1', vaultId: 'vault-a', name: 'App', address: '10.0.0.5', port: 22, username: 'ops', group: 'Default', authType: 'password', tags: [], createdAt: 1, updatedAt: 1 }
const now = 100_000
const metrics: ServerMonitorSnapshot = { hostname: 'app', os: 'Linux', kernel: '6', uptimeSeconds: 100, cpuPercent: 95, load1: 1, load5: 1, load15: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, memoryPercent: 50, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null, sampledAt: now }
const telemetry = (status: ProbeProviderTelemetry['status']): ProbeProviderTelemetry => ({ status, startedAt: now, completedAt: now, durationMs: 0, attempts: 0, maxRetries: 2, retryDelayMs: 100, recovered: status === 'recovered', exhausted: status === 'failed', sections: ['metrics'] })
function probe(kind: ProbeProviderKind = 'komari', sampledAt = now, ttlMs = 10_000): ProbeSnapshot {
  const provider = { kind, id: kind === 'komari' ? 'integration-a' : kind, ...(kind === 'komari' ? { nodeId: 'node-a', endpoint: 'https://example.test' } : {}), capabilities: ['metrics' as const] }
  return { schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username }, provider, transport: 'direct', health: 'online', receivedAt: sampledAt, metrics: createProbeObservation({ data: { ...metrics, sampledAt }, source: provider, sampledAt, receivedAt: sampledAt, ttlMs, confidence: kind === 'komari' ? 'partial' : 'observed' }), inventory: null, errors: [] }
}
function row(snapshot: ProbeSnapshot, vaultId = host.vaultId!): PersistedProbeSnapshotRecord {
  return { vaultId, hostId: snapshot.host.hostId, providerKind: snapshot.provider.kind, providerId: snapshot.provider.id, snapshot, sampledAt: snapshot.metrics?.freshness.sampledAt ?? snapshot.receivedAt, receivedAt: snapshot.receivedAt, expiresAt: snapshot.metrics?.freshness.expiresAt ?? snapshot.receivedAt, updatedAt: snapshot.receivedAt }
}
function komari(): WorkspaceKomariState {
  return { integration: { id: 'integration-a', vaultId: 'vault-a', name: 'Komari', endpoint: 'https://example.test', credentialRef: 'secret', enabled: true, createdAt: 1, updatedAt: 1 }, state: { snapshots: [], mappings: [], syncState: { integrationId: 'integration-a', lastSyncedAt: now - 50, lastSuccessfulSyncAt: now - 50, ttlMs: 60_000, alertSummary: null, updatedAt: now }, lastSyncedAt: now - 50 }, mappingRevision: 0, error: false }
}
function data(rows: PersistedProbeSnapshotRecord[] = []): WorkspaceProviderData {
  return { rows, komari: [komari()], monitors: [], inventoryCache: {}, inventoryStates: {}, agents: [] }
}
function monitor(status: ServerMonitorLatest['status'] = 'online', sampledAt = now): ServerMonitorLatest {
  return { hostKey: getServerMonitorHostKey(host), hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, status, snapshot: { ...metrics, cpuPercent: 12, sampledAt }, lastAttemptAt: sampledAt, lastSuccessAt: sampledAt, updatedAt: sampledAt, probeTelemetry: telemetry(status === 'online' ? 'success' : 'failed') }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

beforeEach(() => { vi.clearAllMocks(); clearServerMonitorStates(); clearWorkspaceInventoryStates() })
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })

describe('Workspace provider projection', () => {
  it('restores canonical-only Komari with source metadata and no SSH telemetry', () => {
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(probe())]), runtimeMonitor: monitor('offline'), now })
    expect(result.view?.metrics?.cpuPercent).toBe(95)
    expect(result.view?.health).toMatchObject({ provider: 'komari', state: 'online', fallbackProvider: 'ssh-agentless' })
    expect(result.source).toMatchObject({ kind: 'komari', id: 'integration-a', nodeId: 'node-a', health: 'online', confidence: 'partial', sampledAt: now, receivedAt: now, lastSyncedAt: now - 50, ttlMs: 10_000, expiresAt: now + 10_000, capabilities: ['metrics'] })
    expect(result.telemetry).toBeNull()
    expect(result.view?.metrics?.diskPercent).toBeNull()
  })

  it('keeps Komari own sync/TTL visible after falling back to a newer SSH sample', () => {
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(probe('komari', now - 1000, 200))]), runtimeMonitor: monitor(), now })
    expect(result.view?.metrics?.cpuPercent).toBe(12)
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', fallbackProvider: 'komari', health: 'online' })
    expect(result.sources.find((source) => source.kind === 'komari')).toMatchObject({ health: 'stale', sampledAt: now - 1000, lastSyncedAt: now - 50, expiresAt: now - 800 })
    expect(result.telemetry?.status).toBe('success')
  })

  it.each(['offline', 'unknown'] as const)('does not mark a %s provider online from retained unexpired metrics', (health) => {
    const snapshot = { ...probe(), health }
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(snapshot)]), now })
    expect(result.view?.health.state).not.toBe('online')
    expect(result.source?.health).not.toBe('online')
  })

  it('prefers another healthy provider over a newer failed row and stale SSH cache', () => {
    const failed = { ...probe('komari'), telemetry: telemetry('failed'), receivedAt: now + 1 }
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(failed), row(probe('shellbeam-agent', now - 100, 5000))]), runtimeMonitor: monitor('offline'), now: now + 1 })
    expect(result.source?.kind).toBe('shellbeam-agent')
    expect(result.view?.health.state).toBe('online')
    expect(result.sources.find((source) => source.kind === 'komari')).toMatchObject({ health: 'offline', syncError: false })
  })

  it('does not infer sync time from a mapping update or return invalid samples as zero', () => {
    const current = data([row(probe('komari', now + 1))])
    current.komari[0].state!.syncState = null
    current.komari[0].state!.lastSyncedAt = now // legacy derived cache metadata is not a successful sync
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, now })
    expect(result.source).toMatchObject({ health: 'unknown', sampledAt: null, expiresAt: null, lastSyncedAt: null })
    expect(result.view?.metrics).toBeNull()
  })

  it('keeps legacy alert-created sync times unknown without changing valid metric sampling or TTL', () => {
    const current = data([row(probe())])
    current.komari[0].state!.syncState!.lastSuccessfulSyncAt = undefined
    current.komari[0].state!.syncState!.lastSyncedAt = now
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, now })
    expect(result.source).toMatchObject({ health: 'online', sampledAt: now, lastSyncedAt: null, ttlMs: 10_000, expiresAt: now + 10_000 })
    expect(result.view?.metrics?.sampledAt).toBe(now)
    current.komari[0].state!.syncState!.lastSuccessfulSyncAt = now - 50
    current.komari[0].integration.updatedAt = now - 25
    expect(buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, now }).source?.lastSyncedAt).toBeNull()
  })

  it('uses the durable expiry and ignores foreign Vault rows, integration config and reassigned nodes', () => {
    const current = data([row(probe(), 'other-vault'), { ...row(probe('komari', now - 1000, 10_000)), expiresAt: now - 1 }])
    let result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, now })
    expect(result.source?.health).toBe('stale')
    current.komari[0].state!.mappings = [{ integrationId: 'integration-a', hostId: 'other-host', nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: now }]
    result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, now })
    expect(result.source).toBeNull()
    expect(result.view?.metrics).toBeNull()
    expect(buildWorkspaceProviderState({ host, vaultId: 'vault-b', data: current, now }).view).toBeNull()
  })

  it.each(['ssh-agentless', 'shellbeam-agent'] as const)('keeps actual SSH metric provenance when a newer %s inventory-only row exists', (kind) => {
    const inventoryOnly = probe(kind, now + 1000)
    inventoryOnly.inventory = createProbeObservation({ data: { resource: { hostname: 'new-inventory', os: 'Linux', kernel: '6', uptime: '', cpuPercent: 99, memoryPercent: 99, memoryText: '', diskPercent: 99, diskText: '', network: '' }, tools: [], services: [], containers: [], pm2: [], projects: [], scannedAt: now + 1000 }, source: inventoryOnly.provider, sampledAt: now + 1000, receivedAt: now + 1000, ttlMs: 5000 })
    inventoryOnly.metrics = null
    inventoryOnly.telemetry = { ...telemetry('success'), sections: ['inventory'] }
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(inventoryOnly)]), runtimeMonitor: monitor(), now: now + 2000 })
    expect(result.view?.health.provider).toBe('ssh-agentless')
    expect(result.view?.metrics?.sampledAt).toBe(now)
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', sampledAt: now, receivedAt: null, ttlMs: 120_000, capabilities: ['metrics'] })
    expect(result.telemetry?.sections).toEqual(['metrics'])
  })

  it.each([false, true])('ignores inventory-only SSH failure when current SSH metrics remain valid (agent fallback: %s)', (withAgent) => {
    const inventoryFailure: ProbeSnapshot = { ...probe('ssh-agentless', now + 1000), metrics: null, inventory: null, health: 'offline',
      errors: [{ section: 'inventory', message: 'inventory collector failed' }], telemetry: { ...telemetry('failed'), sections: ['inventory'] } }
    const rows = [row(inventoryFailure), ...(withAgent ? [row(probe('shellbeam-agent', now + 500))] : [])]
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data(rows), runtimeMonitor: monitor(), now: now + 2000 })
    expect(result.view?.health).toMatchObject({ state: 'online', provider: 'ssh-agentless' })
    expect(result.view?.metrics).toMatchObject({ cpuPercent: 12, sampledAt: now })
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', health: 'online', sampledAt: now, receivedAt: null, capabilities: ['metrics'] })
    expect(result.telemetry).toMatchObject({ status: 'success', sections: ['metrics'] })
    expect(result.view?.health.probe).toMatchObject({ providerKind: 'ssh-agentless', state: 'fresh', telemetry: { status: 'success', sections: ['metrics'] } })
    expect(result.view?.health.error).toBeUndefined()
  })

  it('keeps SSH metrics selected when a healthy agent supplies both metrics and inventory', () => {
    const agent = probe('shellbeam-agent', now + 1000)
    agent.inventory = createProbeObservation({ data: { resource: { hostname: 'agent-inventory', os: 'Linux', kernel: '6', uptime: '', cpuPercent: 99, memoryPercent: 99, memoryText: '', diskPercent: 99, diskText: '', network: '' }, tools: [], services: [], containers: [], pm2: [], projects: [], scannedAt: now + 1000 }, source: agent.provider, sampledAt: now + 1000, receivedAt: now + 1000, ttlMs: 5000 })
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(agent)]), runtimeMonitor: monitor(), now: now + 2000 })
    expect(result.view?.metrics).toMatchObject({ cpuPercent: 12, sampledAt: now })
    expect(result.view?.inventory?.resource.hostname).toBe('agent-inventory')
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', sampledAt: now, capabilities: ['metrics'] })
    expect(result.telemetry?.sections).toEqual(['metrics'])
  })

  it('rejects a stale non-Komari route while keeping a manual Komari binding after address changes', () => {
    const jump = { ...host, id: 'jump', address: 'bastion-new', port: 2222, username: 'jump' }
    const target = { ...host, jumpHostId: jump.id }
    const wrongRoute = { ...probe('shellbeam-agent'), transport: 'proxy-jump' as const, host: { ...probe().host, jump: { hostId: jump.id, address: 'bastion-old', port: 22, username: 'jump' } } }
    const correctRoute = { ...wrongRoute, host: { ...wrongRoute.host, jump: { hostId: jump.id, address: jump.address, port: jump.port, username: jump.username } } }
    expect(buildWorkspaceProviderState({ host: target, hosts: [target, jump], vaultId: 'vault-a', data: data([row(wrongRoute)]), now }).view?.metrics).toBeNull()
    expect(buildWorkspaceProviderState({ host: target, hosts: [target, jump], vaultId: 'vault-a', data: data([row(correctRoute)]), now }).source?.kind).toBe('shellbeam-agent')
    const mixedFleet = [{ ...jump, vaultId: 'vault-b', address: 'foreign-bastion' }, { ...target, vaultId: 'vault-b', address: 'foreign-target' }, { ...host, id: 'unrelated-host' }, target, jump]
    const scoped = buildWorkspaceProviderState({ host: target, hosts: mixedFleet, vaultId: 'vault-a', data: data([row(correctRoute)]), now })
    expect(scoped.source?.kind).toBe('shellbeam-agent')
    expect(scoped.view?.route).toMatchObject({ transport: 'proxy-jump', jumpHost: jump.address, jumpPort: jump.port, jumpUser: jump.username })
    expect(buildWorkspaceProviderState({ host: target, hosts: [target], vaultId: 'vault-a', data: data([row(correctRoute)]), now }).view?.metrics).toBeNull()
    const changedAddress = { ...host, address: '10.0.0.99' }
    expect(buildWorkspaceProviderState({ host: changedAddress, vaultId: 'vault-a', data: data([row(probe())]), now }).source?.kind).toBe('komari')
  })

  it('keeps a mapped but unavailable Komari node visible as an unknown SSH fallback', () => {
    const current = data()
    current.komari[0].state!.mappings = [{ integrationId: 'integration-a', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: now }]
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, runtimeMonitor: monitor(), now })
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', fallbackProvider: 'komari' })
    expect(result.sources.find((source) => source.kind === 'komari')).toMatchObject({ health: 'unknown', sampledAt: null, lastSyncedAt: now - 50, capabilities: [] })
  })

  it.each([false, true])('keeps an authoritative unsampled mapping visible after a rename (SSH available: %s)', (withSsh) => {
    const current = data()
    const entry = current.komari[0]
    entry.mappingRevision = 1
    entry.state!.mappings = [{ integrationId: 'integration-a', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: now - 1000 }]
    entry.integration.name = 'Renamed server'
    entry.integration.updatedAt = now - 25
    const original = JSON.stringify(current)
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, runtimeMonitor: withSsh ? monitor() : undefined, now })
    expect(result.sources.find(source => source.kind === 'komari')).toMatchObject({
      id: 'integration-a', nodeId: 'node-a', health: 'unknown', sampledAt: null, lastSyncedAt: null,
    })
    if (withSsh) {
      expect(result.source).toMatchObject({ kind: 'ssh-agentless', health: 'online', fallbackProvider: 'komari' })
      expect(result.view?.metrics?.cpuPercent).toBe(12)
    } else {
      expect(result.view?.metrics).toBeNull()
      expect(result.view?.health.state).toBe('unknown')
    }
    expect(JSON.stringify(current)).toBe(original)
  })

  it('distinguishes first report from interruption using the same endpoint, integration, node and host baseline', () => {
    const snapshot: ProbeSnapshot = { ...probe(), provider: { ...probe().provider, endpoint: 'https://example.test' }, metrics: null, health: 'unknown', errors: [{ section: 'metrics', code: 'empty', message: 'Komari returned no dated metric observations' }] }
    const current = data([row(snapshot)])
    const project = () => buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: current, runtimeMonitor: monitor(), now })
    let result = project()
    expect(result.source).toMatchObject({ kind: 'ssh-agentless', health: 'online' })
    expect(result.sources.find((source) => source.kind === 'komari')).toMatchObject({ health: 'unknown', waitingForFirstReport: true, sampledAt: null })
    const baseline = { integrationId: 'integration-a', endpoint: 'https://example.test', nodeId: 'node-a', hostId: host.id, lastHealthySampledAt: now - 1000 }
    const setBaseline = (value: typeof baseline) => { current.komari[0].state!.syncState!.alertSummary = { schemaVersion: 1, alerts: [], audit: [], probeBaselines: [value] } }
    setBaseline(baseline)
    expect(project().sources.find((source) => source.kind === 'komari')?.waitingForFirstReport).toBe(false)
    for (const key of ['integrationId', 'endpoint', 'nodeId', 'hostId'] as const) {
      setBaseline({ ...baseline, [key]: 'other-scope' })
      expect(project().sources.find((source) => source.kind === 'komari')?.waitingForFirstReport).toBe(true)
    }
    current.komari[0].integration.endpoint = 'https://replacement.test'
    result = project()
    expect(result.sources.some((source) => source.kind === 'komari')).toBe(false)
    expect(result.source?.kind).toBe('ssh-agentless')
  })

  it('does not turn an empty first report into an offline host without another source', () => {
    const snapshot: ProbeSnapshot = { ...probe(), provider: { ...probe().provider, endpoint: 'https://example.test' }, metrics: null, health: 'unknown', errors: [{ section: 'metrics', code: 'empty', message: 'Komari returned no dated metric observations' }] }
    const result = buildWorkspaceProviderState({ host, vaultId: 'vault-a', data: data([row(snapshot)]), now })
    expect(result.source).toMatchObject({ kind: 'komari', health: 'unknown', waitingForFirstReport: true })
    expect(result.view?.health.state).toBe('unknown')
  })
})

describe('useWorkspaceProviderState', () => {
  let currentData: WorkspaceProviderData
  beforeEach(() => {
    currentData = data([row(probe())])
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_probe_snapshots') return currentData.rows.filter((item) => item.vaultId === (args as { query: { vaultId: string } }).query.vaultId)
      if (command === 'list_komari_integrations') return currentData.komari.map((entry) => entry.integration)
      if (command === 'list_komari_snapshots') return currentData.komari[0]?.state?.snapshots ?? []
      if (command === 'list_komari_mappings') return currentData.komari[0]?.state?.mappings ?? []
      if (command === 'get_komari_mapping_state') return { mappings: currentData.komari[0]?.state?.mappings ?? [], revision: currentData.komari[0]?.mappingRevision ?? 0 }
      if (command === 'get_komari_sync_state') return currentData.komari[0]?.state?.syncState ?? null
      return []
    })
  })

  it('retains unscoped SSH behavior and recomputes TTL on the clock without native or remote calls', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const unscoped = { ...host, vaultId: undefined }
    const latest = { ...monitor(), hostKey: host.id }
    mergeServerMonitorStates({ [host.id]: { latest, history: [] } })
    const { result } = renderHook(() => useWorkspaceProviderState({ host: unscoped }))
    expect(result.current.view?.health.state).toBe('online')
    expect(invoke).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(121_000))
    expect(result.current.view?.health.state).toBe('stale')
    expect(result.current.source?.ttlMs).toBe(120_000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('drops a deferred old Vault result after switching to the same host id in another Vault', async () => {
    const old = deferred<PersistedProbeSnapshotRecord[]>()
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_probe_snapshots') return (args as { query: { vaultId: string } }).query.vaultId === 'vault-a' ? old.promise : [row(probe('shellbeam-agent'), 'vault-b')]
      return command === 'get_komari_sync_state' ? null : []
    })
    const { result, rerender } = renderHook(({ vaultId }) => useWorkspaceProviderState({ host: { ...host, vaultId }, vaultId }), { initialProps: { vaultId: 'vault-a' } })
    rerender({ vaultId: 'vault-b' })
    await waitFor(() => expect(result.current.source?.kind).toBe('shellbeam-agent'))
    await act(async () => { old.resolve([row(probe())]); await old.promise })
    expect(result.current.source?.kind).toBe('shellbeam-agent')
    expect(result.current.view?.host.vaultId).toBe('vault-b')
  })

  it('invalidates a rebound Komari node immediately and rejects an in-flight old read', async () => {
    const { result } = renderHook(() => useWorkspaceProviderState({ host, vaultId: 'vault-a' }))
    await waitFor(() => expect(result.current.source?.kind).toBe('komari'))
    const beforeEdit = deferred<PersistedProbeSnapshotRecord[]>()
    const afterEdit = deferred<PersistedProbeSnapshotRecord[]>()
    let reads = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_probe_snapshots') return ++reads === 1 ? beforeEdit.promise : afterEdit.promise
      if (command === 'list_komari_integrations') return [komari().integration]
      return command === 'get_komari_sync_state' ? null : []
    })
    let refresh!: Promise<void>
    act(() => { refresh = result.current.refresh() })
    act(() => { window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { vaultId: 'vault-a', integrationId: 'integration-a' } })) })
    expect(result.current.view?.metrics).toBeNull()
    expect(result.current.source).toBeNull()
    await act(async () => { beforeEdit.resolve([row(probe())]); await refresh })
    expect(result.current.view?.metrics).toBeNull()
    await act(async () => { afterEdit.resolve([]); await afterEdit.promise })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.source).toBeNull()
  })

  it('polls background-only failure updates and reacts to a vault-scoped history event', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const { result } = renderHook(() => useWorkspaceProviderState({ host, vaultId: 'vault-a' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.source?.health).toBe('online')
    currentData.rows = [row({ ...probe(), health: 'offline', telemetry: telemetry('failed') })]
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_PROVIDER_POLL_MS) })
    expect(result.current.source).toMatchObject({ health: 'offline', syncError: false })
    currentData.rows = [row(probe('shellbeam-agent', now + WORKSPACE_PROVIDER_POLL_MS, 100_000))]
    await act(async () => { window.dispatchEvent(new CustomEvent('provider-metric-history-changed', { detail: { vaultId: 'vault-a' } })); await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.source?.kind).toBe('shellbeam-agent')
  })

  it('rejects an active Vault conflict without issuing native reads', () => {
    const { result } = renderHook(() => useWorkspaceProviderState({ host, vaultId: 'vault-b' }))
    expect(result.current.view).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
})
