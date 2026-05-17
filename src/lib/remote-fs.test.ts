import { describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import {
  createRemoteFsClient,
  resolveRemoteFsAuth,
} from './remote-fs'

const sftpListDir = vi.fn(async (_payload?: unknown) => [])
const sftpDownloadFile = vi.fn(async (_payload?: unknown) => ({ path: '/tmp/app.conf', contentB64: 'Y29uZmln', sizeBytes: 6 }))
const sftpDeletePath = vi.fn(async (_payload?: unknown) => {})
const sftpRenamePath = vi.fn(async (_payload?: unknown) => {})
const sftpCreateDir = vi.fn(async (_payload?: unknown) => {})
const sftpCreateFile = vi.fn(async (_payload?: unknown) => {})
const sftpWriteFile = vi.fn(async (_payload?: unknown) => {})
const sftpHomeDir = vi.fn(async (_payload?: unknown) => '/root')

vi.mock('./sftp', () => ({
  sftpListDir: (payload: unknown) => sftpListDir(payload),
  sftpDownloadFile: (payload: unknown) => sftpDownloadFile(payload),
  sftpDeletePath: (payload: unknown) => sftpDeletePath(payload),
  sftpRenamePath: (payload: unknown) => sftpRenamePath(payload),
  sftpCreateDir: (payload: unknown) => sftpCreateDir(payload),
  sftpCreateFile: (payload: unknown) => sftpCreateFile(payload),
  sftpWriteFile: (payload: unknown) => sftpWriteFile(payload),
  sftpHomeDir: (payload: unknown) => sftpHomeDir(payload),
}))

describe('remote fs helpers', () => {
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
})
