import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => { vi.useRealTimers() })

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
    expect(screen.getByTestId('workspace-logs-app')).toHaveClass('space-y-4')
    expect(screen.getByTestId('workspace-logs-output')).toHaveClass('max-h-[26rem]', 'overflow-auto')
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

  it('opens service filters, searches locally, copies visible rows and cancels bounded follow', async () => {
    runSshCommand.mockResolvedValue({ stdout: 'healthy service\nerror worker', stderr: '', exitCode: 0, durationMs: 1 })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<WorkspaceLogsApp selectedHostId="host-1" hosts={[host]} resolveAuthSecret={async () => 'secret'} initialUnit="nginx.service" />)
    await screen.findByText(/healthy service/)
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({ command: expect.stringContaining("--unit='nginx.service'") }))
    fireEvent.change(screen.getByLabelText('Search retained log lines'), { target: { value: 'error' } })
    expect(screen.getByTestId('workspace-logs-output')).toHaveTextContent('error worker')
    expect(screen.getByTestId('workspace-logs-output')).not.toHaveTextContent('healthy service')
    expect(runSshCommand).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible logs' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('error worker'))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Follow (5 min)' }))
    await act(async () => { await Promise.resolve() })
    expect(runSshCommand).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Stop following' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(runSshCommand).toHaveBeenCalledTimes(2)
    view.unmount()
  })
})
