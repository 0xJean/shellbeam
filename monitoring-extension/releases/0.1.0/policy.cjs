'use strict'
// Pure, bounded policy engine. Evaluations consume original, dated samples;
// cached observations never advance sustain/recovery timers.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const plain = o => o && typeof o === 'object' && !Array.isArray(o)
const text = (s, max = 120) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s)
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max
const id = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s)
const METRICS = ['cpu', 'memory', 'disk', 'load1']
function validate(policy) {
  if (!plain(policy) || !Array.isArray(policy.rules) || !Array.isArray(policy.silences) || policy.rules.length > 64 || policy.silences.length > 64) throw Error('INVALID_POLICY')
  const ids = new Set()
  for (const r of policy.rules) {
    if (!plain(r) || !id(r.id) || ids.has(r.id) || !text(r.name) || !id(r.nodeId) || !text(r.nodeCreatedAt) || !METRICS.includes(r.metric) || typeof r.enabled !== 'boolean' || !Number.isFinite(r.threshold) || r.threshold <= 0 || r.threshold > (r.metric === 'load1' ? 100000 : 100) || !Number.isFinite(r.recovery) || r.recovery < 0 || r.recovery >= r.threshold || !integer(r.durationSeconds, 0, 86400) || !integer(r.recoverySeconds, 0, 86400)) throw Error('INVALID_RULE')
    ids.add(r.id)
  }
  const silenceIds = new Set()
  for (const s of policy.silences) {
    if (!plain(s) || !id(s.id) || silenceIds.has(s.id) || !text(s.name) || typeof s.enabled !== 'boolean' || !Array.isArray(s.ruleIds) || new Set(s.ruleIds).size !== s.ruleIds.length || s.ruleIds.some(r => !ids.has(r))) throw Error('INVALID_SILENCE')
    if (s.kind === 'once') {
      if (!integer(s.startAt, 1, 8640000000000000) || !integer(s.endAt, s.startAt + 1, 8640000000000000) || s.endAt - s.startAt > 366 * 86400000) throw Error('INVALID_SILENCE')
    } else if (s.kind === 'weekly') {
      if (!Array.isArray(s.days) || !s.days.length || new Set(s.days).size !== s.days.length || s.days.some(d => !integer(d, 0, 6)) || !integer(s.startMinute, 0, 1439) || !integer(s.endMinute, 0, 1439) || s.startMinute === s.endMinute || s.timezone !== 'UTC') throw Error('INVALID_SILENCE')
    } else throw Error('INVALID_SILENCE')
    silenceIds.add(s.id)
  }
  return policy
}
function silenced(policy, ruleId, now) {
  const date = new Date(now); const day = date.getUTCDay(); const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return policy.silences.some(s => {
    if (!s.enabled || (s.ruleIds.length && !s.ruleIds.includes(ruleId))) return false
    if (s.kind === 'once') return now >= s.startAt && now < s.endAt
    if (s.startMinute < s.endMinute) return s.days.includes(day) && minute >= s.startMinute && minute < s.endMinute
    return (s.days.includes(day) && minute >= s.startMinute) || (s.days.includes((day + 6) % 7) && minute < s.endMinute)
  })
}
function sample(report, metric) {
  const at = Date.parse(report?.updated_at)
  let value = metric === 'cpu' ? (plain(report?.cpu) ? report.cpu.usage ?? 0 : undefined) : metric === 'load1' ? report?.load?.load1 : undefined
  if (metric === 'memory' || metric === 'disk') {
    const part = metric === 'memory' ? report?.ram : report?.disk
    value = Number.isFinite(part?.used) && Number.isFinite(part?.total) && part.total > 0 ? part.used / part.total * 100 : undefined
  }
  return Number.isFinite(at) && Number.isFinite(value) && value >= 0 && (metric === 'load1' || value <= 100) ? { at, value } : null
}
function evaluate(rule, previous, samples, policy, now, notificationsEnabled = true) {
  const state = { sampledAt: 0, pendingAt: null, recoveryAt: null, firing: false, notified: false, status: 'unknown', ...previous }
  const events = []
  if (!rule.enabled) { state.status = 'disabled'; state.pendingAt = state.recoveryAt = null; return { state, events } }
  const fresh = samples.filter(s => s && s.at <= now && now - s.at <= 180000).sort((a, b) => a.at - b.at)
  if (!fresh.length) { state.status = 'unknown'; state.pendingAt = state.recoveryAt = null; return { state, events } }
  for (const s of fresh) {
    if (s.at <= state.sampledAt) continue
    if (s.at - state.sampledAt > 180000) state.pendingAt = state.recoveryAt = null
    state.sampledAt = s.at; state.value = s.value
    if (state.firing) {
      if (s.value <= rule.recovery) {
        if (state.recoveryAt === null) state.recoveryAt = s.at
        if (s.at - state.recoveryAt >= rule.recoverySeconds * 1000) {
          state.firing = false; state.recoveryAt = null
          if (state.notified) events.push({ kind: 'recovered', sampledAt: s.at, value: s.value, suppressed: silenced(policy, rule.id, now) || !notificationsEnabled, suppressionReason: !notificationsEnabled ? 'channel-disabled' : 'silenced' })
          state.notified = false
        }
      } else state.recoveryAt = null
    } else if (s.value >= rule.threshold) {
      if (state.pendingAt === null) state.pendingAt = s.at
      if (s.at - state.pendingAt >= rule.durationSeconds * 1000) { state.firing = true; state.pendingAt = null }
    } else state.pendingAt = null
    // Silence changes delivery only. Acknowledgement or ending a window does
    // not manufacture recovery, and no queued historical message is replayed.
    if (state.firing && !state.notified) {
      const reason = !notificationsEnabled ? 'channel-disabled' : silenced(policy, rule.id, now) ? 'silenced' : null
      const muted = reason !== null
      if (!muted || state.suppressionRecorded !== reason) events.push({ kind: 'firing', sampledAt: s.at, value: s.value, suppressed: muted, suppressionReason: reason })
      state.notified = !muted; state.suppressionRecorded = reason
    }
    if (!state.firing) state.suppressionRecorded = false
  }
  state.status = state.firing ? (silenced(policy, rule.id, now) ? 'silenced' : 'firing') : state.pendingAt !== null ? 'pending' : 'healthy'
  return { state, events }
}
module.exports = { validate, silenced, sample, evaluate, own, METRICS }
