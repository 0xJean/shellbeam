import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceProcessesApp } from './workspace-processes-app'

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

describe('workspace processes app', () => {
  beforeEach(() => {
    runSshCommand.mockReset()
  })

  it('shows a process list from the connected host', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '412 nginx 12.4 3.1 S\n278 node 8.2 6.3 S',
      stderr: '',
      exitCode: 0,
      durationMs: 15,
    })

    render(
      <WorkspaceProcessesApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByText('Process Monitor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run ps aux/i })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText('nginx')).toBeInTheDocument()
    })
    expect(screen.getByText('node')).toBeInTheDocument()
  })

  it('shows a terminal fallback command for process inspection', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '412 nginx 12.4 3.1 S',
      stderr: '',
      exitCode: 0,
      durationMs: 15,
    })

    render(
      <WorkspaceProcessesApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/ps -eo pid/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /run top/i })).toBeInTheDocument()
  })
})
