/**
 * Biometric authentication abstraction layer.
 *
 * Uses `tauri-plugin-biometry` when available (iOS / Android / macOS / Windows).
 *
 * On macOS and iOS: the Rust side keeps the password in a data protection Keychain
 * item that requires Touch ID or Face ID, so the OS enforces the check and a device
 * passcode does not open it. On macOS that needs the keychain-access-groups
 * entitlement; a build without it reports unavailable.
 *
 * On Android: uses the plugin's native keystore via setData/getData.
 */

import { invoke } from '@tauri-apps/api/core'
import { t } from '@/lib/i18n'

const DOMAIN = 'com.shellbeam'
const KEY_NAME = 'vault-master-pw'
const LS_ENABLED_KEY = 'shellbeam.biometricEnabled'

export type BiometryType = 'none' | 'touchId' | 'faceId' | 'fingerprint' | 'iris' | 'auto'

export interface BiometricStatus {
  available: boolean
  type: BiometryType
  error?: string
}

// ---------------------------------------------------------------------------
// Dynamic import helper — returns null when the plugin is not installed
// ---------------------------------------------------------------------------

async function getPlugin() {
  try {
    return await import('@choochmeque/tauri-plugin-biometry-api')
  } catch {
    return null
  }
}

/**
 * Map plugin's raw biometry type enum to our type.
 * Plugin enum: None=0, Auto=1, TouchID=2, FaceID=3, Iris=4
 */
function mapType(raw: number): BiometryType {
  switch (raw) {
    case 1: return 'auto'
    case 2: return 'touchId'
    case 3: return 'faceId'
    case 4: return 'iris'
    default: return 'none'
  }
}

/** Detect platform to correct biometry type misreporting */
function detectPlatform(): 'macos' | 'windows' | 'ios' | 'android' | 'unknown' {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  return 'unknown'
}

/**
 * Fix biometry type based on platform.
 * The plugin often returns 'auto' (enum 1) or misreports the type.
 * Map to the correct platform-native biometry type.
 */
function correctTypeForPlatform(type: BiometryType): BiometryType {
  const platform = detectPlatform()
  if (platform === 'macos') {
    // macOS only has Touch ID
    if (type === 'faceId' || type === 'auto') return 'touchId'
  }
  if (platform === 'ios') {
    // iOS: auto → Face ID (most modern iPhones); older devices with Touch ID
    // would report touchId directly. Plugin returning auto means Face ID.
    if (type === 'auto') return 'faceId'
  }
  if (platform === 'android') {
    // Android: auto/faceId → fingerprint (most common biometric)
    if (type === 'auto' || type === 'faceId') return 'fingerprint'
  }
  if (platform === 'windows') {
    if (type === 'auto') return 'auto' // Windows Hello is correct for auto
  }
  return type
}

const usesAppleKeychain = () => {
  const platform = detectPlatform()
  return platform === 'macos' || platform === 'ios'
}

// ---------------------------------------------------------------------------
// macOS and iOS Keychain storage, in Rust (see biometric_store.rs)
// ---------------------------------------------------------------------------

let pluginItemPurged = false

/**
 * Earlier iOS versions kept the password in the plugin's item, which the device
 * passcode opens. It is never migrated: the user enrols again from Settings.
 */
async function purgeIosPluginItem(plugin: NonNullable<Awaited<ReturnType<typeof getPlugin>>>) {
  if (pluginItemPurged || detectPlatform() !== 'ios') return
  pluginItemPurged = true
  try { await plugin.removeData({ domain: DOMAIN, name: KEY_NAME }) } catch { /* nothing stored */ }
}

async function keychainStorePassword(password: string): Promise<void> {
  await invoke<void>('biometric_store_password', { password })
}

async function keychainRetrievePassword(reason: string): Promise<string> {
  return await invoke<string>('biometric_retrieve_password', { reason })
}

async function keychainHasPassword(): Promise<boolean> {
  return await invoke<boolean>('biometric_has_password')
}

async function keychainRemovePassword(): Promise<void> {
  await invoke<void>('biometric_remove_password')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether biometric auth is available on this device.
 *
 * On macOS and iOS the answer also needs the Keychain: a build without the
 * entitlement, or a Mac without enrolled Touch ID, cannot use biometric unlock. An enrolment
 * that no longer exists (such as one from the old file store) clears the enabled
 * flag, so the user enrols again from Settings rather than being re-enrolled silently.
 */
export async function checkBiometricStatus(): Promise<BiometricStatus> {
  const plugin = await getPlugin()
  if (!plugin) return { available: false, type: 'none', error: 'Plugin not installed' }
  try {
    await purgeIosPluginItem(plugin)
    if (usesAppleKeychain() && !(await keychainHasPassword())) localStorage.removeItem(LS_ENABLED_KEY)
    const status = await plugin.checkStatus()
    const type = correctTypeForPlatform(mapType(status.biometryType))
    return {
      available: status.isAvailable,
      type,
      error: status.error,
    }
  } catch (e) {
    if (usesAppleKeychain()) localStorage.removeItem(LS_ENABLED_KEY)
    return { available: false, type: 'none', error: String(e) }
  }
}

/** Human-readable label for the biometry type. */
export function biometryLabel(type: BiometryType): string {
  switch (type) {
    case 'touchId': return 'Touch ID'
    case 'faceId': return 'Face ID'
    case 'fingerprint': return t('biometric.fingerprint')
    case 'iris': return t('biometric.iris')
    case 'auto': return detectPlatform() === 'windows' ? 'Windows Hello' : t('biometric.generic')
    default: return t('biometric.generic')
  }
}

/**
 * Store the vault master password in secure storage,
 * protected by biometric authentication.
 *
 * macOS/iOS: Keychain item requiring Touch ID or Face ID. Writing does not prompt;
 * callers read it back, and that read is what asks for the biometric.
 * Android: plugin keystore via setData()
 */
export async function storeMasterPassword(password: string): Promise<void> {
  if (usesAppleKeychain()) {
    await keychainStorePassword(password)
  } else {
    const plugin = await getPlugin()
    if (!plugin) throw new Error('Biometric plugin not available')
    await plugin.setData({ domain: DOMAIN, name: KEY_NAME, data: password })
  }
  localStorage.setItem(LS_ENABLED_KEY, 'true')
}

/**
 * Retrieve the vault master password from secure storage.
 * This will trigger a biometric prompt (Face ID / Touch ID / etc.).
 *
 * macOS/iOS: Keychain read; the OS shows the prompt before releasing the item
 * Android: plugin getData() (triggers biometric natively)
 */
export async function retrieveMasterPassword(reason: string): Promise<string> {
  if (usesAppleKeychain()) return await keychainRetrievePassword(reason)
  const plugin = await getPlugin()
  if (!plugin) throw new Error('Biometric plugin not available')
  const resp = await plugin.getData({ domain: DOMAIN, name: KEY_NAME, reason })
  return resp.data
}

/** Check if a stored password exists without triggering biometric prompt. */
export async function hasMasterPassword(): Promise<boolean> {
  if (usesAppleKeychain()) {
    try { return await keychainHasPassword() } catch { return false }
  }
  const plugin = await getPlugin()
  if (!plugin) return false
  try {
    return await plugin.hasData({ domain: DOMAIN, name: KEY_NAME })
  } catch {
    return false
  }
}

/** Remove the stored master password and disable biometric unlock. */
export async function removeMasterPassword(): Promise<void> {
  if (usesAppleKeychain()) {
    try { await keychainRemovePassword() } catch { /* ok */ }
  } else {
    const plugin = await getPlugin()
    if (plugin) {
      try { await plugin.removeData({ domain: DOMAIN, name: KEY_NAME }) } catch { /* ok */ }
    }
  }
  localStorage.removeItem(LS_ENABLED_KEY)
}

/** Whether the user has previously enabled biometric unlock (UI hint only). */
export function isBiometricEnabled(): boolean {
  return localStorage.getItem(LS_ENABLED_KEY) === 'true'
}
