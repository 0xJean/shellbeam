import { AI_SETTINGS_EVENT, legacyAIKeys } from './ai'
import { migrateLegacyConversations } from './ai-conversation-store'
import { clearAIKeys, hydrateAIKeys } from './ai-secrets'

/**
 * A Vault unlocked: load its AI keys, move keys and conversations an older
 * release kept in plain text into it, and let open AI panels reload.
 */
export async function onAIVaultUnlocked(vaultId: string): Promise<void> {
  await hydrateAIKeys(vaultId, legacyAIKeys())
  window.dispatchEvent(new Event(AI_SETTINGS_EVENT))
  await migrateLegacyConversations(vaultId)
}

/** The Vault locked or another one became active: AI keys leave memory. */
export function onAIVaultLocked() {
  clearAIKeys()
  window.dispatchEvent(new Event(AI_SETTINGS_EVENT))
}
