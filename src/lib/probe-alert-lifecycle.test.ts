import { webcrypto } from 'node:crypto'
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'
import { createProbeAlertLifecycleConsumer, probeAlertRuleId } from './probe-alert-lifecycle'
import { beginProbeCollectionSequence, getProbeCollectionConfigRevision, type ProbeCollectionEvent, type ProbeCollectionSection } from './probe-collection-events'
import { clearLocalOpsMemory, loadLocalAlertState, saveLocalAlertRules, saveLocalAlertState } from './local-ops-store'
import { flushLocalOpsHost, localOpsPersistenceError, resetLocalOpsPersistenceMemory, type LocalOpsDocument } from './local-ops-persistence'
import { actOnLocalAlert, evaluateLocalAlertRules, normalizeLocalAlertRule } from './local-alert-rules'
import { KOMARI_NOTIFICATION_EVENT } from './komari-alert-notifications'
import type { NotificationPayload } from './notification-dispatch'
import { saveNotificationPolicy } from './notification-policy'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const target: HostProfile = { vaultId: 'vault-a', id: 'edge', name: 'edge', address: '192.0.2.10', port: 22, username: 'ops', authType: 'privateKey', privateKeyRef: 'PRIVATE_REFERENCE', jumpHostId: 'bastion', group: '', tags: [], createdAt: 1, updatedAt: 1 }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
let documents: Map<string, LocalOpsDocument>
let notices: NotificationPayload[]
let beforeList: (() => Promise<void>) | undefined
let beforeWrite: (() => Promise<void>) | undefined
let failWrite: boolean
let nativeDescriptor: PropertyDescriptor | undefined
const onNotice = (event: Event) => { notices.push((event as CustomEvent<NotificationPayload>).detail) }
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear(); clearLocalOpsMemory(); resetLocalOpsPersistenceMemory()
  nativeDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  documents = new Map(); notices = []; beforeList = undefined; beforeWrite = undefined; failWrite = false
  window.addEventListener(KOMARI_NOTIFICATION_EVENT, onNotice)
  saveNotificationPolicy({ enabled: true, channels: ['local'], recoveryChannels: ['local'], notifyOnRecovery: true, cooldownMs: 0 })
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === 'local_ops_list') {
      if (beforeList) await beforeList()
      const query = (args as { query: { vaultId: string; hostId: string; kind?: string } }).query
      return clone([...documents.values()].filter(row => row.vaultId === query.vaultId && row.hostId === query.hostId && (!query.kind || query.kind === row.kind)))
    }
    if (command === 'local_ops_upsert') {
      if (beforeWrite) await beforeWrite()
      if (failWrite) throw new Error('local journal unavailable')
      const payload = (args as { payload: LocalOpsDocument & { expectedRevision: number } }).payload
      const key = JSON.stringify([payload.vaultId, payload.hostId, payload.kind])
      if (payload.expectedRevision !== (documents.get(key)?.revision ?? 0)) throw new Error('LOCAL_OPS_REVISION_CONFLICT')
      const row = { vaultId: payload.vaultId, hostId: payload.hostId, kind: payload.kind, payload: clone(payload.payload), revision: payload.expectedRevision + 1, updatedAt: Date.now() }
      documents.set(key, row)
      return clone(row)
    }
    throw new Error('unexpected native command')
  })
})
afterEach(() => {
  window.removeEventListener(KOMARI_NOTIFICATION_EVENT, onNotice)
  if (nativeDescriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', nativeDescriptor)
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.unstubAllGlobals()
})

async function event(outcome: 'success' | 'failure' | 'unknown', index = 0, section: ProbeCollectionSection = 'metrics', host = target): Promise<ProbeCollectionEvent> {
  const completedAt = Date.now() - 1_000 + index
  return { eventId: crypto.randomUUID(), vaultId: host.vaultId!, hostId: host.id, configRevision: await getProbeCollectionConfigRevision(host),
    provider: { kind: 'ssh-agentless', id: 'ssh-agentless' }, transport: host.jumpHostId ? 'proxy-jump' : 'direct', startedAt: completedAt - 1, startedSequence: beginProbeCollectionSequence(), completedAt,
    sections: [{ section, outcome, sampledAt: outcome === 'success' ? completedAt : null, reason: outcome === 'success' ? 'observed' : outcome === 'failure' ? 'collection-unavailable' : 'observation-unavailable' }] }
}
function consumer(host = target) {
  return createProbeAlertLifecycleConsumer({ getCurrentHost: value => value.vaultId === host.vaultId && value.hostId === host.id ? host : null, isCurrent: () => true })
}

describe('durable SSH probe alert lifecycle', () => {
  it('opens once without prior cache, preserves unknown/fallback incidents, and resolves only on a new real sample', async () => {
    const lifecycle = consumer()
    const failed = await event('failure')
    await Promise.all([lifecycle.consume(failed), lifecycle.consume(failed)])
    await lifecycle.flush()
    let state = loadLocalAlertState('vault-a', 'edge')
    expect(state.alerts).toHaveLength(1)
    expect(state.alerts[0]).toMatchObject({ metric: 'probe-provider', status: 'active', transport: 'proxy-jump', source: 'ssh-agentless' })
    expect(state.audit.map(row => row.event)).toEqual(['opened'])
    expect(notices.map(row => row.kind)).toEqual(['alert.opened'])
    expect([...documents.values()].some(row => row.kind === 'alert-state')).toBe(true)
    await lifecycle.consume(await event('unknown', 20))
    expect(loadLocalAlertState('vault-a', 'edge').alerts[0].status).toBe('active')
    // A source that merely returns the old successful sample cannot recover
    // a failure which was observed after that sample was taken.
    const old = await event('success', 30)
    old.sections[0].sampledAt = failed.completedAt - 1
    await lifecycle.consume(old)
    expect(loadLocalAlertState('vault-a', 'edge').alerts[0].status).toBe('active')
    await lifecycle.consume(await event('success', 100))
    state = loadLocalAlertState('vault-a', 'edge')
    expect(state.alerts[0].status).toBe('resolved')
    expect(state.audit.map(row => row.event)).toEqual(['opened', 'resolved'])
    expect(notices.map(row => row.kind)).toEqual(['alert.opened', 'alert.resolved'])
    expect(JSON.stringify([...documents.values()])).not.toContain('PRIVATE')
  })

  it('rehydrates a prior session and deduplicates its durable audit and notification before a fresh recovery', async () => {
    const failed = await event('failure')
    await consumer().consume(failed)
    clearLocalOpsMemory(); resetLocalOpsPersistenceMemory()
    const nextSession = consumer()
    await nextSession.consume({ ...failed, eventId: crypto.randomUUID() })
    expect(loadLocalAlertState('vault-a', 'edge').audit.map(row => row.event)).toEqual(['opened'])
    expect(notices).toHaveLength(1)
    await nextSession.consume(await event('success', 100))
    expect(loadLocalAlertState('vault-a', 'edge').alerts[0].status).toBe('resolved')
    expect(notices).toHaveLength(2)
  })

  it('ignores late section outcomes without replacing the original successful sample timestamp', async () => {
    const lifecycle = consumer()
    const failed = await event('failure')
    const recovered = await event('success', 100)
    await lifecycle.consume(failed)
    await lifecycle.consume(recovered)
    expect(await lifecycle.consume(await event('unknown', 20))).toEqual({ status: 'ignored' })
    expect(await lifecycle.consume(await event('failure', 30))).toEqual({ status: 'ignored' })
    const ruleId = await probeAlertRuleId(failed.provider, 'metrics')
    expect(loadLocalAlertState('vault-a', 'edge').evaluations.find(row => row.ruleId === ruleId)).toMatchObject({ state: 'healthy', sampledAt: recovered.sections[0].sampledAt })
    await lifecycle.consume(await event('unknown', 200))
    expect(await lifecycle.consume(await event('failure', 150))).toEqual({ status: 'ignored' })
    // An independent section remains eligible despite a newer metrics attempt.
    await lifecycle.consume(await event('failure', 40, 'inventory'))
    expect(loadLocalAlertState('vault-a', 'edge').alerts.map(row => row.status)).toEqual(['resolved', 'active'])
    expect(loadLocalAlertState('vault-a', 'edge').audit.map(row => row.event)).toEqual(['opened', 'resolved', 'opened'])
  })

  it('rejects old unknown evidence after rehydrating a newer persisted metric sample', async () => {
    const recovered = await event('success', 100)
    await consumer().consume(recovered)
    clearLocalOpsMemory(); resetLocalOpsPersistenceMemory()
    const lifecycle = consumer()
    expect(await lifecycle.consume(await event('unknown', 20))).toEqual({ status: 'ignored' })
    const ruleId = await probeAlertRuleId(recovered.provider, 'metrics')
    expect(loadLocalAlertState('vault-a', 'edge').evaluations.find(row => row.ruleId === ruleId)?.sampledAt).toBe(recovered.sections[0].sampledAt)
    expect(notices).toEqual([])
  })

  it('isolates section and provider identities instead of using inventory success to recover a metric incident', async () => {
    const lifecycle = consumer()
    await lifecycle.consume(await event('failure'))
    await lifecycle.consume(await event('success', 20, 'inventory'))
    expect(loadLocalAlertState('vault-a', 'edge').alerts[0].status).toBe('active')
    const otherProvider = await event('failure', 30)
    otherProvider.provider = { kind: 'ssh-agentless', id: 'other-ssh-provider' }
    await lifecycle.consume(otherProvider)
    expect(loadLocalAlertState('vault-a', 'edge').alerts).toHaveLength(2)
    expect(await probeAlertRuleId(otherProvider.provider, 'metrics')).not.toBe(await probeAlertRuleId({ kind: 'ssh-agentless', id: 'ssh-agentless' }, 'metrics'))
    await lifecycle.consume(await event('success', 100))
    expect(loadLocalAlertState('vault-a', 'edge').alerts.map(row => row.status)).toEqual(['resolved', 'active'])
    expect(loadLocalAlertState('vault-b', 'edge').alerts).toEqual([])
  })

  it.each(['vault', 'host', 'jump-generation'] as const)('drops a late %s change during native hydration before writing or notifying', async changed => {
    const entered = deferred(); const release = deferred()
    beforeList = async () => { entered.resolve(); await release.promise }
    let currentHost: HostProfile | null = target
    let current = true
    const lifecycle = createProbeAlertLifecycleConsumer({ getCurrentHost: () => currentHost, isCurrent: () => current })
    const work = lifecycle.consume(await event('failure'))
    await entered.promise
    if (changed === 'vault') currentHost = { ...target, vaultId: 'vault-b' }
    if (changed === 'host') currentHost = { ...target, address: '192.0.2.11', updatedAt: 2 }
    if (changed === 'jump-generation') current = false
    release.resolve()
    expect(await work).toEqual({ status: 'ignored' })
    expect(documents.size).toBe(0)
    expect(notices).toEqual([])
  })

  it('serializes simultaneous section writes under the same host and canonical revision', async () => {
    const entered = deferred(); const release = deferred()
    let writeCount = 0
    beforeWrite = async () => { if (++writeCount === 1) { entered.resolve(); await release.promise } }
    const first = consumer(); const second = consumer()
    const one = first.consume(await event('failure'))
    await entered.promise
    const two = second.consume(await event('failure', 20, 'inventory'))
    await Promise.resolve()
    expect(writeCount).toBe(1)
    release.resolve()
    await Promise.all([one, two])
    expect(loadLocalAlertState('vault-a', 'edge').alerts).toHaveLength(2)
    expect(loadLocalAlertState('vault-a', 'edge').audit).toHaveLength(2)
    expect(writeCount).toBe(2)
  })

  it('rejects persistence failures without notifications or a successful flush and permits durable repair', async () => {
    failWrite = true
    const lifecycle = consumer()
    const failed = await event('failure')
    await expect(lifecycle.consume(failed)).rejects.toThrow('LOCAL_OPS_PERSISTENCE_UNAVAILABLE')
    await expect(lifecycle.flush()).rejects.toThrow('LOCAL_OPS_PERSISTENCE_UNAVAILABLE')
    expect(localOpsPersistenceError('vault-a', 'edge')).toBe('persistence-unavailable')
    expect(notices).toEqual([])
    expect(documents.size).toBe(0)
    failWrite = false
    await lifecycle.consume(failed)
    await expect(lifecycle.flush()).resolves.toBeUndefined()
    expect(documents.size).toBeGreaterThan(0)
    expect(notices).toHaveLength(1)
  })

  it('does not notify a departed Vault after its native write finally completes', async () => {
    const entered = deferred(); const release = deferred()
    beforeWrite = async () => { entered.resolve(); await release.promise }
    let current = true
    const lifecycle = createProbeAlertLifecycleConsumer({ getCurrentHost: () => target, isCurrent: () => current })
    const work = lifecycle.consume(await event('failure'))
    await entered.promise
    current = false
    release.resolve()
    expect(await work).toEqual({ status: 'ignored' })
    await lifecycle.flush()
    expect([...documents.values()].filter(row => row.kind === 'alert-state')).toHaveLength(1)
    expect(loadLocalAlertState('vault-b', 'edge').alerts).toEqual([])
    expect(notices).toEqual([])
  })

  it('rehydrates a concurrent canonical close on CAS conflict and does not send a false recovery', async () => {
    const lifecycle = consumer()
    await lifecycle.consume(await event('failure'))
    const key = JSON.stringify(['vault-a', 'edge', 'alert-state'])
    const canonical = clone(documents.get(key)!)
    const closed = actOnLocalAlert(canonical.payload as ReturnType<typeof loadLocalAlertState>, (canonical.payload as ReturnType<typeof loadLocalAlertState>).alerts[0].ruleId, 'close')
    beforeWrite = async () => {
      beforeWrite = undefined
      documents.set(key, { ...canonical, revision: canonical.revision + 1, payload: closed })
    }
    await expect(lifecycle.consume(await event('success', 100))).rejects.toThrow('LOCAL_OPS_PERSISTENCE_UNAVAILABLE')
    await expect(lifecycle.flush()).rejects.toThrow('LOCAL_OPS_PERSISTENCE_UNAVAILABLE')
    expect(localOpsPersistenceError('vault-a', 'edge')).toBe('revision-conflict')
    expect(loadLocalAlertState('vault-a', 'edge').alerts[0].status).toBe('closed')
    expect(loadLocalAlertState('vault-a', 'edge').audit.map(row => row.event)).toEqual(['opened', 'closed'])
    expect(notices.map(row => row.kind)).toEqual(['alert.opened'])
  })

  it('keeps user-rule and built-in probe evaluations through edits and independent scheduler passes', async () => {
    const userRule = normalizeLocalAlertRule({ id: 'user-cpu', hostId: target.id, name: 'CPU', metric: 'cpu', threshold: 90, recoveryThreshold: 80, durationMs: 0, recoveryDurationMs: 0, enabled: true })
    saveLocalAlertRules(target.vaultId, target.id, [userRule])
    const sampledAt = Date.now() - 2_000
    saveLocalAlertState(target.vaultId, target.id, evaluateLocalAlertRules(loadLocalAlertState(target.vaultId, target.id), [userRule], [{ ruleId: userRule.id, value: 100, sampledAt, source: 'ssh-agentless', transport: 'proxy-jump' }]))
    await flushLocalOpsHost(target.vaultId, target.id)
    const lifecycle = consumer()
    const failed = await event('failure')
    await lifecycle.consume(failed)
    const probeId = await probeAlertRuleId(failed.provider, 'metrics')
    saveLocalAlertRules(target.vaultId, target.id, [{ ...userRule, name: 'Renamed CPU' }])
    let state = loadLocalAlertState(target.vaultId, target.id)
    expect(state.evaluations.some(row => row.ruleId === probeId)).toBe(true)
    state = evaluateLocalAlertRules(state, [{ ...userRule, name: 'Renamed CPU' }], [{ ruleId: userRule.id, value: 95, sampledAt: sampledAt + 100, source: 'ssh-agentless', transport: 'proxy-jump' }])
    saveLocalAlertState(target.vaultId, target.id, state)
    await flushLocalOpsHost(target.vaultId, target.id)
    await lifecycle.consume(await event('success', 100))
    state = loadLocalAlertState(target.vaultId, target.id)
    expect(state.alerts.find(row => row.ruleId === probeId)?.status).toBe('resolved')
    expect(state.alerts.find(row => row.ruleId === userRule.id)?.status).toBe('active')
    expect(state.evaluations.map(row => row.ruleId).sort()).toEqual([probeId, userRule.id].sort())
    expect(state.audit.filter(row => row.ruleId === probeId).map(row => row.event)).toEqual(['opened', 'resolved'])
  })

  it('does not consume Komari, unsupported/paused evidence as failure, or malformed success timestamps', async () => {
    const lifecycle = consumer()
    for (const reason of ['paused', 'unsupported', 'scope-unavailable'] as const) {
      const unknown = await event('unknown')
      unknown.sections[0].reason = reason
      await lifecycle.consume(unknown)
    }
    expect(loadLocalAlertState('vault-a', 'edge').alerts).toEqual([])
    const komari = await event('failure'); komari.provider.kind = 'komari'
    expect(await lifecycle.consume(komari)).toEqual({ status: 'ignored' })
    const invalid = await event('success'); invalid.sections[0].sampledAt = invalid.completedAt + 1
    expect(await lifecycle.consume(invalid)).toEqual({ status: 'ignored' })
    const pausedFailure = await event('failure'); pausedFailure.sections[0].reason = 'paused'
    expect(await lifecycle.consume(pausedFailure)).toEqual({ status: 'ignored' })
    expect(notices).toEqual([])
  })

  it('localizes new alert labels without changing provider identity or rewriting prior audit names', async () => {
    let label = '探针采集不可用'
    const lifecycle = createProbeAlertLifecycleConsumer({ getCurrentHost: () => target, isCurrent: () => true, ruleName: section => `${label} · ${section}` })
    await lifecycle.consume(await event('failure'))
    const first = loadLocalAlertState('vault-a', 'edge')
    const id = first.alerts[0].ruleId
    expect(first.audit[0].name).toBe('探针采集不可用 · metrics')
    label = 'Probe collection unavailable'
    await lifecycle.consume(await event('success', 100))
    const recovered = loadLocalAlertState('vault-a', 'edge')
    expect(recovered.alerts[0].ruleId).toBe(id)
    expect(recovered.audit[0].name).toBe('探针采集不可用 · metrics')
  })
})
