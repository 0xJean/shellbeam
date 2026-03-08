/**
 * Full app data reset — clears Rust-side app data, localStorage,
 * and biometric secure storage. Works on all platforms.
 */
import { removeMasterPassword } from '@/lib/biometric'
import { invoke } from '@tauri-apps/api/core'

export async function clearAllAppData(): Promise<void> {
  // 1. Clear biometric secure storage (keychain / credential manager)
  await removeMasterPassword().catch(() => {})

  // 2. Clear Rust-side app data directory (hosts, vault, history, sync, etc.)
  await invoke('clear_app_data')

  // 3. Clear all localStorage (welcome flag, settings, biometric flag, etc.)
  localStorage.clear()
}
