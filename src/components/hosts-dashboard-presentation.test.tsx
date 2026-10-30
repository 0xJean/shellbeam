import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews, type HostOpsView } from '@/lib/host-ops-view'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { reconcileKomariAlerts } from '@/lib/komari-alerts'
import type { HostProfile } from '@/lib/hosts'
import type { LocalAlertRecord } from '@/lib/local-alert-rules'
import { HostsDashboard } from './hosts-dashboard'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('@/lib/host-ops-view', async original => ({ ...await original<typeof import('@/lib/host-ops-view')>(), loadHostOpsViews: vi.fn() }))

const hosts: HostProfile[] = ['Terminal host', 'SSH host', 'Mapped host'].map((name, index) => ({
  id: `host-${index}`, vaultId: 'vault-a', name, address: `10.0.0.${index + 1}`, port: 22,
  username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1,
}))
const resource = { hostname: 'monitored', os: 'Linux', kernel: '', uptime: '1 day', cpuPercent: 22, diskPercent: 20, memoryPercent: 30, memoryText: '', diskText: '', network: '' }
function observe(view: HostOpsView, provider: 'ssh-agentless' | 'komari' = 'ssh-agentless'): HostOpsView {
  const now = Date.now()
  return { ...view, resource, health: { ...view.health, state: 'online', provider, freshness: { sampledAt: now, updatedAt: now, ageMs: 0, stale: false, ttlMs: 60_000 } } }
}
const localAlert = (hostId: string, status: LocalAlertRecord['status'] = 'active'): LocalAlertRecord => ({
  ruleId: 'cpu-rule', hostId, name: 'CPU exceeds threshold', metric: 'cpu', status, severity: 'warning', openedAt: 100,
  updatedAt: 100, resolvedAt: status === 'resolved' ? 100 : null, value: 95, source: 'ssh-agentless', transport: 'direct',
})
function element(extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) {
  return <I18nProvider><HostsDashboard activeVaultId="vault-a" vaultUnlocked hosts={hosts} selectedHostId={null} loading={false}
    onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} onOpenWorkspace={vi.fn()} {...extra} /></I18nProvider>
}
async function settled() {
  await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByTestId('host-ops-refresh')).toBeEnabled())
}
function card(id: string) { return screen.getAllByTestId('host-card').find(item => item.getAttribute('data-host-id') === id)! }
async function openViewOptions() {
  const options = await screen.findByTestId('host-view-options')
  if (!options.hasAttribute('open')) fireEvent.click(options.querySelector('summary')!)
  return within(options).getByTestId('host-monitoring-summary-toggle')
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(invoke).mockReset().mockImplementation(async command => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : [])
  vi.mocked(loadHostOpsViews).mockReset().mockImplementation(async profiles => buildHostOpsViews({ hosts: profiles }))
  vi.mocked(runWorkspaceRemoteCommand).mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('progressive host presentation', () => {
  it.each(['list', 'grid'] as const)('keeps terminal-only hosts usable without Komari, fake health or empty operations in %s', async mode => {
    const onSelectHost = vi.fn(), onOpenWorkspace = vi.fn(), onConnectHost = vi.fn(), onLoadVaultSecret = vi.fn()
    render(element({ onSelectHost, onOpenWorkspace, onConnectHost, onLoadVaultSecret }))
    await settled()
    if (mode === 'grid') fireEvent.click(screen.getByTitle('Grid view'))
    else {
      expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'false')
      expect(screen.getByTestId('host-list-header').children).toHaveLength(6)
    }
    expect(screen.getAllByTestId('host-card')).toHaveLength(3)
    for (const id of ['host-ops-summary', 'host-ops-details-toggle', 'host-resource-summary', 'host-view-options', 'host-alerts-open', 'multi-host-operations-panel', 'komari-alert-panel', 'komari-mappings-panel']) expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    expect(screen.queryByText(/Komari|not-installed|No probe/i)).not.toBeInTheDocument()
    fireEvent.click(within(card('host-0')).getByTestId('host-connect'))
    expect(onSelectHost).toHaveBeenCalledWith('host-0')
    expect(onConnectHost).toHaveBeenCalledWith('host-0')
    expect(onLoadVaultSecret).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
  })

  it('keeps region and available SSH metrics visible by default without expanding diagnostics or suppressing alerts', async () => {
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles, localAlertStates: { 'host-1': { version: 1, alerts: [localAlert('host-1')], audit: [], evaluations: [] } } })
      views['host-1'] = observe(views['host-1']); return views
    })
    render(element()); await settled()
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'false')
    expect(screen.getByTestId('host-list-header').children).toHaveLength(7)
    expect(within(card('host-1')).getByTestId('host-resource-summary')).toBeVisible()
    expect(within(card('host-1')).getByTestId('host-ops-details')).not.toBeVisible()
    expect(screen.getByTestId('host-alerts-open')).toHaveTextContent('1 open')
    const toggle = await openViewOptions()
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'true')
    expect(within(card('host-1')).getByTestId('host-resource-summary')).toBeVisible()
  })

  it('shows SSH monitoring without a Komari connection and keeps both layouts collapsed until requested', async () => {
    localStorage.setItem('shellbeam:host-monitoring-summary:vault-a', 'visible')
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles }); views['host-1'] = observe(views['host-1']); return views
    })
    render(element())
    await settled()
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'true')
    expect(screen.getByTestId('host-list-header').children).toHaveLength(9)
    expect(within(within(card('host-1')).getByTestId('host-ops-compact-source')).getByTitle('SSH agentless scanning')).toHaveTextContent('SSH')
    expect(within(card('host-1')).getByTestId('host-resource-summary')).toBeVisible()
    expect(within(card('host-1')).getByTestId('host-ops-details')).not.toBeVisible()
    expect(within(card('host-0')).queryByTestId('host-ops-summary')).not.toBeInTheDocument()
    expect(screen.queryByText(/Komari/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Grid view'))
    const toggle = within(card('host-1')).getByTestId('host-ops-details-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(card('host-1')).getByTestId('host-ops-details')).not.toBeVisible()
    fireEvent.click(toggle)
    expect(within(card('host-1')).getByTestId('host-ops-details')).toBeVisible()
  })

  it('keeps a mapped Komari host, an SSH host and an unobserved host distinct in the same list', async () => {
    localStorage.setItem('shellbeam:host-monitoring-summary:vault-a', 'visible')
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles }); views['host-1'] = observe(views['host-1']); views['host-2'] = observe(views['host-2'], 'komari'); return views
    })
    render(element()); await settled()
    expect(within(card('host-0')).queryByTestId('host-ops-summary')).not.toBeInTheDocument()
    expect(within(card('host-0')).queryByText(/Komari|Monitoring service|SSH$/)).not.toBeInTheDocument()
    expect(within(within(card('host-1')).getByTestId('host-ops-compact-source')).getByTitle('SSH agentless scanning')).toHaveTextContent('SSH')
    expect(within(card('host-1')).queryByText(/Komari|Monitoring service/)).not.toBeInTheDocument()
    expect(within(within(card('host-2')).getByTestId('host-ops-compact-source')).getByTitle('Monitoring service')).toHaveTextContent('Monitoring service')
    expect(screen.queryByTestId('komari-alert-panel')).not.toBeInTheDocument()
  })

  it('keeps active filters clearable after the last current monitoring source disappears', async () => {
    let currentSource = true
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles })
      if (currentSource) views['host-2'] = observe(views['host-2'], 'komari')
      return views
    })
    render(element()); await settled()
    await openViewOptions()
    fireEvent.click(screen.getByTestId('host-ops-advanced-filters').querySelector('summary')!)
    fireEvent.change(screen.getByLabelText('Probe provider'), { target: { value: 'komari' } })
    expect(screen.getAllByTestId('host-card')).toHaveLength(1)
    expect(card('host-2')).toBeVisible()
    currentSource = false
    fireEvent.click(screen.getByTestId('host-ops-refresh'))
    await waitFor(() => expect(screen.queryByTestId('host-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('host-view-options')).toBeVisible()
    expect(screen.getByLabelText('Probe provider')).toHaveValue('komari')
    fireEvent.click(screen.getByRole('button', { name: 'Clear operations filters' }))
    expect(screen.getAllByTestId('host-card')).toHaveLength(3)
    expect(screen.queryByTestId('host-view-options')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-resource-summary')).not.toBeInTheDocument()
  })

  it('resets source and health filters before showing a different Vault with no observations', async () => {
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles })
      if (profiles[0]?.vaultId === 'vault-a') views['host-2'] = observe(views['host-2'], 'komari')
      return views
    })
    const view = render(element()); await settled()
    await openViewOptions()
    fireEvent.click(screen.getByTestId('host-ops-advanced-filters').querySelector('summary')!)
    fireEvent.change(screen.getByLabelText('Probe provider'), { target: { value: 'komari' } })
    fireEvent.click(screen.getByTestId('host-status-online'))
    expect(screen.getAllByTestId('host-card')).toHaveLength(1)
    view.rerender(element({ activeVaultId: 'vault-b', hosts: hosts.map(host => ({ ...host, vaultId: 'vault-b' })) }))
    await settled()
    expect(screen.getAllByTestId('host-card')).toHaveLength(3)
    expect(screen.queryByTestId('host-view-options')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Health status' })).not.toBeInTheDocument()
    view.rerender(element()); await settled()
    expect(screen.getAllByTestId('host-card')).toHaveLength(3)
    await openViewOptions()
    fireEvent.click(screen.getByTestId('host-ops-advanced-filters').querySelector('summary')!)
    expect(screen.getByLabelText('Probe provider')).toHaveValue('all')
    expect(screen.getByTestId('host-status-all')).toHaveAttribute('aria-checked', 'true')
  })

  it('changes only monitoring presentation and restores the independent preference for each Vault', async () => {
    localStorage.setItem('shellbeam:host-monitoring-summary:vault-a', 'visible')
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => Object.fromEntries(Object.entries(buildHostOpsViews({ hosts: profiles })).map(([id, view]) => [id, observe(view)])))
    const onScanHosts = vi.fn(), onLoadVaultSecret = vi.fn()
    const view = render(element({ onScanHosts, onLoadVaultSecret })); await settled()
    const loads = vi.mocked(loadHostOpsViews).mock.calls.length, nativeCalls = vi.mocked(invoke).mock.calls.length
    fireEvent.click(await openViewOptions())
    await act(async () => {})
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'false')
    expect(screen.getByTestId('host-list-header').children).toHaveLength(7)
    expect(screen.getAllByTestId('host-resource-summary')).toHaveLength(3)
    expect(screen.getAllByTestId('host-resource-summary').every(item => !item.closest('[hidden]'))).toBe(true)
    expect(localStorage.getItem('shellbeam:host-monitoring-summary:vault-a')).toBe('hidden')
    expect(loadHostOpsViews).toHaveBeenCalledTimes(loads)
    expect(invoke).toHaveBeenCalledTimes(nativeCalls)
    expect(onScanHosts).not.toHaveBeenCalled(); expect(onLoadVaultSecret).not.toHaveBeenCalled()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    localStorage.setItem('shellbeam:host-monitoring-summary:vault-b', 'visible')
    const profilesB = hosts.map(host => ({ ...host, vaultId: 'vault-b' }))
    view.rerender(element({ activeVaultId: 'vault-b', hosts: profilesB, onScanHosts, onLoadVaultSecret })); await settled()
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'true')
    expect(await openViewOptions()).toBeChecked()
    view.rerender(element({ onScanHosts, onLoadVaultSecret })); await settled()
    expect(screen.getByTestId('host-list-header')).toHaveAttribute('data-monitoring', 'false')
    expect(await openViewOptions()).not.toBeChecked()
  })

  it('keeps one combined alert entry available when monitoring is hidden and filters by host and source', async () => {
    localStorage.setItem('shellbeam:host-monitoring-summary:vault-a', 'visible')
    const komari = reconcileKomariAlerts([], [{ integrationId: 'source', nodeId: 'node', hostId: 'host-2', kind: 'probe-error:metrics', title: 'Monitor data unavailable', severity: 'warning', count: 1, updatedAt: 100 }], { now: 100 }).alerts
    vi.mocked(loadHostOpsViews).mockImplementation(async profiles => {
      const views = buildHostOpsViews({ hosts: profiles, localAlertStates: { 'host-1': { version: 1, alerts: [localAlert('host-1'), { ...localAlert('host-1', 'resolved'), ruleId: 'recovered-rule', name: 'Recovered issue' }], audit: [], evaluations: [] } } })
      views['host-1'] = observe(views['host-1']); views['host-2'] = { ...observe(views['host-2'], 'komari'), komariAlerts: komari }; return views
    })
    const onSelectHost = vi.fn(), onOpenWorkspace = vi.fn()
    render(element({ onSelectHost, onOpenWorkspace })); await settled()
    fireEvent.click(await openViewOptions())
    expect(screen.getByTestId('host-alerts-open')).toHaveTextContent('2 open')
    expect(screen.queryByTestId('host-alerts-center')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('host-alerts-open'))
    const center = screen.getByTestId('host-alerts-center')
    expect(center).toBeVisible(); expect(within(center).getAllByTestId('host-incident')).toHaveLength(2)
    fireEvent.change(within(center).getByLabelText('Source'), { target: { value: 'komari' } })
    expect(within(center).getAllByTestId('host-incident')).toHaveLength(1)
    expect(within(center).getByTestId('host-incident')).toHaveAttribute('data-host-id', 'host-2')
    fireEvent.change(within(center).getByLabelText('Source'), { target: { value: '' } })
    fireEvent.change(within(center).getByLabelText('Host'), { target: { value: 'host-1' } })
    expect(within(center).getAllByTestId('host-incident')).toHaveLength(1)
    fireEvent.click(within(center).getByLabelText('Include history'))
    expect(within(center).getAllByTestId('host-incident')).toHaveLength(2)
    fireEvent.click(within(center).getAllByRole('button', { name: 'Host overview' })[0])
    expect(onSelectHost).toHaveBeenCalledWith('host-1'); expect(onOpenWorkspace).toHaveBeenCalledWith('host-1', 'overview')
    expect(screen.queryByTestId('host-alerts-center')).not.toBeInTheDocument()
  })

  it('requires explicit list selection before showing batch controls, with no second picker or retained cross-Vault selection', async () => {
    const view = render(element()); await settled()
    expect(screen.queryByTestId('multi-host-operations-panel')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Select host/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('host-batch-select'))
    expect(screen.getAllByRole('checkbox', { name: /Select host/ })).toHaveLength(3)
    expect(screen.queryByTestId('multi-host-operations-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select host · SSH host' }))
    const panel = screen.getByTestId('multi-host-operations-panel')
    expect(panel).toBeVisible(); expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(panel).getByText('SSH host')).toBeVisible()
    expect(within(panel).queryByText('Terminal host')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('host-batch-select'))
    expect(screen.queryByTestId('multi-host-operations-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('host-batch-select'))
    expect(screen.getByRole('checkbox', { name: 'Select host · SSH host' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select host · SSH host' }))
    view.rerender(element({ activeVaultId: 'vault-b', hosts: hosts.map(host => ({ ...host, vaultId: 'vault-b' })) })); await settled()
    expect(screen.queryByTestId('multi-host-operations-panel')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Select host/ })).not.toBeInTheDocument()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'operation_job_create')).toBe(false)
  })
})
