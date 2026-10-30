import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetHost } from '@/hooks/use-fleet-metrics'
import type { HostProfile } from '@/lib/hosts'
import { I18nProvider } from '@/lib/i18n'

const fleet = vi.hoisted(() => ({ hosts: [] as FleetHost[], loading: false, refresh: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@/hooks/use-fleet-metrics', () => ({ useFleetMetrics: () => ({ ...fleet, alerts: [], agents: [], certificates: [], from: 0, to: 0, refreshedAt: 1, error: false }) }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/components/hosts-overview', () => ({ ProbeCoverageBanner: () => null }))
vi.mock('@/components/probe-install-dialog', () => ({ ProbeInstallDialog: () => null }))

import { MobileHostsPage } from './mobile-hosts-page'

const host = (id: string, name: string, group: string, address: string): HostProfile => ({ id, vaultId: 'v', name, address, port: 22, username: 'root', authType: 'password', group, tags: [], createdAt: 1, updatedAt: 1 })
const hosts = [host('h1', 'prod-web-01', 'Production', '47.242.18.6'), host('h2', 'db-master', 'Production', '10.0.3.12'), host('h3', 'staging-api', 'Staging', '91.107.200.4'), host('h4', 'old-box', 'Staging', '10.0.9.9')]
const metrics = (cpu: number, memory: number, disk: number) => ({
  hostname: '', os: 'Ubuntu 22.04', kernel: '', uptimeSeconds: 38 * 86_400 + 5, cpuPercent: cpu, load1: 0.82, load5: null, load15: null,
  memoryUsedBytes: 5.4 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, memoryPercent: memory, diskUsedBytes: null, diskTotalBytes: null, diskPercent: disk,
  networkRxBytesPerSec: 12.4 * 1024 ** 2, networkTxBytesPerSec: 3.1 * 1024 ** 2, latencyMs: 20, sampledAt: 1,
})
const entry = (profile: HostProfile, status: string, values: ReturnType<typeof metrics> | null, extra: Partial<FleetHost> = {}): FleetHost => ({
  host: profile, status, openAlerts: 0, history: [],
  view: { metrics: values, resource: null, inventory: values ? { containers: [{}, {}, {}, {}] } : null } as unknown as FleetHost['view'],
  ...extra,
})

function renderPage(overrides: Partial<Parameters<typeof MobileHostsPage>[0]> = {}) {
  const props = {
    hosts, activeVaultId: 'v', vaultUnlocked: true, onCreateHost: vi.fn(), onUpdateHost: vi.fn(), onDeleteHost: vi.fn(async () => {}),
    onConnectHost: vi.fn(), onOpenWorkspace: vi.fn(), onOpenPortForwarding: vi.fn(), ...overrides,
  }
  render(<I18nProvider><MobileHostsPage {...props} /></I18nProvider>)
  return props
}

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  fleet.loading = false
  fleet.hosts = [
    entry(hosts[0], 'online', metrics(42, 68, 51)),
    entry(hosts[1], 'online', metrics(30, 40, 91)),
    entry(hosts[2], 'online', null, { openAlerts: 2 }),
    entry(hosts[3], 'offline', null),
  ]
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

describe('MobileHostsPage', () => {
  it('groups hosts, counts statuses and explains what needs attention', () => {
    renderPage()
    expect(screen.getByTestId('mobile-hosts-filter-all')).toHaveTextContent('All4')
    expect(screen.getByTestId('mobile-hosts-filter-online')).toHaveTextContent('Online1')
    expect(screen.getByTestId('mobile-hosts-filter-attention')).toHaveTextContent('Alerting2')
    expect(screen.getByTestId('mobile-hosts-filter-offline')).toHaveTextContent('Offline1')
    expect(screen.getByTestId('mobile-hosts-attention')).toHaveTextContent('2 hosts need attention')
    expect(screen.getByTestId('mobile-hosts-attention')).toHaveTextContent('db-master Disk 91% · staging-api · 2 open alerts')
    const groups = screen.getAllByTestId('mobile-hosts-group')
    expect(groups.map((group) => group.querySelector('h3 span')?.textContent)).toEqual(['Production · 2', 'Staging · 2'])
    expect(within(groups[0]).getAllByTestId('mobile-host-row').map((row) => row.dataset.hostId)).toEqual(['h2', 'h1'])
    expect(within(groups[0]).getAllByRole('img')[0]).toHaveAttribute('aria-label', 'CPU 30% · Memory 40% · Disk 91%')
    expect(within(groups[1]).getByText('Offline')).toBeInTheDocument()
  })

  it('filters, searches and sorts', () => {
    renderPage()
    fireEvent.click(screen.getByTestId('mobile-hosts-attention'))
    expect(screen.getAllByTestId('mobile-host-row').map((row) => row.dataset.hostId)).toEqual(['h2', 'h3'])
    fireEvent.click(screen.getByTestId('mobile-hosts-filter-all'))
    fireEvent.change(screen.getByTestId('mobile-hosts-search'), { target: { value: '91.107' } })
    expect(screen.getAllByTestId('mobile-host-row').map((row) => row.dataset.hostId)).toEqual(['h3'])
    fireEvent.change(screen.getByTestId('mobile-hosts-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('mobile-hosts-sort'))
    expect(screen.getAllByTestId('mobile-host-row').map((row) => row.dataset.hostId)).toEqual(['h1', 'h2', 'h3', 'h4'])
  })

  it('opens a host with live status and server tools', () => {
    const props = renderPage()
    fireEvent.click(screen.getAllByTestId('mobile-host-row').find((row) => row.dataset.hostId === 'h1')!)
    expect(screen.getByTestId('mobile-host-status')).toHaveTextContent('Online')
    expect(screen.getByTestId('mobile-host-detail')).toHaveTextContent('up 38 d')
    expect(screen.getByTestId('mobile-host-tile-cpu')).toHaveTextContent('Load 0.8242%')
    expect(screen.getByTestId('mobile-host-tile-memory')).toHaveTextContent('68%5.4/ 8 GB')
    expect(screen.getByTestId('mobile-host-tile-disk')).toHaveTextContent('51%')
    expect(screen.getByTestId('mobile-host-tile-network')).toHaveTextContent('↑ 3.112.4MB/s')
    expect(screen.getByTestId('mobile-host-docker-count')).toHaveTextContent('4')
    fireEvent.click(screen.getByTestId('mobile-host-connect'))
    expect(props.onConnectHost).toHaveBeenCalledWith('h1')
    fireEvent.click(screen.getByTestId('mobile-host-workspace'))
    fireEvent.click(screen.getByTestId('mobile-host-tool-docker'))
    expect(vi.mocked(props.onOpenWorkspace).mock.calls).toEqual([['h1', 'overview'], ['h1', 'docker']])
    fireEvent.click(screen.getByTestId('mobile-host-forward'))
    expect(props.onOpenPortForwarding).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mobile-host-back'))
    expect(screen.getByTestId('mobile-hosts-page')).toBeInTheDocument()
  })

  it('shows no invented tiles without samples and deletes only after confirmation', () => {
    const props = renderPage()
    fireEvent.click(screen.getAllByTestId('mobile-host-row').find((row) => row.dataset.hostId === 'h4')!)
    expect(screen.getByTestId('mobile-host-no-live')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-host-live')).toBeNull()
    fireEvent.click(screen.getByTestId('mobile-host-more'))
    fireEvent.click(screen.getByTestId('mobile-host-delete'))
    expect(props.onDeleteHost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mobile-host-delete'))
    expect(props.onDeleteHost).toHaveBeenCalledWith('h4')
  })

  it('fills the new host form from an ssh command after a tap', async () => {
    const readText = vi.fn(async () => 'ssh -i ~/.ssh/id_ed25519_work root@47.242.18.8 -p 2222')
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'iPhone', clipboard: { readText }, permissions: { query: vi.fn(async () => { throw new TypeError('unsupported') }) } })
    renderPage({ vaultKeys: ['id_ed25519_work'] })
    fireEvent.click(screen.getByTestId('mobile-hosts-add'))
    const chip = await screen.findByTestId('clipboard-ssh-chip')
    await Promise.resolve()
    expect(readText).not.toHaveBeenCalled()
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByTestId('host-address')).toHaveValue('47.242.18.8'))
    expect(screen.getByTestId('host-port')).toHaveValue(2222)
    expect(screen.getByTestId('host-username')).toHaveValue('root')
    expect(screen.getByTestId('clipboard-ssh-filled')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mobile-new-host-close'))
    expect(screen.queryByTestId('mobile-new-host')).toBeNull()
  })

  it('offers a detected command when clipboard access is already granted and hides on denial', async () => {
    const readText = vi.fn(async () => 'ssh deploy@10.0.0.5')
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Android', clipboard: { readText }, permissions: { query: vi.fn(async () => ({ state: 'granted' })) } })
    const onAddFormClose = vi.fn()
    renderPage({ openAddForm: true, onAddFormClose })
    expect(screen.getByTestId('mobile-hosts-fab')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('clipboard-ssh-chip')).toHaveAttribute('data-state', 'found'))
    expect(screen.getByTestId('clipboard-ssh-chip')).toHaveTextContent('ssh deploy@10.0.0.5')
    fireEvent.click(screen.getByTestId('mobile-new-host-close'))
    expect(onAddFormClose).toHaveBeenCalled()
    cleanup()

    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }) }, permissions: { query: vi.fn(async () => ({ state: 'prompt' })) } })
    renderPage({ openAddForm: true })
    fireEvent.click(await screen.findByTestId('clipboard-ssh-chip'))
    await waitFor(() => expect(screen.queryByTestId('clipboard-ssh-chip')).toBeNull())
    expect(screen.getByTestId('host-address')).toHaveValue('')
  })
})
