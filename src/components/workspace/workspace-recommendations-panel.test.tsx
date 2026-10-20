import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from '@/lib/hosts'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import { getServerMonitorHostKey } from '@/lib/server-monitor'
import { clearServerMonitorStates, createServerMonitorLatest, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import { clearWorkspaceInventoryStates, mergeWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey, type WorkspaceInventory } from '@/lib/workspace-inventory'
import { createProbeObservation, type ProbeSnapshot } from '@/lib/probe-provider'
import { toPersistedProbeSnapshotPayload, type PersistedProbeSnapshotRecord } from '@/lib/probe-persistence'
import { clearLocalOpsMemory, saveLocalAlertState } from '@/lib/local-ops-store'
import { COLLECTION_LIMITS } from '@/lib/collection-limits'
import { WorkspaceRecommendationsPanel } from './workspace-recommendations-panel'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const host: HostProfile = {
  id: 'same-host', vaultId: 'vault-a', name: 'API', address: '127.0.0.1', port: 2201,
  username: 'ops', authType: 'privateKey', privateKeyRef: 'fixture-target',
  group: 'Fixture', tags: [], createdAt: 1, updatedAt: 1,
}
const baseMetrics: ServerMonitorSnapshot = {
  hostname: 'api', os: 'Linux', kernel: '6', uptimeSeconds: 30,
  cpuPercent: 10, load1: null, load5: null, load15: null,
  memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: 20,
  diskUsedBytes: null, diskTotalBytes: null, diskPercent: 30,
  networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null, sampledAt: 1,
}
let persistedRows: PersistedProbeSnapshotRecord[]

function komariRow(options: { vaultId?: string; sampledAt?: number; ttlMs?: number; metrics?: Partial<ServerMonitorSnapshot>; health?: ProbeSnapshot['health'] } = {}): PersistedProbeSnapshotRecord {
  const sampledAt = options.sampledAt ?? Date.now()
  const source = { kind: 'komari' as const, id: 'komari-fixture', nodeId: 'node-a', endpoint: 'https://komari.example', capabilities: ['metrics' as const] }
  const snapshot: ProbeSnapshot = {
    schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username },
    provider: { ...source, capabilities: [...source.capabilities] }, transport: 'direct',
    health: options.health ?? 'online', receivedAt: Date.now(), inventory: null, errors: [],
    metrics: createProbeObservation({ source: { ...source, capabilities: [...source.capabilities] }, data: { ...baseMetrics, ...options.metrics, sampledAt }, sampledAt, receivedAt: Date.now(), ttlMs: options.ttlMs ?? 120_000, confidence: 'partial' }),
  }
  return toPersistedProbeSnapshotPayload(snapshot, options.vaultId ?? host.vaultId!) as PersistedProbeSnapshotRecord
}

function saveAlert(vaultId: string) {
  saveLocalAlertState(vaultId, host.id, {
    version: 1, evaluations: [], audit: [], alerts: [{
      ruleId: 'cpu', hostId: host.id, name: 'CPU', metric: 'cpu', status: 'active', severity: 'warning',
      openedAt: Date.now(), updatedAt: Date.now(), resolvedAt: null, value: 95, source: 'komari', transport: 'direct',
    }],
  })
}

async function mount(options: { currentHost?: HostProfile | null; vaultId?: string } = {}) {
  const currentHost = options.currentHost === undefined ? host : options.currentHost
  const onSelectApp = vi.fn()
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(<WorkspaceRecommendationsPanel host={currentHost} hosts={currentHost ? [currentHost] : []} vaultId={options.vaultId ?? currentHost?.vaultId} onSelectApp={onSelectApp} />)
  })
  return { ...result!, onSelectApp }
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  localStorage.clear()
  clearLocalOpsMemory()
  clearServerMonitorStates()
  clearWorkspaceInventoryStates()
  persistedRows = []
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'list_probe_snapshots') {
      const query = (args as { query: { vaultId: string; hostId?: string } }).query
      return persistedRows.filter((row) => row.vaultId === query.vaultId && (!query.hostId || row.hostId === query.hostId))
    }
    if (command === 'list_komari_integrations') return [{ id: 'komari-fixture', vaultId: (args as { vaultId: string }).vaultId, name: 'Fixture', endpoint: 'https://komari.example', credentialRef: 'komari.fixture', enabled: true, createdAt: 1, updatedAt: 1 }]
    if (command === 'list_komari_mappings') return [{ integrationId: 'komari-fixture', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: 1 }]
    if (command === 'get_komari_mapping_state') return { revision: 1, mappings: [{ integrationId: 'komari-fixture', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: 1 }] }
    if (command === 'get_komari_sync_state') return null
    if (['list_shellbeam_agents', 'list_server_monitor_latest', 'list_workspace_inventory_snapshots', 'list_workspace_inventory_host_states', 'operation_audit_list', 'list_komari_snapshots', 'local_ops_list'].includes(command)) return []
    throw new Error(`Unexpected native read: ${command}`)
  })
})
afterEach(() => { vi.useRealTimers() })

describe('Workspace recommendations from the selected Provider', () => {
  it('uses a Komari-only observation for resource recommendations and opens the matching app', async () => {
    persistedRows = [komariRow({ metrics: { cpuPercent: 94, diskPercent: 97 } })]
    const { onSelectApp } = await mount()
    expect(await screen.findByText('Inspect CPU or memory pressure')).toBeInTheDocument()
    expect(screen.getByText('Disk is getting full')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open file system' }))
    expect(onSelectApp).toHaveBeenCalledWith('fileSystem')
  })

  it('does not reuse failed SSH pressure or suggest connection repair while Komari is healthy', async () => {
    const now = Date.now()
    mergeServerMonitorStates({ [getServerMonitorHostKey(host)]: { history: [], latest: createServerMonitorLatest(host, 'offline', now, undefined, { snapshot: { ...baseMetrics, sampledAt: now, cpuPercent: 99, diskPercent: 99 }, error: 'SSH target unavailable' }) } })
    persistedRows = [komariRow()]
    await mount()
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_probe_snapshots', expect.objectContaining({ query: expect.objectContaining({ vaultId: 'vault-a' }) })))
    expect(screen.queryByText('Inspect CPU or memory pressure')).not.toBeInTheDocument()
    expect(screen.queryByText('Disk is getting full')).not.toBeInTheDocument()
    expect(screen.queryByText('Inspect the failed host connection in Terminal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-recommendations')).not.toBeInTheDocument()
  })

  it('expires resource suggestions when the original Komari TTL passes without new samples', async () => {
    vi.useFakeTimers()
    persistedRows = [komariRow({ ttlMs: 500, metrics: { cpuPercent: 94, diskPercent: 97 } })]
    await mount()
    expect(screen.getByText('Inspect CPU or memory pressure')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(screen.queryByText('Inspect CPU or memory pressure')).not.toBeInTheDocument()
    expect(screen.queryByText('Disk is getting full')).not.toBeInTheDocument()
  })

  it.each(['unknown', 'offline', 'paused'] as const)('does not interpret %s observations with retained values as a current resource diagnosis', async (health) => {
    persistedRows = [komariRow({ health, metrics: { cpuPercent: 99, diskPercent: 99 } })]
    await mount()
    expect(screen.queryByText('Inspect CPU or memory pressure')).not.toBeInTheDocument()
    expect(screen.queryByText('Disk is getting full')).not.toBeInTheDocument()
  })

  it('uses an observed partial CPU metric without fabricating a missing disk value', async () => {
    persistedRows = [komariRow({ metrics: { cpuPercent: 94, diskPercent: null, memoryPercent: null } })]
    await mount()
    expect(await screen.findByText('Inspect CPU or memory pressure')).toBeInTheDocument()
    expect(screen.queryByText('Disk is getting full')).not.toBeInTheDocument()
  })

  it('keeps fresh service inventory and scoped local alerts independent of expired metrics', async () => {
    const now = Date.now()
    persistedRows = [komariRow({ sampledAt: now - 2_000, ttlMs: 500, metrics: { cpuPercent: 99, diskPercent: 99 } })]
    const inventory: WorkspaceInventory = {
      resource: { hostname: 'api', os: 'Linux', kernel: '6', uptime: '30s', cpuPercent: 20, memoryPercent: 30, memoryText: '30M/100M', diskPercent: 40, diskText: '40M/100M', network: 'unknown' },
      tools: [], services: [{ name: 'fixture.service', active: 'failed', enabled: 'disabled' }],
      containers: [], pm2: [], projects: [], scannedAt: now,
    }
    mergeWorkspaceInventoryStates({ [getWorkspaceInventoryHostKey(host)]: { status: 'ready', inventory, updatedAt: now } })
    saveAlert('vault-a')
    await mount()
    expect(screen.getByText('Inspect failed services')).toBeInTheDocument()
    expect(screen.getByText('Investigate active host alerts in logs')).toBeInTheDocument()
    expect(screen.queryByText('Inspect CPU or memory pressure')).not.toBeInTheDocument()
    expect(screen.queryByText('Disk is getting full')).not.toBeInTheDocument()
    act(() => { mergeWorkspaceInventoryStates({ [getWorkspaceInventoryHostKey(host)]: { status: 'ready', inventory: { ...inventory, scannedAt: now - COLLECTION_LIMITS.cadence.inventoryTtlMs - 1 }, updatedAt: now } }) })
    expect(screen.queryByText('Inspect failed services')).not.toBeInTheDocument()
    expect(screen.getByText('Investigate active host alerts in logs')).toBeInTheDocument()
  })

  it('shows no host observations or alerts for a null host or a conflicting Vault', async () => {
    persistedRows = [komariRow({ metrics: { cpuPercent: 99, diskPercent: 99 } })]
    saveAlert('vault-a')
    const { rerender } = await mount({ currentHost: null, vaultId: 'vault-a' })
    expect(screen.queryByTestId('workspace-recommendations')).not.toBeInTheDocument()
    await act(async () => { rerender(<WorkspaceRecommendationsPanel host={host} hosts={[host]} vaultId="vault-b" onSelectApp={() => {}} />) })
    expect(screen.queryByTestId('workspace-recommendations')).not.toBeInTheDocument()
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('list_probe_snapshots', expect.anything())
  })

  it('rejects a late previous-Vault observation for the same host ID after switching scope', async () => {
    const old = komariRow({ metrics: { cpuPercent: 99, diskPercent: 99 } })
    let resolveOld!: (rows: PersistedProbeSnapshotRecord[]) => void
    const previous = new Promise<PersistedProbeSnapshotRecord[]>((resolve) => { resolveOld = resolve })
    const read = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) => command === 'list_probe_snapshots' && (args as { query: { vaultId: string } }).query.vaultId === 'vault-a' ? previous : read(command, args))
    saveAlert('vault-a')
    const current = { ...host, vaultId: 'vault-b' }
    persistedRows = [komariRow({ vaultId: 'vault-b' })]
    const { rerender } = await mount()
    expect(screen.getByText('Investigate active host alerts in logs')).toBeInTheDocument()
    await act(async () => { rerender(<WorkspaceRecommendationsPanel host={current} hosts={[current]} vaultId="vault-b" onSelectApp={() => {}} />) })
    await act(async () => { resolveOld([old]); await previous })
    expect(screen.queryByTestId('workspace-recommendations')).not.toBeInTheDocument()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_probe_snapshots', expect.objectContaining({ query: expect.objectContaining({ vaultId: 'vault-b' }) }))
  })
})
