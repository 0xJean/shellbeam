import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { moveHostsToVault, planHostMove, type HostMovePlan } from '@/lib/host-move'
import { healthCheckStorageKey } from '@/lib/health-checks'
import { vaultUnlock } from '@/lib/vault'
import { HostMoveDialog } from './host-move-dialog'

vi.mock('@/lib/host-move', async (original) => ({ ...await original<typeof import('@/lib/host-move')>(), planHostMove: vi.fn(), moveHostsToVault: vi.fn() }))
vi.mock('@/lib/vault', () => ({ vaultUnlock: vi.fn() }))

const vaults = [{ id: 'personal', name: 'Personal' }, { id: 'team', name: 'Team' }, { id: 'lab', name: 'Lab' }]
const hosts = [{ id: 'web', name: 'web-1' }]
function plan(extra: Partial<HostMovePlan> = {}): HostMovePlan {
  return {
    hosts: [{ id: 'web', name: 'web-1' }, { id: 'bastion', name: 'bastion' }],
    addedJumpHosts: [{ id: 'bastion', name: 'bastion', requiredBy: ['web'] }],
    blockingDependents: [], conflicts: [],
    secrets: { moved: 2, copied: 1, renamed: [{ from: 'ssh/web', to: 'ssh/web-2' }] },
    records: { portForwards: 3, knownHosts: 2, commandHistory: 40, activity: 0, databaseRows: 120 },
    mcpClientsAffected: [{ id: 'claude', name: 'Claude Desktop' }],
    sourceUnlocked: true, targetUnlocked: true, targetUninitialized: false,
    ...extra,
  }
}
function renderDialog(props: Partial<React.ComponentProps<typeof HostMoveDialog>> = {}) {
  const onMoved = vi.fn(), onOpenChange = vi.fn()
  render(<I18nProvider><HostMoveDialog open sourceVaultId="personal" vaults={vaults} hosts={hosts} onOpenChange={onOpenChange} onMoved={onMoved} {...props} /></I18nProvider>)
  return { onMoved, onOpenChange }
}
const confirm = () => screen.getByTestId('host-move-confirm')

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(planHostMove).mockReset().mockResolvedValue(plan())
  vi.mocked(moveHostsToVault).mockReset()
  vi.mocked(vaultUnlock).mockReset()
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('HostMoveDialog', () => {
  it('plans against the first other Vault and shows hosts, added jump hosts, credentials, records and MCP clients', async () => {
    renderDialog()
    await screen.findByTestId('host-move-plan')
    expect(planHostMove).toHaveBeenCalledWith({ sourceVaultId: 'personal', targetVaultId: 'team', hostIds: ['web'] })
    expect(screen.getByTestId('host-move-route')).toHaveTextContent('Personal')
    expect(screen.getByTestId('host-move-route')).toHaveTextContent('Team')
    expect(screen.queryByRole('radio', { name: 'Personal' })).not.toBeInTheDocument()
    const list = screen.getByTestId('host-move-hosts')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByTestId('host-move-jump-host')).toHaveTextContent('Moved as a jump host for web-1')
    expect(within(list.querySelector('[data-host-id="web"]') as HTMLElement).queryByTestId('host-move-jump-host')).not.toBeInTheDocument()
    const secrets = screen.getByTestId('host-move-secrets')
    expect(secrets).toHaveTextContent('2 moved'); expect(secrets).toHaveTextContent('1 copied')
    expect(secrets).toHaveTextContent('ssh/web'); expect(secrets).toHaveTextContent('ssh/web-2')
    const records = screen.getByTestId('host-move-records')
    expect(records).toHaveTextContent('Port forwards3'); expect(records).toHaveTextContent('Command history40')
    expect(records).not.toHaveTextContent('Activity')
    expect(screen.getByTestId('host-move-mcp')).toHaveTextContent('Claude Desktop')
    expect(confirm()).toBeEnabled(); expect(confirm()).toHaveTextContent('Move 2 host(s)')

    fireEvent.click(screen.getByRole('radio', { name: 'Lab' }))
    await waitFor(() => expect(planHostMove).toHaveBeenLastCalledWith({ sourceVaultId: 'personal', targetVaultId: 'lab', hostIds: ['web'] }))
    expect(screen.getByTestId('host-move-route')).toHaveTextContent('Lab')
  })

  it('adds blocking dependents to the move and plans again; confirm stays off while blocked', async () => {
    vi.mocked(planHostMove)
      .mockResolvedValueOnce(plan({ blockingDependents: [{ id: 'db', name: 'db-1', dependsOn: ['web'] }] }))
      .mockResolvedValueOnce(plan({ hosts: [...plan().hosts, { id: 'db', name: 'db-1' }] }))
    renderDialog()
    const dependents = await screen.findByTestId('host-move-dependents')
    expect(dependents).toHaveTextContent('db-1'); expect(dependents).toHaveTextContent('Connects through web-1')
    expect(confirm()).toBeDisabled()
    fireEvent.click(within(dependents).getByTestId('host-move-add-dependents'))
    await waitFor(() => expect(planHostMove).toHaveBeenLastCalledWith({ sourceVaultId: 'personal', targetVaultId: 'team', hostIds: ['web', 'db'] }))
    await waitFor(() => expect(screen.queryByTestId('host-move-dependents')).not.toBeInTheDocument())
    expect(confirm()).toBeEnabled(); expect(confirm()).toHaveTextContent('Move 3 host(s)')
  })

  it('blocks on conflicts and an uninitialized target', async () => {
    vi.mocked(planHostMove).mockResolvedValue(plan({ conflicts: [{ id: 'web', name: 'web-1', reason: 'Already in the target' }], targetUnlocked: false, targetUninitialized: true }))
    renderDialog()
    expect(await screen.findByTestId('host-move-conflicts')).toHaveTextContent('Already in the target')
    expect(screen.getByTestId('host-move-uninitialized')).toHaveTextContent('Team has not been set up')
    expect(screen.queryByTestId('host-move-unlock')).not.toBeInTheDocument()
    expect(confirm()).toBeDisabled()
  })

  it('unlocks a locked target inline, shows unlock errors, then plans again', async () => {
    vi.mocked(planHostMove).mockResolvedValueOnce(plan({ targetUnlocked: false })).mockResolvedValueOnce(plan())
    vi.mocked(vaultUnlock).mockRejectedValueOnce(new Error('wrong password')).mockResolvedValueOnce({ initialized: true, unlocked: true, secretCount: 1 })
    renderDialog()
    const form = await screen.findByTestId('host-move-unlock')
    expect(form).toHaveAttribute('data-vault-id', 'team'); expect(form).toHaveTextContent('Team is locked')
    expect(confirm()).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Master password'), { target: { value: 'nope' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Unlock' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('wrong password')
    fireEvent.change(within(form).getByLabelText('Master password'), { target: { value: 'secret' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(vaultUnlock).toHaveBeenLastCalledWith('secret', 'team'))
    await waitFor(() => expect(planHostMove).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('host-move-unlock')).not.toBeInTheDocument())
    expect(confirm()).toBeEnabled()
  })

  it('moves, clears the moved hosts local caches and reports back', async () => {
    localStorage.setItem(healthCheckStorageKey('personal', 'web'), '[]')
    localStorage.setItem(healthCheckStorageKey('personal', 'other'), '[]')
    vi.mocked(moveHostsToVault).mockResolvedValue({ movedHostIds: ['web', 'bastion'], warnings: [] })
    const { onMoved } = renderDialog()
    await screen.findByTestId('host-move-plan')
    fireEvent.click(confirm())
    expect(await screen.findByTestId('host-move-done')).toHaveTextContent('Moved 2 host(s) to Team.')
    expect(moveHostsToVault).toHaveBeenCalledWith({ sourceVaultId: 'personal', targetVaultId: 'team', hostIds: ['web'] })
    expect(onMoved).toHaveBeenCalledWith(['web', 'bastion'])
    expect(localStorage.getItem(healthCheckStorageKey('personal', 'web'))).toBeNull()
    expect(localStorage.getItem(healthCheckStorageKey('personal', 'other'))).toBe('[]')
    expect(screen.queryByTestId('host-move-retry')).not.toBeInTheDocument()
  })

  it('shows warnings and retries the same move', async () => {
    vi.mocked(moveHostsToVault)
      .mockResolvedValueOnce({ movedHostIds: ['web'], warnings: ['Known hosts were not copied'] })
      .mockResolvedValueOnce({ movedHostIds: ['web'], warnings: [] })
    const { onMoved } = renderDialog()
    await screen.findByTestId('host-move-plan')
    fireEvent.click(screen.getByRole('radio', { name: 'Lab' }))
    await waitFor(() => expect(planHostMove).toHaveBeenLastCalledWith(expect.objectContaining({ targetVaultId: 'lab' })))
    await waitFor(() => expect(confirm()).toBeEnabled())
    fireEvent.click(confirm())
    expect(await screen.findByTestId('host-move-warnings')).toHaveTextContent('Known hosts were not copied')
    fireEvent.click(screen.getByTestId('host-move-retry'))
    await waitFor(() => expect(moveHostsToVault).toHaveBeenCalledTimes(2))
    expect(vi.mocked(moveHostsToVault).mock.calls[1][0]).toEqual({ sourceVaultId: 'personal', targetVaultId: 'lab', hostIds: ['web'] })
    await waitFor(() => expect(screen.queryByTestId('host-move-warnings')).not.toBeInTheDocument())
    expect(onMoved).toHaveBeenCalledTimes(2)
  })

  it('shows plan and move errors inline', async () => {
    vi.mocked(planHostMove).mockRejectedValueOnce(new Error('vault busy')).mockResolvedValueOnce(plan())
    vi.mocked(moveHostsToVault).mockRejectedValue(new Error('disk full'))
    const { onMoved } = renderDialog()
    expect(await screen.findByTestId('host-move-plan-error')).toHaveTextContent('vault busy')
    expect(confirm()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByTestId('host-move-plan')
    fireEvent.click(confirm())
    expect(await screen.findByTestId('host-move-error')).toHaveTextContent('disk full')
    expect(screen.getByTestId('host-move-dialog')).toHaveAttribute('data-phase', 'plan')
    expect(onMoved).not.toHaveBeenCalled()
  })
})
