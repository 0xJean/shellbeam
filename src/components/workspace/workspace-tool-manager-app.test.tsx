import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceToolManagerApp } from './workspace-tool-manager-app'
import { TOOL_CATALOG, buildToolActionCommand, executeVerifiedToolPackageAction } from '@/lib/workspace-tools'

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

const workerHost = {
  id: 'host-2',
  name: 'Worker Node',
  address: '10.0.0.16',
  port: 22,
  username: 'ubuntu',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

function findTool(id: string) {
  const tool = TOOL_CATALOG.find((entry) => entry.id === id)
  if (!tool) throw new Error(`Missing tool fixture: ${id}`)
  return tool
}

describe('workspace tool manager app', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.setItem('shellbeam.locale', 'en')
    runSshCommand.mockReset()
    invoke.mockReset()
    let sequence = 0
    const jobs = new Map()
    invoke.mockImplementation(async (command, payload) => {
      if (command === 'operation_job_create') {
        const job = { ...payload.request, jobId: `tool-job-${++sequence}`, auditId: `tool-audit-${sequence}`, status: 'queued' }
        jobs.set(job.jobId, job)
        return job
      }
      if (command === 'operation_job_update') {
        const job = { ...jobs.get(payload.request.jobId), ...payload.request }
        jobs.set(job.jobId, job)
        return job
      }
      return []
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('renders the broad common tool catalog', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByText('Common Services & Toolchains')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-card-nginx')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-card-docker')).toBeInTheDocument()
    const logoSources = Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src') || '')
    expect(logoSources.some((src) => src.includes('/nginx'))).toBe(true)
    expect(logoSources.some((src) => src.includes('/docker'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'codex' } })
    expect(screen.getByTestId('workspace-tool-card-codex')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/openai'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'gemini' } })
    expect(screen.getByTestId('workspace-tool-card-gemini')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/googlegemini'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'claude' } })
    expect(screen.getByTestId('workspace-tool-card-claude')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('img')).some((img) => img.getAttribute('src')?.includes('/anthropic'))).toBe(true)

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalled()
    })
  })

  it('builds distro-aware package install commands', () => {
    const command = buildToolActionCommand(findTool('nginx'), 'install')
    expect(command).toContain('apt-get update')
    expect(command).toContain("apt-get install -y 'nginx'")
    expect(command).toContain('dnf install -y')
    expect(command).toContain('__SB_ACTION_EXIT')
  })

  it('uses service-aware icons for unbranded tools', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText(/search nginx/i), { target: { value: 'cron' } })
    const cronCard = screen.getByTestId('workspace-tool-card-cron')
    expect(cronCard).toBeInTheDocument()
    expect(cronCard.querySelector('img')?.getAttribute('src')).toContain('/linux')

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalled()
    })
  })

  it('builds npm global install commands for agent CLIs', () => {
    expect(buildToolActionCommand(findTool('codex'), 'install')).toContain("npm install -g '@openai/codex'")
    expect(buildToolActionCommand(findTool('gemini'), 'install')).toContain("npm install -g '@google/gemini-cli'")
    expect(buildToolActionCommand(findTool('claude'), 'install')).toContain("npm install -g '@anthropic-ai/claude-code'")
  })

  it('builds systemd service commands for managed services', () => {
    const statusCommand = buildToolActionCommand(findTool('nginx'), 'status')
    expect(statusCommand).toContain("systemctl status 'nginx' --no-pager")

    const restartCommand = buildToolActionCommand(findTool('nginx'), 'restart')
    expect(restartCommand).toContain("sb_root systemctl restart 'nginx'")
  })

  it('runs selected tool actions on the resolved remote host', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=1\n__SB_BINARY=nginx\n__SB_PATH=/usr/sbin/nginx\n__SB_VERSION=nginx version: nginx/1.24.0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    fireEvent.click(screen.getByTestId('workspace-tool-card-nginx'))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^check$/i })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: /^check$/i }))

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
        hostId: 'host-1',
        host: '10.0.0.15',
        command: expect.stringContaining('__SB_INSTALLED='),
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('workspace-tool-output')).toHaveTextContent(/nginx version/i)
    })
  })

  it('switches the managed server from the tool manager itself', async () => {
    runSshCommand.mockResolvedValue({
      stdout: '__SB_INSTALLED=0',
      stderr: '',
      exitCode: 0,
      durationMs: 18,
    })

    render(
      <WorkspaceToolManagerApp
        selectedHostId="host-1"
        hosts={[host, workerHost]}
        resolveAuthSecret={async () => 'secret'}
      />,
    )

    expect(screen.getByTestId('workspace-tool-host-host-1')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-host-host-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-tool-host-host-2'))

    await waitFor(() => {
      expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({
        hostId: 'host-2',
        host: '10.0.0.16',
      }))
    })
  })

  it('stops the old visible-tools scan when the same host id moves to another vault', async () => {
    const observed = { stdout: '__SB_INSTALLED=0', stderr: '', exitCode: 0, durationMs: 1 }
    runSshCommand.mockResolvedValue(observed)
    const props = { selectedHostId: host.id, resolveAuthSecret: async () => 'unused', hideHeader: true }
    const view = render(<WorkspaceToolManagerApp {...props} vaultId="a" hosts={[{ ...host, vaultId: 'a' }]} />)
    const scan = screen.getByRole('button', { name: /scan visible/i })
    await waitFor(() => expect(scan).toBeEnabled())
    await waitFor(() => expect(runSshCommand).toHaveBeenCalled())
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'upsert_workspace_tool_status')).toBe(true))
    let finishOld!: (result: typeof observed) => void
    runSshCommand.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    runSshCommand.mockClear()
    invoke.mockClear()
    fireEvent.click(scan)
    await waitFor(() => expect(runSshCommand).toHaveBeenCalledTimes(1))
    expect(runSshCommand.mock.calls[0][0]).toMatchObject({ vaultId: 'a', hostId: host.id })
    view.rerender(<WorkspaceToolManagerApp {...props} vaultId="b" hosts={[{ ...host, vaultId: 'b' }]} />)
    await waitFor(() => expect(runSshCommand.mock.calls.some(([request]) => request.vaultId === 'b')).toBe(true))
    await act(async () => { finishOld({ ...observed, stdout: '__SB_INSTALLED=1\n__SB_VERSION=old-vault-only' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: /scan visible/i })).toBeEnabled())
    expect(runSshCommand.mock.calls.filter(([request]) => request.vaultId === 'a')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([command]) => command === 'upsert_workspace_tool_status').every(([, payload]) => payload.payload.vaultId === 'b')).toBe(true)
    expect(document.body.textContent).not.toContain('old-vault-only')
  })

  it('ignores late persisted statuses from the previously opened vault', async () => {
    const original = invoke.getMockImplementation()!
    const persisted = (vaultId: string, version: string) => [{ vaultId, hostKey: `vault:${JSON.stringify([vaultId, host.id])}`, hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, toolId: 'nginx', toolName: 'Nginx', status: { installed: vaultId === 'a', checkedAt: 'now', checkedAtMs: 100, version }, updatedAt: 100 }]
    let hydrateA!: (rows: ReturnType<typeof persisted>) => void
    invoke.mockImplementation((command, payload) => {
      if (command === 'list_workspace_tool_statuses') return payload.vaultId === 'a'
        ? new Promise((resolve) => { hydrateA = resolve })
        : Promise.resolve(persisted('b', 'vault-b-version'))
      return original(command, payload)
    })
    const props = { selectedHostId: host.id, resolveAuthSecret: async () => 'unused' }
    const view = render(<WorkspaceToolManagerApp {...props} vaultId="a" hosts={[{ ...host, vaultId: 'a' }]} />)
    await waitFor(() => expect(hydrateA).toBeTypeOf('function'))
    view.rerender(<WorkspaceToolManagerApp {...props} vaultId="b" hosts={[{ ...host, vaultId: 'b' }]} />)
    await waitFor(() => expect(screen.getByTestId('workspace-tool-card-nginx')).toHaveTextContent('Missing'))
    await act(async () => { hydrateA(persisted('a', 'vault-a-version')) })
    expect(screen.getByTestId('workspace-tool-card-nginx')).toHaveTextContent('Missing')
    expect(document.body.textContent).not.toContain('vault-a-version')
    expect(runSshCommand).not.toHaveBeenCalled()
  })

  it('shows a persistence error without claiming the tool status was saved', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command, payload) => command === 'upsert_workspace_tool_status'
      ? Promise.reject(new Error('database /private/vault-key failed'))
      : original(command, payload))
    runSshCommand.mockResolvedValue({ stdout: '__SB_INSTALLED=1\n__SB_VERSION=1.0', stderr: '', exitCode: 0, durationMs: 1 })
    render(<WorkspaceToolManagerApp vaultId="a" selectedHostId={host.id} hosts={[{ ...host, vaultId: 'a' }]} resolveAuthSecret={async () => 'unused'} />)
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'upsert_workspace_tool_status')).toBe(true))
    fireEvent.click(screen.getByTestId('workspace-tool-card-nginx'))
    await waitFor(() => expect(screen.getByText('Tool status could not be loaded or saved. Refresh before continuing.')).toBeInTheDocument())
    expect(screen.getByTestId('workspace-tool-card-nginx')).toHaveTextContent('Unknown')
    expect(document.body.textContent).not.toContain('/private/vault-key')
  })

  async function openTool() {
    const resolveAuthSecret = vi.fn(async () => 'must not read saved credentials')
    runSshCommand.mockResolvedValue({ stdout: '__SB_INSTALLED=0', stderr: '', exitCode: 0, durationMs: 1 })
    render(<WorkspaceToolManagerApp vaultId="team" selectedHostId="host-2" hosts={[host, { ...workerHost, vaultId: 'team', jumpHost: 'bastion.example' }]} resolveAuthSecret={resolveAuthSecret} />)
    await waitFor(() => expect(runSshCommand).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('workspace-tool-card-nginx'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^install$/i })).toBeEnabled())
    invoke.mockClear(); runSshCommand.mockClear(); resolveAuthSecret.mockClear()
    return { resolveAuthSecret }
  }

  it.each(['install', 'upgrade', 'uninstall', 'restart'] as const)('records a cancelled %s before executing any command or verification', async (action) => {
    const { resolveAuthSecret } = await openTool()
    vi.mocked(window.confirm).mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${action}$`, 'i') }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'rejected' }) }))
    expect(runSshCommand).not.toHaveBeenCalled()
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('operation_job_create', { request: expect.objectContaining({ vaultId: 'team', hostId: 'host-2', action: action === 'restart' ? 'service.restart' : `tool.${action}`, risk: 'high', confirmationRequired: true }) })
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Worker Node · ubuntu@10.0.0.16:22'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('ProxyJump bastion.example'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(action === 'restart' ? 'Command summary: systemctl restart -- nginx.service' : 'Command summary: package manager'))
  })

  it('audits installation only after an independent installed/version observation on the scoped host', async () => {
    const { resolveAuthSecret } = await openTool()
    runSshCommand.mockImplementation(async ({ command }) => command.includes('apt-get install')
      ? { stdout: 'installer private_token=secret-output', stderr: '', exitCode: 0, durationMs: 2 }
      : { stdout: '__SB_INSTALLED=1\n__SB_VERSION=nginx/1.27.4\n__SB_VERSION_EXIT=0', stderr: '', exitCode: 0, durationMs: 3 })
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'completed', resultSummary: 'tool=nginx; action=install; verification=passed; installed=true; version=observed' }) }))
    expect(runSshCommand).toHaveBeenCalledTimes(2)
    expect(runSshCommand.mock.calls[0][0].command).toContain('apt-get install')
    expect(runSshCommand.mock.calls[1][0].command).not.toContain('apt-get install')
    expect(runSshCommand.mock.calls.every(([request]) => request.vaultId === 'team' && request.hostId === 'host-2')).toBe(true)
    expect(resolveAuthSecret).not.toHaveBeenCalled()
    const audit = JSON.stringify(invoke.mock.calls.filter(([command]) => command.startsWith('operation_job_')))
    expect(audit).not.toMatch(/private_token|secret-output|nginx\/1\.27\.4|apt-get/)
    expect(screen.getByTestId('workspace-tool-output')).toHaveTextContent('status=completed')
  })

  it('shows an unknown audited outcome when an accepted install cannot be observed', async () => {
    await openTool()
    runSshCommand.mockResolvedValueOnce({ stdout: 'accepted', stderr: '', exitCode: 0, durationMs: 2 })
      .mockRejectedValueOnce(new Error('Permission denied /private/secret after accepted install'))
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown' }) }))
    expect(screen.getByTestId('workspace-tool-output')).toHaveTextContent('status=unknown')
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('/private/secret')
  })

  it('verifies a stopped service as inactive instead of treating systemctl status exit 3 as failure', async () => {
    await openTool()
    runSshCommand.mockImplementation(async ({ command }) => ({ stdout: command.includes('systemctl show ') ? 'ActiveState=inactive\nUnitFileState=disabled' : '', stderr: '', exitCode: 0, durationMs: 1 }))
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'completed', resultSummary: 'action=stop; verification=passed; active=inactive; enabled=disabled' }) }))
    expect(runSshCommand.mock.calls[0][0].command).toContain('sb_root systemctl stop -- nginx.service')
    expect(runSshCommand.mock.calls[1][0].command).toBe('systemctl show --property=ActiveState --property=UnitFileState -- nginx.service')
    expect(runSshCommand.mock.calls.some(([request]) => request.command.includes('systemctl status'))).toBe(false)
    expect(invoke.mock.calls.filter(([command]) => command === 'operation_job_create')).toHaveLength(1)
  })

  it('keeps service changes unknown when post-state inspection fails', async () => {
    await openTool()
    runSshCommand.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 })
      .mockRejectedValueOnce(new Error('channel closed /private/log'))
    fireEvent.click(screen.getByRole('button', { name: /^restart$/i }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown' }) }))
    expect(screen.getByTestId('workspace-tool-output')).toHaveTextContent('status=unknown')
  })

  it.each([
    ['install', '__SB_INSTALLED=0', 'tool_post_state_mismatch'],
    ['upgrade', '__SB_INSTALLED=1\n__SB_VERSION=command failed\n__SB_VERSION_EXIT=2', 'remote_state_unknown'],
    ['install', '__SB_INSTALLED=1\n__SB_VERSION_EXIT=0', 'remote_state_unknown'],
    ['uninstall', '__SB_INSTALLED=1\n__SB_VERSION=1.0\n__SB_VERSION_EXIT=0', 'tool_post_state_mismatch'],
  ] as const)('checks the actual %s post-state without trusting the action exit code', async (action, stdout, errorCode) => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }).mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0, durationMs: 1 })
    expect(await executeVerifiedToolPackageAction(run, findTool('nginx'), action)).toMatchObject({ exitCode: 125, errorCode })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('observes an uninstalled binary without demanding a version', async () => {
    const run = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }).mockResolvedValueOnce({ stdout: '__SB_INSTALLED=0', stderr: '', exitCode: 0, durationMs: 1 })
    expect(await executeVerifiedToolPackageAction(run, findTool('nginx'), 'uninstall')).toMatchObject({ exitCode: 0, resultSummary: 'tool=nginx; action=uninstall; verification=passed; installed=false; version=not-required' })
  })

  it.skipIf(process.platform === 'win32')('preserves the real version command exit status through bounded shell output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shellbeam-tool-check-'))
    try {
      writeFileSync(join(directory, 'shellbeam-test-tool'), '#!/bin/sh\nprintf "version unavailable\\n"\nexit 3\n', { mode: 0o700 })
      const command = buildToolActionCommand({ ...findTool('nginx'), binary: 'shellbeam-test-tool', binaries: [], service: undefined, versionCommand: undefined }, 'check')
      const output = execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` }, encoding: 'utf8' })
      expect(output).toContain('__SB_INSTALLED=1')
      expect(output).toContain('__SB_VERSION_EXIT=3')
      expect(output).not.toContain('__SB_VERSION_EXIT=0')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
