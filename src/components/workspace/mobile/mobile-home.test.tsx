import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMobileShell } from '../workspace-mobile-shell'
import { clearWorkspaceInventoryStates, mergeWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey, type WorkspaceInventory } from '@/lib/workspace-inventory'
import type { WorkspaceAppId } from '@/lib/workspace'
import { MOBILE_HOME_PREFS_KEY } from './mobile-home-prefs'

const { invoke, sendInteractiveInput } = vi.hoisted(() => ({ invoke: vi.fn(async () => []), sendInteractiveInput: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/interactive-session', () => ({ sendInteractiveInput }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('../provider-history-panel', () => ({ ProviderHistoryDisclosure: () => null }))
vi.mock('../workspace-recommendations-panel', () => ({ WorkspaceRecommendationsPanel: () => null }))
vi.mock('../workspace-status-cards', () => ({ WorkspaceStatusCards: () => <div data-testid="workspace-status-cards" /> }))

const host = { id: 'web-1', vaultId: 'team', name: 'prod-web-01', address: '10.0.0.7', port: 22, username: 'root', group: 'Default', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0 }
const inventory: WorkspaceInventory = {
  resource: { hostname: 'web', os: 'Linux', kernel: '', uptime: '', cpuPercent: null, memoryPercent: null, memoryText: '', diskPercent: null, diskText: '', network: '' },
  tools: [], pm2: [], projects: [], scannedAt: Date.now(),
  services: [{ name: 'nginx.service', active: 'active', enabled: 'enabled' }, { name: 'worker.service', active: 'failed', enabled: 'enabled' }],
  containers: [{ name: 'api-server', image: 'api:1', status: 'Up 3 days', ports: '' }, { name: 'postgres-exp', image: 'postgres:16', status: 'Exited (0) 2 hours ago', ports: '' }],
}

async function renderShell(app: WorkspaceAppId = 'overview', onSelectApp = vi.fn()) {
  const view = await act(async () => render(<WorkspaceMobileShell activeVaultId="team" sessionId="session-1" hostId={host.id} hostName={host.name} hostAddress={host.address} hosts={[host]} activeApp={app} onSelectApp={onSelectApp} resolveAuthSecret={async () => 'secret'} />))
  return { ...view, onSelectApp }
}

describe('v3 mobile home', () => {
  beforeEach(() => {
    localStorage.clear(); clearWorkspaceInventoryStates(); invoke.mockClear(); sendInteractiveInput.mockClear()
  })

  it('shows honest empty widgets when the host has no data yet', async () => {
    await renderShell()
    expect(within(screen.getByTestId('mobile-widget-host')).getByText('No resource sample yet')).toBeInTheDocument()
    expect(within(screen.getByTestId('mobile-widget-cpu')).getByText('No recorded CPU history yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Page 2' }))
    expect(within(screen.getByTestId('mobile-widget-docker')).getByText('Not scanned yet')).toBeInTheDocument()
    expect(within(screen.getByTestId('mobile-widget-certs')).getByText('No certificates yet')).toBeInTheDocument()
    expect(within(screen.getByTestId('mobile-widget-tasks')).getByText('No scheduled tasks')).toBeInTheDocument()
    expect(within(screen.getByTestId('mobile-widget-network')).getByText('No network samples yet')).toBeInTheDocument()
  })

  it('fills widgets and badges from inventory, certificate cache and scheduled tasks', async () => {
    const now = Date.now()
    mergeWorkspaceInventoryStates({ [getWorkspaceInventoryHostKey(host)]: { status: 'ready', inventory, updatedAt: now } })
    localStorage.setItem('shellbeam.certificates.team', JSON.stringify([{ hostId: host.id, path: '/etc/ssl/a.pem', domains: ['shellbeam.dev'], notAfter: now + 64.5 * 86_400_000, observedAt: now }]))
    localStorage.setItem('shellbeam.scheduled-tasks.v1:team:web-1', JSON.stringify([{ id: 't1', hostId: host.id, name: 'Backup Postgres', command: 'pg_dump', intervalMinutes: 60, enabled: true, lastRunAt: null, nextRunAt: now + 3_600_000, lastStatus: 'idle', lastResultSummary: null, lastErrorSummary: null, createdAt: now, updatedAt: now }]))
    const { onSelectApp } = await renderShell()
    expect(screen.getByRole('button', { name: 'Services · 1 failed services' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Docker · 1 exited containers' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Page 2' }))
    const docker = screen.getByTestId('mobile-widget-docker')
    expect(docker).toHaveTextContent('2 containers · 1 exited')
    expect(within(docker).getByText('postgres-exp')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-widget-certs')).toHaveTextContent('64d')
    expect(screen.getByTestId('mobile-widget-certs')).toHaveTextContent('shellbeam.dev')
    expect(screen.getByTestId('mobile-widget-tasks')).toHaveTextContent('Next: Backup Postgres')
    fireEvent.click(docker)
    expect(onSelectApp).toHaveBeenCalledWith('docker')
  })

  it('saves widget choices and the list layout on this device', async () => {
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Add widgets' }))
    fireEvent.click(screen.getByTestId('mobile-widget-option-docker'))
    fireEvent.click(screen.getByTestId('mobile-widget-option-cpu'))
    fireEvent.click(screen.getByTestId('mobile-widget-gallery-save'))
    expect(JSON.parse(localStorage.getItem(MOBILE_HOME_PREFS_KEY)!).widgets).toEqual(['host', 'certs', 'tasks', 'network'])
    expect(screen.queryByTestId('mobile-widget-cpu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Page 2' }))
    expect(screen.queryByTestId('mobile-widget-docker')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mobile-home-layout-toggle'))
    expect(screen.getByTestId('mobile-app-list')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(MOBILE_HOME_PREFS_KEY)!).layout).toBe('list')
  })

  it('searches apps and scanned services from the home screen', async () => {
    mergeWorkspaceInventoryStates({ [getWorkspaceInventoryHostKey(host)]: { status: 'ready', inventory, updatedAt: Date.now() } })
    const { onSelectApp } = await renderShell()
    fireEvent.click(screen.getByTestId('mobile-home-search'))
    fireEvent.change(screen.getByTestId('mobile-spotlight-input'), { target: { value: 'nginx' } })
    const services = within(screen.getByRole('region', { name: 'Services' }))
    expect(services.getByText('nginx.service')).toBeInTheDocument()
    fireEvent.click(services.getByRole('button', { name: 'Logs' }))
    expect(onSelectApp).toHaveBeenCalledWith('logs')
    expect(screen.queryByTestId('mobile-spotlight')).not.toBeInTheDocument()
  })

  it('opens quick actions on long press and types into the session terminal', async () => {
    const { onSelectApp } = await renderShell()
    fireEvent.contextMenu(screen.getByTestId('mobile-home-app-docker'))
    const menu = within(screen.getByRole('menu'))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Type docker ps in Terminal' }))
    expect(onSelectApp).toHaveBeenCalledWith('terminal')
    expect(sendInteractiveInput).toHaveBeenCalledWith('session-1', 'docker ps')
  })

  it('lists apps opened in this session in the switcher', async () => {
    const { rerender, onSelectApp } = await renderShell('services')
    const props = { activeVaultId: 'team', sessionId: 'session-1', hostId: host.id, hostName: host.name, hostAddress: host.address, hosts: [host], onSelectApp }
    await act(async () => rerender(<WorkspaceMobileShell {...props} activeApp="logs" />))
    fireEvent.click(screen.getByTestId('workspace-mobile-switcher-button'))
    expect(screen.getByTestId('mobile-switcher-card-logs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close Services' }))
    expect(screen.queryByTestId('mobile-switcher-card-services')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }))
    expect(onSelectApp).toHaveBeenCalledWith('logs')
  })
})
