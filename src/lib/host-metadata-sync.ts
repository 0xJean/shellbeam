import { invoke } from '@tauri-apps/api/core'
import { getKomariServerVersion, requestKomari, KomariApiError, type KomariConnectionConfig } from './komari'
import { vaultGetSecret, vaultStatus } from './vault'

export interface HostMetadata { name: string; group: string; tags: string[] }
export interface RemoteHostMetadata { identity: string; values: HostMetadata }
export interface HostMetadataBinding {
  id: string; vaultId: string; hostId: string; integrationId: string; nodeId: string
  endpoint: string; credentialRef: string; integrationVersion: number; mappingRevision: number
  identity: string; baseline: HostMetadata | null; desired: HostMetadata; remote: HostMetadata
  status: 'synced' | 'pending' | 'applying' | 'conflict' | 'retry' | 'failed' | 'disabled'
  version: number; attempts: number; nextAttemptAt: number; errorCode: string | null
  conflicts: (keyof HostMetadata)[]; jobId: string; updatedAt: number
}
export const HOST_METADATA_CHANGED = 'shellbeam:host-metadata-changed'
export const metadataSession = (vaultId: string) => invoke<number>('host_metadata_session', { vaultId })
export const listHostMetadata = (vaultId: string) => invoke<HostMetadataBinding[]>('list_host_metadata_sync', { vaultId })
export async function metadataAction(row: HostMetadataBinding, action: string, session: number, extra: { remote?: RemoteHostMetadata; choices?: Partial<Record<keyof HostMetadata, 'local' | 'remote'>>; errorCode?: string } = {}) {
  return invoke<HostMetadataBinding>('host_metadata_sync_action', { input: { vaultId: row.vaultId, id: row.id, expectedVersion: row.version, action, session, ...extra } })
}
export function notifyHostMetadataChanged(vaultId: string) {
  window.dispatchEvent(new CustomEvent(HOST_METADATA_CHANGED, { detail: { vaultId } }))
}
/** Only the verified 1.6 REST contract is writable. These three fields are
 * partial updates; SSH credentials, addresses and tokens never enter a body. */
export async function readRemoteHostMetadata(config: KomariConnectionConfig, nodeId: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<RemoteHostMetadata> {
  const version = await getKomariServerVersion(config, fetchImpl)
  if (!/^v?1\.6\.\d+(?:$|[-+])/.test(version.version)) throw new KomariApiError('Unsupported metadata contract', { code: 'endpoint-version' })
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const value = await requestKomari<Record<string, unknown>>(config, { path: `/api/admin/client/${encodeURIComponent(nodeId)}`, signal }, fetchImpl)
  if (!value || value.uuid !== nodeId || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.group !== 'string' || typeof value.tags !== 'string') {
    throw new KomariApiError('Invalid metadata response', { code: 'invalid-response' })
  }
  const values = { name: value.name, group: value.group, tags: value.tags ? value.tags.split(';') : [] }
  if ([...values.name].length > 100 || [...values.group].length > 100 || values.tags.length > 50
    || values.tags.some(tag => !tag || new TextEncoder().encode(tag).length > 100)
    || [values.name, values.group, ...values.tags].some(text => /[\p{Cc}]/u.test(text))) {
    throw new KomariApiError('Unsupported metadata values', { code: 'invalid-response' })
  }
  return { identity: `${nodeId}:${value.created_at}`, values }
}
export function metadataPatch(row: Pick<HostMetadataBinding, 'remote' | 'desired'>): Record<string, string> {
  const patch: Record<string, string> = {}
  if (row.remote.name !== row.desired.name) patch.name = row.desired.name
  if (row.remote.group !== row.desired.group) patch.group = row.desired.group
  if (JSON.stringify(row.remote.tags) !== JSON.stringify(row.desired.tags)) patch.tags = row.desired.tags.join(';')
  return patch
}
export async function writeRemoteHostMetadata(config: KomariConnectionConfig, row: HostMetadataBinding, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  const patch = metadataPatch(row)
  if (!Object.keys(patch).length) return
  await requestKomari(config, { path: `/api/admin/client/${encodeURIComponent(row.nodeId)}/edit`, method: 'POST', body: patch, signal }, fetchImpl)
}
function safeError(error: unknown): string {
  const code = error instanceof KomariApiError ? error.code : 'unavailable'
  return ['permission', 'endpoint-version', 'rate-limited', 'identity-changed', 'invalid-response'].includes(code) ? code : 'unavailable'
}
const workers = new Set<string>()
/** One bounded worker per Vault; at most two remote requests run concurrently.
 * Reads always precede writes, including recovery of interrupted POSTs. */
export async function syncHostMetadata(vaultId: string, valid: () => boolean, signal?: AbortSignal) {
  if (workers.has(vaultId) || !valid()) return
  workers.add(vaultId)
  let session: number | undefined
  const guard = async () => {
    if (!valid() || signal?.aborted) throw new Error('METADATA_SCOPE_CHANGED')
    if (!(await vaultStatus(vaultId)).unlocked || !valid() || signal?.aborted) throw new Error('METADATA_SCOPE_CHANGED')
    if (session !== undefined && await metadataSession(vaultId) !== session) throw new Error('METADATA_SESSION_CHANGED')
    if (!valid() || signal?.aborted) throw new Error('METADATA_SCOPE_CHANGED')
  }
  try {
    await guard()
    session = await metadataSession(vaultId)
    const all = await listHostMetadata(vaultId)
    await guard()
    const due = all.filter(row => !['disabled', 'failed'].includes(row.status) && Date.now() >= row.nextAttemptAt).slice(0, 20)
    let index = 0
    let changed = false
    const run = async () => {
      while (index < due.length && valid() && !signal?.aborted) {
        let row = due[index++]
        try {
          await guard()
          const token = await vaultGetSecret(row.credentialRef, vaultId)
          await guard()
          if (!token) throw new KomariApiError('Missing access credential', { code: 'permission' })
          const config = { endpoint: row.endpoint, token }
          const remote = await readRemoteHostMetadata(config, row.nodeId, signal)
          await guard()
          row = await metadataAction(row, 'observe', session!, { remote })
          changed = true
          await guard()
          if (row.status !== 'pending') continue
          // Native CAS checks binding revision, host intent and Vault immediately
          // before dispatch. A request already sent cannot be promised undone.
          row = await metadataAction(row, 'sending', session!)
          if (row.status !== 'applying') continue
          await guard()
          await writeRemoteHostMetadata(config, row, signal)
          await guard()
          const verified = await readRemoteHostMetadata(config, row.nodeId, signal)
          await guard()
          row = await metadataAction(row, 'observe', session!, { remote: verified })
          if (row.status === 'pending') row = await metadataAction(row, 'error', session!, { errorCode: 'readback-mismatch' })
        } catch (error) {
          if (!valid() || signal?.aborted) return
          // CAS rejection means another edit/scope already owns the row.
          if (String(error).includes('METADATA_') || String(error).includes('VAULT_LOCKED')) continue
          try { await guard(); await metadataAction(row, 'error', session!, { errorCode: safeError(error) }); changed = true } catch { /* new scope/intent wins */ }
        }
      }
    }
    await Promise.all([run(), run()])
    if (changed && valid() && !signal?.aborted) notifyHostMetadataChanged(vaultId)
  } finally { workers.delete(vaultId) }
}
