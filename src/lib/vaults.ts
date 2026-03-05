import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface VaultMeta {
  id: string
  name: string
  createdAt: number
  isDefault: boolean
}

export const DEFAULT_VAULT_ID = 'personal'

export async function listVaults(): Promise<VaultMeta[]> {
  try {
    return await invoke<VaultMeta[]>('list_vaults')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function createVault(name: string): Promise<VaultMeta> {
  try {
    return await invoke<VaultMeta>('create_vault', { name })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function updateVault(vaultId: string, name: string): Promise<VaultMeta> {
  try {
    return await invoke<VaultMeta>('update_vault', { vaultId, name })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function deleteVault(vaultId: string): Promise<void> {
  try {
    await invoke('delete_vault', { vaultId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
