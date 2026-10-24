import { invoke } from '@tauri-apps/api/core'

export type LocalOpsDocumentKind = 'alert-rules' | 'alert-state' | 'health-checks' | 'health-history' | 'scheduled-tasks'
export interface LocalOpsDocument { vaultId: string; hostId: string; kind: LocalOpsDocumentKind; payload: unknown; revision: number; updatedAt: number }
interface Adapter { readCache: (vaultId: string, hostId: string) => unknown | null; writeCache: (vaultId: string, hostId: string, payload: unknown) => void }
const adapters = new Map<LocalOpsDocumentKind, Adapter>()
const revisions = new Map<string, number>()
const hydrated = new Set<string>()
const queues = new Map<string, Promise<void>>()
const errors = new Map<string, string>()
const hydrations = new Map<string, Promise<void>>()
export const LOCAL_OPS_PERSISTENCE_EVENT = 'shellbeam:local-ops-persistence'
export function hasNativeLocalOps() { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }
function scope(vaultId: string, hostId: string) { return JSON.stringify([vaultId, hostId]) }
function key(vaultId: string, hostId: string, kind: LocalOpsDocumentKind) { return JSON.stringify([vaultId, hostId, kind]) }
function emit() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_OPS_PERSISTENCE_EVENT)) }
export function registerLocalOpsAdapter(kind: LocalOpsDocumentKind, adapter: Adapter) { adapters.set(kind, adapter) }
export function localOpsPersistenceError(vaultId: string | undefined, hostId: string) {
  return [...adapters.keys()].map((kind) => errors.get(key(vaultId || '', hostId, kind))).find(Boolean) ?? null
}
export function isLocalOpsHydrated(vaultId: string, hostId: string) { return !hasNativeLocalOps() || hydrated.has(scope(vaultId, hostId)) }
export function applyLocalOpsDocument(row: LocalOpsDocument) {
  const id = key(row.vaultId, row.hostId, row.kind)
  if (row.revision < (revisions.get(id) ?? 0)) return
  if (row.revision !== revisions.get(id)) adapters.get(row.kind)?.writeCache(row.vaultId, row.hostId, row.payload)
  revisions.set(id, row.revision)
  errors.delete(id)
  emit()
}
/** Mirror a credential-free renderer cache into the canonical scoped DB. A
 * stale renderer is rehydrated and rejected, never silently overwriting an
 * acknowledged/closed lifecycle row from another session. */
export function queueLocalOpsDocument(vaultId: string | undefined, hostId: string, kind: LocalOpsDocumentKind, payload: unknown): Promise<LocalOpsDocument | null> {
  if (!hasNativeLocalOps()) return Promise.resolve(null)
  const vault = vaultId?.trim() || ''
  const id = key(vault, hostId, kind)
  const previous = queues.get(id) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    if (!vault) throw new Error('LOCAL_OPS_VAULT_REQUIRED')
    if (!revisions.has(id)) {
      const rows = await invoke<LocalOpsDocument[]>('local_ops_list', { query: { vaultId: vault, hostId, kind } })
      const existing = rows.find((row) => row.vaultId === vault && row.hostId === hostId && row.kind === kind)
      if (existing) { applyLocalOpsDocument(existing); throw new Error('LOCAL_OPS_RELOAD_REQUIRED') }
      revisions.set(id, 0)
    }
    try {
      const row = await invoke<LocalOpsDocument>('local_ops_upsert', { payload: { vaultId: vault, hostId, kind, payload, expectedRevision: revisions.get(id) ?? 0 } })
      // This write originated from the current cache, so keep live sustain
      // timers rather than hydrating the same document back into the renderer.
      revisions.set(id, row.revision); errors.delete(id); emit()
      return row
    } catch (error) {
      if (String(error).includes('REVISION_CONFLICT')) {
        const rows = await invoke<LocalOpsDocument[]>('local_ops_list', { query: { vaultId: vault, hostId, kind } })
        const latest = rows.find((row) => row.vaultId === vault && row.hostId === hostId && row.kind === kind)
        if (latest) applyLocalOpsDocument(latest)
      }
      throw error
    }
  })
  const settled = operation.then(() => undefined, (error) => { errors.set(id, String(error).includes('REVISION_CONFLICT') || String(error).includes('RELOAD_REQUIRED') ? 'revision-conflict' : 'persistence-unavailable'); emit() })
  queues.set(id, settled)
  void settled.finally(() => { if (queues.get(id) === settled) queues.delete(id) })
  // Keep errors observable through flush/status without an unhandled rejection
  // when a synchronous UI cache writer intentionally ignores this promise.
  void operation.catch(() => undefined)
  return operation
}
export async function flushLocalOpsHost(vaultId: string | undefined, hostId: string) {
  if (!hasNativeLocalOps()) return
  const vault = vaultId?.trim() || ''
  await Promise.all([...adapters.keys()].map((kind) => queues.get(key(vault, hostId, kind))))
  if (localOpsPersistenceError(vault, hostId)) throw new Error('LOCAL_OPS_PERSISTENCE_UNAVAILABLE')
}
export function hydrateLocalOpsHost(vaultId: string | undefined, hostId: string, refresh = false): Promise<void> {
  if (!hasNativeLocalOps()) return Promise.resolve()
  const vault = vaultId?.trim() || ''
  if (!vault) return Promise.reject(new Error('LOCAL_OPS_VAULT_REQUIRED'))
  const id = scope(vault, hostId)
  if (!refresh && hydrated.has(id)) return Promise.resolve()
  const pending = hydrations.get(id)
  if (pending) return pending
  const work = (async () => {
    await Promise.all([...adapters.keys()].map((kind) => queues.get(key(vault, hostId, kind))))
    const rows = await invoke<LocalOpsDocument[]>('local_ops_list', { query: { vaultId: vault, hostId } })
    const available = new Set<LocalOpsDocumentKind>()
    for (const row of rows) {
      if (row.vaultId !== vault || row.hostId !== hostId || !adapters.has(row.kind)) continue
      available.add(row.kind); applyLocalOpsDocument(row)
    }
    for (const [kind, adapter] of adapters) {
      if (available.has(kind)) continue
      revisions.set(key(vault, hostId, kind), 0)
      const cached = adapter.readCache(vault, hostId)
      if (cached !== null) await queueLocalOpsDocument(vault, hostId, kind, cached)
    }
    hydrated.add(id); emit()
  })()
  hydrations.set(id, work)
  void work.catch(() => undefined).finally(() => { if (hydrations.get(id) === work) hydrations.delete(id) })
  return work
}
export function resetLocalOpsPersistenceMemory() { revisions.clear(); hydrated.clear(); queues.clear(); errors.clear(); hydrations.clear() }
