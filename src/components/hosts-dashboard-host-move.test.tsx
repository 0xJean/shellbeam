import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import { moveHostsToVault, planHostMove, type HostMovePlan } from '@/lib/host-move'
import type { HostProfile } from '@/lib/hosts'
import { HostsDashboard } from './hosts-dashboard'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))
vi.mock('@/lib/host-ops-view', async original => ({ ...await original<typeof import('@/lib/host-ops-view')>(), loadHostOpsViews: vi.fn() }))
vi.mock('@/lib/host-move', async original => ({ ...await original<typeof import('@/lib/host-move')>(), planHostMove: vi.fn(), moveHostsToVault: vi.fn() }))

const hosts: HostProfile[] = ['alpha', 'beta', 'gamma'].map((name, index) => ({
  id: `host-${index}`, vaultId: 'vault-a', name, address: `10.0.0.${index + 1}`, port: 22,
  username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1,
}))
const vaults = [{ id: 'vault-a', name: 'Alpha vault' }, { id: 'vault-b', name: 'Beta vault' }]
const plan = (ids: string[]): HostMovePlan => ({
  hosts: hosts.filter(host => ids.includes(host.id)).map(({ id, name }) => ({ id, name })), addedJumpHosts: [], blockingDependents: [], conflicts: [],
  secrets: { moved: 0, copied: 0, renamed: [] }, records: { portForwards: 0, knownHosts: 0, commandHistory: 0, activity: 0, databaseRows: 0 },
  mcpClientsAffected: [], sourceUnlocked: true, targetUnlocked: true, targetUninitialized: false,
})
function element(extra: Partial<React.ComponentProps<typeof HostsDashboard>> = {}) {
  return <I18nProvider><HostsDashboard activeVaultId="vault-a" vaultUnlocked hosts={hosts} selectedHostId={null} loading={false}
    onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} {...extra} /></I18nProvider>
}
async function settled() {
  await waitFor(() => expect(loadHostOpsViews).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByTestId('host-ops-refresh')).toBeEnabled())
}
function selectBatch(...names: string[]) {
  fireEvent.click(screen.getByTestId('host-batch-select'))
  for (const name of names) fireEvent.click(screen.getByRole('checkbox', { name: `Select host · ${name}` }))
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(invoke).mockReset().mockImplementation(async command => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : [])
  vi.mocked(loadHostOpsViews).mockReset().mockImplementation(async profiles => buildHostOpsViews({ hosts: profiles }))
  vi.mocked(planHostMove).mockReset().mockImplementation(async request => plan(request.hostIds))
  vi.mocked(moveHostsToVault).mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('moving hosts from the hosts page', () => {
  it('offers the batch and per-host move only when another Vault exists', async () => {
    const view = render(element({ vaults: [vaults[0]] })); await settled()
    selectBatch('alpha')
    expect(screen.getByTestId('host-batch-bar')).toBeVisible()
    expect(screen.queryByTestId('host-move-entry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('host-move-to-vault')).not.toBeInTheDocument()
    view.rerender(element({ vaults }))
    expect(within(screen.getByTestId('host-batch-bar')).getByTestId('host-move-entry')).toHaveTextContent('Move to vault…')
    expect(screen.getAllByTestId('host-move-to-vault')).toHaveLength(3)
  })

  it('moves the selected hosts, then refreshes and drops them from the selection', async () => {
    const onRefreshHosts = vi.fn(async () => {})
    vi.mocked(moveHostsToVault).mockResolvedValue({ movedHostIds: ['host-0'], warnings: [] })
    render(element({ vaults, onRefreshHosts })); await settled()
    selectBatch('alpha', 'beta')
    fireEvent.click(screen.getByTestId('host-move-entry'))
    await waitFor(() => expect(planHostMove).toHaveBeenCalledWith({ sourceVaultId: 'vault-a', targetVaultId: 'vault-b', hostIds: ['host-0', 'host-1'] }))
    await waitFor(() => expect(screen.getByTestId('host-move-confirm')).toBeEnabled())
    fireEvent.click(screen.getByTestId('host-move-confirm'))
    await screen.findByTestId('host-move-done')
    await waitFor(() => expect(onRefreshHosts).toHaveBeenCalled())
    expect(screen.getByRole('checkbox', { name: 'Select host · alpha' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select host · beta' })).toBeChecked()
    expect(screen.getByTestId('host-move-dialog')).toBeInTheDocument()
  })

  it('opens the move for one host from its card', async () => {
    render(element({ vaults })); await settled()
    const card = screen.getAllByTestId('host-card').find(item => item.getAttribute('data-host-id') === 'host-2')!
    fireEvent.click(within(card).getByTestId('host-move-to-vault'))
    await waitFor(() => expect(planHostMove).toHaveBeenCalledWith({ sourceVaultId: 'vault-a', targetVaultId: 'vault-b', hostIds: ['host-2'] }))
  })
})
