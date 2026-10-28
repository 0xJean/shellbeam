/**
 * Browser-side leftovers of a deleted Vault. The native side purges files and
 * databases; these are the localStorage caches the renderer keys by Vault id.
 * Prefixes mirror the key builders named beside them; the unit test checks
 * them against those builders so a renamed key cannot silently survive.
 */

/** Keys of the form `<base>:<vaultId>:<host...>` (Vault id inserted raw). */
const RAW_HOST_PREFIXES = [
  'shellbeam.scheduled-tasks.v1', // scheduled-tasks.ts storageKey
  'shellbeam.healthChecks.v1', // health-checks.ts healthCheckStorageKey
]
/** Keys of the form `<base>:<encodeURIComponent(vaultId)>:<host...>`. */
const ENCODED_HOST_PREFIXES = [
  'shellbeam.localOps.v1', // local-ops-store.ts localOpsStorageKey
  'shellbeam.healthCheckHistory.v1', // health-checks.ts healthCheckHistoryStorageKey
]
/** Keys of the form `<base>:<vaultId>`. */
const VAULT_SUFFIX_BASES = [
  'shellbeam:host-monitoring-summary', // hosts-dashboard.tsx monitoring summary toggle
  'shellbeam.interactiveHistory', // interactive-history.ts, per Vault as `<base>:<vaultId>`
]
const CERTIFICATE_PREFIX = 'shellbeam.certificates.' // certificate-cache.ts
/** One JSON object whose entries are keyed by observation key (`vault:["<id>","<host>"]`). */
const WORKSPACE_INVENTORY_CACHE_KEY = 'shellbeam.workspaceInventoryCache.v1'

export function isVaultLocalStorageKey(key: string, vaultId: string): boolean {
  if (!vaultId) return false
  if (key === `${CERTIFICATE_PREFIX}${vaultId}`) return true
  if (VAULT_SUFFIX_BASES.some((base) => key === `${base}:${vaultId}`)) return true
  if (RAW_HOST_PREFIXES.some((base) => key.startsWith(`${base}:${vaultId}:`))) return true
  const encoded = encodeURIComponent(vaultId)
  return ENCODED_HOST_PREFIXES.some((base) => key.startsWith(`${base}:${encoded}:`))
}

/** Observation keys start with this exact text; see getHostObservationKey. */
export function vaultObservationKeyPrefix(vaultId: string) {
  return `vault:[${JSON.stringify(vaultId)},`
}

/** Remove this Vault's localStorage entries. Returns the keys removed or rewritten. */
export function clearVaultLocalData(vaultId: string, storage: Storage | undefined = globalThis.localStorage): string[] {
  if (!vaultId || !storage) return []
  const touched: string[] = []
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null) keys.push(key)
    }
    for (const key of keys) {
      if (!isVaultLocalStorageKey(key, vaultId)) continue
      storage.removeItem(key)
      touched.push(key)
    }
    if (pruneInventoryCache(storage, vaultId)) touched.push(WORKSPACE_INVENTORY_CACHE_KEY)
  } catch { /* Storage is a cache only; a failure here must not undo the deletion. */ }
  return touched
}

function pruneInventoryCache(storage: Storage, vaultId: string) {
  const raw = storage.getItem(WORKSPACE_INVENTORY_CACHE_KEY)
  if (!raw) return false
  let cache: unknown
  try { cache = JSON.parse(raw) } catch { return false }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false
  const prefix = vaultObservationKeyPrefix(vaultId)
  const entries = Object.entries(cache as Record<string, unknown>)
  const kept = entries.filter(([key]) => !key.startsWith(prefix))
  if (kept.length === entries.length) return false
  storage.setItem(WORKSPACE_INVENTORY_CACHE_KEY, JSON.stringify(Object.fromEntries(kept)))
  return true
}
