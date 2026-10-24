import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { clearLocalOpsMemory, loadLocalAlertState, saveLocalAlertState } from './local-ops-store'
import { EMPTY_LOCAL_ALERT_STATE, actOnLocalAlert, evaluateLocalAlertRules, normalizeLocalAlertRule } from './local-alert-rules'
import { loadHealthCheckHistory, persistHealthCheckResult } from './health-checks'
import { flushLocalOpsHost, hydrateLocalOpsHost, localOpsPersistenceError, resetLocalOpsPersistenceMemory, type LocalOpsDocument } from './local-ops-persistence'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const docs = new Map<string, LocalOpsDocument>()
const rule = normalizeLocalAlertRule({ id: 'cpu', hostId: 'host', name: 'CPU', metric: 'cpu', durationMs: 0 })
const firing = () => evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, [rule], [{ ruleId: rule.id, value: 99, sampledAt: 1_000, source: 'ssh-agentless', transport: 'proxy-jump' }], 1_000)
function key(vault: string, host: string, kind: string) { return JSON.stringify([vault, host, kind]) }
beforeEach(() => {
  localStorage.clear(); clearLocalOpsMemory(); resetLocalOpsPersistenceMemory(); docs.clear()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const request = args as { query?: { vaultId: string; hostId: string; kind?: string }; payload?: LocalOpsDocument & { expectedRevision: number } }
    if (command === 'local_ops_list') return structuredClone([...docs.values()].filter((row) => row.vaultId === request.query!.vaultId && row.hostId === request.query!.hostId && (!request.query!.kind || row.kind === request.query!.kind)))
    if (command === 'local_ops_upsert') {
      const row = request.payload!; const id = key(row.vaultId, row.hostId, row.kind); const previous = docs.get(id)
      if ((previous?.revision ?? 0) !== row.expectedRevision) throw new Error('LOCAL_OPS_REVISION_CONFLICT')
      const document = { vaultId: row.vaultId, hostId: row.hostId, kind: row.kind, payload: structuredClone(row.payload), revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() }
      docs.set(id, document); return structuredClone(document)
    }
    throw new Error(`unexpected command ${command}`)
  })
})
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); resetLocalOpsPersistenceMemory() })
describe('canonical native local operations persistence', () => {
  it('saves host/vault scoped alert and check history and hydrates their safe state after renderer restart', async () => {
    await hydrateLocalOpsHost('vault', 'host')
    saveLocalAlertState('vault', 'host', actOnLocalAlert(firing(), rule.id, 'acknowledge', 2_000, 'confirmed-job'))
    persistHealthCheckResult('vault', { checkId: 'check', hostId: 'host', status: 'unknown', checkedAt: 2_000, nextCheckAt: 3_000, durationMs: 5, latencyMs: null, provider: 'ssh-agentless', transport: 'proxy-jump', errorCode: 'auth', errorSummary: 'password=secret' })
    await flushLocalOpsHost('vault', 'host')
    expect(JSON.stringify([...docs.values()])).not.toContain('password=secret')
    localStorage.clear(); clearLocalOpsMemory(); resetLocalOpsPersistenceMemory()
    await hydrateLocalOpsHost('vault', 'host')
    expect(loadLocalAlertState('vault', 'host').audit.at(-1)?.operationJobId).toBe('confirmed-job')
    expect(loadHealthCheckHistory('vault', 'host')[0]).toMatchObject({ status: 'unknown', errorSummary: 'auth' })
    expect(loadLocalAlertState('other', 'host').alerts).toEqual([])
    expect(loadHealthCheckHistory('vault', 'other')).toEqual([])
  })
  it('uses native state as authority and does not overwrite a peer session acknowledgment with stale observations', async () => {
    await hydrateLocalOpsHost('vault', 'host')
    saveLocalAlertState('vault', 'host', firing()); await flushLocalOpsHost('vault', 'host')
    const document = docs.get(key('vault', 'host', 'alert-state'))!
    docs.set(key('vault', 'host', 'alert-state'), { ...document, revision: document.revision + 1, payload: actOnLocalAlert(firing(), rule.id, 'acknowledge', 2_000, 'peer-job') })
    saveLocalAlertState('vault', 'host', firing())
    await expect(flushLocalOpsHost('vault', 'host')).rejects.toThrow('PERSISTENCE_UNAVAILABLE')
    expect(loadLocalAlertState('vault', 'host').alerts[0]).toMatchObject({ status: 'acknowledged', operationJobId: 'peer-job' })
    expect(localOpsPersistenceError('vault', 'host')).toBe('revision-conflict')
    await hydrateLocalOpsHost('vault', 'host', true)
    expect(localOpsPersistenceError('vault', 'host')).toBeNull()
  })
  it('migrates old renderer data only into its exact scope and never reads another vault', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    saveLocalAlertState('vault', 'host', firing())
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    await hydrateLocalOpsHost('vault', 'host')
    expect(docs.get(key('vault', 'host', 'alert-state'))?.revision).toBe(1)
    expect(docs.has(key('other', 'host', 'alert-state'))).toBe(false)
    expect(vi.mocked(invoke).mock.calls.some(([command, args]) => command === 'local_ops_list' && (args as { query: { vaultId: string } }).query.vaultId === 'other')).toBe(false)
  })
  it('reports native persistence failure instead of claiming a durable audit', async () => {
    await hydrateLocalOpsHost('vault', 'host')
    vi.mocked(invoke).mockRejectedValue(new Error('database unavailable'))
    saveLocalAlertState('vault', 'host', firing())
    await expect(flushLocalOpsHost('vault', 'host')).rejects.toThrow('PERSISTENCE_UNAVAILABLE')
    expect(localOpsPersistenceError('vault', 'host')).toBe('persistence-unavailable')
  })
})
