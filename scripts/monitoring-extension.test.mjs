import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validate, sample, evaluate, silenced } = require('../monitoring-extension/policy.cjs')
const rule = { id: 'rule-1', name: 'CPU', nodeId: 'node-1', nodeCreatedAt: '2026-10-01T00:00:00Z', metric: 'cpu', threshold: 90, recovery: 70, durationSeconds: 30, recoverySeconds: 15, enabled: true }
const policy = { rules: [rule], silences: [] }
const now = Date.parse('2026-10-22T12:00:00Z')
test('rules reject ambiguous IDs, invalid thresholds and missing node identity', () => {
  assert.equal(validate(policy), policy)
  for (const patch of [{ id: '__proto__' }, { threshold: 101 }, { recovery: 95 }, { nodeCreatedAt: '' }, { durationSeconds: -1 }, { enabled: 'true' }]) assert.throws(() => validate({ ...policy, rules: [{ ...rule, ...patch }] }))
  assert.throws(() => validate({ ...policy, rules: [rule, rule] }))
})
test('original v2 timestamps and zero percentages are interpreted without invented sample time', () => {
  assert.deepEqual(sample({ updated_at: new Date(now).toISOString(), cpu: { usage: 95 } }, 'cpu'), { at: now, value: 95 })
  assert.deepEqual(sample({ updated_at: new Date(now).toISOString(), cpu: {} }, 'cpu'), { at: now, value: 0 })
  assert.equal(sample({ cpu: { usage: 95 } }, 'cpu'), null)
  assert.equal(sample({ updated_at: new Date(now).toISOString(), ram: { used: 4, total: 0 } }, 'memory'), null)
})
test('stale, future and repeated samples cannot fire or recover', () => {
  const first = evaluate(rule, {}, [{ at: now, value: 95 }], policy, now)
  assert.equal(first.state.status, 'pending')
  assert.equal(evaluate(rule, first.state, [{ at: now, value: 95 }], policy, now + 60000).events.length, 0)
  for (const at of [now - 180001, now + 1]) assert.equal(evaluate(rule, {}, [{ at, value: 95 }], policy, now).state.status, 'unknown')
  const firing = { ...first.state, firing: true, notified: true }
  const unknown = evaluate(rule, firing, [], policy, now + 240000)
  assert.equal(unknown.state.firing, true); assert.equal(unknown.events.length, 0)
})
test('sustained new observations fire, preserve hysteresis and recover once', () => {
  let a = evaluate(rule, {}, [{ at: now - 30000, value: 95 }, { at: now, value: 95 }], policy, now)
  assert.equal(a.events.length, 1); assert.equal(a.events[0].kind, 'firing')
  a = evaluate(rule, a.state, [{ at: now + 1000, value: 80 }], policy, now + 1000)
  assert.equal(a.state.firing, true); assert.equal(a.events.length, 0)
  a = evaluate(rule, a.state, [{ at: now + 2000, value: 60 }, { at: now + 17000, value: 60 }], policy, now + 17000)
  assert.equal(a.state.firing, false); assert.equal(a.events[0].kind, 'recovered')
  assert.equal(evaluate(rule, a.state, [{ at: now + 17000, value: 60 }], policy, now + 18000).events.length, 0)
})
test('missing intervals break both sustain clocks', () => {
  const pending = evaluate(rule, {}, [{ at: now, value: 95 }], policy, now)
  assert.equal(evaluate(rule, pending.state, [{ at: now + 190000, value: 95 }], policy, now + 190000).state.status, 'pending')
})
test('silence keeps incidents active and ending it requires a new sample', () => {
  const p = { ...policy, silences: [{ id: 's1', name: 'Maintenance', enabled: true, kind: 'once', startAt: now - 100000, endAt: now + 1000, ruleIds: [rule.id] }] }
  validate(p)
  const a = evaluate(rule, {}, [{ at: now - 30000, value: 95 }, { at: now, value: 95 }], p, now)
  assert.equal(a.state.status, 'silenced'); assert.equal(a.state.firing, true); assert.equal(a.events[0].suppressed, true)
  assert.equal(evaluate(rule, a.state, [{ at: now, value: 95 }], p, now + 2000).events.length, 0)
  const b = evaluate(rule, a.state, [{ at: now + 3000, value: 95 }], p, now + 3000)
  assert.equal(b.events.length, 1); assert.equal(b.events[0].suppressed, false)
})
test('weekly UTC crossing midnight respects start weekday and exclusive end', () => {
  const p = { ...policy, silences: [{ id: 's1', name: 'Night', enabled: true, kind: 'weekly', timezone: 'UTC', days: [4], startMinute: 23 * 60, endMinute: 60, ruleIds: [] }] }
  validate(p)
  assert.equal(silenced(p, rule.id, Date.parse('2026-10-22T23:00:00Z')), true)
  assert.equal(silenced(p, rule.id, Date.parse('2026-10-23T00:59:59Z')), true)
  assert.equal(silenced(p, rule.id, Date.parse('2026-10-23T01:00:00Z')), false)
  assert.equal(silenced(p, rule.id, Date.parse('2026-10-23T23:30:00Z')), false)
})
test('serialization and restart cannot replay previous dispatches', () => {
  const result = evaluate(rule, {}, [{ at: now - 30000, value: 95 }, { at: now, value: 95 }], policy, now)
  const persisted = JSON.parse(JSON.stringify(result.state))
  assert.equal(evaluate(rule, persisted, [{ at: now, value: 95 }, { at: now + 1000, value: 95 }], policy, now + 1000).events.length, 0)
})
test('disabled rules do not manufacture recovery or notification', () => {
  const r = evaluate({ ...rule, enabled: false }, { firing: true, notified: true }, [{ at: now, value: 0 }], policy, now)
  assert.equal(r.state.firing, true); assert.equal(r.state.status, 'disabled'); assert.equal(r.events.length, 0)
})
