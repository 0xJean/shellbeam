import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export interface DiscoveredDevice {
  name: string
  host: string
  port: number
  deviceType: string // "phone" or "computer"
}

// ─── Android NSD bridge (window.ShellBeamNSD injected by MainActivity) ──────

interface ShellBeamNSDBridge {
  registerService(port: number, instanceName: string): void
  unregisterService(): void
  startDiscovery(): void
  stopDiscovery(): void
}

declare global {
  interface Window {
    ShellBeamNSD?: ShellBeamNSDBridge
  }
}

const isAndroid = /android/i.test(navigator.userAgent)

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
  // On Android, also trigger NSD discovery via native bridge
  if (isAndroid && window.ShellBeamNSD) {
    try { window.ShellBeamNSD.startDiscovery() } catch { /* silent */ }
  }
}

export async function mdnsStopDiscover(): Promise<void> {
  try {
    await invoke('mdns_stop_discover')
  } catch { /* silent */ }
  if (isAndroid && window.ShellBeamNSD) {
    try { window.ShellBeamNSD.stopDiscovery() } catch { /* silent */ }
  }
}

/**
 * Register NSD service on Android (called after sync server starts).
 */
export function androidNsdRegister(port: number, instanceName: string): void {
  if (isAndroid && window.ShellBeamNSD) {
    try { window.ShellBeamNSD.registerService(port, instanceName) } catch { /* silent */ }
  }
}

/**
 * Unregister NSD service on Android.
 */
export function androidNsdUnregister(): void {
  if (isAndroid && window.ShellBeamNSD) {
    try { window.ShellBeamNSD.unregisterService() } catch { /* silent */ }
  }
}

export function onMdnsDeviceFound(callback: (device: DiscoveredDevice) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false

  // Listen for Tauri events (macOS/iOS — emitted by Rust)
  listen<DiscoveredDevice>('mdns-device-found', (event) => {
    if (!cancelled) callback(event.payload)
  }).then((fn) => {
    if (cancelled) { fn() } else { unlisten = fn }
  })

  // Listen for Android NSD events (emitted by NsdHelper via CustomEvent)
  const handleNsdEvent = (e: Event) => {
    if (cancelled) return
    const detail = (e as CustomEvent).detail as DiscoveredDevice
    if (detail?.host && detail?.port) {
      callback(detail)
    }
  }
  if (isAndroid) {
    window.addEventListener('shellbeam-nsd-device', handleNsdEvent)
  }

  return () => {
    cancelled = true
    unlisten?.()
    if (isAndroid) {
      window.removeEventListener('shellbeam-nsd-device', handleNsdEvent)
    }
  }
}
