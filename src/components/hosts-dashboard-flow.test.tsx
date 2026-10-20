import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsDashboard } from './hosts-dashboard'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { ProbeSnapshot } from '@/lib/probe-provider'
import type { HostProfile } from '@/lib/hosts'
import type { KomariAlertRecord, KomariAlertState } from '@/lib/komari-alerts'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import * as komariSync from '@/lib/komari-sync'
import * as komariBridge from '@/lib/komari-probe-link'
import { KOMARI_MAPPING_CHANGED_EVENT, type KomariSyncState, type KomariSnapshotPayload } from '@/lib/komari-persistence'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []) }))
vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/host-ops-view', async (original) => ({ ...(await original<typeof import('@/lib/host-ops-view')>()), loadHostOpsViews: vi.fn() }))
const hosts: HostProfile[] = ['API host', 'DB host'].map((name, i) => ({ id: `host-${i}`, name, address: `10.0.0.${i + 1}`, port: 22, username: 'ops', authType: 'password', group: 'Production', tags: [], createdAt: 1, updatedAt: 1 }))
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string) => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : [])
  vi.mocked(runWorkspaceRemoteCommand).mockReset()
  const views = buildHostOpsViews({ hosts })
  const now = Date.now()
  views['host-0'] = { ...views['host-0'], health: { ...views['host-0'].health, state: 'online', provider: 'komari', freshness: { sampledAt: now, updatedAt: now, ageMs: 0, stale: false, ttlMs: 60_000 } }, resource: { hostname: 'api', os: 'Ubuntu', kernel: '', uptime: '', cpuPercent: 95, diskPercent: 90, memoryPercent: 50, memoryText: '', diskText: '', network: '' }, capabilities: ['docker', 'metrics'], highestAlertSeverity: 'critical', alertOpenCount: 1, localAlertOpen: 1 }
  views['host-1'] = { ...views['host-1'], health: { ...views['host-1'].health, state: 'stale', provider: 'ssh-agentless', freshness: { sampledAt: now - 600_000, updatedAt: now - 600_000, ageMs: 600_000, stale: true, ttlMs: 60_000 } }, resource: { hostname: 'db', os: 'Debian', kernel: '', uptime: '', cpuPercent: 10, diskPercent: null, memoryPercent: 20, memoryText: '', diskText: '', network: '' }, capabilities: ['services'], highestAlertSeverity: null, alertOpenCount: 0 }
  vi.mocked(loadHostOpsViews).mockReset().mockResolvedValue(views)
})
function dashboardElement(extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) { return <I18nProvider><HostsDashboard activeVaultId="vault" hosts={hosts} selectedHostId={null} loading={false} onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} {...extra} /></I18nProvider> }
function renderDashboard(extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) { return render(dashboardElement(extra)) }
function komariSnapshot(sampledAt: number, ttlMs = 60_000): ProbeSnapshot {
  const source = { kind: 'komari' as const, id: 'komari-a', nodeId: 'node-1', endpoint: 'https://komari.test', capabilities: ['metrics' as const] }
  const metrics: ServerMonitorSnapshot = { hostname: 'api', os: 'Linux', kernel: '', uptimeSeconds: 100, cpuPercent: 33, load1: null, load5: null, load15: null, memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null, sampledAt }
  return { schemaVersion: 1, host: { hostId: 'host-0', address: hosts[0].address, port: 22, username: 'ops' }, provider: source, health: 'online', transport: 'direct', receivedAt: sampledAt,
    metrics: { data: metrics, source, freshness: { sampledAt, receivedAt: sampledAt, ttlMs, expiresAt: sampledAt + ttlMs, expired: false, expiryReason: null }, confidence: 'partial' }, inventory: null, errors: [] }
}
describe('host operations filter workflow', () => {
  it('keeps integration setup and empty provider alerts out of the host dashboard', async () => {
    renderDashboard({ onOpenWorkspace: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
    expect(screen.queryByTestId('komari-mappings-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('komari-probe-mapping-notice')).not.toBeInTheDocument()
    expect(screen.queryByTestId('komari-alert-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Open operations for API host' })).toBeVisible()
  })

  it('shows one local incident count while retaining the distinct zero-valued server aggregate in source details', async () => {
    const now = Date.now()
    const snapshot = { ...komariSnapshot(now - 1000), alerts: { load: 0, offline: 0, total: 0, active: 0, updatedAt: now } }
    const metrics: KomariAlertRecord = { schemaVersion: 1, source: 'komari', alertId: 'metrics', fingerprint: 'komari-a|node-1|host-0|probe-error:metrics', integrationId: 'komari-a', nodeId: 'node-1', hostId: 'host-0', kind: 'probe-error:metrics', title: 'Komari Probe metrics error: Komari returned no dated metric observations', severity: 'warning', count: 1, status: 'active', firstSeenAt: now, lastSeenAt: now, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, closedAt: null, relatedOperationJobId: null, deduplicatedCount: 0 }
    const alertState: KomariAlertState = { schemaVersion: 1, audit: [], alerts: [
      metrics,
      { ...metrics, alertId: 'health', fingerprint: 'komari-a|node-1|host-0|probe-unknown', kind: 'probe-unknown', title: 'Komari Probe health is unknown' },
      { ...metrics, alertId: 'retry', fingerprint: 'komari-a|node-1|host-0|probe-error:provider', kind: 'probe-error:provider', severity: 'critical', title: 'Komari Probe provider error: Probe recovery failed after 3 retries: Komari returned no dated metric observations' },
    ], summary: { load: null, offline: null, total: 3, active: 3, open: 3, acknowledged: 0, resolved: 0, closed: 0, deduplicated: 0, localUpdatedAt: now, updatedAt: now } }
    vi.mocked(loadHostOpsViews).mockResolvedValue(buildHostOpsViews({ hosts, komariSnapshots: [snapshot], komariAlertStates: [alertState], now }))
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'get_komari_sync_state') return { integrationId: 'komari-a', lastSyncedAt: now, lastSuccessfulSyncAt: now, ttlMs: 60_000, alertSummary: alertState, updatedAt: now }
      if (command === 'list_komari_snapshots') return [{ updatedAt: now, snapshot }]
      if (command === 'list_komari_mappings') return [{ integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: now }]
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    renderDashboard({ vaultUnlocked: true, onLoadVaultSecret: vi.fn(async () => null) })
    const hostCard = screen.getAllByTestId('host-card').find((card) => card.getAttribute('data-host-id') === 'host-0')!
    const summary = await within(hostCard).findByTestId('host-ops-alert-summary')
    expect(summary).toBeVisible()
    expect(summary).toHaveAttribute('data-total', '1')
    expect(summary).toHaveAttribute('data-active', '1')
    expect(summary).toHaveAttribute('data-open', '1')
    expect(summary).toHaveTextContent(/Alerts\s*1/)
    fireEvent.click(within(hostCard).getByTestId('host-ops-details-toggle'))
    const incidentDetails = within(hostCard).getByTestId('host-ops-details-alert-summary')
    expect(incidentDetails).toBeVisible()
    expect(incidentDetails).toHaveTextContent(/Alerts\s*1\s*·\s*1 active/)
    const source = screen.getByTestId('komari-remote-alert-summary')
    expect(source).not.toBeVisible()
    fireEvent.click(within(hostCard).getByTestId('host-data-source-details').querySelector('summary')!)
    expect(source).toBeVisible()
    expect(source).toHaveTextContent('Server alert summary: 0/0')
  })

  it.each([true, false])('renders only a confirmed persisted Komari sync timestamp (sync state: %s)', async (hasSync) => {
    const syncedAt = Date.now() - 5000
    const sampleAt = syncedAt - 10000
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'get_komari_sync_state') return hasSync ? { integrationId: 'komari-a', lastSyncedAt: syncedAt, lastSuccessfulSyncAt: syncedAt, ttlMs: 60000, alertSummary: null, updatedAt: syncedAt } : null
      if (command === 'list_komari_snapshots') return [{ updatedAt: syncedAt, snapshot: { schemaVersion: 1, host: { hostId: 'host-0' }, provider: { kind: 'komari', id: 'komari-a', nodeId: 'node-1', endpoint: 'https://komari.test', capabilities: ['metrics'] }, health: 'online', receivedAt: sampleAt, metrics: null, inventory: null, errors: [] } }]
      if (command === 'list_komari_mappings') return [{ integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: syncedAt }]
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    renderDashboard({ vaultUnlocked: true, onLoadVaultSecret: vi.fn(async () => null) })
    const row = await screen.findByTestId('komari-host-last-sync')
    if (hasSync) expect(row.querySelector('time')).toHaveAttribute('datetime', new Date(syncedAt).toISOString())
    else { expect(row).toHaveTextContent('Unknown'); expect(row.querySelector('time')).toBeNull() }
  })

  it.each([false, true])('keeps missing successful-sync provenance unknown across two cache refreshes and an actual alert write (legacy state: %s)', async (hasLegacyState) => {
    const updatedAt = Date.now() - 1000
    const snapshot = komariSnapshot(updatedAt - 120_000)
    const before = JSON.stringify(snapshot)
    let syncState: KomariSyncState | null = hasLegacyState ? { integrationId: 'komari-a', lastSyncedAt: updatedAt, ttlMs: 60_000, alertSummary: null, updatedAt } : null
    const onLoadVaultSecret = vi.fn(async () => 'fixture-token')
    const http = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'))
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'get_komari_sync_state') return syncState
      if (command === 'list_komari_snapshots') return [{ updatedAt, snapshot }]
      if (command === 'list_komari_mappings') return [{ integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt }]
      if (command === 'upsert_komari_sync_state') {
        // Emulate the native generic upsert: lifecycle writes preserve nullable
        // provenance, even when their legacy TTL hint contains a cache timestamp.
        syncState = { ...(args as { payload: KomariSyncState }).payload, lastSuccessfulSyncAt: syncState?.lastSuccessfulSyncAt ?? null }
        return undefined
      }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    try {
      const view = renderDashboard({ vaultUnlocked: true, onLoadVaultSecret })
      await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
      expect(syncState?.alertSummary?.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'probe-error:metrics', title: 'Komari monitoring data is stale', status: 'active' })]))
      expect(invoke).toHaveBeenCalledWith('upsert_komari_sync_state', { payload: expect.objectContaining({ lastSyncedAt: updatedAt }) })
      expect(screen.getByTestId('komari-host-last-sync').querySelector('time')).toBeNull()
      expect(screen.getByTestId('komari-host-last-sync')).toHaveTextContent('Unknown')

      // A new host-list reference triggers the real default refresh, which now
      // reads the state actually written above, rather than a frozen fixture.
      view.rerender(dashboardElement({ hosts: [...hosts], vaultUnlocked: true, onLoadVaultSecret }))
      await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
      expect(screen.getByTestId('komari-host-last-sync')).toHaveTextContent('Unknown')
      expect(screen.getByTestId('komari-host-last-sync').querySelector('time')).toBeNull()
      expect(syncState?.lastSuccessfulSyncAt).toBeNull()
      expect(onLoadVaultSecret).not.toHaveBeenCalled()
      expect(http).not.toHaveBeenCalled()
      expect(JSON.stringify(snapshot)).toBe(before)
      expect(snapshot.metrics?.freshness.expiresAt).toBe(snapshot.metrics!.freshness.sampledAt + 60_000)
    } finally { http.mockRestore() }
  })

  it('persists a real cached healthy baseline without an alert or invented sync provenance, once across refreshes', async () => {
    const sampledAt = Date.now() - 5_000
    const updatedAt = sampledAt + 1_000
    const snapshot = komariSnapshot(sampledAt)
    let syncState: KomariSyncState = { integrationId: 'komari-a', lastSyncedAt: updatedAt, lastSuccessfulSyncAt: null, ttlMs: 60_000, alertSummary: null, updatedAt }
    const onLoadVaultSecret = vi.fn(async () => 'fixture-token')
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'get_komari_sync_state') return syncState
      if (command === 'list_komari_snapshots') return [{ updatedAt, snapshot }]
      if (command === 'list_komari_mappings') return [{ integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt }]
      if (command === 'upsert_komari_sync_state') {
        syncState = { ...(args as { payload: KomariSyncState }).payload, lastSuccessfulSyncAt: null }
        return undefined
      }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    const view = renderDashboard({ vaultUnlocked: true, onLoadVaultSecret })
    await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
    expect(syncState.alertSummary).toEqual(expect.objectContaining({
      alerts: [], audit: [],
      probeBaselines: [{ integrationId: 'komari-a', endpoint: 'https://komari.test', nodeId: 'node-1', hostId: 'host-0', lastHealthySampledAt: sampledAt }],
    }))
    expect(syncState.lastSuccessfulSyncAt).toBeNull()
    expect(syncState.lastSyncedAt).toBe(updatedAt)
    view.rerender(dashboardElement({ hosts: [...hosts], vaultUnlocked: true, onLoadVaultSecret }))
    await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'upsert_komari_sync_state')).toHaveLength(1)
    expect(onLoadVaultSecret).not.toHaveBeenCalled()
  })

  it('shows the first committed real sync while retaining the remote metric sample and TTL', async () => {
    const sampledAt = Date.now() - 10_000
    const mapping = { integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 }
    let saved: { lastSyncedAt: number; snapshots: KomariSnapshotPayload[] } | undefined
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/admin/client/list')) return new Response(JSON.stringify([{ uuid: 'node-1', name: hosts[0].name, ipv4: hosts[0].address }]))
      if (String(input).includes('/api/admin/notification/')) return new Response('[]')
      return new Response(JSON.stringify([{ time: sampledAt, cpu: 33 }]))
    })
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'get_komari_sync_state') return null
      if (command === 'get_komari_mapping_state') return { revision: 7, mappings: [mapping] }
      if (command === 'list_komari_mappings') return [mapping]
      if (command === 'persist_komari_sync') { saved = (args as { payload: typeof saved }).payload; return undefined }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    try {
      renderDashboard({ vaultUnlocked: true, onLoadVaultSecret: vi.fn(async () => 'fixture-token') })
      const row = await screen.findByTestId('komari-host-last-sync')
      expect(saved).toBeDefined()
      expect(http).toHaveBeenCalled()
      expect(row.querySelector('time')).toHaveAttribute('datetime', new Date(saved!.lastSyncedAt).toISOString())
      const metrics = saved!.snapshots[0].snapshot.metrics!
      expect(metrics.data.sampledAt).toBe(sampledAt)
      expect(metrics.freshness).toMatchObject({ sampledAt, ttlMs: 60_000, expiresAt: sampledAt + 60_000 })
      expect(saved!.lastSyncedAt).toBeGreaterThan(sampledAt)
    } finally { http.mockRestore() }
  })

  it('invalidates a rebound Komari source immediately while replacement sync is pending and rejects a queued old-host action', async () => {
    let moved = false
    let finishOldCheck!: (state: unknown) => void
    const mapping = (hostId: string) => ({ integrationId: 'komari-a', hostId, nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 })
    let checks = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true }]
      if (command === 'get_komari_sync_state') return { integrationId: 'komari-a', lastSyncedAt: Date.now(), ttlMs: 60_000, alertSummary: null }
      if (command === 'list_komari_snapshots') return moved ? [] : [{ updatedAt: Date.now(), snapshot: komariSnapshot(Date.now()) }]
      if (command === 'list_komari_mappings') return [mapping(moved ? 'host-1' : 'host-0')]
      if (command === 'get_komari_mapping_state') {
        if (++checks === 1) return new Promise((resolve) => { finishOldCheck = resolve })
        return { revision: 1, mappings: [mapping('host-1')] }
      }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    let finishSync!: (result: komariSync.KomariSyncResult) => void
    const sync = vi.spyOn(komariSync, 'syncKomariIntegration').mockImplementation(() => new Promise((resolve) => { finishSync = resolve }))
    const operation = vi.spyOn(komariBridge, 'runKomariLinkedProbeOperation')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderDashboard({ onLoadVaultSecret: vi.fn(async () => 'token'), vaultUnlocked: true, onOpenWorkspace: vi.fn() })
      const source = await screen.findByTestId('komari-probe-ops-view')
      const hostCard = source.closest('[data-testid="host-card"]') as HTMLElement
      fireEvent.click(within(hostCard).getByTestId('host-ops-details-toggle'))
      fireEvent.click(source.closest('details')!.querySelector('summary')!)
      fireEvent.click(await screen.findByRole('button', { name: 'Review probe installation' }))
      await waitFor(() => expect(checks).toBe(1))
      moved = true
      act(() => {
        window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { vaultId: 'vault', integrationId: 'komari-a' } }))
        window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))
      })
      expect(screen.queryByRole('button', { name: 'Review probe installation' })).not.toBeInTheDocument()
      expect(screen.getAllByTestId('host-ops-summary')).toHaveLength(1)
      expect(screen.getByTestId('host-ops-summary')).toHaveTextContent('ssh-agentless')
      await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
      await act(async () => { finishOldCheck({ revision: 1, mappings: [mapping('host-1')] }) })
      expect(operation).not.toHaveBeenCalled()
      expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
      await act(async () => { finishSync({ integrationId: 'komari-a', syncedAt: Date.now(), clients: [], mapping: { mappings: [], conflicts: [], unmappedHosts: [], unmappedNodes: [] }, snapshots: [], alerts: null, alertState: null, alertAudit: [] }) })
    } finally { sync.mockRestore(); operation.mockRestore(); error.mockRestore() }
  })

  it.each([true, false])('routes installation review to the signed Workspace panel without a remote write or installation job (Workspace available: %s)', async (available) => {
    const manual = { integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 }
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true }]
      if (command === 'get_komari_sync_state') return { integrationId: 'komari-a', lastSyncedAt: Date.now(), ttlMs: 60_000, alertSummary: null }
      if (command === 'list_komari_snapshots') return [{ updatedAt: Date.now(), snapshot: komariSnapshot(Date.now()) }]
      if (command === 'list_komari_mappings') return [manual]
      if (command === 'get_komari_mapping_state') return { revision: 1, mappings: [manual] }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    const onOpenWorkspace = vi.fn()
    const onSelectHost = vi.fn()
    const operation = vi.spyOn(komariBridge, 'runKomariLinkedProbeOperation')
    try {
      renderDashboard({ onLoadVaultSecret: vi.fn(async () => 'token'), vaultUnlocked: true, onSelectHost, onOpenWorkspace: available ? onOpenWorkspace : undefined })
      const source = await screen.findByTestId('komari-probe-ops-view')
      const hostCard = source.closest('[data-testid="host-card"]') as HTMLElement
      fireEvent.click(within(hostCard).getByTestId('host-ops-details-toggle'))
      const disclosure = source.closest('details')!
      expect(disclosure).not.toHaveAttribute('open')
      fireEvent.click(disclosure.querySelector('summary')!)
      expect(source).toBeVisible()
      if (available) {
        fireEvent.click(await screen.findByRole('button', { name: 'Review probe installation' }))
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledWith('host-0', 'overview'))
        expect(onSelectHost).toHaveBeenCalledWith('host-0')
      } else {
        expect(screen.queryByRole('button', { name: 'Review probe installation' })).not.toBeInTheDocument()
        expect(onSelectHost).not.toHaveBeenCalled()
      }
      expect(operation).not.toHaveBeenCalled()
      expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'operation_job_create')).toHaveLength(0)
    } finally { operation.mockRestore() }
  })

  it('does not let an old-Vault action completion cancel the current Vault refresh', async () => {
    let finishScan!: () => void
    const onScanHosts = vi.fn(() => new Promise<void>((resolve) => { finishScan = resolve }))
    const onOpenWorkspace = vi.fn()
    const view = renderDashboard({ onScanHosts, onOpenWorkspace })
    await waitFor(() => expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Open operations for DB host' }), { target: { value: 'refresh' } })
    let finishNew!: (views: Awaited<ReturnType<typeof loadHostOpsViews>>) => void
    vi.mocked(loadHostOpsViews).mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve }))
    view.rerender(dashboardElement({ activeVaultId: 'new-vault', onScanHosts, onOpenWorkspace }))
    await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalledTimes(2))
    await act(async () => { finishScan() })
    expect(loadHostOpsViews).toHaveBeenCalledTimes(2)
    await act(async () => { finishNew(buildHostOpsViews({ hosts })) })
    expect(screen.getByTestId('host-ops-refresh-status')).toHaveAttribute('data-status', 'fresh')
  })

  it('syncs saved manual choices with the same Vault and mapping revision before publishing host observations', async () => {
    const manual = { integrationId: 'komari-a', hostId: 'host-0', nodeId: 'node-different-address', source: 'manual' as const, confidence: 'explicit' as const, updatedAt: 1 }
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true }]
      if (command === 'get_komari_mapping_state') return { mappings: [manual], revision: 7 }
      if (command === 'list_komari_mappings') return [manual]
      if (command === 'get_komari_sync_state') return null
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    const sync = vi.spyOn(komariSync, 'syncKomariIntegration').mockResolvedValue({ integrationId: 'komari-a', syncedAt: 1234, clients: [], mapping: { mappings: [manual], conflicts: [], unmappedHosts: [], unmappedNodes: [] }, snapshots: [], alerts: null, alertState: null, alertAudit: [] })
    try {
      renderDashboard({ onLoadVaultSecret: vi.fn(async () => 'token'), vaultUnlocked: true })
      await waitFor(() => expect(sync).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault', explicitMappings: { 'host-0': 'node-different-address' } })))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('persist_komari_sync', { payload: expect.objectContaining({ vaultId: 'vault', expectedMappingRevision: 7 }) }))
    } finally { sync.mockRestore() }
  })

  it('does not publish a late old-Vault sync after changing Vaults', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'list_komari_integrations') return (args as { vaultId: string }).vaultId === 'vault' ? [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true }] : []
      if (command === 'get_komari_mapping_state') return { mappings: [], revision: 0 }
      if (command === 'get_komari_sync_state') return null
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    let finish!: (result: komariSync.KomariSyncResult) => void
    const sync = vi.spyOn(komariSync, 'syncKomariIntegration').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    try {
      const onLoadVaultSecret = vi.fn(async () => 'token')
      const view = renderDashboard({ onLoadVaultSecret })
      await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
      view.rerender(dashboardElement({ activeVaultId: 'other-vault', onLoadVaultSecret }))
      await act(async () => { finish({ integrationId: 'komari-a', syncedAt: 1234, clients: [], mapping: { mappings: [], conflicts: [], unmappedHosts: [], unmappedNodes: [] }, snapshots: [], alerts: null, alertState: null, alertAudit: [] }) })
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'persist_komari_sync')).toHaveLength(0)
    } finally { sync.mockRestore() }
  })

  it('shows selected provider throughput and uptime without requiring an inventory snapshot', async () => {
    const views = buildHostOpsViews({ hosts })
    const metrics: ServerMonitorSnapshot = { hostname: 'api', os: 'Linux', kernel: '', uptimeSeconds: 90_061, cpuPercent: 12, load1: null, load5: null, load15: null, memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null, diskUsedBytes: null, diskTotalBytes: null, diskPercent: null, networkRxBytesPerSec: 0, networkTxBytesPerSec: 2048, latencyMs: null, sampledAt: Date.now() }
    views['host-0'].metrics = metrics
    vi.mocked(loadHostOpsViews).mockResolvedValue(views)
    renderDashboard()
    await waitFor(() => expect(screen.getByText('↓ 0 B/s')).toBeVisible())
    expect(screen.getByText('↑ 2.0 KB/s')).toBeVisible()
    expect(screen.getByText('1d 1h')).toBeVisible()
  })

  it('searches current referenced jump metadata immediately after the jump profile is edited', async () => {
    const target = { ...hosts[0], jumpHostId: 'jump', jumpHost: 'old.jump.example', jumpUser: 'old-jump-user', jumpPort: 2201 }
    const jump = { ...hosts[1], id: 'jump', name: 'Original Bastion', address: 'old.jump.example', username: 'old-jump-user', port: 2201 }
    const profiles = [target, jump, hosts[1]]
    let view!: ReturnType<typeof renderDashboard>
    await act(async () => { view = renderDashboard({ hosts: profiles, externalSearch: 'Original Bastion' }) })
    expect(screen.getByText('API host', { selector: 'p' })).toBeVisible()
    const editedJump = { ...jump, name: 'Edited Gateway', address: 'new.jump.example', username: 'current-jump-user', port: 2299, updatedAt: 2 }
    const editedProfiles = [target, editedJump, hosts[1]]
    for (const query of ['Edited Gateway', 'new.jump.example', 'current-jump-user', '2299']) {
      await act(async () => { view.rerender(dashboardElement({ hosts: editedProfiles, externalSearch: query })) })
      expect(screen.getByText('API host', { selector: 'p' })).toBeVisible()
      expect(screen.queryByText('DB host', { selector: 'p' })).not.toBeInTheDocument()
    }
    for (const query of ['Original Bastion', 'old.jump.example', 'old-jump-user', '2201']) {
      await act(async () => { view.rerender(dashboardElement({ hosts: editedProfiles, externalSearch: query })) })
      expect(screen.queryByText('API host', { selector: 'p' })).not.toBeInTheDocument()
    }
    await act(async () => { view.rerender(dashboardElement({ hosts: [target, hosts[1]], externalSearch: 'old.jump.example' })) })
    expect(screen.queryByText('API host', { selector: 'p' })).not.toBeInTheDocument()
  })

  it('filters unsupported hosts separately from unreachable hosts', async () => {
    const views = buildHostOpsViews({ hosts })
    views['host-0'].health.state = 'unsupported'
    views['host-1'].health.state = 'offline'
    vi.mocked(loadHostOpsViews).mockResolvedValue(views)
    renderDashboard()
    await waitFor(() => expect(screen.getByText('Unsupported monitoring', { selector: 'span' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Health status'), { target: { value: 'unsupported' } })
    expect(screen.getByText('API host', { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByText('DB host', { selector: 'p' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Health status'), { target: { value: 'offline' } })
    expect(screen.getByText('DB host', { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByText('API host', { selector: 'p' })).not.toBeInTheDocument()
  })

  it('requires a scoped review of the command and route before any batch mutation, including cancelled audits', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const request = (args as { request?: Record<string, unknown> })?.request
      if (command === 'operation_job_create') return { ...request, jobId: 'batch-job', auditId: 'batch-audit', status: 'queued' }
      if (command === 'operation_job_update') return { ...request, auditId: 'batch-audit' }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDashboard()
    fireEvent.click(screen.getByRole('checkbox', { name: /API host/ }))
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'service.restart' } })
    fireEvent.change(screen.getByLabelText('Service or container'), { target: { value: 'nginx.service' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run operation' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('systemctl restart nginx.service'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ops@10.0.0.1:22 · direct'))
    expect(invoke).toHaveBeenCalledWith('operation_job_create', expect.objectContaining({ request: expect.objectContaining({ vaultId: 'vault', hostId: 'host-0' }) }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', expect.objectContaining({ request: expect.objectContaining({ status: 'cancelled' }) })))
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
  it('opens diagnosis for the selected host and refreshes only that host before reloading its operations', async () => {
    const onOpenWorkspace = vi.fn()
    const onScanHosts = vi.fn(async () => {})
    renderDashboard({ onOpenWorkspace, onScanHosts })
    await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalled())
    const previousLoads = vi.mocked(loadHostOpsViews).mock.calls.length
    const control = screen.getByRole('combobox', { name: 'Open operations for DB host' })
    fireEvent.change(control, { target: { value: 'logs' } })
    expect(onOpenWorkspace).toHaveBeenCalledWith('host-1', 'logs')
    fireEvent.change(control, { target: { value: 'refresh' } })
    await waitFor(() => expect(onScanHosts).toHaveBeenCalledWith([hosts[1]]))
    await waitFor(() => expect(vi.mocked(loadHostOpsViews).mock.calls.length).toBeGreaterThan(previousLoads))
  })
  it('filters actual host cards across dimensions, excludes unknown resource values and clears as one action', async () => {
    renderDashboard()
    fireEvent.click(screen.getByText(/Operations filters/))
    const alerts = await screen.findByTestId('host-ops-local-alerts')
    expect(alerts).toBeVisible()
    expect(alerts).toHaveAttribute('data-severity', 'critical')
    expect(alerts).toHaveAttribute('data-open-count', '1')
    expect(alerts).toHaveTextContent('Critical · Local open alerts: 1')
    fireEvent.change(screen.getByLabelText('Probe provider'), { target: { value: 'komari' } })
    expect(screen.getByText('API host', { selector: 'p' })).toBeInTheDocument(); expect(screen.queryByText('DB host', { selector: 'p' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Operating system'), { target: { value: 'Ubuntu' } })
    fireEvent.change(screen.getByLabelText('Highest open alert severity'), { target: { value: 'critical' } })
    fireEvent.change(screen.getByLabelText('Capability'), { target: { value: 'docker' } })
    fireEvent.change(screen.getByLabelText('Resource threshold'), { target: { value: 'disk' } })
    fireEvent.change(screen.getByLabelText('At least (%)'), { target: { value: '95' } })
    expect(screen.queryByText('API host', { selector: 'p' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('At least (%)'), { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText('Data freshness'), { target: { value: 'fresh' } })
    expect(screen.getByText('API host', { selector: 'p' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear operations filters' }))
    expect(screen.getByText('API host', { selector: 'p' })).toBeInTheDocument(); expect(screen.getByText('DB host', { selector: 'p' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Resource threshold'), { target: { value: 'disk' } })
    fireEvent.change(screen.getByLabelText('At least (%)'), { target: { value: '0' } })
    expect(screen.queryByText('DB host', { selector: 'p' })).not.toBeInTheDocument()
  })
  it('selects stale observations older than the configured age without treating missing data as zero', async () => {
    renderDashboard()
    fireEvent.click(screen.getByText(/Operations filters/))
    await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('option', { name: 'Ubuntu' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Data freshness'), { target: { value: 'older' } })
    fireEvent.change(screen.getByLabelText('Older than (minutes)'), { target: { value: '5' } })
    expect(screen.getByText('DB host', { selector: 'p' })).toBeInTheDocument(); expect(screen.queryByText('API host', { selector: 'p' })).not.toBeInTheDocument()
  })
})
