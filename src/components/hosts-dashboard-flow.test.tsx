import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostsDashboard } from './hosts-dashboard'
import { I18nProvider } from '@/lib/i18n'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import type { HostProfile } from '@/lib/hosts'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => command === 'mcp_list_project_deployments' ? { projects: [], total: 0, observedAt: 0 } : []) }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/host-ops-view', async (original) => ({ ...(await original<typeof import('@/lib/host-ops-view')>()), loadHostOpsViews: vi.fn() }))
const hosts: HostProfile[] = ['API host', 'DB host'].map((name, i) => ({ id: `host-${i}`, name, address: `10.0.0.${i + 1}`, port: 22, username: 'ops', authType: 'password', group: 'Production', tags: [], createdAt: 1, updatedAt: 1 }))
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('shellbeam.locale', 'en')
  const views = buildHostOpsViews({ hosts })
  const now = Date.now()
  views['host-0'] = { ...views['host-0'], health: { ...views['host-0'].health, state: 'online', provider: 'komari', freshness: { sampledAt: now, updatedAt: now, ageMs: 0, stale: false, ttlMs: 60_000 } }, resource: { hostname: 'api', os: 'Ubuntu', kernel: '', uptime: '', cpuPercent: 95, diskPercent: 90, memoryPercent: 50, memoryText: '', diskText: '', network: '' }, capabilities: ['docker', 'metrics'], highestAlertSeverity: 'critical', alertOpenCount: 1, localAlertOpen: 1 }
  views['host-1'] = { ...views['host-1'], health: { ...views['host-1'].health, state: 'stale', provider: 'ssh-agentless', freshness: { sampledAt: now - 600_000, updatedAt: now - 600_000, ageMs: 600_000, stale: true, ttlMs: 60_000 } }, resource: { hostname: 'db', os: 'Debian', kernel: '', uptime: '', cpuPercent: 10, diskPercent: null, memoryPercent: 20, memoryText: '', diskText: '', network: '' }, capabilities: ['services'], highestAlertSeverity: null, alertOpenCount: 0 }
  vi.mocked(loadHostOpsViews).mockReset().mockResolvedValue(views)
})
function renderDashboard() { return render(<I18nProvider><HostsDashboard activeVaultId="vault" hosts={hosts} selectedHostId={null} loading={false} onSelectHost={vi.fn()} onCreateHost={vi.fn()} onUpdateHost={vi.fn()} onDeleteHost={vi.fn()} /></I18nProvider>) }
describe('host operations filter workflow', () => {
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
