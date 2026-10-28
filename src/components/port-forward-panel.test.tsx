import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))

import { PortForwardPanel } from './port-forward-panel'

const host: HostProfile = { id: 'db', name: 'db-master', address: 'db.test', port: 22, username: 'ops', authType: 'password', group: 'Default', tags: [], createdAt: 1, updatedAt: 1 }
const cache: HostProfile = { ...host, id: 'cache', name: 'redis-cache', address: 'cache.test', jumpHostId: 'db' }
const rule = (id: string, type: string, extra = {}) => ({ id, hostId: 'db', name: id, type, bindHost: '127.0.0.1', bindPort: 1080, targetHost: '10.0.3.12', targetPort: 5432, createdAt: 1, updatedAt: 1, ...extra })

let rules: ReturnType<typeof rule>[] = []
let running = new Set<string>()

describe('PortForwardPanel', () => {
  beforeEach(() => {
    localStorage.setItem('shellbeam.locale', 'en')
    rules = [rule('local-db', 'local'), rule('expose', 'remote'), rule('socks', 'dynamic', { targetHost: '', targetPort: 0, hostId: 'cache' })]
    running = new Set(['local-db'])
    invoke.mockReset()
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'list_port_forward_rules') return rules
      if (command === 'port_forward_tunnel_status') return running.has(args.ruleId as string)
      if (command === 'add_port_forward_rule') { rules = [...rules, rule('new', (args.payload as { type: string }).type)]; return rules.at(-1) }
      if (command === 'start_port_forward_tunnel') { if (args.ruleId === 'expose') throw 'REMOTE_FORWARD_REJECTED'; running.add(args.ruleId as string); return null }
      if (command === 'stop_port_forward_tunnel') { running.delete(args.ruleId as string); return null }
      return null
    })
  })

  it('shows each rule type, the mapping through the SSH host and type explanations', async () => {
    render(<PortForwardPanel hosts={[host, cache]} vaultId="v" />)
    const socks = await screen.findByTestId('port-forward-rule-socks')
    expect(within(socks).getByTestId('port-forward-type-chip')).toHaveTextContent('SOCKS -D')
    expect(within(socks).getByText('dynamic proxy')).toBeInTheDocument()
    expect(within(socks).getByText(/redis-cache · via db-master/)).toBeInTheDocument()
    const local = screen.getByTestId('port-forward-rule-local-db')
    expect(within(local).getByTestId('port-forward-type-chip')).toHaveTextContent('Local -L')
    expect(within(local).getByText('10.0.3.12:5432')).toBeInTheDocument()
    expect(within(local).getByText('Running')).toBeInTheDocument()
    expect(within(screen.getByTestId('port-forward-rule-expose')).getByText('this machine')).toBeInTheDocument()
    expect(screen.getByText('1 running · 3 rules · rules are saved with the vault')).toBeInTheDocument()
    expect(screen.getByText('Dynamic SOCKS -D')).toBeInTheDocument()
  })

  it('saves a dynamic rule as dynamic without a target', async () => {
    const onOutput = vi.fn()
    render(<PortForwardPanel hosts={[host]} vaultId="v" onOutput={onOutput} />)
    await screen.findByTestId('port-forward-rule-socks')
    fireEvent.click(screen.getAllByRole('button', { name: /Add Rule/ })[0])
    fireEvent.change(screen.getByRole('combobox', { name: 'Select host' }), { target: { value: 'db' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. DB tunnel'), { target: { value: 'Proxy' } })
    fireEvent.click(screen.getByTestId('port-forward-type-dynamic'))
    expect(screen.getByTestId('port-forward-dynamic-hint')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onOutput).toHaveBeenCalledWith('Port forward rule added'))
    expect(invoke).toHaveBeenCalledWith('add_port_forward_rule', {
      payload: { hostId: 'db', name: 'Proxy', type: 'dynamic', bindHost: '127.0.0.1', bindPort: 8080, targetHost: '', targetPort: 0 },
      vaultId: 'v',
    })
  })

  it('starts and stops tunnels from the switch and offers retry after a failed start', async () => {
    const onError = vi.fn()
    render(<PortForwardPanel hosts={[host, cache]} vaultId="v" onError={onError} />)
    const socksSwitch = await screen.findByRole('switch', { name: 'Start socks' })
    fireEvent.click(socksSwitch)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Stop socks' })).toHaveAttribute('aria-checked', 'true'))
    expect(invoke).toHaveBeenCalledWith('start_port_forward_tunnel', { ruleId: 'socks', vaultId: 'v' })
    fireEvent.click(screen.getByRole('switch', { name: 'Stop local-db' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_port_forward_tunnel', { ruleId: 'local-db' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Start expose' }))
    const expose = screen.getByTestId('port-forward-rule-expose')
    await waitFor(() => expect(within(expose).getByText('Start failed')).toBeInTheDocument())
    expect(onError).toHaveBeenCalled()
    expect(within(expose).getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('shows traffic and running time for running tunnels only, with totals in the summary', async () => {
    const startedAt = Date.now() - 2 * 3600_000 - 60_000
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'list_port_forward_rules') return rules
      if (command === 'port_forward_tunnel_status') return running.has(args.ruleId as string)
      if (command === 'port_forward_tunnel_stats') return [
        { ruleId: 'local-db', running: true, bytesIn: 182 * 1024 * 1024, bytesOut: 12 * 1024 * 1024, startedAt },
        // A registered but stopped tunnel never shows numbers.
        { ruleId: 'socks', running: false, bytesIn: 0, bytesOut: 0, startedAt },
      ]
      return null
    })
    render(<PortForwardPanel hosts={[host, cache]} vaultId="v" />)
    const local = await screen.findByTestId('port-forward-rule-local-db')
    await waitFor(() => expect(within(local).getByTestId('port-forward-traffic')).toHaveTextContent('↓ 182 MB · ↑ 12.0 MB'))
    expect(within(local).getByText('Running 2 h')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('port_forward_tunnel_stats', { ruleId: undefined })
    expect(within(screen.getByTestId('port-forward-rule-socks')).queryByTestId('port-forward-traffic')).toBeNull()
    expect(within(screen.getByTestId('port-forward-rule-expose')).queryByTestId('port-forward-traffic')).toBeNull()
    expect(screen.getByTestId('port-forward-traffic-total')).toHaveTextContent('↓ 182 MB · ↑ 12.0 MB total')
  })

  it('shows no traffic or totals when nothing is running', async () => {
    running = new Set()
    render(<PortForwardPanel hosts={[host, cache]} vaultId="v" />)
    await screen.findByTestId('port-forward-rule-local-db')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('port_forward_tunnel_stats', { ruleId: undefined }))
    expect(screen.queryByTestId('port-forward-traffic')).toBeNull()
    expect(screen.queryByTestId('port-forward-traffic-total')).toBeNull()
  })
})
