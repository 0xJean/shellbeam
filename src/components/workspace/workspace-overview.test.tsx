import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceModeToggle } from './workspace-mode-toggle'
import { WorkspaceOverview } from './workspace-overview'
import { clearServerMonitorStates, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import type { ServerMonitorLatest } from '@/lib/server-monitor'
import { clearLocalOpsMemory, saveLocalAlertState } from '@/lib/local-ops-store'
vi.mock('./shellbeam-agent-panel', () => ({ ShellbeamAgentPanel: () => null }))
vi.mock('@/lib/probe-persistence', () => ({ listPersistedProbeSnapshots: vi.fn(async () => []) }))

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
  it('shows the workspace app launcher and status cards', () => {
    render(
      <WorkspaceOverview
        hostName="Production API"
        hostAddress="10.0.0.15"
        activeApp="overview"
        onSelectApp={() => {}}
      />,
    )

    expect(screen.getByText('Production API')).toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
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
    mergeServerMonitorStates({ [host.id]: { history: [], latest: { status: 'online', snapshot: { sampledAt: now, diskPercent: 96, cpuPercent: 90, memoryPercent: 30 } } as ServerMonitorLatest } })
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
})
