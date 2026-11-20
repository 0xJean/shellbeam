import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { HostProfile } from './hosts'
import { clearLocalOpsMemory, loadLocalAlertState, saveLocalAlertState } from './local-ops-store'
import { EMPTY_LOCAL_ALERT_STATE, actOnLocalAlert, evaluateLocalAlertRules, normalizeLocalAlertRule } from './local-alert-rules'
import { flushLocalOpsHost, localOpsPersistenceError, resetLocalOpsPersistenceMemory, type LocalOpsDocument } from './local-ops-persistence'
import { runLocalAlertAction } from './local-alert-actions'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const host: HostProfile = { id: 'host', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'password', jumpHost: 'bastion', group: 'Custom', tags: [], createdAt: 1, updatedAt: 1 }
const rule = normalizeLocalAlertRule({ id: 'cpu', hostId: host.id, name: 'CPU', metric: 'cpu', durationMs: 0 })
let job: Record<string, unknown>
beforeEach(() => {
  localStorage.clear(); clearLocalOpsMemory(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  saveLocalAlertState('vault', host.id, evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, [rule], [{ ruleId: rule.id, value: 99, sampledAt: 1_000, source: 'ssh-agentless', transport: 'proxy-jump' }], 1_000))
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    const request = (args as { payload?: Record<string, unknown>; request?: Record<string, unknown> }).payload ?? (args as { request: Record<string, unknown> }).request
    if (command === 'operation_job_create') { job = { ...request, jobId: 'canonical-job', auditId: 'canonical-audit', status: 'queued', confirmationStatus: 'pending' }; return { ...job } }
    if (command === 'operation_job_update') { job = { ...job, ...request }; return { ...job } }
    throw new Error(`unexpected ${command}`)
  })
})
afterEach(() => vi.restoreAllMocks())
describe('canonical local alert actions', () => {
  it('records rejected consent without mutating the incident', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const result = await runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'acknowledge', confirmMessage: 'Confirm?' })
    expect(result).toBeNull()
    expect(job).toMatchObject({ action: 'local-alert.acknowledge', vaultId: 'vault', hostId: 'host', transport: 'proxy-jump', status: 'cancelled', confirmationStatus: 'rejected' })
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('active')
  })
  it('persists confirmed job links in the incident and immutable lifecycle audit across sessions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'acknowledge', confirmMessage: 'Confirm?', now: () => 2_000 })
    expect(job).toMatchObject({ status: 'completed', confirmationStatus: 'confirmed', provider: 'local-ops', target: 'cpu' })
    clearLocalOpsMemory()
    expect(loadLocalAlertState('vault', host.id).alerts[0]).toMatchObject({ status: 'acknowledged', operationJobId: 'canonical-job' })
    expect(loadLocalAlertState('vault', host.id).audit.at(-1)).toMatchObject({ event: 'acknowledged', operationJobId: 'canonical-job' })
    await runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'close', confirmMessage: 'Confirm?', now: () => 3_000 })
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('closed')
    expect(job.action).toBe('local-alert.close')
  })
  it('cannot mutate an alert through a different host or empty lifecycle', async () => {
    await expect(runLocalAlertAction({ vaultId: 'other', host, ruleId: rule.id, action: 'close', confirmMessage: 'Confirm?' })).rejects.toThrow('ALERT_NOT_FOUND')
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })
  it('does not create a job for an already superseded scope or a conflicting host Vault', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const options = { vaultId: 'vault', host, ruleId: rule.id, action: 'close' as const, confirmMessage: 'Confirm?' }
    expect(await runLocalAlertAction({ ...options, isCurrent: () => false })).toBeNull()
    await expect(runLocalAlertAction({ ...options, host: { ...host, vaultId: 'other' } })).rejects.toThrow('LOCAL_OPS_HOST_VAULT_MISMATCH')
    expect(confirm).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('active')
  })
  it('cancels a queued action if the Vault switches during job creation, retaining the original alert', async () => {
    let current = true
    const original = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const result = await original(command, args)
      if (command === 'operation_job_create') current = false
      return result
    })
    const confirm = vi.spyOn(window, 'confirm')
    expect(await runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'close', confirmMessage: 'Confirm?', isCurrent: () => current })).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('active')
    expect(loadLocalAlertState('other', host.id).alerts).toEqual([])
    expect(job).toMatchObject({ vaultId: 'vault', hostId: host.id, status: 'cancelled', confirmationStatus: 'pending', errorCode: 'operation_scope_changed' })
  })
})

it('does not claim a lifecycle change when the native confirmed transaction fails', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  const original = vi.mocked(invoke).getMockImplementation()!
  const state = loadLocalAlertState('vault', host.id)
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'local_ops_list') return [{ vaultId: 'vault', hostId: host.id, kind: 'alert-state', payload: state, revision: 1, updatedAt: 1_000 }]
    if (command === 'local_ops_alert_action') throw new Error('LOCAL_OPS_DATABASE_UNAVAILABLE')
    return original(command, args)
  })
  try {
    await expect(runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'close', confirmMessage: 'Confirm?' })).rejects.toThrow('DATABASE_UNAVAILABLE')
    expect(loadLocalAlertState('vault', host.id).alerts[0].status).toBe('active')
    expect(job).toMatchObject({ status: 'failed', confirmationStatus: 'confirmed' })
    expect(loadLocalAlertState('vault', host.id).audit).toHaveLength(1)
  } finally { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') }
})

it('completes audit before updating UI cache and survives concurrent background alert-state writes without REVISION_CONFLICT', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  resetLocalOpsPersistenceMemory()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  const original = vi.mocked(invoke).mockImplementation(vi.mocked(invoke).getMockImplementation()!).getMockImplementation()!
  const initialState = loadLocalAlertState('vault', host.id)
  let stored: LocalOpsDocument = { vaultId: 'vault', hostId: host.id, kind: 'alert-state', payload: structuredClone(initialState), revision: 1, updatedAt: 1_000 }
  const order: string[] = []
  let upsertCalls = 0
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const request = args as { payload?: Record<string, unknown>; query?: { kind?: string } }
    if (command === 'local_ops_list') {
      return request.query?.kind && request.query.kind !== 'alert-state' ? [] : [structuredClone(stored)]
    }
    if (command === 'local_ops_upsert') {
      upsertCalls++
      const payload = request.payload as unknown as LocalOpsDocument & { expectedRevision: number }
      if (payload.expectedRevision !== stored.revision) throw new Error('LOCAL_OPS_REVISION_CONFLICT')
      stored = { ...stored, payload: structuredClone(payload.payload), revision: stored.revision + 1, updatedAt: 2_000 }
      return structuredClone(stored)
    }
    if (command === 'local_ops_alert_action') {
      // Simulate LocalOpsRuntime.scanRules() calling saveLocalAlertState with
      // stale pre-close observations while local_ops_alert_action is in flight.
      saveLocalAlertState('vault', host.id, initialState)
      stored = {
        ...stored,
        payload: actOnLocalAlert(stored.payload as typeof initialState, rule.id, 'close', 3_000, String(request.payload?.operationJobId)),
        revision: stored.revision + 1,
        updatedAt: 3_000,
      }
      order.push('native-alert-action')
      return structuredClone(stored)
    }
    if (command === 'operation_job_update' && ((args as { request?: Record<string, unknown> }).request?.status === 'completed')) {
      // At the moment the audit row transitions to completed, the UI cache must
      // not have already announced `closed` ahead of the audit write.
      expect(loadLocalAlertState('vault', host.id).alerts[0].status).not.toBe('closed')
      order.push('job-completed')
    }
    return original(command, args)
  })
  try {
    const result = await runLocalAlertAction({ vaultId: 'vault', host, ruleId: rule.id, action: 'close', confirmMessage: 'Confirm?' })
    await flushLocalOpsHost('vault', host.id)
    expect(result?.job).toMatchObject({ action: 'local-alert.close', status: 'completed', confirmationStatus: 'confirmed' })
    expect(job).toMatchObject({ action: 'local-alert.close', status: 'completed' })
    expect(loadLocalAlertState('vault', host.id).alerts[0]).toMatchObject({ status: 'closed', operationJobId: 'canonical-job' })
    expect((stored.payload as typeof initialState).alerts[0]).toMatchObject({ status: 'closed', operationJobId: 'canonical-job' })
    expect(localOpsPersistenceError('vault', host.id)).toBeNull()
    expect(upsertCalls).toBe(0)
    expect(order).toEqual(['native-alert-action', 'job-completed'])
  } finally {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    resetLocalOpsPersistenceMemory()
  }
})
