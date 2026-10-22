import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const engine = require('../monitoring-extension/policy.cjs')
const source = readFileSync(new URL('../monitoring-extension/server.cjs', import.meta.url), 'utf8')
const node = { uuid: 'node', created_at: 'created' }
const rule = { id: 'rule', name: 'CPU', nodeId: 'node', nodeCreatedAt: 'created', metric: 'cpu', threshold: 80, recovery: 60, durationSeconds: 0, recoverySeconds: 0, enabled: true }
function runtime(files = new Map()) {
  const routes = new Map(); const sends = []; let cron; let cpu = 90; let at = Date.now(); let enabled = true; let failSave = false; let beforeSend
  const fs = { existsSync: p => files.has(p), readFileSync: p => files.get(p), writeFileSync: (p, s) => { if (failSave) throw Error('disk full'); files.set(p, s) }, renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a) } }
  const server = { route: (method, p, h) => routes.set(method + p, h), cron: (_, h) => { cron = h }, call: async (name) => {
    if (name === 'admin:listClients') return [node]
    if (name === 'admin:getSettings') return { notification_enabled: enabled, notification_method: 'webhook', api_key: 'must-not-persist' }
    if (name === 'public:getClientRecentRecords') return [{ updated_at: new Date(at).toISOString(), cpu: { usage: cpu } }]
    if (name === 'admin:sendNotification') { sends.push(name); if (beforeSend) await beforeSend(); throw Error('response lost') }
    throw Error('unexpected method')
  } }
  const context = vm.createContext({ require: n => n === 'server' ? server : n === 'fs' ? fs : n === './policy.cjs' ? engine : require(n), Date, JSON })
  vm.runInContext(source, context); vm.runInContext('load()', context)
  return { files, sends, setSend: f => { beforeSend = f }, setEnabled: b => { enabled = b }, diskFull: () => { failSave = true }, sample: (value, timestamp = Date.now()) => { cpu = value; at = timestamp }, tick: () => vm.runInContext('tick()', context), registered: () => !!cron,
    request: async (method, path, body, admin = true) => { const r = { setHeader() {}, end(v) { this.body = JSON.parse(v) } }; await routes.get(method + '/api/shellbeam-alerts/v1' + path)({ context: { principal: { roles: admin ? ['admin'] : [] } }, body: JSON.stringify(body) }, r); return { status: r.statusCode, body: r.body } } }
}
async function save(r, rules = [rule], silences = []) { const view = (await r.request('GET', '/policy')).body; return r.request('POST', '/policy', { ...view, rules, silences }) }
test('runtime authenticates public-site routes and rejects stale and recreated identities', async () => {
  const r = runtime(); assert.equal(r.registered(), true)
  for (const [m, p] of [['GET', '/policy'], ['GET', '/status'], ['POST', '/policy']]) assert.equal((await r.request(m, p, {}, false)).status, 403)
  const old = (await r.request('GET', '/policy')).body; assert.equal((await save(r)).status, 200)
  assert.equal((await r.request('POST', '/policy', old)).status, 409)
  assert.equal((await save(r, [{ ...rule, nodeCreatedAt: 'new' }])).status, 409)
  assert.equal((await r.request('GET', '/policy')).body.rules[0].nodeCreatedAt, 'created')
})
test('global notification disable suppresses dispatch without consuming the incident', async () => {
  const r = runtime(); await save(r); r.setEnabled(false); await r.tick()
  let state = (await r.request('GET', '/status')).body
  assert.equal(state.evaluations.rule.firing, true); assert.equal(state.evaluations.rule.notified, false); assert.equal(state.events[0].delivery, 'channel-disabled'); assert.equal(r.sends.length, 0)
  r.setEnabled(true); await r.tick(); assert.equal(r.sends.length, 0)
  await new Promise(resolve => setTimeout(resolve, 5)); r.sample(90); await r.tick(); assert.equal(r.sends.length, 1)
  state = (await r.request('GET', '/status')).body; assert.equal(state.events.at(-1).delivery, 'unknown')
  assert.ok(!JSON.stringify([...r.files.values()]).includes('must-not-persist'))
})
test('lost send response and restart do not replay; failed persistence prevents dispatch', async () => {
  const r = runtime(); await save(r); await r.tick(); assert.equal(r.sends.length, 1)
  const restarted = runtime(r.files); await restarted.tick(); assert.equal(restarted.sends.length, 0)
  const broken = runtime(); await save(broken); broken.diskFull(); await assert.rejects(broken.tick()); assert.equal(broken.sends.length, 0)
})
test('configuration changed during a send cancels remaining stale dispatches and prunes removed state', async () => {
  const r = runtime(); await save(r, [rule, { ...rule, id: 'second' }])
  r.setSend(async () => { assert.equal((await save(r, [rule])).status, 200) })
  await r.tick(); assert.equal(r.sends.length, 1)
  const state = (await r.request('GET', '/status')).body
  assert.equal(state.evaluations.second, undefined)
  assert.equal(state.events.find(e => e.ruleId === 'second').delivery, 'configuration-changed')
  assert.equal(state.receipts.length, 2)
})

test('renaming preserves unknown dispatch markers and semantic edits require newer samples', async () => {
  const r = runtime(); await save(r); await r.tick(); assert.equal(r.sends.length, 1)
  await save(r, [{ ...rule, name: 'Renamed' }]); await r.tick(); assert.equal(r.sends.length, 1)
  await save(r, [{ ...rule, threshold: 85 }]); await r.tick(); assert.equal(r.sends.length, 1)
  await new Promise(resolve => setTimeout(resolve, 5)); r.sample(95); await r.tick(); assert.equal(r.sends.length, 2)
})
