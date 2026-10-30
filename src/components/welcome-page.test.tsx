import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomePage } from './welcome-page'
import { useWelcomePage } from '@/hooks/use-welcome-page'
import { offerVaultSetup } from '@/lib/vault-setup-handoff'
import { parseSshConfig } from '@/lib/hosts'
import { updateVault } from '@/lib/vaults'

const mocks = vi.hoisted(() => ({
  vault: {
    vaultStatusState: { initialized: false, unlocked: false, secretCount: 0 } as { initialized: boolean; unlocked: boolean; secretCount: number } | null,
    vaults: [{ id: 'personal', name: 'Personal', createdAt: 0, isDefault: true }],
    activeVaultId: 'personal',
    refreshVaults: vi.fn(async () => {}),
  },
  app: { setPcSidebarNav: vi.fn() },
  hosts: { setPcOpenAddHost: vi.fn(), refreshHosts: vi.fn(async () => {}) },
}))

vi.mock('@/contexts/vault-context', () => ({ useVault: () => mocks.vault }))
vi.mock('@/contexts/app-context', () => ({ useApp: () => mocks.app }))
vi.mock('@/contexts/hosts-context', () => ({ useHosts: () => mocks.hosts }))
vi.mock('@/lib/hosts', () => ({ parseSshConfig: vi.fn() }))
vi.mock('@/lib/vaults', () => ({ updateVault: vi.fn(async () => ({})) }))
vi.mock('@/components/ssh-import-dialog', () => ({
  SshImportDialog: ({ onImported }: { onImported: () => void }) => <button type="button" data-testid="ssh-import-dialog" onClick={onImported} />,
}))

const SSH_ENTRIES = [
  { alias: 'prod-web-01', hostName: '47.242.18.6', port: null, user: 'root', identityFile: null, proxyJump: null },
  { alias: 'db-master', hostName: '10.0.3.12', port: 2222, user: 'postgres', identityFile: '~/.ssh/id', proxyJump: 'bastion' },
]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('shellbeam.locale', 'en')
  mocks.vault.vaultStatusState = { initialized: false, unlocked: false, secretCount: 0 }
  vi.mocked(parseSshConfig).mockResolvedValue(SSH_ENTRIES)
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })

function fillVaultForm(password = 'Str0ng!Passw0rd') {
  fireEvent.change(screen.getByTestId('welcome-master-password'), { target: { value: password } })
  fireEvent.change(screen.getByTestId('welcome-confirm-password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('checkbox'))
}

describe('welcome onboarding', () => {
  it('offers the tutorial, skip, monitoring, and MCP without initiating any action', () => {
    const onDismiss = vi.fn()
    const onOpenGuide = vi.fn()
    render(<WelcomePage onDismiss={onDismiss} onOpenGuide={onOpenGuide} />)
    expect(screen.getByText('Native server monitoring')).toBeInTheDocument()
    expect(screen.getByText('Agent access (MCP)')).toBeInTheDocument()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(onOpenGuide).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start the guided tour' }))
    expect(onOpenGuide).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Go straight to the app' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
  it('creates the vault through the gate handler and moves on to adding hosts', async () => {
    const submit = vi.fn(async () => {})
    render(<WelcomePage onDismiss={vi.fn()} onOpenGuide={vi.fn()} />)
    let release = () => {}
    act(() => { release = offerVaultSetup(submit) })
    const create = screen.getByTestId('welcome-create-vault')
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByTestId('welcome-master-password'), { target: { value: 'Str0ng!Passw0rd' } })
    fireEvent.change(screen.getByTestId('welcome-confirm-password'), { target: { value: 'different' } })
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByTestId('welcome-confirm-password'), { target: { value: 'Str0ng!Passw0rd' } })
    expect(create).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(create).toBeEnabled()
    fireEvent.click(create)
    await screen.findByText('Step 2 of 2')
    expect(submit).toHaveBeenCalledWith('Str0ng!Passw0rd')
    expect(updateVault).not.toHaveBeenCalled()
    expect(await screen.findByText('prod-web-01')).toBeInTheDocument()
    expect(screen.getByText(/postgres@10\.0\.3\.12:2222/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 hosts' })).toBeEnabled()
    act(release)
  })
  it('keeps the form open with the error when creation fails, and cannot create without the gate handler', async () => {
    render(<WelcomePage onDismiss={vi.fn()} onOpenGuide={vi.fn()} />)
    fillVaultForm()
    expect(screen.getByTestId('welcome-create-vault')).toBeDisabled()
    let release = () => {}
    act(() => { release = offerVaultSetup(vi.fn(async () => { throw new Error('disk full') })) })
    fireEvent.click(screen.getByTestId('welcome-create-vault'))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
    act(release)
  })
  it('renames the vault when the name was changed', async () => {
    render(<WelcomePage onDismiss={vi.fn()} onOpenGuide={vi.fn()} />)
    let release = () => {}
    act(() => { release = offerVaultSetup(vi.fn(async () => {})) })
    fireEvent.change(screen.getByDisplayValue('Personal'), { target: { value: 'Work' } })
    fillVaultForm()
    fireEvent.click(screen.getByTestId('welcome-create-vault'))
    await screen.findByText('Step 2 of 2')
    expect(updateVault).toHaveBeenCalledWith('personal', 'Work')
    expect(mocks.vault.refreshVaults).toHaveBeenCalled()
    act(release)
  })
  it('starts at host setup for an existing vault and opens the existing add-host and import flows', async () => {
    mocks.vault.vaultStatusState = { initialized: true, unlocked: true, secretCount: 2 }
    const onDismiss = vi.fn()
    render(<WelcomePage onDismiss={onDismiss} onOpenGuide={vi.fn()} />)
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 hosts' }))
    fireEvent.click(screen.getByTestId('ssh-import-dialog'))
    expect(mocks.hosts.refreshHosts).toHaveBeenCalled()
    expect(mocks.app.setPcSidebarNav).toHaveBeenCalledWith('hosts')
    expect(onDismiss).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('radio', { name: /Add manually/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    expect(mocks.hosts.setPcOpenAddHost).toHaveBeenCalledWith(true)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })
  it('falls back to manual add when ~/.ssh/config has no hosts', async () => {
    mocks.vault.vaultStatusState = { initialized: true, unlocked: true, secretCount: 0 }
    vi.mocked(parseSshConfig).mockResolvedValue([])
    render(<WelcomePage onDismiss={vi.fn()} onOpenGuide={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('No hosts found in ~/.ssh/config')).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: /Add manually/ })).toHaveAttribute('aria-checked', 'true')
  })
  it('shows on first launch and respects existing welcomeSeen on later launches', () => {
    const first = renderHook(useWelcomePage)
    expect(first.result.current.show).toBe(true)
    act(() => first.result.current.dismiss())
    expect(first.result.current.show).toBe(false)
    first.unmount()
    const later = renderHook(useWelcomePage)
    expect(later.result.current.show).toBe(false)
    expect(localStorage.getItem('shellbeam.guide.v1')).toBeNull()
  })
  it('can dismiss even if local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { result } = renderHook(useWelcomePage)
    act(() => result.current.dismiss())
    expect(result.current.show).toBe(false)
  })
})
