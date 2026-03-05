import { invoke } from '@tauri-apps/api/core'
import { save, open } from '@tauri-apps/plugin-dialog'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface BackupCreateOptions {
  vaultId?: string | null
  includeHosts?: boolean
  includeSnippets?: boolean
  includeVault?: boolean
  includeSync?: boolean
  includeHistory?: boolean
}

export interface BackupCreateResult {
  path: string
  sizeBytes: number
  createdAt: number
}

export interface BackupRestoreOptions {
  vaultId?: string | null
  overwriteHosts?: boolean
  overwriteSnippets?: boolean
  overwriteVault?: boolean
  overwriteSync?: boolean
  overwriteHistory?: boolean
}

export interface BackupRestoreResult {
  hostsRestored: number
  snippetsRestored: number
  vaultRestored: boolean
  syncRestored: boolean
  historyRestored: number
}

export async function backupCreate(
  password: string,
  options?: BackupCreateOptions
): Promise<BackupCreateResult> {
  const path = await save({
    defaultPath: `shellbeam_backup_${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'ShellBeam Backup', extensions: ['json'] }],
  })
  if (!path) {
    throw new Error('Save cancelled')
  }
  try {
    return await invoke<BackupCreateResult>('backup_create', {
      payload: {
        path,
        password,
        vaultId: options?.vaultId ?? undefined,
        includeHosts: options?.includeHosts ?? true,
        includeSnippets: options?.includeSnippets ?? true,
        includeVault: options?.includeVault ?? true,
        includeSync: options?.includeSync ?? true,
        includeHistory: options?.includeHistory ?? false,
      },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function backupRestore(
  password: string,
  options?: BackupRestoreOptions
): Promise<BackupRestoreResult> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'ShellBeam Backup', extensions: ['json'] }],
  })
  if (!path || typeof path !== 'string') {
    throw new Error('Open cancelled')
  }
  try {
    return await invoke<BackupRestoreResult>('backup_restore', {
      payload: {
        path,
        password,
        vaultId: options?.vaultId ?? undefined,
        overwriteHosts: options?.overwriteHosts ?? true,
        overwriteSnippets: options?.overwriteSnippets ?? true,
        overwriteVault: options?.overwriteVault ?? true,
        overwriteSync: options?.overwriteSync ?? true,
        overwriteHistory: options?.overwriteHistory ?? false,
      },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
