import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface HostKeyAcceptance { host: string; port: number; fingerprint: string }

export interface KnownHostEntry {
  host: string
  port: number
  fingerprintSha256: string
  keyType: string
  addedAt: number
}

// Known hosts are scoped per vault; an unset vault means Personal.
export async function listKnownHosts(vaultId: string | undefined): Promise<KnownHostEntry[]> {
  try {
    return await invoke<KnownHostEntry[]>('list_known_hosts', { vaultId })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function fetchAndAddKnownHost(vaultId: string | undefined, host: string, port: number): Promise<KnownHostEntry> {
  try {
    return await invoke<KnownHostEntry>('fetch_and_add_known_host', { vaultId, host, port })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function removeKnownHost(vaultId: string | undefined, host: string, port: number): Promise<void> {
  try {
    await invoke('remove_known_host', { vaultId, host, port })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
