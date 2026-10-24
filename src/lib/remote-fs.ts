import type { HostProfile } from '@/lib/hosts'
import type { AuthType } from '@/lib/ssh'
import {
  sftpCreateFile,
  sftpChmod,
  sftpCreateDir,
  sftpDeletePath,
  sftpDownloadFile,
  sftpHomeDir,
  sftpListDir,
  sftpStatPath,
  sftpRenamePath,
  sftpWriteFile,
  sftpUploadFile,
  type SftpEntry,
  type SftpFileData,
  type SftpPathState,
} from './sftp'
import { runFileMutations, runFileRead, type FileMutation, type FileOperationContext, type FileVerification } from './file-operation'

export interface RemoteFsAuth {
  hostId?: string
  vaultId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
}

export async function resolveRemoteFsAuth(
  host: HostProfile,
  resolveAuthSecret: (host: HostProfile) => Promise<string>,
  vaultId?: string,
): Promise<RemoteFsAuth> {
  // Saved hosts are resolved by the native transport inside the correct vault.
  // Legacy/manual callers can still supply an explicit credential resolver.
  vaultId = vaultId ?? host.vaultId
  const scopedHost = !!vaultId && !!host.id
  const secret = scopedHost ? undefined : await resolveAuthSecret(host)
  return {
    ...(scopedHost ? { hostId: host.id, vaultId } : {}),
    host: host.address,
    port: host.port || 22,
    username: host.username || 'root',
    authType: host.authType,
    password: host.authType === 'password' ? secret : undefined,
    privateKey: host.authType === 'privateKey' ? secret : undefined,
    jumpHost: host.jumpHost,
    jumpPort: host.jumpPort,
    jumpUser: host.jumpUser,
  }
}

export function createRemoteFsClient(
  host: HostProfile,
  resolveAuthSecret: (host: HostProfile) => Promise<string>,
  options: Omit<FileOperationContext, 'host'> = {},
) {
  async function withAuth() {
    return resolveRemoteFsAuth(host, resolveAuthSecret, options.vaultId)
  }
  const context = { host, ...options }
  const mutate = (mutation: FileMutation) => runFileMutations(context, [mutation])
  async function observe(remotePath: string, followSymlinks = false) {
    const state = await sftpStatPath({ ...(await withAuth()), remotePath, followSymlinks })
    if (!state || typeof state.exists !== 'boolean') throw new Error('Remote file post-state is unavailable')
    return state
  }
  function fileSizeVerification(state: SftpPathState, expectedSize: number | null): FileVerification {
    if (!state.exists || state.isFile === false) return { status: 'failed' }
    if (state.isFile !== true || !Number.isSafeInteger(state.size) || state.size == null || expectedSize === null) return { status: 'unknown' }
    return state.size === expectedSize ? { status: 'verified', evidence: 'file-size', sizeBytes: state.size } : { status: 'failed' }
  }
  function deleteMutation(remotePath: string): FileMutation {
    return { action: 'delete', path: remotePath,
      execute: async () => sftpDeletePath({ ...(await withAuth()), remotePath }),
      verify: async () => (await observe(remotePath)).exists ? { status: 'failed' } : { status: 'verified', evidence: 'path-absent' },
    }
  }
  function writeMutation(action: 'upload' | 'write' | 'create-file', remotePath: string, readContent: () => Promise<string>): FileMutation {
    let expectedSize: number | null = null
    return { action, path: remotePath,
      execute: async () => {
        const contentB64 = await readContent()
        if (contentB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentB64)) throw new Error('Invalid file content encoding')
        expectedSize = contentB64.length / 4 * 3 - (contentB64.endsWith('==') ? 2 : contentB64.endsWith('=') ? 1 : 0)
        const auth = await withAuth()
        if (action === 'upload') await sftpUploadFile({ ...auth, remotePath, contentB64 })
        else if (action === 'create-file') await sftpCreateFile({ ...auth, remotePath })
        else await sftpWriteFile({ ...auth, remotePath, contentB64 })
      },
      verify: async () => fileSizeVerification(await observe(remotePath, true), expectedSize),
    }
  }

  return {
    async getHomeDir(): Promise<string> {
      return runFileRead(context, 'home', '.', async () => sftpHomeDir({ ...(await withAuth()), remotePath: '.' }), () => 'Home directory observed; path omitted')
    },
    async listDir(remotePath: string): Promise<SftpEntry[]> {
      return runFileRead(context, 'list', remotePath, async () => sftpListDir({ ...(await withAuth()), remotePath }), (entries) => `Directory observed; entries=${entries.length}; names omitted`)
    },
    async readFile(remotePath: string): Promise<SftpFileData> {
      return runFileRead(context, 'read', remotePath, async () => sftpDownloadFile({ ...(await withAuth()), remotePath }), (file) => `File observed; bytes=${file.sizeBytes}; content omitted`)
    },
    async statPath(remotePath: string, followSymlinks = false): Promise<SftpPathState> {
      return runFileRead(context, 'stat', remotePath, async () => observe(remotePath, followSymlinks), (state) => `Path observed; exists=${state.exists}; metadata only`)
    },
    async deletePath(remotePath: string) {
      return mutate(deleteMutation(remotePath))
    },
    async deletePaths(remotePaths: string[]) {
      return runFileMutations(context, [...new Set(remotePaths)].map(deleteMutation))
    },
    async renamePath(oldRemotePath: string, newRemotePath: string) {
      return mutate({ action: 'rename', path: oldRemotePath, destination: newRemotePath,
        execute: async () => sftpRenamePath({ ...(await withAuth()), oldRemotePath, newRemotePath }),
        verify: async () => {
          const previous = await observe(oldRemotePath)
          const destination = await observe(newRemotePath)
          return !previous.exists && destination.exists ? { status: 'verified', evidence: 'rename-observed' } : { status: 'failed' }
        },
      })
    },
    async createDir(remotePath: string) {
      return mutate({ action: 'create-directory', path: remotePath,
        execute: async () => sftpCreateDir({ ...(await withAuth()), remotePath }),
        verify: async () => {
          const state = await observe(remotePath)
          return !state.exists || state.isDir === false ? { status: 'failed' } : state.isDir === true ? { status: 'verified', evidence: 'directory-present' } : { status: 'unknown' }
        },
      })
    },
    async createFile(remotePath: string) {
      return mutate(writeMutation('create-file', remotePath, async () => ''))
    },
    async writeFile(remotePath: string, contentB64: string) {
      return mutate(writeMutation('write', remotePath, async () => contentB64))
    },
    async chmod(remotePath: string, mode: number) {
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid file permission mode')
      return mutate({ action: 'chmod', path: remotePath, mode,
        execute: async () => sftpChmod({ ...(await withAuth()), remotePath, mode }),
        verify: async () => {
          const state = await observe(remotePath, true)
          return !state.exists ? { status: 'failed' } : !Number.isInteger(state.permissions) || state.permissions == null ? { status: 'unknown' } : state.permissions === mode ? { status: 'verified', evidence: 'mode', permissions: state.permissions } : { status: 'failed' }
        },
      })
    },
    async uploadFiles(files: { remotePath: string; readContent: () => Promise<string> }[]) {
      return runFileMutations(context, files.map(({ remotePath, readContent }) => writeMutation('upload', remotePath, readContent)))
    },
  }
}
