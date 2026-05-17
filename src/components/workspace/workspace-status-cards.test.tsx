import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStatusCards } from './workspace-status-cards'

const runSshCommand = vi.fn()

vi.mock('@/lib/sessions', () => ({
  runSshCommand: (payload: unknown) => runSshCommand(payload),
}))

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

describe('workspace status cards', () => {
  beforeEach(() => {
    runSshCommand.mockReset()
  })

  it('shows real telemetry values from the connected host', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'cpu:23\nmemory:61\ndisk:74\nnetwork:18.4 MB/s',
      stderr: '',
      exitCode: 0,
      durationMs: 14,
    })

    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('23%')).toBeInTheDocument()
    })
    expect(screen.getByText('61%')).toBeInTheDocument()
    expect(screen.getByText('74%')).toBeInTheDocument()
    expect(screen.getByText('18.4 MB/s')).toBeInTheDocument()
  })

  it('falls back gracefully when no host is selected', async () => {
    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId={null}
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
    })
  })

  it('loads telemetry by matching the current host address when host id is unavailable', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'cpu:31\nmemory:48\ndisk:52\nnetwork:12.1 KB/s',
      stderr: '',
      exitCode: 0,
      durationMs: 11,
    })

    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId={null}
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('31%')).toBeInTheDocument()
    })
  })

  it('marks telemetry as unreachable when the host cannot be accessed', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '',
      stderr: 'TCP connect failed: timed out',
      exitCode: -1,
      durationMs: 15000,
      errorType: 'network',
      errorCode: 'network_error',
      errorSource: 'ssh',
      retryable: true,
    })

    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Unreachable').length).toBeGreaterThan(0)
    })
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'unreachable')
  })

  it('uses a container-adaptive grid so four cards reflow inside narrow widgets', async () => {
    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('workspace-status-grid')).toHaveClass('grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]')
    })
    expect(screen.getAllByTestId('workspace-status-card')).toHaveLength(4)
  })

  it('uses the darker workspace monitor card styling from the visual language spec', async () => {
    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveClass('bg-[var(--workspace-surface-900)]')
    })
    expect(screen.getAllByTestId('workspace-status-meter')[0]).toHaveClass('bg-[rgba(8,15,22,0.9)]')
  })
})
