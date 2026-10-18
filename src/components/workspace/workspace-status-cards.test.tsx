import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerMonitorHostKey } from '@/lib/server-monitor'
import { clearServerMonitorStates, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import { WorkspaceStatusCards } from './workspace-status-cards'

vi.mock('./shellbeam-agent-panel', () => ({ ShellbeamAgentPanel: () => null }))
vi.mock('@/lib/probe-persistence', () => ({ listPersistedProbeSnapshots: vi.fn(async () => []) }))

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

const snapshot = {
  hostname: 'prod-api',
  os: 'Ubuntu 24.04 LTS',
  kernel: 'Linux 6.8',
  uptimeSeconds: 86400,
  cpuPercent: 23,
  load1: 0.5,
  load5: 0.4,
  load15: 0.3,
  memoryUsedBytes: 640,
  memoryTotalBytes: 1000,
  memoryPercent: 61,
  diskUsedBytes: 740,
  diskTotalBytes: 1000,
  diskPercent: 74,
  networkRxBytesPerSec: 18.4 * 1024 * 1024,
  networkTxBytesPerSec: 4 * 1024 * 1024,
  latencyMs: 14,
  sampledAt: Date.now(),
}

describe('workspace status cards', () => {
  beforeEach(() => {
    clearServerMonitorStates()
  })
  afterEach(() => vi.useRealTimers())

  it('ages a persisted online sample to stale without another SSH request', () => {
    vi.useFakeTimers()
    const sampledAt = Date.now()
    const key = getServerMonitorHostKey(host)
    mergeServerMonitorStates({ [key]: { history: [], latest: {
      hostKey: key, hostId: host.id, hostName: host.name, hostAddress: host.address,
      username: host.username, port: host.port, status: 'online', snapshot: { ...snapshot, sampledAt },
      lastAttemptAt: sampledAt, lastSuccessAt: sampledAt, updatedAt: sampledAt,
    } } })
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'online')
    act(() => vi.advanceTimersByTime(150_000))
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'stale')
    expect(screen.getAllByText('Data stale')).not.toHaveLength(0)
    expect(screen.getByText('23%')).toBeInTheDocument()
  })

  it('shows live telemetry values from the shared monitor state', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'online',
          snapshot,
          lastAttemptAt: snapshot.sampledAt,
          lastSuccessAt: snapshot.sampledAt,
          probeTelemetry: {
            status: 'recovered',
            startedAt: snapshot.sampledAt - 180,
            completedAt: snapshot.sampledAt,
            durationMs: 180,
            attempts: 1,
            maxRetries: 2,
            retryDelayMs: 150,
            recovered: true,
            exhausted: false,
            sections: ['metrics'],
          },
          updatedAt: snapshot.sampledAt,
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getByText('23%')).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
    expect(screen.getByText('74%')).toBeInTheDocument()
    expect(screen.getByText(/↓ 18 MB\/s/)).toBeInTheDocument()
    expect(screen.getAllByText('Online').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'online')
    expect(screen.getAllByTestId('workspace-probe-telemetry')).toHaveLength(4)
    expect(screen.getAllByTestId('workspace-probe-telemetry')[0]).toHaveTextContent('Recovered from cache')
    expect(screen.getAllByTestId('workspace-probe-telemetry')[0]).toHaveTextContent('1 retries')
  })

  it('falls back gracefully when no host is selected', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={null} hosts={[host]} />)

    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'idle')
  })

  it('uses only the active Vault observation when host IDs collide', async () => {
    const vaultHost = { ...host, vaultId: 'active' }
    const otherHost = { ...host, vaultId: 'other', address: '10.0.0.99' }
    for (const [candidate, cpu] of [[host, 99], [otherHost, 88], [vaultHost, 37]] as const) {
      const key = getServerMonitorHostKey(candidate)
      mergeServerMonitorStates({ [key]: { history: [], latest: {
        hostKey: key, hostId: candidate.id, hostName: candidate.name, hostAddress: candidate.address,
        username: candidate.username, port: candidate.port, status: 'online', snapshot: { ...snapshot, cpuPercent: cpu },
        lastAttemptAt: snapshot.sampledAt, lastSuccessAt: snapshot.sampledAt, updatedAt: snapshot.sampledAt,
      } } })
    }
    const view = await act(async () => render(<WorkspaceStatusCards activeVaultId="active" hostAddress={host.address} selectedHostId={host.id} hosts={[otherHost, host]} />))
    expect(screen.getByText('37%')).toBeInTheDocument()
    expect(screen.queryByText('99%')).not.toBeInTheDocument()
    expect(screen.queryByText('88%')).not.toBeInTheDocument()
    await act(async () => view.rerender(<WorkspaceStatusCards activeVaultId="missing" hostAddress={host.address} selectedHostId={host.id} hosts={[otherHost, host]} />))
    expect(screen.queryByText('37%')).not.toBeInTheDocument()
    expect(screen.queryByText('99%')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'idle')
  })

  it('matches the current host address when host id is unavailable', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'stale',
          snapshot: { ...snapshot, cpuPercent: 31 },
          lastAttemptAt: snapshot.sampledAt,
          lastSuccessAt: snapshot.sampledAt,
          updatedAt: snapshot.sampledAt,
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={null} hosts={[host]} />)

    expect(screen.getByText('31%')).toBeInTheDocument()
    expect(screen.getAllByText('Data stale').length).toBeGreaterThan(0)
  })

  it('shows offline status without launching another SSH request', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'offline',
          snapshot: null,
          lastAttemptAt: Date.now(),
          lastSuccessAt: null,
          error: 'TCP connect failed: timed out',
          updatedAt: Date.now(),
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'offline')
  })

  it('uses a container-adaptive grid so four cards reflow inside narrow widgets', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getByTestId('workspace-status-grid')).toHaveClass('grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]')
    expect(screen.getAllByTestId('workspace-status-card')).toHaveLength(4)
  })

  it('uses the darker workspace monitor card styling from the visual language spec', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveClass('bg-[var(--workspace-surface-900)]')
    expect(screen.getAllByTestId('workspace-status-meter')[0]).toHaveClass('bg-[var(--workspace-surface-950)]')
  })
})
