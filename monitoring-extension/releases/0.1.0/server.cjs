'use strict'
const server = require('server')
const fs = require('fs')
const crypto = require('crypto')
const engine = require('./policy.cjs')
const PATH = '/api/shellbeam-alerts/v1'
const FILE = 'state.json'
function persist(next) {
  fs.writeFileSync('state.pending.json', JSON.stringify(next), { mode: 384 })
  fs.renameSync('state.pending.json', FILE)
  state = next
}
let state
if (fs.existsSync(FILE)) {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  engine.validate(state.policy)
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || typeof state.identity !== 'string' || !state.evaluations || !Array.isArray(state.events)) throw Error('INVALID_PERSISTED_STATE')
} else persist({ version: 1, identity: crypto.randomBytes(24).toString('hex'), revision: 1, policy: { rules: [], silences: [] }, evaluations: {}, events: [], receipts: [] })
function json(res, code, value) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
function admin(req, res) {
  const p = req.context && req.context.principal
  if (!p || !Array.isArray(p.roles) || !p.roles.includes('admin')) { json(res, 403, { error: 'ADMIN_REQUIRED' }); return false }
  return true
}
const view = () => ({ extension_identity: state.identity, revision: state.revision, rules: state.policy.rules, silences: state.policy.silences })
server.route('GET', PATH + '/policy', (req, res) => { if (admin(req, res)) json(res, 200, view()) })
server.route('GET', PATH + '/status', (req, res) => { if (admin(req, res)) json(res, 200, { revision: state.revision, evaluations: state.evaluations, events: state.events, receipts: state.receipts || [], scope: 'extension-load-notifications' }) })
let saving = false
server.route('POST', PATH + '/policy', async (req, res) => {
  if (!admin(req, res)) return
  if (saving) return json(res, 409, { error: 'BUSY' })
  saving = true
  try {
    const input = JSON.parse(String(req.body))
    if (input.extension_identity !== state.identity || input.revision !== state.revision) return json(res, 409, { error: 'CONFLICT' })
    const next = engine.validate({ rules: input.rules, silences: input.silences })
    const clients = await server.call('admin:listClients')
    if (!Array.isArray(clients) || next.rules.some(r => !clients.some(c => c.uuid === r.nodeId && c.created_at === r.nodeCreatedAt))) return json(res, 409, { error: 'NODE_CHANGED' })
    // RPC yields; recheck CAS immediately before the atomic file replacement.
    if (input.revision !== state.revision) return json(res, 409, { error: 'CONFLICT' })
    const evaluations = Object.fromEntries(Object.entries(state.evaluations).filter(([id]) => next.rules.some(r => r.id === id)))
    for (const r of next.rules) {
      const old = state.policy.rules.find(x => x.id === r.id)
      const keys = ['nodeId', 'nodeCreatedAt', 'metric', 'enabled', 'threshold', 'recovery', 'durationSeconds', 'recoverySeconds']
      if (!old || keys.some(k => old[k] !== r[k])) {
        // Renaming is metadata, not another delivery attempt. A changed rule
        // waits for evidence newer than its previous evaluation watermark.
        evaluations[r.id] = { sampledAt: evaluations[r.id]?.sampledAt || 0 }
      }
    }
    const receipts = [...(state.receipts || []), { revision: state.revision + 1, at: Date.now(), actor: 'administrator', rules: next.rules.length, silences: next.silences.length }].slice(-500)
    persist({ ...state, policy: next, revision: state.revision + 1, evaluations, receipts })
    json(res, 200, view())
  } catch { json(res, 400, { error: 'POLICY_NOT_SAVED' }) }
  finally { saving = false }
})
let ticking = false
async function tick() {
  if (ticking || saving) return
  ticking = true
  try {
    const revision = state.revision
    const settings = await server.call('admin:getSettings')
    const notificationsEnabled = settings && settings.notification_enabled === true && typeof settings.notification_method === 'string' && !['', 'none'].includes(settings.notification_method)
    const clients = await server.call('admin:listClients')
    if (!Array.isArray(clients)) return
    const reports = Object.create(null)
    for (const rule of state.policy.rules) {
      if (!rule.enabled || engine.own(reports, rule.nodeId)) continue
      if (!clients.some(c => c.uuid === rule.nodeId && c.created_at === rule.nodeCreatedAt)) { reports[rule.nodeId] = []; continue }
      try { const rows = await server.call('public:getClientRecentRecords', { uuid: rule.nodeId }); reports[rule.nodeId] = Array.isArray(rows) ? rows.slice(-60) : [] } catch { reports[rule.nodeId] = [] }
    }
    if (revision !== state.revision || saving) return
    const evaluations = { ...state.evaluations }; const pending = []; const now = Date.now()
    for (const rule of state.policy.rules) {
      const result = engine.evaluate(rule, evaluations[rule.id], (reports[rule.nodeId] || []).map(r => engine.sample(r, rule.metric)), state.policy, now, notificationsEnabled)
      evaluations[rule.id] = result.state
      for (const event of result.events) pending.push({ ...event, ruleId: rule.id, nodeId: rule.nodeId, name: rule.name, metric: rule.metric, at: now, delivery: event.suppressed ? event.suppressionReason : 'unknown' })
    }
    // Persist dispatch markers before sending. A lost response or restart never
    // resends a prior attempt. This is at-most-once dispatch, not a delivery receipt.
    persist({ ...state, evaluations, events: [...state.events, ...pending].slice(-500) })
    for (const event of pending) {
      if (event.suppressed) continue
      // No dispatch after a concurrent policy edit; only a new raw sample can
      // establish another attempt. Reads must not replay a cancelled send.
      if (revision !== state.revision) {
        event.delivery = 'configuration-changed'
        const evaluation = state.evaluations[event.ruleId]
        const evaluations = { ...state.evaluations }
        if (event.kind === 'firing' && evaluation?.sampledAt === event.sampledAt) evaluations[event.ruleId] = { ...evaluation, notified: false }
        persist({ ...state, evaluations, events: state.events.map(e => e.ruleId === event.ruleId && e.sampledAt === event.sampledAt && e.kind === event.kind ? event : e) })
        continue
      }
      try {
        await server.call('admin:sendNotification', { event: { event: event.kind === 'recovered' ? 'ShellBeamLoadRecovered' : 'ShellBeamLoad', clients: [{ uuid: event.nodeId }], time: new Date(event.sampledAt).toISOString(), message: `${event.name}: ${event.metric} ${event.value} (${event.kind})`, emoji: '' } })
        event.delivery = 'service-accepted'
      } catch { event.delivery = 'unknown' }
      // Configuration can change while delivery is in flight. Preserve that
      // newer configuration, and only update the matching dispatch marker.
      persist({ ...state, events: state.events.map(e => e.ruleId === event.ruleId && e.sampledAt === event.sampledAt && e.kind === event.kind ? event : e) })
    }
  } finally { ticking = false }
}
function load() { server.cron('*/15 * * * * *', () => { tick().catch(() => {}) }) }
