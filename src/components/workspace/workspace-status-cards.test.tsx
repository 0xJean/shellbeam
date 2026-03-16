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

  it('falls back gracefully when no host is selected', () => {
    render(
      <WorkspaceStatusCards
        hostAddress="10.0.0.15"
        selectedHostId={null}
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
  })
})
