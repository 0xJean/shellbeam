import { invoke } from '@tauri-apps/api/core'
import { KomariApiError, requestKomari, type KomariConnectionConfig } from './komari'
import { metadataSession, readRemoteHostMetadata } from './host-metadata-sync'
import { vaultGetSecret, vaultStatus } from './vault'

export interface OfflineRule { enabled: boolean; gracePeriod: number }
export interface RuleObservation { identity: string; rule: OfflineRule | null }
export interface HostRuleIntent {
  id: string; vaultId: string; hostId: string; integrationId: string; nodeId: string
  endpoint: string; credentialRef: string; integrationVersion: number; mappingRevision: number; hostCreatedAt: number
  baseline: RuleObservation; remote: RuleObservation; desired: OfflineRule
  status: 'pending' | 'applying' | 'synced' | 'conflict' | 'failed' | 'disabled'
  version: number; jobId: string; errorCode: string | null; updatedAt: number; observedAt: number
}
export const HOST_RULES_CHANGED = 'shellbeam:host-notification-rules-changed'
export const notifyHostRulesChanged = (vaultId: string) => window.dispatchEvent(new CustomEvent(HOST_RULES_CHANGED, { detail: { vaultId } }))
export const listHostRules = (vaultId: string) => invoke<HostRuleIntent[]>('list_host_notification_rules', { vaultId })
export const ruleAction = (row: HostRuleIntent, action: string, session: number, extra: { remote?: RuleObservation; errorCode?: string } = {}) =>
  invoke<HostRuleIntent>('host_notification_rule_action', { input: { vaultId: row.vaultId, id: row.id, expectedVersion: row.version, session, action, ...extra } })
export type SaveHostRule = Pick<HostRuleIntent, 'vaultId' | 'hostId' | 'integrationId' | 'nodeId' | 'desired' | 'remote'> & {
  session: number; expectedVersion: number; expectedMappingRevision: number; expectedIntegrationVersion: number
}
export const saveHostRule = (input: SaveHostRule) => invoke<HostRuleIntent>('save_host_notification_rule', { input })
export function validOfflineRule(rule: OfflineRule): boolean {
  return typeof rule.enabled === 'boolean' && Number.isInteger(rule.gracePeriod) && rule.gracePeriod >= 1 && rule.gracePeriod <= 86400
}
/** Verified 1.6 contract only. Runtime fields (last_notified/client_info) are
 * neither written nor retained. Absence is distinct from a disabled rule. */
export async function readOfflineRule(config: KomariConnectionConfig, nodeId: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<RuleObservation> {
  const node = await readRemoteHostMetadata(config, nodeId, signal, fetchImpl)
  const value = await requestKomari<unknown>(config, { path: '/api/admin/notification/offline', signal }, fetchImpl)
  if (!Array.isArray(value)) throw new KomariApiError('Invalid rule response', { code: 'invalid-response' })
  const matches = value.filter(item => item && typeof item === 'object' && item.client === nodeId)
  if (matches.length > 1) throw new KomariApiError('Ambiguous rule response', { code: 'invalid-response' })
  const item = matches[0]
  if (!item) return { identity: node.identity, rule: null }
  const rule = { enabled: item.enable, gracePeriod: item.grace_period }
  if (!validOfflineRule(rule)) throw new KomariApiError('Unsupported rule values', { code: 'invalid-response' })
  return { identity: node.identity, rule }
}
export async function writeOfflineRule(config: KomariConnectionConfig, nodeId: string, rule: OfflineRule, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  if (!validOfflineRule(rule)) throw new Error('HOST_RULE_INVALID')
  await requestKomari(config, { path: '/api/admin/notification/offline/edit', method: 'POST', body: [{ client: nodeId, enable: rule.enabled, grace_period: rule.gracePeriod }], signal }, fetchImpl)
}
const workers = new Set<string>()
const lastReads = new Map<string, number>()
/** Fresh intents may POST once. Recovery/failed intents only GET until an
 * explicit retry. No timers send test notifications or change local policy. */
export async function syncHostRules(vaultId: string, valid: () => boolean, signal?: AbortSignal) {
  if (!valid() || workers.has(vaultId)) return
  workers.add(vaultId)
  let session: number | undefined
  const guard = async () => {
    if (!valid() || signal?.aborted || !(await vaultStatus(vaultId)).unlocked) throw new Error('HOST_RULE_SCOPE_CHANGED')
    if (session !== undefined && await metadataSession(vaultId) !== session) throw new Error('HOST_RULE_SCOPE_CHANGED')
    if (!valid() || signal?.aborted) throw new Error('HOST_RULE_SCOPE_CHANGED')
  }
  try {
    await guard(); session = await metadataSession(vaultId)
    const rows = await listHostRules(vaultId); await guard()
    const due = rows.filter(row => ['pending', 'applying', 'failed'].includes(row.status) && (row.status === 'pending' || Date.now() - (lastReads.get(`${vaultId}:${row.id}`) ?? 0) >= 60000)).slice(0, 10)
    let cursor = 0
    const run = async () => {
      while (cursor < due.length) {
        let row = due[cursor++]
        try {
          await guard()
          const token = await vaultGetSecret(row.credentialRef, vaultId); await guard()
          if (!token) throw new KomariApiError('Access credential required', { code: 'permission' })
          const config = { endpoint: row.endpoint, token }
          const remote = await readOfflineRule(config, row.nodeId, signal); await guard()
          lastReads.set(`${vaultId}:${row.id}`, Date.now())
          row = await ruleAction(row, 'observe', session!, { remote }); await guard()
          if (row.status !== 'pending') continue
          row = await ruleAction(row, 'sending', session!); await guard()
          if (row.status !== 'applying') continue
          await writeOfflineRule(config, row.nodeId, row.desired, signal); await guard()
          const verified = await readOfflineRule(config, row.nodeId, signal); await guard()
          await ruleAction(row, 'observe', session!, { remote: verified })
        } catch (error) {
          if (!valid() || signal?.aborted) return
          if (String(error).includes('HOST_RULE_') || String(error).includes('VAULT_LOCKED')) continue
          try { await guard(); await ruleAction(row, 'error', session!, { errorCode: error instanceof KomariApiError ? error.code : 'unavailable' }); lastReads.set(`${vaultId}:${row.id}`, Date.now()) } catch { /* stale scope/intent wins */ }
        }
      }
    }
    await Promise.all([run(), run()])
    if (due.length && valid() && !signal?.aborted) notifyHostRulesChanged(vaultId)
    // Bound process-local scheduling metadata; canonical intent is in SQLite.
    if (lastReads.size > 1000) lastReads.clear()
  } finally { workers.delete(vaultId) }
}
