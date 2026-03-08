/**
 * Biometric authentication abstraction layer.
 *
 * Uses `tauri-plugin-biometry` when available (iOS / Android / macOS / Windows).
 *
 * On macOS: keychain-access-groups entitlement causes app launch failure on
 * macOS 26 Tahoe (provenance mechanism). So we use authenticate() for Touch ID
 * verification + encrypted file storage for the password (no keychain needed).
 *
 * On iOS/Android: uses the plugin's native keychain/keystore via setData/getData.
 */

import { invoke } from '@tauri-apps/api/core'

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
    // @ts-ignore — package may not be installed
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
 * Some plugins misreport — e.g. returning FaceID on macOS which only has Touch ID.
 */
function correctTypeForPlatform(type: BiometryType): BiometryType {
  const platform = detectPlatform()
  if (platform === 'macos' && type === 'faceId') return 'touchId'
  if (platform === 'android' && type === 'faceId') return 'fingerprint'
  return type
}

const isMacOS = () => detectPlatform() === 'macos'

// ---------------------------------------------------------------------------
// macOS file-based secure storage (avoids keychain entitlement requirement)
//
// On macOS 26+, keychain-access-groups entitlement causes app launch failure.
// Instead we: authenticate() with Touch ID + store password in an encrypted
// file via Rust backend (AES-256-GCM, same encryption as vault secrets).
// ---------------------------------------------------------------------------

async function macosStorePassword(password: string): Promise<void> {
  await invoke<void>('biometric_store_password', { password })
}

async function macosRetrievePassword(): Promise<string> {
  return await invoke<string>('biometric_retrieve_password')
}

async function macosHasPassword(): Promise<boolean> {
  return await invoke<boolean>('biometric_has_password')
}

async function macosRemovePassword(): Promise<void> {
  await invoke<void>('biometric_remove_password')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether biometric auth is available on this device.
 *
 * On macOS: the plugin's checkStatus() may return isAvailable=false when the
 * app lacks keychain entitlements (macOS 26 provenance). However authenticate()
 * still works fine via LocalAuthentication. So on macOS we optimistically
 * report available=true with type=touchId if the plugin is loaded, and let
 * actual authenticate() calls handle any real failures.
 */
export async function checkBiometricStatus(): Promise<BiometricStatus> {
  const plugin = await getPlugin()
  if (!plugin) return { available: false, type: 'none', error: 'Plugin not installed' }
  try {
    const status = await plugin.checkStatus()
    const rawType = mapType(status.biometryType)
    const type = correctTypeForPlatform(rawType)

    // On macOS, checkStatus may falsely report unavailable due to missing
    // keychain entitlements. authenticate() works without them, so we
    // optimistically mark as available when the plugin loaded successfully.
    if (isMacOS() && !status.isAvailable) {
      return { available: true, type: 'touchId' }
    }

    return {
      available: status.isAvailable,
      type,
      error: status.error,
    }
  } catch (e) {
    // On macOS, even if checkStatus throws, Touch ID may still work
    if (isMacOS()) {
      return { available: true, type: 'touchId' }
    }
    return { available: false, type: 'none', error: String(e) }
  }
}

/** Human-readable label for the biometry type. */
export function biometryLabel(type: BiometryType): string {
  switch (type) {
    case 'touchId': return 'Touch ID'
    case 'faceId': return 'Face ID'
    case 'fingerprint': return '指纹'
    case 'iris': return '虹膜'
    case 'auto': return 'Windows Hello'
    default: return ''
  }
}

/**
 * Store the vault master password in secure storage,
 * protected by biometric authentication.
 *
 * macOS: authenticate() + encrypted file (no keychain entitlement needed)
 * iOS/Android: plugin keychain/keystore via setData()
 */
export async function storeMasterPassword(password: string): Promise<void> {
  const plugin = await getPlugin()
  if (!plugin) throw new Error('Biometric plugin not available')

  if (isMacOS()) {
    // Touch ID verify first, then store to encrypted file.
    // allowDeviceCredential lets the user fall back to Mac password,
    // which is equally valid as Touch ID for identity verification.
    await plugin.authenticate('验证身份以启用 Touch ID 解锁', { allowDeviceCredential: true })
    await macosStorePassword(password)
  } else {
    await plugin.setData({ domain: DOMAIN, name: KEY_NAME, data: password })
  }
  localStorage.setItem(LS_ENABLED_KEY, 'true')
}

/**
 * Retrieve the vault master password from secure storage.
 * This will trigger a biometric prompt (Face ID / Touch ID / etc.).
 *
 * macOS: authenticate() + read encrypted file
 * iOS/Android: plugin getData() (triggers biometric natively)
 */
export async function retrieveMasterPassword(reason: string): Promise<string> {
  const plugin = await getPlugin()
  if (!plugin) throw new Error('Biometric plugin not available')

  if (isMacOS()) {
    await plugin.authenticate(reason, { allowDeviceCredential: true })
    return await macosRetrievePassword()
  }
  const resp = await plugin.getData({ domain: DOMAIN, name: KEY_NAME, reason })
  return resp.data
}

/** Check if a stored password exists without triggering biometric prompt. */
export async function hasMasterPassword(): Promise<boolean> {
  if (isMacOS()) {
    try { return await macosHasPassword() } catch { return false }
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
  if (isMacOS()) {
    try { await macosRemovePassword() } catch { /* ok */ }
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
