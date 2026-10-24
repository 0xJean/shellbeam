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

export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  try {
    return await invoke<KnownHostEntry[]>('list_known_hosts')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function fetchAndAddKnownHost(host: string, port: number): Promise<KnownHostEntry> {
  try {
    return await invoke<KnownHostEntry>('fetch_and_add_known_host', { host, port })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function removeKnownHost(host: string, port: number): Promise<void> {
  try {
    await invoke('remove_known_host', { host, port })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
