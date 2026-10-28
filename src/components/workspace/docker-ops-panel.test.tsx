import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { runDockerContainerAction } from '@/lib/docker-ops'
import { DockerOpsPanel } from './docker-ops-panel'

vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn().mockResolvedValue({ stdout: '__SB_DOCKER=abc123|api|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1 }) }))
vi.mock('@/lib/operation-job', () => ({ operationTransport: () => 'direct', runConfirmedOperation: vi.fn() }))
vi.mock('@/lib/docker-ops', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/docker-ops')>(), runDockerContainerAction: vi.fn() }))

beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en'); vi.clearAllMocks(); vi.mocked(runWorkspaceRemoteCommand).mockReset().mockResolvedValue({ stdout: '__SB_DOCKER=abc123|api|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1 }); vi.mocked(runDockerContainerAction).mockReset() })
afterEach(() => { cleanup() })

describe('DockerOpsPanel', () => {
  it('renders the container operations surface', async () => {
    render(<DockerOpsPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByTestId('docker-ops-panel')).toBeInTheDocument()
    expect(await screen.findByText('api')).toBeInTheDocument()
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({ audit: { action: 'docker.list', target: 'docker containers' } }))
  })

  it('journals read-only logs and addresses the selected immutable container id', async () => {
    render(<DockerOpsPanel host={{ vaultId: 'vault-a', id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }))
    await screen.findByTestId('docker-ops-output')
    expect(runWorkspaceRemoteCommand).toHaveBeenLastCalledWith(expect.objectContaining({ command: "docker logs --tail 100 --timestamps 'abc123'", audit: { action: 'docker.logs', target: 'api' } }))
    expect(runDockerContainerAction).not.toHaveBeenCalled()
  })

  it('rejects unknown list observations and never paints their markers as running containers', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce({ stdout: '__SB_DOCKER=abc123|api|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1, errorType: 'unknown' })
    render(<DockerOpsPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Container state could not be observed')
    expect(screen.queryByText('api')).not.toBeInTheDocument()
  })

  it('ignores a delayed old-Vault list when the new Vault has the same host id', async () => {
    const base = { id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password' as const, tags: [], createdAt: 0, updatedAt: 0 }
    let completeOld!: (value: Awaited<ReturnType<typeof runWorkspaceRemoteCommand>>) => void
    vi.mocked(runWorkspaceRemoteCommand).mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve })).mockResolvedValueOnce({ stdout: '__SB_DOCKER=bbb123|new-vault|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1 })
    const resolveAuthSecret = vi.fn()
    const view = render(<DockerOpsPanel host={{ ...base, vaultId: 'vault-a' }} resolveAuthSecret={resolveAuthSecret} />)
    view.rerender(<DockerOpsPanel host={{ ...base, vaultId: 'vault-b' }} resolveAuthSecret={resolveAuthSecret} />)
    await screen.findByText('new-vault')
    await act(async () => { completeOld({ stdout: '__SB_DOCKER=aaa123|old-vault|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1 }) })
    expect(screen.queryByText('old-vault')).not.toBeInTheDocument()
    expect(screen.getByText('new-vault')).toBeInTheDocument()
  })

  it('displays the in-job verification summary without performing a second external verification scan', async () => {
    vi.mocked(runDockerContainerAction).mockResolvedValue({ job: { jobId: 'job-1', auditId: 'audit-1', status: 'unknown' }, value: { stdout: '', stderr: '', exitCode: 0, durationMs: 2, verification: { status: 'unknown', summary: 'Expected running; observed exited.' }, container: { id: 'abc123', name: 'api', image: 'acme/api', status: 'exited', ports: '', running: false } } } as Awaited<ReturnType<typeof runDockerContainerAction>>)
    render(<DockerOpsPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    const output = await screen.findByTestId('docker-ops-output')
    expect(output).toHaveTextContent('status=unknown')
    expect(output).toHaveTextContent('verification=unknown; Expected running; observed exited.')
    expect(screen.getByText('exited')).toBeInTheDocument()
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
    expect(runDockerContainerAction).toHaveBeenCalledTimes(1)
  })

  it('shows published ports in the container table and per-row actions', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValue({ stdout: '__SB_DOCKER=abc123|api|acme/api|Up 1 minute|0.0.0.0:3000->3000/tcp\n__SB_DOCKER=def456|db|postgres:16|Exited (0) 2 hours ago|', stderr: '', exitCode: 0, durationMs: 1 })
    render(<DockerOpsPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByText('0.0.0.0:3000→3000/tcp')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Ports' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Logs' })[1])
    await screen.findByTestId('docker-ops-output')
    expect(runWorkspaceRemoteCommand).toHaveBeenLastCalledWith(expect.objectContaining({ command: "docker logs --tail 100 --timestamps 'def456'", audit: { action: 'docker.logs', target: 'db' } }))
    expect(screen.getByText('db · logs')).toBeInTheDocument()
  })
})
