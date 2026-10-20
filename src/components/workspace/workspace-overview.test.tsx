import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeToggle } from './workspace-mode-toggle'
import { WorkspaceOverview } from './workspace-overview'
import { clearServerMonitorStates, createServerMonitorLatest, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import { getServerMonitorHostKey, type ServerMonitorSnapshot } from '@/lib/server-monitor'
import { clearLocalOpsMemory, saveLocalAlertState } from '@/lib/local-ops-store'
vi.mock('./shellbeam-agent-panel', () => ({ ShellbeamAgentPanel: () => null }))
vi.mock('@/lib/probe-persistence', async (original) => ({ ...await original<typeof import('@/lib/probe-persistence')>(), listPersistedProbeSnapshots: vi.fn(async () => []) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

function pressureMetrics(sampledAt: number): ServerMonitorSnapshot {
  return { hostname: 'api', os: 'Linux', kernel: '', sampledAt, diskPercent: 96, cpuPercent: 90, memoryPercent: 30,
    uptimeSeconds: null, load1: null, load5: null, load15: null, memoryUsedBytes: null, memoryTotalBytes: null,
    diskUsedBytes: null, diskTotalBytes: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, latencyMs: null }
}

describe('workspace mode toggle', () => {
  it('renders terminal and workspace options and calls onChange', () => {
    const onChange = vi.fn()

    render(<WorkspaceModeToggle mode="terminal" onChange={onChange} />)

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    expect(onChange).toHaveBeenCalledWith('workspace')
  })
})

describe('workspace overview', () => {
  beforeEach(() => { clearServerMonitorStates(); clearLocalOpsMemory(); localStorage.clear() })
  it('keeps SSH apps available without empty metric cards', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Production API')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-resources-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-status-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Komari')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /file transfer/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /file system/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /logs/i })).toBeInTheDocument()
  })

  it('shows recent activity entries when available', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
        activityItems={[
          { id: '1', label: 'Restarted nginx', detail: '2m ago' },
        ]}
      />,
    )

    expect(screen.getByText('Restarted nginx')).toBeInTheDocument()
    expect(screen.getByText('2m ago')).toBeInTheDocument()
  })

  it('navigates to a selected workspace app', () => {
    const onSelectApp = vi.fn()

    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={onSelectApp}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /services/i }))

    expect(onSelectApp).toHaveBeenCalledWith('services')
  })

  it('renders recommendations from rule-based helpers', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
        recommendations={[
          { id: 'disk', title: 'Disk is getting full', targetApp: 'fileTransfer' },
        ]}
      />,
    )

    expect(screen.getByText('Disk is getting full')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open file transfer/i })).toBeInTheDocument()
  })

  it('uses current host metrics and vault-scoped alerts to show actionable diagnostics', async () => {
    const host = { id: 'host-1', name: 'Production API', address: '10.0.0.15', port: 22, username: 'root', group: 'Default', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0 }
    const now = Date.now()
    const scoped = { ...host, vaultId: 'team' }
    mergeServerMonitorStates({ [getServerMonitorHostKey(scoped)]: { history: [], latest: createServerMonitorLatest(scoped, 'online', now, undefined, { snapshot: pressureMetrics(now) }) } })
    const onSelectApp = vi.fn()
    await act(async () => { render(<WorkspaceOverview activeVaultId="team" hostId={host.id} hosts={[host]} hostName={host.name} hostAddress={host.address} activeApp="overview" onSelectApp={onSelectApp} />) })
    expect(screen.getByText('Inspect CPU or memory pressure')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open file system' }))
    expect(onSelectApp).toHaveBeenCalledWith('fileSystem')
    act(() => { saveLocalAlertState('another-vault', host.id, { version: 1, evaluations: [], audit: [], alerts: [{ ruleId: 'disk', hostId: host.id, name: 'Disk', metric: 'disk', status: 'active', severity: 'warning', openedAt: now, updatedAt: now, resolvedAt: null, value: 96, source: 'ssh-agentless', transport: 'direct' }] }) })
    expect(screen.queryByText('Investigate active host alerts in logs')).not.toBeInTheDocument()
    act(() => { saveLocalAlertState('team', host.id, { version: 1, evaluations: [], audit: [], alerts: [{ ruleId: 'disk', hostId: host.id, name: 'Disk', metric: 'disk', status: 'active', severity: 'warning', openedAt: now, updatedAt: now, resolvedAt: null, value: 96, source: 'ssh-agentless', transport: 'direct' }] }) })
    expect(screen.getByText('Investigate active host alerts in logs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }))
    expect(onSelectApp).toHaveBeenLastCalledWith('logs')
  })

  it('does not treat future metrics or another Vault observation as current recommendations', async () => {
    const host = { id: 'same-id', vaultId: 'team', name: 'API', address: '10.0.0.15', port: 22, username: 'ops', group: 'Default', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0 }
    const now = Date.now()
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: { history: [], latest: createServerMonitorLatest(host, 'online', now, undefined, { snapshot: pressureMetrics(now + 60_000) }) },
      [getServerMonitorHostKey({ ...host, vaultId: 'other' })]: { history: [], latest: createServerMonitorLatest({ ...host, vaultId: 'other' }, 'online', now, undefined, { snapshot: pressureMetrics(now) }) },
    })
    await act(async () => render(<WorkspaceOverview activeVaultId="team" hostId={host.id} hosts={[host]} hostName={host.name} hostAddress={host.address} activeApp="overview" onSelectApp={() => {}} />))
    expect(screen.queryByText('Inspect CPU or memory pressure')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-recommendations')).not.toBeInTheDocument()
  })
})
