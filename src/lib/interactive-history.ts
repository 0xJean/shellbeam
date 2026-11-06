import { vaultOpenData, vaultSealData } from './vault'

/**
 * Typed commands, kept per Vault and then by host address. Commands can carry
 * passwords (`mysql -p…`, `export TOKEN=…`), so storage only ever holds them
 * sealed by their Vault (`${SEALED_KEY}:${vaultId}`). A Vault's history is read
 * when it unlocks and leaves memory when it locks; commands typed while it is
 * not loaded stay in memory and join the history once it is.
 *
 * Older releases kept the history in plain text (`${LEGACY_KEY}:${vaultId}`,
 * and before Vaults, an unscoped `${LEGACY_KEY}` that belongs to Personal).
 * Loading a Vault seals that text and removes it once the seal is stored.
 */
const LEGACY_KEY = 'shellbeam.interactiveHistory'
const SEALED_KEY = 'shellbeam.interactiveHistorySealed'
const PURPOSE = 'terminal.history'
const DEFAULT_VAULT_ID = 'personal'
const MAX_PER_HOST = 200
const SAVE_DELAY_MS = 300

export interface InteractiveCommand {
  command: string
  timestamp: number
}

type HostHistoryMap = Record<string, InteractiveCommand[]>

const caches = new Map<string, HostHistoryMap>()
/** Vaults whose stored history has been read; only these are written back. */
const loaded = new Set<string>()
let generation = 0

function vaultKey(vaultId: string | undefined) {
  return vaultId?.trim() || DEFAULT_VAULT_ID
}

const sealedKey = (vaultId: string) => `${SEALED_KEY}:${vaultId}`
const legacyKey = (vaultId: string) => `${LEGACY_KEY}:${vaultId}`

function parseMap(raw: string | null): HostHistoryMap {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HostHistoryMap : {}
  } catch { return {} }
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** Every entry of both maps, oldest first, the newest MAX_PER_HOST per host. */
function merge(into: HostHistoryMap, from: HostHistoryMap) {
  for (const [host, list] of Object.entries(from)) {
    if (!Array.isArray(list)) continue
    const merged = [...(into[host] ?? []), ...list]
      .filter((entry) => entry && typeof entry.command === 'string' && typeof entry.timestamp === 'number')
      .sort((a, b) => a.timestamp - b.timestamp)
    into[host] = merged.slice(-MAX_PER_HOST)
  }
}

function cacheFor(vaultId: string): HostHistoryMap {
  let map = caches.get(vaultId)
  if (!map) { map = {}; caches.set(vaultId, map) }
  return map
}

const listeners = new Set<(vaultId: string, host: string) => void>()

function emit(vaultId: string, host: string) {
  queueMicrotask(() => { for (const cb of listeners) cb(vaultId, host) })
}

export function subscribeInteractiveHistory(cb: (vaultId: string, host: string) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
const pendingSaves = new Set<string>()
let saveChain: Promise<void> = Promise.resolve()

function scheduleSave(vaultId: string) {
  pendingSaves.add(vaultId)
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; void flushInteractiveHistory() }, SAVE_DELAY_MS)
}

/** Seals and stores every loaded Vault with unsaved commands. Failures (a locked Vault) keep them pending. */
export function flushInteractiveHistory(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const scope = generation
  saveChain = saveChain.then(async () => {
    for (const vaultId of [...pendingSaves]) {
      const map = caches.get(vaultId)
      if (!map || !loaded.has(vaultId) || scope !== generation) continue
      try {
        const sealed = await vaultSealData(PURPOSE, vaultId, JSON.stringify(map), vaultId)
        if (scope !== generation) return
        localStorage.setItem(sealedKey(vaultId), sealed)
        pendingSaves.delete(vaultId)
      } catch { /* Vault locked or storage full: try again on the next change or unlock. */ }
    }
  })
  return saveChain
}

export function recordInteractiveCommand(vaultId: string | undefined, hostAddress: string, command: string) {
  const trimmed = command.trim()
  if (!trimmed || !hostAddress) return

  const vault = vaultKey(vaultId)
  const map = cacheFor(vault)
  const list = map[hostAddress] ?? []
  list.push({ command: trimmed, timestamp: Date.now() })
  if (list.length > MAX_PER_HOST) list.splice(0, list.length - MAX_PER_HOST)
  map[hostAddress] = list

  if (loaded.has(vault)) scheduleSave(vault)
  else pendingSaves.add(vault)
  emit(vault, hostAddress)
}

export function getInteractiveHistory(vaultId: string | undefined, hostAddress: string): InteractiveCommand[] {
  if (!hostAddress) return []
  return caches.get(vaultKey(vaultId))?.[hostAddress] ?? []
}

/** True when a subscription event concerns this vault and host. An empty host means every host of the Vault. */
export function isInteractiveHistoryEvent(vaultId: string | undefined, hostAddress: string, eventVault: string, eventHost: string) {
  return eventVault === vaultKey(vaultId) && (eventHost === '' || eventHost === hostAddress)
}

/**
 * A Vault unlocked: open its stored history, add commands typed before it was
 * loaded, and seal any plain text an older release left. Plain text is removed
 * only after the sealed history is stored.
 */
export async function hydrateInteractiveHistory(vaultId: string | undefined): Promise<void> {
  const vault = vaultKey(vaultId)
  const scope = generation
  const map: HostHistoryMap = {}
  const sealed = read(sealedKey(vault))
  if (sealed) {
    try { merge(map, parseMap(await vaultOpenData(PURPOSE, vault, sealed, vault))) } catch { return /* Locked or not this Vault's: keep what is stored. */ }
  }
  if (scope !== generation) return
  const legacyKeys = [legacyKey(vault), ...(vault === DEFAULT_VAULT_ID ? [LEGACY_KEY] : [])].filter((key) => read(key) !== null)
  for (const key of legacyKeys) merge(map, parseMap(read(key)))
  merge(map, caches.get(vault) ?? {})
  caches.set(vault, map)
  loaded.add(vault)
  if (legacyKeys.length || pendingSaves.has(vault)) {
    pendingSaves.add(vault)
    await flushInteractiveHistory()
    if (!pendingSaves.has(vault)) for (const key of legacyKeys) { try { localStorage.removeItem(key) } catch { /* storage unavailable */ } }
  }
  emit(vault, '')
}

/** The Vault locked or changed: commands leave memory. One typed in the last moment before the lock, not yet sealed, is dropped. */
export function clearInteractiveHistory() {
  generation += 1
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const vaults = [...caches.keys()]
  caches.clear()
  loaded.clear()
  pendingSaves.clear()
  for (const vault of vaults) emit(vault, '')
}

/** Test-only: forget cached state so storage is re-read. */
export function resetInteractiveHistoryCacheForTests() {
  generation += 1
  caches.clear()
  loaded.clear()
  pendingSaves.clear()
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  saveChain = Promise.resolve()
}
