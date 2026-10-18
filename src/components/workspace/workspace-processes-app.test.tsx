import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      stdout: '412 12.4 3.1 S nginx\n278 8.2 6.3 S node',
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
    expect(screen.getByTestId('workspace-processes-app')).toHaveClass('space-y-4')
    expect(screen.getByTestId('workspace-processes-list')).toHaveClass('max-h-[26rem]', 'overflow-auto')
  })

  it('shows a terminal fallback command for process inspection', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '412 12.4 3.1 S nginx',
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

  it('falls back to the active host address when host id is missing', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '412 12.4 3.1 S nginx',
      stderr: '',
      exitCode: 0,
      durationMs: 15,
    })

    render(
      <WorkspaceProcessesApp
        selectedHostId={null}
        hostAddress="10.0.0.15"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('nginx')).toBeInTheDocument()
    })
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
      hostId: 'host-1',
      host: '10.0.0.15',
    }))
  })

  it('paginates the bounded process snapshot, sorts locally and opens safe process details', async () => {
    runSshCommand.mockImplementation(async (payload) => ({
      stdout: payload.command.includes(' -p ') ? 'PID PPID USER ELAPSED RSS VSZ CPU MEM STAT COMMAND\n1 0 root 01:00 2 4 0 0 S worker-1' : Array.from({ length: 60 }, (_, index) => `${index + 1} ${index + 1}.0 1.0 S worker-${index + 1}`).join('\n'),
      stderr: '', exitCode: 0, durationMs: 1,
    }))
    render(<WorkspaceProcessesApp selectedHostId="host-1" hosts={[host]} resolveAuthSecret={async () => 'secret'} />)
    await screen.findByText('worker-60')
    expect(screen.queryByText('worker-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('worker-1')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Sort processes'), { target: { value: 'pid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inspect PID 1' }))
    await screen.findByText(/PID PPID USER ELAPSED/)
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'ps -p 1 -o pid,ppid,user,etime,rss,vsz,pcpu,pmem,stat,comm' }))
    expect(runSshCommand.mock.calls.some(([payload]) => payload.command.includes('args'))).toBe(false)
  })
})
