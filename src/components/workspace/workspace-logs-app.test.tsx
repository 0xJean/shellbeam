import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceLogsApp } from './workspace-logs-app'

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

describe('workspace logs app', () => {
  beforeEach(() => {
    runSshCommand.mockReset()
  })

  it('loads logs from the active source', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'Mar 17 sshd[1]: Accepted publickey',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceLogsApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Accepted publickey/i)).toBeInTheDocument()
    })
  })

  it('falls back to host address when host id is missing', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'Mar 17 kernel: healthy',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceLogsApp
        selectedHostId={null}
        hostAddress="10.0.0.15"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/healthy/i)).toBeInTheDocument()
    })
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
      hostId: 'host-1',
      host: '10.0.0.15',
    }))
  })
})
