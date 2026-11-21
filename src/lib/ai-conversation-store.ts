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
  /** Monotonic revision incremented on every saved mutation of this thread. */
  revision?: number
  /** Ephemeral panel/client token identifying the last writer to avoid self-conflicts during rapid saves. */
  lastWriterId?: string
  turns: AITurn[]
}

export interface StoredThreadBook {
  version: 2
  activeId: string
  threads: AIConversationThread[]
}

export type LoadBookResult =
  | { status: 'ok'; book: StoredThreadBook }
  | { status: 'empty' }
  | { status: 'error' }

export interface SaveThreadOptions {
  /** Revision this panel last loaded or saved; a mismatch from another writer forks instead of overwriting. */
  expectedRevision?: number
  /** Per-panel writer identity so back-to-back saves from the same panel do not conflict with themselves. */
  clientId?: string
}

export interface SaveThreadResult {
  book: StoredThreadBook | null
  threadId: string
  revision: number
  forked: boolean
  /** Set when a stale clear was rejected to protect newer sibling turns; caller should move to a fresh thread ID. */
  rejectedClear?: boolean
}

const writes = new Map<string, Promise<unknown>>()
/** Maps a diverged `(key, clientId, baseThreadId, expectedRevision)` write to its forked thread ID so rapid follow-ups land in the same fork. */
const activeForks = new Map<string, string>()
let forkSeq = 0

export function threadRevision(thread: Pick<AIConversationThread, 'revision'> | null | undefined): number {
  return typeof thread?.revision === 'number' && Number.isFinite(thread.revision) && thread.revision >= 1
    ? thread.revision
    : 1
}

function nextForkId(baseId: string, existing: AIConversationThread[]): string {
  const stem = baseId.replace(/-fork-[^-]+(?:-[^-]+)?$/, '')
  const used = new Set(existing.map((t) => t.id))
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${stem}-fork-${Date.now()}-${++forkSeq}`
    if (!used.has(candidate)) return candidate
  }
  return `${stem}-fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

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

/**
 * Load all saved threads for this Vault and host, distinguishing confirmed absence (`empty`)
 * from an unreadable/locked Vault (`error`) so callers never clear cached UI on transient errors.
 */
export async function loadConversationBookState(vaultId: string, key: string): Promise<LoadBookResult> {
  await writes.get(key)
  const sealed = read(SEALED_PREFIX + key)
  if (sealed) {
    try {
      const book = parseThreadBook(await vaultOpenData(PURPOSE, key, sealed, vaultId))
      return book ? { status: 'ok', book } : { status: 'empty' }
    } catch { return { status: 'error' } }
  }
  const legacy = read(LEGACY_CONVERSATION_PREFIX + key)
  if (!legacy) return { status: 'empty' }
  const book = parseThreadBook(legacy)
  await queue(key, async () => {
    if (book && !read(SEALED_PREFIX + key)) await writeSealedBook(vaultId, key, book)
    remove(LEGACY_CONVERSATION_PREFIX + key)
  })
  return book ? { status: 'ok', book } : { status: 'empty' }
}

/** Load all saved threads for this Vault and host, migrating legacy plain-text or v1 sealed data. */
export async function loadConversationBook(vaultId: string, key: string): Promise<StoredThreadBook | null> {
  const result = await loadConversationBookState(vaultId, key)
  return result.status === 'ok' ? result.book : null
}

/** Backwards-compatible helper returning the active thread's turns. */
export async function loadConversation(vaultId: string, key: string): Promise<StoredConversation | null> {
  const book = await loadConversationBook(vaultId, key)
  if (!book) return null
  const active = book.threads.find((t) => t.id === book.activeId) ?? book.threads[0]
  return active ? { savedAt: active.savedAt, turns: active.turns } : null
}

/**
 * Save or remove a specific thread inside the host's Vault-sealed thread book without clobbering
 * sibling terminals. If another panel modified the same thread since `expectedRevision`, the write
 * forks into a new thread ID so neither terminal loses replies.
 */
export function saveConversationThread(
  vaultId: string,
  key: string,
  threadId: string,
  turns: AITurn[],
  options: SaveThreadOptions = {},
): Promise<SaveThreadResult | undefined> {
  const kept = turnsToRemember(turns)
  const { expectedRevision, clientId } = options
  return queue(key, async () => {
    const { book: latest, fromLegacy } = await readStoredBook(vaultId, key)
    const existing = latest?.threads ?? []

    const forkLookupKey = clientId && expectedRevision !== undefined
      ? `${key}\0${clientId}\0${threadId}\0${expectedRevision}`
      : null
    let targetId = (forkLookupKey && activeForks.get(forkLookupKey)) || threadId
    let forked = targetId !== threadId
    const prev = existing.find((t) => t.id === targetId)

    // Detect sibling-panel divergence on the same thread and preserve both branches.
    if (!forked && prev && expectedRevision !== undefined) {
      const currentRev = threadRevision(prev)
      const modifiedBySibling = currentRev !== expectedRevision && (!clientId || prev.lastWriterId !== clientId)
      if (modifiedBySibling) {
        if (!kept.length) {
          // Do not let a stale clear wipe replies added by a sibling terminal.
          return { book: latest, threadId: targetId, revision: currentRev, forked: false, rejectedClear: true }
        }
        targetId = nextForkId(threadId, existing)
        forked = true
        if (forkLookupKey) activeForks.set(forkLookupKey, targetId)
      }
    }

    const targetPrev = existing.find((t) => t.id === targetId)
    const others = existing.filter((t) => t.id !== targetId)

    if (!kept.length && !targetPrev) {
      if (fromLegacy) {
        if (latest) await writeSealedBook(vaultId, key, latest)
        remove(LEGACY_CONVERSATION_PREFIX + key)
      }
      return { book: latest, threadId: targetId, revision: 0, forked: false }
    }

    remove(LEGACY_CONVERSATION_PREFIX + key)
    const nextRevision = targetPrev ? threadRevision(targetPrev) + 1 : 1
    const nextThreads = kept.length
      ? [
          {
            id: targetId,
            title: deriveThreadTitle(turns),
            savedAt: Date.now(),
            revision: nextRevision,
            ...(clientId ? { lastWriterId: clientId } : {}),
            turns: kept,
          },
          ...others,
        ].slice(0, MAX_THREADS_PER_HOST)
      : others

    if (nextThreads.length) {
      const activeId = kept.length
        ? targetId
        : (latest?.activeId && latest.activeId !== targetId && nextThreads.some((t) => t.id === latest.activeId)
            ? latest.activeId
            : nextThreads[0].id)
      const nextBook: StoredThreadBook = { version: 2, activeId, threads: nextThreads }
      await writeSealedBook(vaultId, key, nextBook)
      return { book: nextBook, threadId: targetId, revision: kept.length ? nextRevision : 0, forked }
    }
    remove(SEALED_PREFIX + key)
    return { book: null, threadId: targetId, revision: 0, forked: false }
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
