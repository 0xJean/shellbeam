import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { SftpPathState } from './sftp'
import {
  createRemoteFsClient,
  resolveRemoteFsAuth,
} from './remote-fs'

const sftpListDir = vi.fn<(payload?: unknown) => Promise<unknown[]>>(async () => [])
const sftpDownloadFile = vi.fn<(payload?: unknown) => Promise<{ path: string; contentB64: string; sizeBytes: number }>>(async () => ({ path: '/tmp/app.conf', contentB64: 'Y29uZmln', sizeBytes: 6 }))
const sftpDeletePath = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpRenamePath = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpCreateDir = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpCreateFile = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpWriteFile = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpHomeDir = vi.fn<(payload?: unknown) => Promise<string>>(async () => '/root')
const sftpUploadFile = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpChmod = vi.fn<(payload?: unknown) => Promise<void>>(async () => {})
const sftpStatPath = vi.fn<(payload: { remotePath: string }) => Promise<SftpPathState>>()
const states = new Map<string, SftpPathState>()
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('./sftp', () => ({
  sftpListDir: (payload: unknown) => sftpListDir(payload),
  sftpDownloadFile: (payload: unknown) => sftpDownloadFile(payload),
  sftpDeletePath: (payload: unknown) => sftpDeletePath(payload),
  sftpRenamePath: (payload: unknown) => sftpRenamePath(payload),
  sftpCreateDir: (payload: unknown) => sftpCreateDir(payload),
  sftpCreateFile: (payload: unknown) => sftpCreateFile(payload),
  sftpWriteFile: (payload: unknown) => sftpWriteFile(payload),
  sftpHomeDir: (payload: unknown) => sftpHomeDir(payload),
  sftpUploadFile: (payload: unknown) => sftpUploadFile(payload),
  sftpChmod: (payload: unknown) => sftpChmod(payload),
  sftpStatPath: (payload: { remotePath: string }) => sftpStatPath(payload),
}))

describe('remote fs helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    states.clear()
    states.set('/tmp/old.conf', { exists: true, isFile: true, isDir: false, size: 6, permissions: 0o644 })
    sftpStatPath.mockReset().mockImplementation(async ({ remotePath }) => states.get(remotePath) ?? { exists: false })
    sftpDeletePath.mockImplementation(async (payload) => { states.delete((payload as { remotePath: string }).remotePath) })
    sftpRenamePath.mockImplementation(async (payload) => {
      const { oldRemotePath, newRemotePath } = payload as { oldRemotePath: string; newRemotePath: string }
      states.set(newRemotePath, states.get(oldRemotePath) ?? { exists: true }); states.delete(oldRemotePath)
    })
    sftpCreateDir.mockImplementation(async (payload) => { states.set((payload as { remotePath: string }).remotePath, { exists: true, isDir: true, isFile: false }) })
    sftpCreateFile.mockImplementation(async (payload) => { states.set((payload as { remotePath: string }).remotePath, { exists: true, isDir: false, isFile: true, size: 0 }) })
    const write = async (payload: unknown) => {
      const { remotePath, contentB64 } = payload as { remotePath: string; contentB64: string }
      states.set(remotePath, { exists: true, isDir: false, isFile: true, size: atob(contentB64).length })
    }
    sftpWriteFile.mockImplementation(write)
    sftpUploadFile.mockImplementation(write)
    sftpChmod.mockImplementation(async (payload) => {
      const { remotePath, mode } = payload as { remotePath: string; mode: number }
      states.set(remotePath, { ...states.get(remotePath), exists: true, permissions: mode })
    })
    vi.stubGlobal('crypto', webcrypto)
    invoke.mockImplementation(async (command, { request }) => ({ ...request, jobId: 'job-1', auditId: 'audit-1', status: command === 'operation_job_create' ? 'queued' : request.status }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'prompt').mockImplementation((message) => String(message).includes('DELETE') ? 'DELETE' : String(message).includes('OVERWRITE') ? 'OVERWRITE' : 'CHANGE')
  })
  const passwordHost: HostProfile = {
    id: 'host-1',
    name: 'Production API',
    address: '10.0.0.15',
    port: 22,
    username: 'root',
    group: 'Default',
    authType: 'password',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }

  it('normalizes password host auth for remote fs operations', async () => {
    await expect(resolveRemoteFsAuth(passwordHost, async () => 'secret')).resolves.toEqual({
      host: '10.0.0.15',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'secret',
      privateKey: undefined,
    })
  })

  it('wraps common remote filesystem actions with resolved auth', async () => {
    const client = createRemoteFsClient(passwordHost, async () => 'secret')

    await client.listDir('/etc')
    await client.getHomeDir()
    await client.readFile('/tmp/app.conf')
    await client.deletePath('/tmp/old.conf')
    await client.renamePath('/tmp/old.conf', '/tmp/new.conf')
    await client.createDir('/tmp/releases')
    await client.createFile('/tmp/new.conf')
    await client.writeFile('/tmp/new.conf', 'Y29uZmln')

    expect(sftpHomeDir).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '.', password: 'secret' }))
    expect(sftpListDir).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/etc', password: 'secret' }))
    expect(sftpDownloadFile).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/tmp/app.conf', password: 'secret' }))
    expect(sftpDeletePath).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/tmp/old.conf', password: 'secret' }))
    expect(sftpRenamePath).toHaveBeenCalledWith(expect.objectContaining({
      oldRemotePath: '/tmp/old.conf',
      newRemotePath: '/tmp/new.conf',
      password: 'secret',
    }))
    expect(sftpCreateDir).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/tmp/releases', password: 'secret' }))
    expect(sftpCreateFile).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/tmp/new.conf', password: 'secret' }))
    expect(sftpWriteFile).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/tmp/new.conf', contentB64: 'Y29uZmln', password: 'secret' }))
  })

  it('passes jump host settings through SFTP auth payloads', async () => {
    const jumpHost: HostProfile = {
      ...passwordHost,
      id: 'host-jump',
      address: '10.0.0.25',
      authType: 'privateKey',
      jumpHost: 'bastion.example.com',
      jumpPort: 2200,
      jumpUser: 'bastion',
    }
    const client = createRemoteFsClient(jumpHost, async () => 'PRIVATE KEY')

    await client.listDir('/srv')

    expect(sftpListDir).toHaveBeenCalledWith(expect.objectContaining({
      host: '10.0.0.25',
      authType: 'privateKey',
      privateKey: 'PRIVATE KEY',
      jumpHost: 'bastion.example.com',
      jumpPort: 2200,
      jumpUser: 'bastion',
      remotePath: '/srv',
    }))
  })

  it('resolves saved hosts in the native vault scope without loading credentials into the frontend', async () => {
    const resolver = vi.fn(async () => 'must not load')
    const client = createRemoteFsClient(passwordHost, resolver, { vaultId: 'team' })
    await client.listDir('/srv')
    expect(resolver).not.toHaveBeenCalled()
    expect(sftpListDir).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-1', vaultId: 'team', remotePath: '/srv', password: undefined, privateKey: undefined }))
  })

  it('does not resolve auth or read/upload content after cancelled overwrite review', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const resolver = vi.fn(async () => 'secret')
    const readContent = vi.fn(async () => 'c2VjcmV0')
    const client = createRemoteFsClient(passwordHost, resolver)
    expect(await client.uploadFiles([{ remotePath: '/root/a.env', readContent }])).toBe(false)
    expect(resolver).not.toHaveBeenCalled()
    expect(readContent).not.toHaveBeenCalled()
    expect(sftpUploadFile).not.toHaveBeenCalled()
    expect(sftpStatPath).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'cancelled', confirmationStatus: 'rejected' }) })
  })

  it('audits upload and chmod without persisting content or full paths', async () => {
    const client = createRemoteFsClient(passwordHost, async () => 'secret')
    await client.uploadFiles([{ remotePath: '/secret/config.env', readContent: async () => 'c2VjcmV0' }])
    await client.chmod('/secret/config.env', 0o600)
    expect(sftpUploadFile).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/secret/config.env', contentB64: 'c2VjcmV0' }))
    expect(sftpChmod).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/secret/config.env', mode: 0o600 }))
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('/secret/config.env')
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('c2VjcmV0')
    expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'completed', resultSummary: 'verification=file-size; sizeBytes=6' }) })
    expect(invoke).toHaveBeenCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'completed', resultSummary: 'verification=mode; permissions=600' }) })
  })

  it('journals read-only Files observations before execution without prompting or retaining contents', async () => {
    const resolver = vi.fn(async () => 'secret')
    const client = createRemoteFsClient(passwordHost, resolver, { vaultId: 'team' })
    await client.getHomeDir(); await client.listDir('/private'); await client.readFile('/private/credentials')
    const jobs = invoke.mock.calls.filter(([command]) => command === 'operation_job_create').map(([, { request }]) => request)
    expect(jobs.map((job) => job.action)).toEqual(['file.home', 'file.list', 'file.read'])
    expect(jobs.every((job) => job.vaultId === 'team' && job.risk === 'read-only' && job.confirmationRequired === false)).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled(); expect(window.prompt).not.toHaveBeenCalled()
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/\/private|\/root|Y29uZmln/)
  })

  it('does not read remote data when canonical read audit persistence fails', async () => {
    invoke.mockRejectedValueOnce(new Error('database unavailable'))
    const resolver = vi.fn(async () => 'secret')
    await expect(createRemoteFsClient(passwordHost, resolver, { vaultId: 'team' }).readFile('/private/a')).rejects.toThrow('database unavailable')
    expect(sftpDownloadFile).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('records accepted writes as unknown when the independent observation cannot be made', async () => {
    sftpStatPath.mockRejectedValueOnce(new Error('Permission denied /private/a'))
    const client = createRemoteFsClient(passwordHost, async () => 'secret', { vaultId: 'team' })
    await expect(client.writeFile('/private/a', 'Y29uZmln')).rejects.toThrow('post-state is unknown')
    expect(sftpWriteFile).toHaveBeenCalledOnce()
    expect(sftpStatPath).toHaveBeenCalledWith(expect.objectContaining({ remotePath: '/private/a', followSymlinks: true, vaultId: 'team' }))
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown', errorCode: 'remote_state_unknown' }) })
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('/private/a')
  })

  it('uses observed post-state instead of successful mutation responses, including batches', async () => {
    const client = createRemoteFsClient(passwordHost, async () => 'secret', { vaultId: 'team' })
    sftpStatPath.mockResolvedValueOnce({ exists: true, isFile: true, size: 99 })
    await expect(client.writeFile('/tmp/a', 'Y29uZmln')).rejects.toThrow('did not match')
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'failed', errorCode: 'file_post_state_mismatch' }) })
    vi.mocked(window.prompt).mockClear(); invoke.mockClear(); sftpStatPath.mockClear()
    await client.deletePaths(['/tmp/one', '/tmp/two'])
    expect(window.prompt).toHaveBeenCalledOnce()
    expect(sftpStatPath).toHaveBeenCalledTimes(2)
    const creations = invoke.mock.calls.filter(([command]) => command === 'operation_job_create')
    expect(creations).toHaveLength(2)
    expect(creations.every(([, { request }]) => request.action === 'file.delete')).toBe(true)
    expect(invoke.mock.calls.filter(([command, { request }]) => command === 'operation_job_update' && request.status === 'completed')).toHaveLength(2)
  })

  it('distinguishes missing metadata from a known incorrect directory or permission state', async () => {
    const client = createRemoteFsClient(passwordHost, async () => 'secret', { vaultId: 'team' })
    sftpStatPath.mockResolvedValueOnce({ exists: true })
    await expect(client.chmod('/tmp/a', 0o600)).rejects.toThrow('post-state is unknown')
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'unknown' }) })
    sftpStatPath.mockResolvedValueOnce({ exists: true, isDir: false })
    await expect(client.createDir('/tmp/directory')).rejects.toThrow('did not match')
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'failed' }) })
    sftpStatPath.mockResolvedValueOnce({ exists: true, permissions: 0o644 })
    await expect(client.chmod('/tmp/a', 0o600)).rejects.toThrow('did not match')
    expect(invoke).toHaveBeenLastCalledWith('operation_job_update', { request: expect.objectContaining({ status: 'failed' }) })
  })
})
