import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getServerMonitorHostKey } from '@/lib/server-monitor'
import { clearServerMonitorStates, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import { WorkspaceStatusCards } from './workspace-status-cards'

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
  })

  it('falls back gracefully when no host is selected', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={null} hosts={[host]} />)

    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
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
