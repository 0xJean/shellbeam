import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'
import { t } from '@/lib/i18n'

export interface VaultStatus {
  initialized: boolean
  unlocked: boolean
  secretCount: number
}

export async function vaultStatus(vaultId?: string | null) {
  try {
    return await invoke<VaultStatus>('vault_status', { vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultInitialize(masterPassword: string, vaultId?: string | null) {
  try {
    return await invoke<VaultStatus>('vault_initialize', { payload: { masterPassword, vaultId: vaultId ?? undefined } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultUnlock(masterPassword: string, vaultId?: string | null) {
  try {
    return await invoke<VaultStatus>('vault_unlock', { payload: { masterPassword, vaultId: vaultId ?? undefined } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultLock(vaultId?: string | null) {
  try {
    return await invoke<VaultStatus>('vault_lock', { vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultSetSecret(key: string, value: string, vaultId?: string | null) {
  try {
    return await invoke<void>('vault_set_secret', { payload: { key, value, vaultId: vaultId ?? undefined } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultGetSecret(key: string, vaultId?: string | null) {
  try {
    return await invoke<string | null>('vault_get_secret', { payload: { key, vaultId: vaultId ?? undefined } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultDeleteSecret(key: string, vaultId?: string | null) {
  try {
    return await invoke<void>('vault_delete_secret', { payload: { key, vaultId: vaultId ?? undefined } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function vaultListSecretKeys(vaultId?: string | null) {
  try {
    return await invoke<string[]>('vault_list_secret_keys', { vaultId: vaultId ?? undefined })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

/** The Vault cannot serve secrets right now; callers match on the type, not the translated message. */
export class VaultUnavailableError extends Error {
  readonly reason: 'uninitialized' | 'locked'
  constructor(reason: 'uninitialized' | 'locked') {
    super(t(reason === 'locked' ? 'vault.error.locked' : 'vault.error.uninitialized'))
    this.name = 'VaultUnavailableError'
    this.reason = reason
  }
}
