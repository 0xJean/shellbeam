import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runWorkspaceRemoteCommand } from './workspace-remote'
import { buildDockerCommand, isSafeDockerTarget, parseDockerContainers, runDockerContainerAction } from './docker-ops'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn() }))

const host = { id: 'host-1', vaultId: 'vault-a', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', group: 'Custom', tags: [], authType: 'password' as const, createdAt: 0, updatedAt: 0, jumpHostId: 'jump-1' }
const container = { id: 'abc123', name: 'api', image: 'acme/api', status: 'Exited', ports: '', running: false }
const result = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode, durationMs: 1 })
const run = (action: 'start' | 'stop' | 'restart' = 'start') => runDockerContainerAction({ host, resolveAuthSecret: async () => '', container, action, confirmMessage: 'Confirm?' })

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(invoke).mockReset().mockImplementation(async (_command, args) => ({ jobId: 'job-1', auditId: 'audit-1', ...(args as { request: object }).request }))
  vi.mocked(runWorkspaceRemoteCommand).mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { vi.restoreAllMocks() })

describe('docker operations', () => {
  it('parses bounded container markers and running state', () => {
    const rows = parseDockerContainers('__SB_DOCKER=abc123|api|ghcr.io/acme/api:latest|Up 5 minutes|0.0.0.0:8080->80/tcp\n__SB_DOCKER=def456|worker|acme/worker|Exited (1) 2 hours ago|')
    expect(rows).toEqual([
      { id: 'abc123', name: 'api', image: 'ghcr.io/acme/api:latest', status: 'Up 5 minutes', ports: '0.0.0.0:8080->80/tcp', running: true },
      { id: 'def456', name: 'worker', image: 'acme/worker', status: 'Exited (1) 2 hours ago', ports: '', running: false },
    ])
  })

  it('rejects shell metacharacters and quotes command targets', () => {
    expect(isSafeDockerTarget('api; rm -rf /')).toBe(false)
    expect(() => buildDockerCommand('stop', 'api;rm')).toThrow()
    expect(buildDockerCommand('logs', 'api')).toContain("docker logs --tail 100 --timestamps 'api'")
  })

  it('does not complete a successful start whose container immediately exited', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result('abc123')).mockResolvedValueOnce(result('__SB_DOCKER_VERIFY=abc123abcdef|exited|false|false|false'))
    const execution = await run()
    expect(execution?.job.status).toBe('unknown')
    expect(execution?.value).toMatchObject({ exitCode: 0, container: { running: false, status: 'exited' }, verification: { status: 'unknown' } })
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown', resultSummary: expect.stringContaining('observed exited') }) })
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
    expect(runWorkspaceRemoteCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({ host, command: "docker start 'abc123'" }))
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'operation_job_create')).toHaveLength(1)
  })

  it.each(['start', 'restart'] as const)('verifies %s only from an explicit running state', async (action) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result('__SB_DOCKER_VERIFY=abc123abcdef|running|true|false|false'))
    expect((await run(action))?.job.status).toBe('completed')
  })

  it('verifies stop against a non-running state rather than a successful command alone', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result('__SB_DOCKER_VERIFY=abc123abcdef|exited|false|false|false'))
    expect((await run('stop'))?.value.verification.status).toBe('verified')
  })

  it.each(['__SB_DOCKER_VERIFY=abc123abcdef|restarting|true|false|true', '__SB_DOCKER_VERIFY=abc123abcdef|paused|true|true|false', '__SB_DOCKER_VERIFY=other|running|true|false|false', 'unframed output'])('keeps ambiguous/mismatched inspection unknown: %s', async (stdout) => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result(stdout))
    expect((await run())?.job.status).toBe('unknown')
  })

  it('keeps verification transport failures unknown and never replays the mutation', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('permission denied inspecting state'))
    expect((await run())?.job.status).toBe('unknown')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(2)
  })

  it('shows the real host, unresolved jump reference and mutation command in the one confirmation', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce(result('__SB_DOCKER_VERIFY=abc123abcdef|running|true|false|false'))
    await run('restart')
    const review = vi.mocked(window.confirm).mock.calls[0][0]
    expect(review).toContain('edge · ops@10.0.0.1:22')
    expect(review).toContain('ProxyJump host reference jump-1')
    expect(review).toContain("docker restart 'abc123'")
    expect(vi.mocked(invoke).mock.calls.find(([command]) => command === 'operation_job_create')?.[1]).toMatchObject({ request: { vaultId: 'vault-a', hostId: host.id, confirmationRequired: true } })
  })

  it('does not accept an unknown inspection with a successful exit and plausible running markers', async () => {
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...result('__SB_DOCKER_VERIFY=abc123abcdef|running|true|false|false'), errorType: 'unknown' })
    expect((await run())?.job.status).toBe('unknown')
  })

  it('does not inspect after a rejected confirmation or a failed command', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    expect(await run()).toBeNull()
    expect(runWorkspaceRemoteCommand).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    vi.mocked(runWorkspaceRemoteCommand).mockResolvedValueOnce(result('', 1))
    expect((await run())?.job.status).toBe('failed')
    expect(runWorkspaceRemoteCommand).toHaveBeenCalledTimes(1)
  })
})
