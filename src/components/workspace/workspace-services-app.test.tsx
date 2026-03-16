import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceServicesApp } from './workspace-services-app'

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

describe('workspace services app', () => {
  beforeEach(() => {
    runSshCommand.mockReset()
  })

  it('renders a systemd-focused services workspace app', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'nginx.service loaded active running A high performance web server\nssh.service loaded active running OpenBSD Secure Shell server',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceServicesApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByText('Service Control')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getAllByText('nginx.service').length).toBeGreaterThan(0)
    })
    expect(screen.getByRole('button', { name: /restart nginx.service/i })).toBeInTheDocument()
  })

  it('shows unsupported state copy when systemd data is unavailable', async () => {
    runSshCommand.mockRejectedValue(new Error('System has not been booted with systemd as init system'))

    render(
      <WorkspaceServicesApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/systemd services are not available/i)).toBeInTheDocument()
    })
  })

  it('uses host address fallback when host id is unavailable', async () => {
    runSshCommand.mockResolvedValue({
      stdout: 'nginx.service loaded active running A high performance web server',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceServicesApp
        selectedHostId={null}
        hostAddress="10.0.0.15"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText('nginx.service').length).toBeGreaterThan(0)
    })
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
      hostId: 'host-1',
      host: '10.0.0.15',
    }))
  })
})
