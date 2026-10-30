import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDesktopShell } from './workspace-desktop-shell'
import { WorkspaceMobileShell } from './workspace-mobile-shell'
import type { NetworkOpsPanelProps } from './network-ops-panel'
const { networkSpy, sendInteractiveInput } = vi.hoisted(() => ({ networkSpy: vi.fn(), sendInteractiveInput: vi.fn(async () => {}) }))
vi.mock('@/lib/interactive-session', () => ({ sendInteractiveInput }))
vi.mock('./network-ops-panel', () => ({ NetworkOpsPanel: (props: NetworkOpsPanelProps) => {
  networkSpy(props)
  return <div data-testid="network-route"><button onClick={props.onOpenServices}>Network to Services</button><button onClick={() => props.onOpenLogs?.()}>Network to Logs</button><button onClick={() => props.onOpenTerminal?.("ss -lntup '( sport = :443 )'")}>Network to Terminal</button></div>
} }))
vi.mock('./provider-history-panel', () => ({ ProviderHistoryDisclosure: () => null }))
const host = { id: 'network-host', vaultId: 'team', name: 'Network host', address: '10.0.0.8', port: 22, username: 'ops', group: 'Default', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0 }

// Routing integration table: both surfaces preserve host, vault, and interactive
// session while changing app; Terminal receives a preview without an Enter key.
const routingExpectations = [
  { surface: 'desktop', Shell: WorkspaceDesktopShell, frame: 'workspace-desktop-window-network' },
  { surface: 'mobile', Shell: WorkspaceMobileShell, frame: 'workspace-mobile-app-frame' },
] as const
describe.each(routingExpectations)('$surface Network routing', ({ Shell, frame }) => {
  beforeEach(() => { networkSpy.mockClear(); sendInteractiveInput.mockClear(); localStorage.setItem('shellbeam.workspace.layout', 'desktop') })
  it('mounts the registered page and hands off within the same scoped host/session', async () => {
    const onSelectApp = vi.fn()
    render(<Shell activeApp="network" onSelectApp={onSelectApp} activeVaultId="team" sessionId="session-network" hostId={host.id} hostName={host.name} hostAddress={host.address} hosts={[host]} resolveAuthSecret={async () => 'secret'} />)
    await screen.findByTestId('network-route')
    expect(screen.getByTestId(frame)).toBeInTheDocument()
    expect(networkSpy).toHaveBeenCalledWith(expect.objectContaining({ host, vaultId: 'team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Network to Services' })); expect(onSelectApp).toHaveBeenLastCalledWith('services')
    fireEvent.click(screen.getByRole('button', { name: 'Network to Logs' })); expect(onSelectApp).toHaveBeenLastCalledWith('logs')
    fireEvent.click(screen.getByRole('button', { name: 'Network to Terminal' })); expect(onSelectApp).toHaveBeenLastCalledWith('terminal')
    await waitFor(() => expect(sendInteractiveInput).toHaveBeenCalledWith('session-network', "ss -lntup '( sport = :443 )'"))
  })

  it('does not route an old session to an identically named host in another Vault', async () => {
    const props = { activeApp: 'network' as const, onSelectApp: vi.fn(), activeVaultId: 'team', sessionVaultId: 'team', sessionId: 'session-network', hostId: host.id, hostName: host.name, hostAddress: host.address, hosts: [host], resolveAuthSecret: vi.fn(async () => 'secret') }
    const { rerender } = render(<Shell {...props} />)
    await screen.findByTestId('network-route')
    networkSpy.mockClear()
    const otherVaultHost = { ...host, vaultId: 'personal', name: 'Unrelated host', address: '10.0.9.9' }
    rerender(<Shell {...props} activeVaultId="personal" hosts={[otherVaultHost]} />)
    expect(screen.queryByTestId('network-route')).not.toBeInTheDocument()
    expect(screen.getByText(/This session belongs to another Vault/)).toBeInTheDocument()
    expect(networkSpy).not.toHaveBeenCalled()
    expect(props.resolveAuthSecret).not.toHaveBeenCalled()
    expect(sendInteractiveInput).not.toHaveBeenCalled()

    rerender(<Shell {...props} activeVaultId={undefined} />)
    expect(screen.queryByTestId('network-route')).not.toBeInTheDocument()
    expect(networkSpy).not.toHaveBeenCalled()
    rerender(<Shell {...props} />)
    expect(await screen.findByTestId('network-route')).toBeInTheDocument()
    expect(networkSpy).toHaveBeenLastCalledWith(expect.objectContaining({ host, vaultId: 'team' }))
  })
})
