import { parseStoredConversation, turnsToRemember, type AITurn, type StoredConversation } from './ai-conversation'
import { vaultOpenData, vaultSealData } from './vault'

/**
 * AI conversations hold terminal output and command results, so they are kept
 * sealed by their Vault: one encrypted thread-book per Vault and host, readable
 * only while that Vault is unlocked. The storage key is bound into the seal, so
 * conversations cannot be moved to another host's slot.
 */

const SEALED_PREFIX = 'shellbeam.aiConversationSealed.'
/** Where older releases kept conversations in plain text. */
export const LEGACY_CONVERSATION_PREFIX = 'shellbeam.aiConversation.'
const PURPOSE = 'ai.conversation'
const MAX_THREADS_PER_HOST = 20

export interface AIConversationThread {
  id: string
  title: string
  savedAt: number
  turns: AITurn[]
}

export interface StoredThreadBook {
  version: 2
  activeId: string
  threads: AIConversationThread[]
}

const writes = new Map<string, Promise<void>>()

function read(name: string): string | null {
  try { return localStorage.getItem(name) } catch { return null }
}

function remove(name: string) {
  try { localStorage.removeItem(name) } catch { /* storage unavailable */ }
}

export function deriveThreadTitle(turns: AITurn[]): string {
  const firstUser = turns.find((turn) => turn.kind === 'user' && !turn.auto)
  const raw = firstUser && firstUser.kind === 'user' ? firstUser.text.trim().replace(/\s+/g, ' ') : ''
  return raw ? raw.slice(0, 48) : 'New conversation'
}

function parseThreadBook(raw: string): StoredThreadBook | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredThreadBook>
    if (parsed && parsed.version === 2 && Array.isArray(parsed.threads)) {
      const threads = parsed.threads.filter(
        (t): t is AIConversationThread =>
          Boolean(t && typeof t.id === 'string' && typeof t.savedAt === 'number' && Array.isArray(t.turns)),
      )
      if (!threads.length) return null
      const activeId = typeof parsed.activeId === 'string' && threads.some((t) => t.id === parsed.activeId)
        ? parsed.activeId
        : threads[0].id
      return { version: 2, activeId, threads }
    }
  } catch { /* fall through to v1 */ }
  const legacy = parseStoredConversation(raw)
  if (!legacy || !legacy.turns.length) return null
  return {
    version: 2,
    activeId: 'default',
    threads: [{ id: 'default', title: deriveThreadTitle(legacy.turns), savedAt: legacy.savedAt, turns: legacy.turns }],
  }
}

async function writeSealedBook(vaultId: string, key: string, book: StoredThreadBook): Promise<void> {
  const sealed = await vaultSealData(PURPOSE, key, JSON.stringify(book), vaultId)
  localStorage.setItem(SEALED_PREFIX + key, sealed)
}

/** Each key's writes run in order, so an older save never lands after a newer one. */
function queue(key: string, task: () => Promise<void>): Promise<void> {
  const next = (writes.get(key) ?? Promise.resolve()).then(task).catch(() => { /* memory is best effort */ })
  writes.set(key, next)
  void next.then(() => { if (writes.get(key) === next) writes.delete(key) })
  return next
}

/** Load all saved threads for this Vault and host, migrating legacy plain-text or v1 sealed data. */
export async function loadConversationBook(vaultId: string, key: string): Promise<StoredThreadBook | null> {
  await writes.get(key)
  const sealed = read(SEALED_PREFIX + key)
  if (sealed) {
    try {
      return parseThreadBook(await vaultOpenData(PURPOSE, key, sealed, vaultId))
    } catch { return null }
  }
  const legacy = read(LEGACY_CONVERSATION_PREFIX + key)
  if (!legacy) return null
  const book = parseThreadBook(legacy)
  await queue(key, async () => {
    if (book) await writeSealedBook(vaultId, key, book)
    remove(LEGACY_CONVERSATION_PREFIX + key)
  })
  return book
}

/** Backwards-compatible helper returning the active thread's turns. */
export async function loadConversation(vaultId: string, key: string): Promise<StoredConversation | null> {
  const book = await loadConversationBook(vaultId, key)
  if (!book) return null
  const active = book.threads.find((t) => t.id === book.activeId) ?? book.threads[0]
  return active ? { savedAt: active.savedAt, turns: active.turns } : null
}

/** Save or remove a specific thread inside the host's Vault-sealed thread book. */
export function saveConversationThread(
  vaultId: string,
  key: string,
  threadId: string,
  turns: AITurn[],
  existingThreads: AIConversationThread[] = [],
): Promise<void> {
  const kept = turnsToRemember(turns)
  return queue(key, async () => {
    remove(LEGACY_CONVERSATION_PREFIX + key)
    const others = existingThreads.filter((t) => t.id !== threadId)
    const nextThreads = kept.length
      ? [{ id: threadId, title: deriveThreadTitle(kept), savedAt: Date.now(), turns: kept }, ...others].slice(0, MAX_THREADS_PER_HOST)
      : others
    if (nextThreads.length) {
      const activeId = kept.length ? threadId : nextThreads[0].id
      await writeSealedBook(vaultId, key, { version: 2, activeId, threads: nextThreads })
    } else {
      remove(SEALED_PREFIX + key)
    }
  })
}

export function deleteConversationThread(
  vaultId: string,
  key: string,
  threadId: string,
  existingThreads: AIConversationThread[],
): Promise<void> {
  return queue(key, async () => {
    remove(LEGACY_CONVERSATION_PREFIX + key)
    const remaining = existingThreads.filter((t) => t.id !== threadId)
    if (remaining.length) {
      await writeSealedBook(vaultId, key, { version: 2, activeId: remaining[0].id, threads: remaining })
    } else {
      remove(SEALED_PREFIX + key)
    }
  })
}

/** Backwards-compatible single-thread save. */
export function saveConversation(vaultId: string, key: string, turns: AITurn[]): Promise<void> {
  return saveConversationThread(vaultId, key, 'default', turns, [])
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
    const book = parseThreadBook(read(name) ?? '')
    await queue(key, async () => {
      if (book && !read(SEALED_PREFIX + key)) await writeSealedBook(vaultId, key, book)
      remove(name)
    })
  }
}
