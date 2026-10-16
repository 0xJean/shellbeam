import type { HostProfile } from '@/lib/hosts'
import type { AuthType } from '@/lib/ssh'
import {
  sftpCreateFile,
  sftpCreateDir,
  sftpDeletePath,
  sftpDownloadFile,
  sftpHomeDir,
  sftpListDir,
  sftpRenamePath,
  sftpWriteFile,
  type SftpEntry,
  type SftpFileData,
} from './sftp'

export interface RemoteFsAuth {
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
): Promise<RemoteFsAuth> {
  const secret = await resolveAuthSecret(host)
  return {
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
) {
  async function withAuth() {
    return resolveRemoteFsAuth(host, resolveAuthSecret)
  }

  return {
    async getHomeDir(): Promise<string> {
      return sftpHomeDir({ ...(await withAuth()), remotePath: '.' })
    },
    async listDir(remotePath: string): Promise<SftpEntry[]> {
      return sftpListDir({ ...(await withAuth()), remotePath })
    },
    async readFile(remotePath: string): Promise<SftpFileData> {
      return sftpDownloadFile({ ...(await withAuth()), remotePath })
    },
    async deletePath(remotePath: string) {
      return sftpDeletePath({ ...(await withAuth()), remotePath })
    },
    async renamePath(oldRemotePath: string, newRemotePath: string) {
      return sftpRenamePath({ ...(await withAuth()), oldRemotePath, newRemotePath })
    },
    async createDir(remotePath: string) {
      return sftpCreateDir({ ...(await withAuth()), remotePath })
    },
    async createFile(remotePath: string) {
      return sftpCreateFile({ ...(await withAuth()), remotePath })
    },
    async writeFile(remotePath: string, contentB64: string) {
      return sftpWriteFile({ ...(await withAuth()), remotePath, contentB64 })
    },
  }
}
