import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceServicesApp } from './workspace-services-app'

const runSshCommand = vi.fn()
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
    invoke.mockReset()
    invoke.mockImplementation(async (command, payload) => command === 'operation_job_create' ? { ...payload.request, jobId: 'service-job', auditId: 'audit', status: 'queued' } : command === 'operation_job_update' ? payload.request : [])
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
    expect(screen.getByTestId('workspace-services-app')).toHaveClass('space-y-4')
    expect(screen.getByTestId('workspace-services-output')).toHaveClass('max-h-[20rem]', 'overflow-auto')
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

  it('preserves full service identity and load metadata when selecting a long second row for diagnosis', async () => {
    const unit = 'applicationwithanuninterruptedlongservicenamefornarrowviewports.service'
    const onOpenLogs = vi.fn()
    runSshCommand.mockImplementation(async (payload) => ({
      stdout: payload.command.startsWith('systemctl list-units')
        ? `nginx.service loaded active running Web server\n${unit} loaded failed auto-restart Narrow service description`
        : `Observed status for ${unit}`,
      stderr: '', exitCode: 0, durationMs: 1,
    }))
    render(<WorkspaceServicesApp selectedHostId="host-1" hosts={[{ ...host, vaultId: 'team' }]} resolveAuthSecret={async () => 'secret'} vaultId="team" onOpenLogs={onOpenLogs} />)

    const row = await within(screen.getByTestId('workspace-services-list')).findByRole('button', { name: new RegExp(unit) })
    expect(within(row).getByText(unit)).toBeInTheDocument()
    expect(within(row).getByText('Load: loaded')).toBeInTheDocument()
    expect(within(row).getByText('failed')).toBeInTheDocument()
    expect(within(row).getByText('auto-restart')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-services-app')).toHaveAttribute('data-selected-service', unit)
    fireEvent.click(screen.getByTestId('workspace-service-status'))
    await waitFor(() => expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
      vaultId: 'team', hostId: 'host-1', command: `systemctl status --no-pager -- ${unit}`,
    })))
    expect(await screen.findByText(`Observed status for ${unit}`)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({
      vaultId: 'team', hostId: 'host-1', action: 'service.status', target: unit, risk: 'read-only',
    }) })
    fireEvent.click(screen.getByRole('button', { name: `Open logs for ${unit}` }))
    expect(onOpenLogs).toHaveBeenCalledExactlyOnceWith(unit)
    expect(runSshCommand.mock.calls.every(([payload]) => /systemctl (?:list-units|status)\b/.test(payload.command))).toBe(true)
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

  it('links a verified stop to the durable job and opens logs for the same selected service', async () => {
    const onOpenLogs = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    runSshCommand.mockImplementation(async (payload) => ({ stdout: payload.command.startsWith('systemctl show') ? 'ActiveState=inactive\nUnitFileState=enabled' : payload.command.startsWith('systemctl stop') ? '' : 'nginx.service loaded active running Web server', stderr: '', exitCode: 0, durationMs: 1 }))
    render(<WorkspaceServicesApp selectedHostId="host-1" hosts={[host]} resolveAuthSecret={async () => 'secret'} vaultId="team" onOpenLogs={onOpenLogs} />)
    await screen.findByRole('button', { name: 'Stop nginx.service' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop nginx.service' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ jobId: 'service-job', status: 'completed', resultSummary: expect.stringContaining('verification=passed; active=inactive') }) }))
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: 'team', action: 'service.stop' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Open logs for nginx.service' }))
    expect(onOpenLogs).toHaveBeenCalledWith('nginx.service')
  })
})
