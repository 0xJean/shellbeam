import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkOpsPanel } from './network-ops-panel'
import type { NetworkOpsSnapshot } from '@/lib/network-ops'
const { collectNetworkOps } = vi.hoisted(() => ({ collectNetworkOps: vi.fn() }))
vi.mock('@/lib/network-ops', async (original) => ({ ...await original<typeof import('@/lib/network-ops')>(), collectNetworkOps }))
vi.mock('@/components/health-checks-panel', () => ({ HealthChecksPanel: ({ activeVaultId }: { activeVaultId?: string }) => <div data-testid="network-health-checks" data-vault={activeVaultId} /> }))
const host = { id: 'host-1', name: 'Production', address: '10.0.0.1', port: 22, username: 'ops', group: 'Default', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0, jumpHost: 'bastion' }
const snapshot: NetworkOpsSnapshot = { status: 'ready', sections: { LISTEN: 'ready', CONNECTIONS: 'ready', INTERFACES: 'ready', ROUTES: 'ready', SUMMARY: 'ready' }, listeners: [{ protocol: 'tcp', state: 'LISTEN', localAddress: '[::]:443', remoteAddress: '[::]:*', port: 443, pid: '120', process: 'nginx' }], connections: [], interfaces: [{ name: 'eth0', family: 'inet', address: '10.0.0.1/24' }], routes: ['default via 10.0.0.254 dev eth0'], summary: 'TCP: 10', truncated: [], sampledAt: 1000, transport: 'proxy-jump' }
describe('Network ops panel', () => {
  beforeEach(() => { collectNetworkOps.mockReset(); collectNetworkOps.mockResolvedValue(snapshot) })
  it('renders observed sockets and routes, keeps health checks scoped and offers safe same-host handoffs', async () => {
    const onOpenTerminal = vi.fn(); const onOpenServices = vi.fn(); const onOpenLogs = vi.fn()
    render(<NetworkOpsPanel host={host} vaultId="team" resolveAuthSecret={async () => 'secret'} onOpenTerminal={onOpenTerminal} onOpenServices={onOpenServices} onOpenLogs={onOpenLogs} />)
    await screen.findByText('nginx')
    expect(screen.getByTitle('Transport: proxy-jump')).toHaveTextContent('ProxyJump')
    expect(screen.getByText('default via 10.0.0.254 dev eth0')).toBeInTheDocument()
    expect(screen.getByTestId('network-health-checks')).toHaveAttribute('data-vault', 'team')
    fireEvent.click(screen.getByRole('button', { name: 'Inspect port 443' }))
    expect(onOpenTerminal).toHaveBeenCalledWith("ss -lntup '( sport = :443 )'")
    fireEvent.click(screen.getByRole('button', { name: 'Inspect PID 120' }))
    expect(onOpenTerminal).toHaveBeenCalledWith('ps -p 120 -o pid,ppid,user,etime,rss,vsz,pcpu,pmem,stat,comm')
    fireEvent.click(screen.getByRole('button', { name: 'Open services' })); expect(onOpenServices).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open host logs' })); expect(onOpenLogs).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText('Filter sockets by address, port, state or process'), { target: { value: 'nonmatch' } })
    expect(screen.queryByText('nginx')).not.toBeInTheDocument()
  })
  it('does not render transport failure as a healthy empty socket list', async () => {
    collectNetworkOps.mockResolvedValue({ ...snapshot, status: 'unknown', listeners: [] })
    render(<NetworkOpsPanel host={host} resolveAuthSecret={async () => 'secret'} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('could not be verified')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
  it('ignores a completed response from a previously selected host', async () => {
    let resolveFirst: (value: NetworkOpsSnapshot) => void = () => {}
    collectNetworkOps.mockReturnValueOnce(new Promise<NetworkOpsSnapshot>((resolve) => { resolveFirst = resolve })).mockResolvedValueOnce({ ...snapshot, listeners: [{ ...snapshot.listeners[0], process: 'new-host' }] })
    const resolveAuthSecret = async () => 'secret'
    const view = render(<NetworkOpsPanel host={host} resolveAuthSecret={resolveAuthSecret} />)
    await waitFor(() => expect(collectNetworkOps).toHaveBeenCalledTimes(1))
    view.rerender(<NetworkOpsPanel host={{ ...host, id: 'host-2' }} resolveAuthSecret={resolveAuthSecret} />)
    await screen.findByText('new-host')
    resolveFirst(snapshot)
    await waitFor(() => expect(screen.queryByText('nginx')).not.toBeInTheDocument())
    expect(screen.getByText('new-host')).toBeInTheDocument()
  })
})
