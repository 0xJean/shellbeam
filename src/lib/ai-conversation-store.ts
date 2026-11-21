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

const writes = new Map<string, Promise<unknown>>()

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
function queue<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
  const next = (writes.get(key) ?? Promise.resolve()).then(task).catch(() => undefined)
  writes.set(key, next)
  void next.then(() => { if (writes.get(key) === next) writes.delete(key) })
  return next
}

/**
 * Read the latest stored book inside a queued write.
 * Errors from `vaultOpenData` propagate so a locked or unreadable Vault never causes a write to wipe existing threads.
 */
async function readStoredBook(vaultId: string, key: string): Promise<{ book: StoredThreadBook | null; fromLegacy: boolean }> {
  const sealed = read(SEALED_PREFIX + key)
  if (sealed) {
    return { book: parseThreadBook(await vaultOpenData(PURPOSE, key, sealed, vaultId)), fromLegacy: false }
  }
  const legacy = read(LEGACY_CONVERSATION_PREFIX + key)
  if (!legacy) return { book: null, fromLegacy: false }
  return { book: parseThreadBook(legacy), fromLegacy: true }
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
    if (book && !read(SEALED_PREFIX + key)) await writeSealedBook(vaultId, key, book)
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

/** Save or remove a specific thread inside the host's Vault-sealed thread book without clobbering sibling terminals. */
export function saveConversationThread(
  vaultId: string,
  key: string,
  threadId: string,
  turns: AITurn[],
): Promise<StoredThreadBook | null | undefined> {
  const kept = turnsToRemember(turns)
  return queue(key, async () => {
    const { book: latest, fromLegacy } = await readStoredBook(vaultId, key)
    const existing = latest?.threads ?? []
    const hadThread = existing.some((t) => t.id === threadId)
    const others = existing.filter((t) => t.id !== threadId)

    if (!kept.length && !hadThread) {
      if (fromLegacy) {
        if (latest) await writeSealedBook(vaultId, key, latest)
        remove(LEGACY_CONVERSATION_PREFIX + key)
      }
      return latest
    }

    remove(LEGACY_CONVERSATION_PREFIX + key)
    const nextThreads = kept.length
      ? [{ id: threadId, title: deriveThreadTitle(kept), savedAt: Date.now(), turns: kept }, ...others].slice(0, MAX_THREADS_PER_HOST)
      : others
    if (nextThreads.length) {
      const activeId = kept.length
        ? threadId
        : (latest?.activeId && latest.activeId !== threadId && nextThreads.some((t) => t.id === latest.activeId)
            ? latest.activeId
            : nextThreads[0].id)
      const nextBook: StoredThreadBook = { version: 2, activeId, threads: nextThreads }
      await writeSealedBook(vaultId, key, nextBook)
      return nextBook
    }
    remove(SEALED_PREFIX + key)
    return null
  })
}

export function deleteConversationThread(
  vaultId: string,
  key: string,
  threadId: string,
): Promise<StoredThreadBook | null | undefined> {
  return queue(key, async () => {
    const { book: latest } = await readStoredBook(vaultId, key)
    remove(LEGACY_CONVERSATION_PREFIX + key)
    const remaining = (latest?.threads ?? []).filter((t) => t.id !== threadId)
    if (remaining.length) {
      const activeId = latest?.activeId && latest.activeId !== threadId && remaining.some((t) => t.id === latest.activeId)
        ? latest.activeId
        : remaining[0].id
      const nextBook: StoredThreadBook = { version: 2, activeId, threads: remaining }
      await writeSealedBook(vaultId, key, nextBook)
      return nextBook
    }
    remove(SEALED_PREFIX + key)
    return null
  })
}

/** Backwards-compatible single-thread save. */
export async function saveConversation(vaultId: string, key: string, turns: AITurn[]): Promise<void> {
  await saveConversationThread(vaultId, key, 'default', turns)
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
