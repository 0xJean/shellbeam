// Typed commands are kept per vault (`${STORAGE_KEY}:${vaultId}`), then by host address.
const STORAGE_KEY = 'shellbeam.interactiveHistory'
const DEFAULT_VAULT_ID = 'personal'
const MAX_PER_HOST = 200

export interface InteractiveCommand {
  command: string
  timestamp: number
}

type HostHistoryMap = Record<string, InteractiveCommand[]>

const caches = new Map<string, HostHistoryMap>()
let legacyChecked = false

function vaultKey(vaultId: string | undefined) {
  return vaultId?.trim() || DEFAULT_VAULT_ID
}

function storageKey(vaultId: string) {
  return `${STORAGE_KEY}:${vaultId}`
}

function readMap(key: string): HostHistoryMap {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HostHistoryMap : {}
  } catch { return {} }
}

/** The unscoped pre-vault history belongs to Personal; merge it once and drop the old key. */
function migrateLegacy() {
  if (legacyChecked) return
  legacyChecked = true
  try {
    if (localStorage.getItem(STORAGE_KEY) === null) return
    const legacy = readMap(STORAGE_KEY)
    const personalKey = storageKey(DEFAULT_VAULT_ID)
    const personal = readMap(personalKey)
    for (const [host, list] of Object.entries(legacy)) {
      if (!Array.isArray(list)) continue
      const merged = [...list, ...(personal[host] ?? [])].sort((a, b) => a.timestamp - b.timestamp)
      personal[host] = merged.slice(-MAX_PER_HOST)
    }
    localStorage.setItem(personalKey, JSON.stringify(personal))
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* Storage unavailable: nothing to migrate. */ }
}

function loadVault(vaultId: string): HostHistoryMap {
  const cached = caches.get(vaultId)
  if (cached) return cached
  migrateLegacy()
  const map = readMap(storageKey(vaultId))
  caches.set(vaultId, map)
  return map
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
const dirty = new Set<string>()

function scheduleSave(vaultId: string) {
  dirty.add(vaultId)
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    for (const id of dirty) {
      const map = caches.get(id)
      if (!map) continue
      try { localStorage.setItem(storageKey(id), JSON.stringify(map)) } catch { /* Storage full or unavailable. */ }
    }
    dirty.clear()
  }, 300)
}

const listeners = new Set<(vaultId: string, host: string) => void>()

export function subscribeInteractiveHistory(cb: (vaultId: string, host: string) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function recordInteractiveCommand(vaultId: string | undefined, hostAddress: string, command: string) {
  const trimmed = command.trim()
  if (!trimmed || !hostAddress) return

  const vault = vaultKey(vaultId)
  const map = loadVault(vault)
  const list = map[hostAddress] ?? []
  list.push({ command: trimmed, timestamp: Date.now() })
  if (list.length > MAX_PER_HOST) list.splice(0, list.length - MAX_PER_HOST)
  map[hostAddress] = list

  scheduleSave(vault)
  queueMicrotask(() => {
    for (const cb of listeners) cb(vault, hostAddress)
  })
}

export function getInteractiveHistory(vaultId: string | undefined, hostAddress: string): InteractiveCommand[] {
  if (!hostAddress) return []
  return loadVault(vaultKey(vaultId))[hostAddress] ?? []
}

/** True when a subscription event concerns this vault and host. */
export function isInteractiveHistoryEvent(vaultId: string | undefined, hostAddress: string, eventVault: string, eventHost: string) {
  return eventVault === vaultKey(vaultId) && eventHost === hostAddress
}

/** Test-only: forget cached state so storage is re-read. */
export function resetInteractiveHistoryCacheForTests() {
  caches.clear()
  dirty.clear()
  legacyChecked = false
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
}
