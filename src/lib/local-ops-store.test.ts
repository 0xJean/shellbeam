import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LOCAL_ALERT_STATE, actOnLocalAlert, evaluateLocalAlertRules, normalizeLocalAlertRule } from './local-alert-rules'
import { clearLocalOpsMemory, dispatchLocalAlertNotifications, loadLocalAlertRules, loadLocalAlertState, localOpsStorageKey, parseLocalAlertState, saveLocalAlertRules, saveLocalAlertState } from './local-ops-store'
const rule = normalizeLocalAlertRule({ id: 'cpu', hostId: 'host', name: 'CPU high', metric: 'cpu', threshold: 90, recoveryThreshold: 80, durationMs: 0, recoveryDurationMs: 0 })
const firing = () => evaluateLocalAlertRules(EMPTY_LOCAL_ALERT_STATE, [rule], [{ ruleId: rule.id, value: 99, sampledAt: 1_000, source: 'ssh-agentless', transport: 'direct' }], 1_000)
beforeEach(() => { localStorage.clear(); clearLocalOpsMemory() })
describe('local alert persistence and delivery', () => {
  it('scopes definitions and histories and strips untrusted fields', () => {
    saveLocalAlertRules('vault', 'host', [{ ...rule, password: 'secret' } as typeof rule])
    expect(loadLocalAlertRules('vault', 'host')).toEqual([rule])
    expect(loadLocalAlertRules('other', 'host')).toEqual([])
    expect(() => saveLocalAlertRules('vault', 'other', [rule])).toThrow('local_alert_invalid_scope')
    localStorage.setItem(localOpsStorageKey('vault', 'other', 'rules'), JSON.stringify([rule]))
    expect(loadLocalAlertRules('vault', 'other')).toEqual([])
  })
  it('retains incidents/audit across sessions but requires new sustain evidence', () => {
    const state = firing()
    state.evaluations[0].pendingSince = 123
    saveLocalAlertState('vault', 'host', state)
    clearLocalOpsMemory()
    const hydrated = loadLocalAlertState('vault', 'host')
    expect(hydrated.alerts[0].status).toBe('active')
    expect(hydrated.evaluations[0].pendingSince).toBeNull()
    expect(hydrated.audit).toEqual(state.audit)
    expect(loadLocalAlertState('vault2', 'host').alerts).toHaveLength(0)
    expect(parseLocalAlertState({ ...state, password: 'secret', alerts: [{ ...state.alerts[0], output: 'secret' }] }, 'host').alerts[0]).not.toHaveProperty('output')
  })
  it('delivers opening and recovery once per immutable event across concurrent refreshes and reload', async () => {
    const onLocal = vi.fn()
    const state = firing()
    const options = { now: 1_000, onLocal, policy: { channels: ['local'] as const, cooldownMs: 0, notifyOnRecovery: true } }
    await Promise.all([dispatchLocalAlertNotifications('vault', 'host', state, options), dispatchLocalAlertNotifications('vault', 'host', state, options)])
    await dispatchLocalAlertNotifications('vault', 'host', state, { ...options, now: 99_000 })
    expect(onLocal).toHaveBeenCalledTimes(1)
    const recovered = evaluateLocalAlertRules(state, [rule], [{ ruleId: rule.id, value: 20, sampledAt: 3_000, source: 'ssh-agentless', transport: 'direct' }], 3_000)
    await dispatchLocalAlertNotifications('vault', 'host', recovered, { ...options, now: 3_000 })
    expect(onLocal).toHaveBeenCalledTimes(2)
    expect(onLocal.mock.calls[1][0]).toMatchObject({ kind: 'alert.resolved' })
  })
  it('keeps incidents open when rules are removed until an explicit audited close', () => {
    saveLocalAlertRules('vault', 'host', [rule])
    saveLocalAlertState('vault', 'host', firing())
    saveLocalAlertRules('vault', 'host', [])
    expect(loadLocalAlertState('vault', 'host').alerts[0].status).toBe('active')
    expect(actOnLocalAlert(loadLocalAlertState('vault', 'host'), rule.id, 'close', 2_000).audit).toHaveLength(2)
  })
})

it('retries only failed channels within its finite budget and never backfills newly enabled channels', async () => {
  const state = firing()
  const onLocal = vi.fn()
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 })
  const policy = { channels: ['local', 'webhook'] as const, webhookUrl: 'https://example.com/hook', cooldownMs: 0 }
  await dispatchLocalAlertNotifications('vault', 'host', state, { now: 1_000, policy, onLocal, fetchImpl })
  await dispatchLocalAlertNotifications('vault', 'host', state, { now: 30_000, policy, onLocal, fetchImpl })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  for (const now of [61_000, 121_000, 181_000, 241_000]) await dispatchLocalAlertNotifications('vault', 'host', state, { now, policy, onLocal, fetchImpl })
  expect(fetchImpl).toHaveBeenCalledTimes(4)
  expect(onLocal).toHaveBeenCalledTimes(1)
  const onSystem = vi.fn()
  await dispatchLocalAlertNotifications('vault', 'host', state, { now: 301_000, policy: { ...policy, channels: ['system'] }, onSystem })
  expect(onSystem).not.toHaveBeenCalled()
})
