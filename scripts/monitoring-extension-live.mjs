#!/usr/bin/env node
/** Explicit upstream contract smoke. Pass an unmodified official Komari 1.6.0
 * binary built for this OS. It creates and removes its own private instance;
 * it never reads an existing database or installs a user/system service. */
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { open, mkdtemp, chmod, realpath, rm, readFile, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--binary') {
  console.error('Usage: node scripts/monitoring-extension-live.mjs --binary /absolute/path/to/official-komari-1.6.0')
  process.exit(2)
}
const binary = await realpath(args[1])
const root = await mkdtemp(join(tmpdir(), 'shellbeam-komari-contract-'))
await chmod(root, 0o700)
const log = await open(join(root, 'server.log'), 'wx', 0o600)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let stage = 'allocate loopback listener'
const reportPath = process.env.SHELLBEAM_MONITORING_EXTENSION_REPORT || join(tmpdir(), 'shellbeam-monitoring-extension-live-report.json')
let resultReport
let child
let stopped = false
let receiver
const checks = []
resultReport = { result: 'failed', checks }
const delivered = []
let interrupted = false
const onSignal = () => { interrupted = true; child?.kill('SIGTERM') }
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

async function waitFor(check, timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until && !interrupted) {
    if (stopped) throw new Error('server exited')
    try { const value = await check(); if (value) return value } catch { /* bounded startup/flush retry */ }
    await delay(100)
  }
  throw new Error('bounded wait expired')
}
async function stop() {
  if (!child || stopped) return true
  child.kill('SIGTERM')
  for (let i = 0; i < 100 && !stopped; i++) await delay(100)
  if (!stopped) child.kill('SIGKILL')
  for (let i = 0; i < 50 && !stopped; i++) await delay(100)
  return stopped
}
try {
  const listener = createNetServer()
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done) })
  const port = listener.address().port
  await new Promise((done, reject) => listener.close((error) => error ? reject(error) : done()))
  const endpoint = `http://127.0.0.1:${port}`
  const request = async (path, { body, headers = {}, method = body === undefined ? 'GET' : 'POST', redirect = 'error' } = {}) => {
    const response = await fetch(`${endpoint}${path}`, { method, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect, signal: AbortSignal.timeout(10000) })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* startup may return non-JSON */ }
    return { response, json, data: json?.data ?? json }
  }
  stage = 'launch isolated official server'
  child = spawn(binary, ['server', '--listen', `127.0.0.1:${port}`, '--database', join(root, 'primary.db')], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'UTC' }, stdio: ['ignore', log.fd, log.fd] })
  child.once('error', () => { stopped = true })
  child.once('close', () => { stopped = true })
  await waitFor(async () => (await request('/api/install/status')).data?.required === true)
  stage = 'complete temporary first-run installation'
  // All credentials stay in process memory; no command line, console or fixture contains them.
  const username = `smoke-${randomBytes(8).toString('hex')}`
  const password = `Sb1${randomBytes(24).toString('hex')}`
  const apiKey = randomBytes(32).toString('hex')
  const install = await request('/api/install/complete', { body: { username, password, sitename: 'ShellBeam isolated contract smoke', description: 'Synthetic local-only API test', metric_dsn: join(root, 'metrics.db') } })
  assert.equal(install.response.status, 200)
  await waitFor(async () => (await request('/api/version')).data?.version === '1.6.0')
  const login = await request('/api/login', { body: { username, password } })
  assert.equal(login.response.status, 200)
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('session_token='))
  stage = 'save temporary Server API Key using the official console route'
  // Match the console's slashless POST and same-origin cookie session. Only
  // this isolated loopback setup follows the server's canonical-path redirect.
  const settings = await request('/api/admin/settings', { redirect: 'follow', headers: { Cookie: cookie, Origin: endpoint }, body: { api_key: apiKey, private_site: true, geo_ip_enabled: false, notification_enabled: false, eula_accepted: true } })
  assert.equal(settings.response.status, 200)
  assert.equal(settings.json?.status, 'success')
  const auth = { Authorization: `Bearer ${apiKey}` }
  const savedKeyCheck = await request('/api/admin/client/list', { headers: { ...auth, Origin: 'tauri://localhost' } })
  assert.equal(savedKeyCheck.response.status, 200)
  assert.equal(savedKeyCheck.response.headers.get('access-control-allow-origin'), 'tauri://localhost')
  stage = 'create synthetic node through official authenticated API'
  const created = await request('/api/admin/client/add', { headers: auth, body: { name: 'shellbeam-contract-node' } })
  assert.equal(created.response.status, 200)
  assert.equal(typeof created.data.uuid, 'string')
  assert.equal(typeof created.data.token, 'string')
  const nodeId = created.data.uuid
  const agentToken = created.data.token
  const checked = (name) => checks.push({ name, passed: true })
  const api = async (path, body) => {
    const wire = await request(path, { headers: auth, ...(body === undefined ? {} : { body }) })
    if (['/api/admin/upload/merge', '/api/admin/plugin/enabled'].includes(path) && wire.response.status !== 200) console.error(JSON.stringify({ archiveDiagnostic: wire.json?.message }))
    assert.equal(wire.response.status, 200, `HTTP ${wire.response.status}`)
    assert.equal(wire.json?.error, undefined)
    return wire.data
  }
  const base = '/api/shellbeam-alerts/v1'
  const rpc = async (method, params = {}) => { const r = await api('/api/rpc2', { jsonrpc: '2.0', id: 1, method, params }); return r.result ?? r }
  assert.ok(Array.isArray(await rpc('admin:getAllPingTasks')))
  const scriptChannel = await api('/api/admin/notification/channel/configuration?id=Javascript')
  assert.ok(scriptChannel.configuration.data.some(f => f.key === 'script' && f.type === 'richtext'))
  await api('/api/admin/notification/channel/configuration', { id: 'Javascript', data: { ...scriptChannel.data, script: '// isolated non-executed configuration', futureField: 'preserved-script' } })
  assert.equal((await api('/api/admin/notification/channel/configuration?id=Javascript')).data.futureField, 'preserved-script')
  checked('built-in script channel schema write/read and ping selector discovery')
  const clients = await api('/api/admin/client/list')
  const originalNode = clients.find(c => c.uuid === nodeId)
  assert.ok(originalNode?.created_at)
  stage = 'verify an installed managed plugin channel'
  const fixtureZip = new JSZip()
  fixtureZip.file('komari-plugin.json', JSON.stringify({ short: 'shellbeam-channel-fixture', name: 'Synthetic channel', version: '0.0.1', komari: '1.6.0', entry: 'main.js' }))
  const declaration = { type: 'managed', name: 'Synthetic channel', data: [{ key: 'token', name: 'Token', type: 'string' }, { key: 'nodes', name: 'Nodes', type: 'nodes' }, { key: 'tasks', name: 'Tasks', type: 'pingtasks' }, { key: 'mode', name: 'Mode', type: 'select', options: 'json,text' }] }
  fixtureZip.file('main.js', `const server = require('server'); function load(){ server.registerNotificationChannel('shellbeam-fixture', ${JSON.stringify(declaration)}, function(){}); }`)
  const fixtureBytes = await fixtureZip.generateAsync({ type: 'nodebuffer' })
  const fixtureUpload = await api('/api/admin/upload/init', { purpose: 'plugin', filename: 'fixture.zip', size: fixtureBytes.length })
  const fixtureForm = new FormData(); fixtureForm.append('upload_id', fixtureUpload.upload_id); fixtureForm.append('chunk_index', '0'); fixtureForm.append('chunk_data', new Blob([fixtureBytes]), 'fixture.zip')
  assert.equal((await fetch(`${endpoint}/api/admin/upload/chunk`, { method: 'POST', headers: auth, body: fixtureForm })).status, 200)
  await api('/api/admin/upload/merge', { upload_id: fixtureUpload.upload_id })
  await api('/api/admin/plugin/enabled', { short: 'shellbeam-channel-fixture', enabled: true, approved: true })
  const pluginConfig = await api('/api/admin/notification/channel/configuration?id=shellbeam-fixture')
  assert.equal(pluginConfig.configuration.data[1].type, 'nodes')
  await api('/api/admin/notification/channel/configuration', { id: 'shellbeam-fixture', data: { ...pluginConfig.data, token: 'synthetic-only', nodes: JSON.stringify([nodeId]), tasks: '[]', mode: 'text', future: { retained: true } } })
  const pluginReadback = await api('/api/admin/notification/channel/configuration?id=shellbeam-fixture')
  assert.deepEqual(pluginReadback.data.nodes, [nodeId]); assert.deepEqual(pluginReadback.data.tasks, []); assert.deepEqual(pluginReadback.data.future, { retained: true }); assert.equal(pluginReadback.data.mode, 'text')
  checked('installed plugin channel schema and selector encoding preserve readback and unknown fields')
  stage = 'upload app-bundled extension'
  const archive = await readFile(join(project, 'src-tauri/resources/monitoring-extension.zip'))
  const upload = await api('/api/admin/upload/init', { purpose: 'plugin', filename: 'shellbeam-alerts.zip', size: archive.length })
  const form = new FormData(); form.append('upload_id', upload.upload_id); form.append('chunk_index', '0'); form.append('chunk_data', new Blob([archive]), 'shellbeam-alerts.zip')
  const chunk = await fetch(`${endpoint}/api/admin/upload/chunk`, { method: 'POST', headers: auth, body: form }); assert.equal(chunk.status, 200)
  stage = 'merge uploaded extension'
  await api('/api/admin/upload/merge', { upload_id: upload.upload_id })
  stage = 'check unapproved extension enable'
  const notApproved = await api('/api/admin/plugin/enabled', { short: 'shellbeam-alerts', enabled: true })
  assert.equal(notApproved.requires_approval, true)
  stage = 'enable approved extension'
  await api('/api/admin/plugin/enabled', { short: 'shellbeam-alerts', enabled: true, approved: true })
  stage = 'verify running extension'
  const plugin = (await api('/api/admin/plugin/list')).find(p => p.short === 'shellbeam-alerts')
  assert.equal(plugin.running, true)
  for (const name of ['komari-plugin.json', 'policy.cjs', 'server.cjs']) {
    const file = await fetch(`${endpoint}/api/admin/plugin/shellbeam-alerts/${name}`, { headers: auth }); assert.equal(file.status, 200)
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), await readFile(join(project, 'monitoring-extension', name)))
  }
  checked('bundled bytes and explicit permission approval')
  stage = 'authenticate every extension route'
  for (const path of ['/policy', '/status']) { const status = (await request(base + path)).response.status; console.log(JSON.stringify({ unauthenticatedPath: path, status })); assert.ok([401, 403].includes(status)) }
  assert.ok([401, 403].includes((await request(base + '/policy', { body: {} })).response.status))
  await api('/api/admin/settings/', { private_site: false })
  for (const path of ['/policy', '/status']) assert.equal((await request(base + path)).response.status, 403)
  assert.equal((await request(base + '/policy', { body: {} })).response.status, 403)
  await api('/api/admin/settings/', { private_site: true })
  checked('unauthenticated reads and writes rejected on private and public sites')
  stage = 'create rule and test compare-and-swap'
  const empty = await api(base + '/policy')
  const rule = { id: 'synthetic-rule', name: 'Synthetic CPU', nodeId, nodeCreatedAt: originalNode.created_at, metric: 'cpu', threshold: 20, recovery: 10, durationSeconds: 0, recoverySeconds: 0, enabled: true }
  let policy = await api(base + '/policy', { ...empty, rules: [rule] })
  assert.equal(policy.rules.length, 1); assert.equal(policy.revision, empty.revision + 1)
  assert.equal((await request(base + '/policy', { headers: auth, body: { ...empty, rules: [rule] } })).response.status, 409)
  assert.equal((await request(base + '/policy', { headers: auth, body: { ...policy, rules: [{ ...rule, nodeCreatedAt: 'recreated' }] } })).response.status, 409)
  assert.deepEqual(await api(base + '/policy'), policy)
  checked('rule readback and stale/recreated-node writes rejected')
  stage = 'configure independent notification receiver'
  receiver = createHttpServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy() })
    req.on('end', () => { try { const data = JSON.parse(body); if (typeof data.event === 'string' && data.event.includes('ShellBeamLoad')) delivered.push(data.event) } catch {} res.writeHead(200); res.end('ok') })
  })
  await new Promise(done => receiver.listen(0, '127.0.0.1', done))
  const channel = await api('/api/admin/notification/channel/configuration?id=webhook')
  await api('/api/admin/notification/channel/configuration', { id: 'webhook', data: { ...channel.data, url: `http://127.0.0.1:${receiver.address().port}/receipt`, method: 'POST', body: '{"event":"{{title}}"}', futureField: 'keep-me' } })
  const savedChannel = await api('/api/admin/notification/channel/configuration?id=webhook')
  assert.equal(savedChannel.data.futureField, 'keep-me')
  await api('/api/admin/settings/', { notification_enabled: false, notification_method: 'webhook', notification_template: '{{message}}' })
  const report = async cpu => {
    const sent = await request('/api/clients/v2/rpc', { body: { token: agentToken, jsonrpc: '2.0', id: 1, method: 'agent.report', params: { report: { cpu: { usage: cpu }, ram: { total: 8192, used: 4096 }, swap: { total: 0, used: 0 }, disk: { total: 100000, used: 20000 }, load: { load1: 0.5, load5: 0.3, load15: 0.2 }, network: { up: 1, down: 1, totalUp: 1, totalDown: 1 }, connections: { tcp: 2, udp: 1 }, uptime: 3600, process: 5 } } } })
    assert.equal(sent.response.status, 200); assert.equal(sent.json?.error, undefined)
  }
  stage = 'disabled service channel never reports delivery'
  await report(30)
  await waitFor(async () => (await api(base + '/status')).events.some(e => e.delivery === 'channel-disabled'), 45000)
  assert.equal(delivered.length, 0)
  assert.equal((await api(base + '/status')).evaluations[rule.id].notified, false)
  checked('globally disabled notifications preserve active incident without marking sent')
  await api('/api/admin/settings/', { notification_enabled: true })
  stage = 'server-only load notification delivery'
  await delay(1100); await report(30)
  await waitFor(async () => delivered.some(x => x.includes('ShellBeamLoad')), 45000)
  const fired = await api(base + '/status'); assert.equal(fired.evaluations[rule.id].firing, true)
  assert.ok(fired.events.some(e => e.kind === 'firing' && e.delivery === 'service-accepted'))
  checked('fresh raw report fired and independent receiver received load notification')
  stage = 'server-only recovery delivery'
  await delay(1100); await report(5)
  await waitFor(async () => delivered.some(x => x.includes('ShellBeamLoadRecovered')), 45000)
  checked('fresh recovery report delivered recovery notification')
  stage = 'one-time silence preserves alert fact and suppresses delivery'
  policy = await api(base + '/policy', { ...policy, silences: [{ id: 'silence-1', name: 'Synthetic maintenance', enabled: true, ruleIds: [rule.id], kind: 'once', startAt: Date.now() - 1000, endAt: Date.now() + 120000 }] })
  const count = delivered.length
  await delay(1100); await report(35)
  await waitFor(async () => (await api(base + '/status')).evaluations[rule.id]?.status === 'silenced', 45000)
  assert.equal(delivered.length, count)
  assert.ok((await api(base + '/status')).events.some(e => e.kind === 'firing' && e.suppressed))
  checked('silence suppressed delivery without resolving the alert')
  stage = 'restart retains schedules and does not replay notifications'
  const beforeRestart = await api(base + '/status')
  await stop(); stopped = false
  child = spawn(binary, ['server', '--listen', `127.0.0.1:${port}`, '--database', join(root, 'primary.db')], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'UTC' }, stdio: ['ignore', log.fd, log.fd] })
  child.once('error', () => { stopped = true }); child.once('close', () => { stopped = true })
  await waitFor(async () => (await api(base + '/policy')).extension_identity === policy.extension_identity)
  assert.deepEqual(await api(base + '/policy'), policy)
  await delay(17000)
  assert.equal(delivered.length, count)
  assert.deepEqual((await api(base + '/status')).events, beforeRestart.events)
  checked('server restart retained policy and dispatch markers without replay')
  stage = 'end silence requires a new observation before notification'
  policy = await api(base + '/policy', { ...policy, silences: policy.silences.map(s => ({ ...s, endAt: Date.now() - 1 })) })
  await delay(1100); await report(40)
  await waitFor(async () => delivered.length > count, 45000)
  checked('new fresh sample after silence delivered current incident')
  stage = 'existing node key channel and history retained'
  const retainedToken = await rpc('admin:getClientToken', { uuid: nodeId }); assert.equal(retainedToken.token ?? retainedToken, agentToken)
  assert.equal((await api('/api/admin/client/list')).find(c => c.uuid === nodeId).created_at, originalNode.created_at)
  assert.equal((await api('/api/admin/notification/channel/configuration?id=webhook')).data.futureField, 'keep-me')
  const finalState = await api(base + '/status')
  checked('node identity token and unknown channel fields retained')
  assert.equal(delivered.length, 3)
  resultReport = { result: 'passed', version: '1.6.0', checks, notificationsReceived: delivered.length, rawSamples: finalState.events.map(e => ({ kind: e.kind, sampledAt: e.sampledAt, suppressed: e.suppressed, delivery: e.delivery })), scope: 'extension-load-notifications', productionAppCoordinator: false, sourceCommit: process.env.GITHUB_SHA ?? null }
  console.log(JSON.stringify({ result: 'passed', checks: checks.length, notificationsReceived: delivered.length }))
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', stage, frames: String(error.stack).split('\n').filter(x => x.trim().startsWith('at ')).slice(0, 5), completed: checks.map(c => c.name) })); process.exitCode = 1
} finally {
  const didStop = await stop(); if (receiver) await new Promise(done => receiver.close(done)); await log.close()
  if (didStop) await rm(root, { recursive: true, force: true }); else process.exitCode = 1
  resultReport.cleanup = didStop; resultReport.serverStopped = stopped
  await writeFile(reportPath, JSON.stringify(resultReport, null, 2))
  console.log(JSON.stringify({ cleanup: didStop, serverStopped: stopped }))
}
