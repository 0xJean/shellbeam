import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface DiscoveredDevice {
  name: string
  host: string
  port: number
  deviceType: string // "phone" or "computer"
}

export async function mdnsDiscoverDevices(): Promise<DiscoveredDevice[]> {
  try {
    return await invoke<DiscoveredDevice[]>('mdns_discover_devices')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function mdnsStartDiscover(): Promise<void> {
  try {
    await invoke('mdns_start_discover')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function mdnsStopDiscover(): Promise<void> {
  try {
    await invoke('mdns_stop_discover')
  } catch { /* silent */ }
}

export function onMdnsDeviceFound(callback: (device: DiscoveredDevice) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false
  listen<DiscoveredDevice>('mdns-device-found', (event) => {
    if (!cancelled) callback(event.payload)
  }).then((fn) => {
    if (cancelled) { fn() } else { unlisten = fn }
  })
  return () => { cancelled = true; unlisten?.() }
}
