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
  getDeviceName?(): string
  logToNative?(message: string): void
}

declare global {
  interface Window {
    ShellBeamNSD?: ShellBeamNSDBridge
  }
}

/** Check if NSD bridge is available (more reliable than UA detection) */
function hasNsdBridge(): boolean {
  try {
    const bridge = window.ShellBeamNSD
    if (!bridge) return false
    // @JavascriptInterface methods exist on the bridge object
    return 'startDiscovery' in bridge
  } catch {
    return false
  }
}

function nsdLog(msg: string, ...args: unknown[]) {
  const formatted = `[NSD] ${msg} ${args.map(a => String(a)).join(' ')}`.trim()
  console.log(formatted)
  // Also log via native bridge so it appears in adb logcat even in release builds
  try {
    const bridge = window.ShellBeamNSD as unknown as Record<string, unknown> | undefined
    if (bridge && typeof bridge.logToNative === 'function') {
      (bridge.logToNative as (s: string) => void)(formatted)
    }
  } catch { /* ignore */ }
}

// Log bridge status at module load time for debugging
nsdLog('module loaded, hasNsdBridge=%s', hasNsdBridge())

export async function mdnsDiscoverDevices(): Promise<DiscoveredDevice[]> {
  try {
    return await invoke<DiscoveredDevice[]>('mdns_discover_devices')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function mdnsStartDiscover(): Promise<void> {
  nsdLog('mdnsStartDiscover called, bridge=%s', hasNsdBridge())
  try {
    await invoke('mdns_start_discover')
    nsdLog('Rust mdns_start_discover OK')
  } catch (error) {
    nsdLog('Rust mdns_start_discover error:', error)
    // On Android the Rust side is a no-op, so ignore errors
    if (!hasNsdBridge()) throw new Error(toInvokeErrorMessage(error))
  }
  // Trigger NSD discovery via native bridge (Android)
  if (hasNsdBridge()) {
    try {
      window.ShellBeamNSD!.startDiscovery()
      nsdLog('ShellBeamNSD.startDiscovery() called OK')
    } catch (e) { nsdLog('ShellBeamNSD.startDiscovery() error:', e) }
  } else {
    nsdLog('No NSD bridge available, skipping native discovery')
  }
}

export async function mdnsStopDiscover(): Promise<void> {
  try {
    await invoke('mdns_stop_discover')
  } catch { /* silent */ }
  if (hasNsdBridge()) {
    try { window.ShellBeamNSD!.stopDiscovery() } catch { /* silent */ }
  }
}

/**
 * Get the Android device model name via NSD bridge.
 * Returns null on non-Android platforms.
 */
export function getAndroidDeviceName(): string | null {
  if (!hasNsdBridge()) return null
  try {
    const bridge = window.ShellBeamNSD
    if (bridge && typeof bridge.getDeviceName === 'function') {
      return bridge.getDeviceName() || null
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Register NSD service on Android (called after sync server starts).
 */
export function androidNsdRegister(port: number, instanceName: string): void {
  nsdLog('androidNsdRegister called, port=%d name=%s bridge=%s', port, instanceName, hasNsdBridge())
  if (hasNsdBridge()) {
    try {
      window.ShellBeamNSD!.registerService(port, instanceName)
      nsdLog('ShellBeamNSD.registerService() called OK')
    } catch (e) { nsdLog('ShellBeamNSD.registerService() error:', e) }
  }
}

/**
 * Unregister NSD service on Android.
 */
export function androidNsdUnregister(): void {
  if (hasNsdBridge()) {
    try { window.ShellBeamNSD!.unregisterService() } catch { /* silent */ }
  }
}

/**
 * Diagnostic: check Android NSD bridge status.
 * Call from browser console or sync panel to debug NSD issues.
 */
export function diagnoseAndroidNsd(): string[] {
  const log: string[] = []
  const ua = navigator.userAgent
  log.push(`[INFO] userAgent: ${ua}`)
  log.push(`[INFO] hasNsdBridge(): ${hasNsdBridge()}`)
  log.push(`[INFO] window.ShellBeamNSD exists: ${!!window.ShellBeamNSD}`)
  log.push(`[INFO] typeof window.ShellBeamNSD: ${typeof window.ShellBeamNSD}`)
  if (window.ShellBeamNSD) {
    const methods = ['registerService', 'unregisterService', 'startDiscovery', 'stopDiscovery']
    for (const m of methods) {
      log.push(`[INFO]   ${m}: ${typeof (window.ShellBeamNSD as unknown as Record<string, unknown>)[m]}`)
    }
  }
  log.forEach(l => console.log(l))
  return log
}

// Expose to global for console debugging — always register so it's available
// even before the NSD bridge is injected
;(window as unknown as Record<string, unknown>).__nsdDiagnose = diagnoseAndroidNsd

// Also listen for bridge-ready event and re-check
window.addEventListener('shellbeam-nsd-ready', () => {
  nsdLog('shellbeam-nsd-ready event received, hasNsdBridge=%s', hasNsdBridge())
})

export function onMdnsDeviceFound(callback: (device: DiscoveredDevice) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false

  // Listen for Tauri events (macOS/iOS — emitted by Rust)
  listen<DiscoveredDevice>('mdns-device-found', (event) => {
    nsdLog('Tauri event mdns-device-found:', event.payload)
    if (!cancelled) callback(event.payload)
  }).then((fn) => {
    if (cancelled) { fn() } else { unlisten = fn }
  })

  // Listen for Android NSD events (emitted by NsdHelper via CustomEvent)
  const handleNsdEvent = (e: Event) => {
    if (cancelled) return
    const detail = (e as CustomEvent).detail as DiscoveredDevice
    nsdLog('CustomEvent shellbeam-nsd-device received:', detail)
    if (detail?.host && detail?.port) {
      callback(detail)
    }
  }
  // Always register the CustomEvent listener — on Android the NSD bridge
  // emits device-found events this way regardless of UA string
  window.addEventListener('shellbeam-nsd-device', handleNsdEvent)
  nsdLog('Registered shellbeam-nsd-device event listener')

  return () => {
    cancelled = true
    unlisten?.()
    window.removeEventListener('shellbeam-nsd-device', handleNsdEvent)
  }
}
