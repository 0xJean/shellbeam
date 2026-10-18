import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsDashboard } from './hosts-dashboard'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import type { HostProfile } from '@/lib/hosts'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import * as komariSync from '@/lib/komari-sync'
import * as komariBridge from '@/lib/komari-probe-link'
import { KOMARI_MAPPING_CHANGED_EVENT } from '@/lib/komari-persistence'
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
describe('host operations filter workflow', () => {
  it('invalidates a rebound Komari source immediately while replacement sync is pending and rejects a queued old-host action', async () => {
    let moved = false
    let finishOldCheck!: (state: unknown) => void
    const mapping = (hostId: string) => ({ integrationId: 'komari-a', hostId, nodeId: 'node-1', source: 'manual', confidence: 'explicit', updatedAt: 1 })
    let checks = 0
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'vault', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari.token', enabled: true }]
      if (command === 'get_komari_sync_state') return { integrationId: 'komari-a', lastSyncedAt: Date.now(), ttlMs: 60_000, alertSummary: null }
      if (command === 'list_komari_snapshots') return moved ? [] : [{ updatedAt: Date.now(), snapshot: { schemaVersion: 1, host: { hostId: 'host-0' }, provider: { kind: 'komari', id: 'komari-a', nodeId: 'node-1', capabilities: ['metrics'] }, health: 'online', receivedAt: Date.now(), metrics: null, inventory: null, errors: [] } }]
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
      if (command === 'list_komari_snapshots') return [{ updatedAt: Date.now(), snapshot: { schemaVersion: 1, host: { hostId: 'host-0' }, provider: { kind: 'komari', id: 'komari-a', nodeId: 'node-1', capabilities: ['metrics'] }, health: 'online', receivedAt: Date.now(), metrics: null, inventory: null, errors: [] } }]
      if (command === 'list_komari_mappings') return [manual]
      if (command === 'get_komari_mapping_state') return { revision: 1, mappings: [manual] }
      return command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []
    })
    const onOpenWorkspace = vi.fn()
    const onSelectHost = vi.fn()
    const operation = vi.spyOn(komariBridge, 'runKomariLinkedProbeOperation')
    try {
      renderDashboard({ onLoadVaultSecret: vi.fn(async () => 'token'), vaultUnlocked: true, onSelectHost, onOpenWorkspace: available ? onOpenWorkspace : undefined })
      if (available) {
        fireEvent.click(await screen.findByRole('button', { name: 'Review probe installation' }))
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledWith('host-0', 'overview'))
        expect(onSelectHost).toHaveBeenCalledWith('host-0')
      } else {
        await waitFor(() => expect(screen.getByTestId('komari-probe-ops-view')).toBeVisible())
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
    await waitFor(() => expect(screen.getByText('Highest severity: Critical · Local open alerts: 1')).toBeInTheDocument())
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
