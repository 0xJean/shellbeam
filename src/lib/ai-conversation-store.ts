import { parseStoredConversation, turnsToRemember, type AITurn, type StoredConversation } from './ai-conversation'
import { vaultOpenData, vaultSealData } from './vault'

/**
 * AI conversations hold terminal output and command results, so they are kept
 * sealed by their Vault: one per Vault and host, readable only while that Vault
 * is unlocked. The storage key is bound into the seal, so a conversation cannot
 * be moved to another host's slot.
 */

const SEALED_PREFIX = 'shellbeam.aiConversationSealed.'
/** Where older releases kept conversations in plain text. */
export const LEGACY_CONVERSATION_PREFIX = 'shellbeam.aiConversation.'
const PURPOSE = 'ai.conversation'

const writes = new Map<string, Promise<void>>()

function read(name: string): string | null {
  try { return localStorage.getItem(name) } catch { return null }
}

function remove(name: string) {
  try { localStorage.removeItem(name) } catch { /* storage unavailable */ }
}

async function writeSealed(vaultId: string, key: string, conversation: StoredConversation): Promise<void> {
  const sealed = await vaultSealData(PURPOSE, key, JSON.stringify(conversation), vaultId)
  localStorage.setItem(SEALED_PREFIX + key, sealed)
}

/** Each key's writes run in order, so an older save never lands after a newer one. */
function queue(key: string, task: () => Promise<void>): Promise<void> {
  const next = (writes.get(key) ?? Promise.resolve()).then(task).catch(() => { /* memory is best effort */ })
  writes.set(key, next)
  void next.then(() => { if (writes.get(key) === next) writes.delete(key) })
  return next
}

/** The conversation saved for this Vault and host, or null when there is none or it cannot be opened. */
export async function loadConversation(vaultId: string, key: string): Promise<StoredConversation | null> {
  await writes.get(key)
  const sealed = read(SEALED_PREFIX + key)
  if (sealed) {
    try { return parseStoredConversation(await vaultOpenData(PURPOSE, key, sealed, vaultId)) } catch { return null }
  }
  const legacy = read(LEGACY_CONVERSATION_PREFIX + key)
  if (!legacy) return null
  const conversation = parseStoredConversation(legacy)
  await queue(key, async () => {
    if (conversation) await writeSealed(vaultId, key, conversation)
    remove(LEGACY_CONVERSATION_PREFIX + key)
  })
  return conversation
}

export function saveConversation(vaultId: string, key: string, turns: AITurn[]): Promise<void> {
  const kept = turnsToRemember(turns)
  return queue(key, async () => {
    remove(LEGACY_CONVERSATION_PREFIX + key)
    if (kept.length) await writeSealed(vaultId, key, { savedAt: Date.now(), turns: kept })
    else remove(SEALED_PREFIX + key)
  })
}

/**
 * Seal every plain-text conversation an older release left for this Vault.
 * Conversations kept without any Vault have nothing to seal them with and are removed.
 */
export async function migrateLegacyConversations(vaultId: string): Promise<void> {
  let names: string[] = []
  try {
    names = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? '')
      .filter((name) => name.startsWith(LEGACY_CONVERSATION_PREFIX))
  } catch { return }
  for (const name of names) {
    const key = name.slice(LEGACY_CONVERSATION_PREFIX.length)
    if (key.startsWith('none:')) { remove(name); continue }
    if (!key.startsWith(`${vaultId}:`)) continue
    const conversation = parseStoredConversation(read(name) ?? '')
    await queue(key, async () => {
      if (conversation && !read(SEALED_PREFIX + key)) await writeSealed(vaultId, key, conversation)
      remove(name)
    })
  }
}
