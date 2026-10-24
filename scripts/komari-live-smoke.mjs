#!/usr/bin/env node
/** Explicit upstream contract smoke. Pass an unmodified official Komari 1.6.0
 * binary built for this OS. It creates and removes its own private instance;
 * it never reads an existing database or installs a user/system service. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { open, mkdtemp, chmod, realpath, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--binary') {
  console.error('Usage: node scripts/komari-live-smoke.mjs --binary /absolute/path/to/official-komari-1.6.0')
  process.exit(2)
}
const binary = await realpath(args[1])
const root = await mkdtemp(join(tmpdir(), 'shellbeam-komari-contract-'))
await chmod(root, 0o700)
const log = await open(join(root, 'server.log'), 'wx', 0o600)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let stage = 'allocate loopback listener'
const observed = { nodes: 0, recent: 0, history: 0, historyStatus: 0, serverHistory: 0, fineHistory: 0 }
let child
let stopped = false
let vite
let receiver
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
  stage = 'ingest two synthetic agent reports through official v2 RPC'
  for (const cpu of [10, 25]) {
    const report = await request('/api/clients/v2/rpc', { body: { token: agentToken, jsonrpc: '2.0', id: cpu, method: 'agent.report', params: { report: { cpu: { usage: cpu }, ram: { total: 8192, used: 4096 }, swap: { total: 0, used: 0 }, disk: { total: 100000, used: 20000 }, load: { load1: 0.5, load5: 0.3, load15: 0.2 }, network: { up: 2048, down: 1024, totalUp: 20480, totalDown: 10240 }, connections: { tcp: 2, udp: 1 }, uptime: 3600, process: 5 } } } })
    assert.equal(report.response.status, 200)
    assert.equal(report.json?.error, undefined)
    await delay(1100)
  }
  stage = 'load unchanged production TypeScript adapters'
  vite = await createViteServer({ root: project, server: { middlewareMode: true }, logLevel: 'silent' })
  const adapter = await vite.ssrLoadModule('/src/lib/komari.ts')
  const providerModule = await vite.ssrLoadModule('/src/lib/komari-probe-provider.ts')
  const config = { endpoint, token: apiKey }
  stage = 'validate real version, node mapping, recent and stored history contracts'
  const version = await adapter.getKomariServerVersion(config)
  assert.equal(version.version, '1.6.0')
  assert.equal(version.apiKeySupported, true)
  stage = 'validate actual node discovery'
  const nodes = await adapter.listKomariClients(config)
  observed.nodes = nodes.length
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].uuid, nodeId)
  assert.equal(nodes[0].name, 'shellbeam-contract-node')
  stage = 'validate native metadata adapter writes and external edits'
  const metadata = await vite.ssrLoadModule('/src/lib/host-metadata-sync.ts')
  const initialMetadata = await metadata.readRemoteHostMetadata(config, nodeId)
  const desired = { name: 'native-profile-edit', group: 'staging', tags: ['web', 'test'] }
  await metadata.writeRemoteHostMetadata(config, { nodeId, remote: initialMetadata.values, desired })
  const afterNativeEdit = await metadata.readRemoteHostMetadata(config, nodeId)
  assert.deepEqual(afterNativeEdit.values, desired)
  assert.equal(afterNativeEdit.identity, initialMetadata.identity)
  const externalEdit = await request(`/api/admin/client/${encodeURIComponent(nodeId)}/edit`, { headers: auth, body: { name: 'external-profile-edit' } })
  assert.equal(externalEdit.response.status, 200)
  const afterExternalEdit = await metadata.readRemoteHostMetadata(config, nodeId)
  assert.deepEqual(afterExternalEdit.values, { ...desired, name: 'external-profile-edit' })
  await metadata.writeRemoteHostMetadata(config, { nodeId, remote: afterExternalEdit.values, desired: initialMetadata.values })
  assert.deepEqual((await metadata.readRemoteHostMetadata(config, nodeId)).values, initialMetadata.values)
  stage = 'validate native offline rule read/write/readback contract'
  const rules = await vite.ssrLoadModule('/src/lib/host-notification-rules.ts')
  const ruleBefore = await rules.readOfflineRule(config, nodeId)
  await rules.writeOfflineRule(config, nodeId, { enabled: false, gracePeriod: 90 })
  const ruleAfter = await rules.readOfflineRule(config, nodeId)
  assert.deepEqual(ruleAfter.rule, { enabled: false, gracePeriod: 90 })
  assert.equal(ruleAfter.identity, ruleBefore.identity)
  // Global notifications are disabled in this synthetic server; no real channel
  // is configured. Verify toggles without sending any test message.
  await rules.writeOfflineRule(config, nodeId, { enabled: true, gracePeriod: 120 })
  assert.deepEqual((await rules.readOfflineRule(config, nodeId)).rule, { enabled: true, gracePeriod: 120 })
  const externalRuleEdit = await request('/api/admin/notification/offline/edit', { headers: auth, body: [{ client: nodeId, enable: false, grace_period: 180 }] })
  assert.equal(externalRuleEdit.response.status, 200)
  assert.deepEqual((await rules.readOfflineRule(config, nodeId)).rule, { enabled: false, gracePeriod: 180 })
  stage = 'validate actual recent reports'
  const recent = await adapter.getKomariRecentRecords(config, nodeId)
  observed.recent = recent.length
  assert.ok(recent.length >= 2)
  assert.ok(recent.some((record) => record.cpu?.usage === 25))
  stage = 'validate actual stored history'
  const history = await waitFor(async () => { const wire = await request(`/api/records/load?uuid=${encodeURIComponent(nodeId)}&load_type=all&hours=24`, { headers: auth }); observed.historyStatus = wire.response.status; observed.serverHistory = Array.isArray(wire.data?.records) ? wire.data.records.length : -1; const fine = await adapter.getKomariHistoryRecords(config, nodeId, { hours: 1 }); observed.fineHistory = fine.length; const records = await adapter.getKomariHistoryRecords(config, nodeId, { hours: 24 }); observed.history = records.length; await delay(500); return records.length >= 1 ? records : null })
  // The official 24h endpoint aggregates into >=1-minute buckets. Two
  // immediate reports can legitimately produce one stored aggregate. Check
  // its real values/time rather than assuming one history row per report.
  assert.ok(history.every((record) => { const sampledAt = adapter.komariRecordSampleTime(record); return typeof record.cpu === 'number' && record.cpu >= 10 && record.cpu <= 25 && sampledAt !== null && sampledAt <= Date.now() && sampledAt >= Date.now() - 24 * 3600000 }))
  const host = { id: 'smoke-local-host', name: nodes[0].name, address: '192.0.2.10', port: 22, username: 'ops', authType: 'password', tags: [], group: 'Test', createdAt: 1, updatedAt: 1 }
  const observations = []
  const provider = providerModule.createKomariProbeProvider({ endpoint, id: 'smoke-local-integration', nodeForHost: () => nodes[0], client: { fetchRecentRecords: () => adapter.getKomariRecentRecords(config, nodeId), fetchHistoryRecords: () => adapter.getKomariHistoryRecords(config, nodeId, { hours: 24 }) }, onHistory: (points) => observations.push(...points) })
  stage = 'validate actual provider metrics'
  const snapshot = await provider.probe({ host, resolveAuthSecret: async () => '' })
  assert.equal(snapshot.health, 'online')
  assert.equal(snapshot.metrics?.data.cpuPercent, 25)
  assert.equal(snapshot.metrics?.data.memoryPercent, 50)
  assert.equal(snapshot.metrics?.data.diskPercent, 20)
  assert.ok(observations.length >= 2)
  assert.ok(observations.every((point) => point.freshness.sampledAt <= point.freshness.receivedAt))
  stage = 'verify metric retention writes and readback'
  const definitions = await request('/api/rpc2', { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'admin:listMetricDefinitions', params: {} } })
  const metrics = definitions.json?.result
  assert.ok(Array.isArray(metrics) && metrics.length > 0)
  const metric = metrics.find(item => typeof item.name === 'string' && Number.isInteger(item.retention_days))
  assert.ok(metric)
  const retentionDays = metric.retention_days === 30 ? 31 : 30
  const retained = await request('/api/rpc2', { headers: auth, body: { jsonrpc: '2.0', id: 2, method: 'admin:updateMetricDefinition', params: { name: metric.name, retention_days: retentionDays } } })
  assert.equal(retained.response.status, 200)
  assert.equal(retained.json?.error, undefined)
  const readback = await request('/api/rpc2', { headers: auth, body: { jsonrpc: '2.0', id: 3, method: 'admin:listMetricDefinitions', params: {} } })
  assert.equal(readback.json.result.find(item => item.name === metric.name)?.retention_days, retentionDays)
  stage = 'configure a synthetic local notification receiver'
  receiver = createHttpServer((req, res) => {
    let body = ''
    req.on('data', data => { body += data; if (body.length > 65536) req.destroy() })
    req.on('end', () => {
      try { const message = JSON.parse(body); if (req.method === 'POST' && req.url === '/receipt' && ['Test', 'Offline', 'Online'].includes(message.event)) delivered.push(message.event) } catch { /* invalid test delivery is never evidence */ }
      res.writeHead(200); res.end('ok')
    })
  })
  await new Promise((done, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', done) })
  const currentChannel = await request('/api/admin/notification/channel/configuration?id=webhook', { headers: auth })
  const channel = { ...currentChannel.data.data, url: `http://127.0.0.1:${receiver.address().port}/receipt`, method: 'POST', body: '{"event":"{{title}}","message":"{{message}}"}' }
  assert.equal((await request('/api/admin/notification/channel/configuration', { headers: auth, body: { id: 'webhook', data: channel } })).response.status, 200)
  assert.deepEqual((await request('/api/admin/notification/channel/configuration?id=webhook', { headers: auth })).data.data, channel)
  assert.equal((await request('/api/admin/settings/', { headers: auth, body: { notification_enabled: true, notification_method: 'webhook', login_notification: false } })).response.status, 200)
  assert.equal((await request('/api/admin/test/sendMessage', { headers: auth, body: {} })).response.status, 200)
  await waitFor(() => delivered.includes('Test'), 10000)
  await rules.writeOfflineRule(config, nodeId, { enabled: true, gracePeriod: 1 })
  const reportAgain = () => request('/api/clients/v2/rpc', { body: { token: agentToken, jsonrpc: '2.0', id: 4, method: 'agent.report', params: { report: { cpu: { usage: 30 }, ram: { total: 8192, used: 4096 }, disk: { total: 100000, used: 20000 }, uptime: 3605 } } } })
  assert.equal((await reportAgain()).json?.error, undefined)
  stage = 'verify real HTTP Agent presence expiry and offline delivery'
  // Official 1.6 uses a 35-second POST presence TTL. Do not fabricate events,
  // change server clocks, or write its notification database to bypass it.
  await waitFor(() => delivered.includes('Offline'), 50000)
  assert.equal(delivered.filter(event => event === 'Offline').length, 1)
  stage = 'verify fresh Agent report and service recovery delivery'
  assert.equal((await reportAgain()).json?.error, undefined)
  await waitFor(() => delivered.includes('Online'), 10000)
  assert.equal(delivered.filter(event => event === 'Online').length, 1)
  assert.equal(delivered.filter(event => event === 'Test').length, 1)
  assert.equal((await request('/api/admin/settings/', { headers: auth, body: { notification_enabled: false } })).response.status, 200)
  stage = 'validate real unauthorized adapter error contracts'
  await assert.rejects(() => adapter.requestKomari({ endpoint, token: 'invalid-test-token' }, { path: '/api/admin/client/list' }), (error) => error.code === 'permission' && [401, 403].includes(error.status))
  await assert.rejects(() => adapter.listKomariClients({ endpoint, token: 'invalid-test-token' }), (error) => error.code === 'permission')
  stage = 'validate authorization CORS headers from desktop origin'
  const cors = await request('/api/admin/client/list', { headers: { ...auth, Origin: 'tauri://localhost' } })
  assert.equal(cors.response.status, 200)
  assert.equal(cors.response.headers.get('access-control-allow-origin'), 'tauri://localhost')
  const preflight = await request('/api/admin/client/list', { method: 'OPTIONS', headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
  assert.equal(preflight.response.status, 204)
  stage = 'complete'
  console.log(JSON.stringify({ result: 'passed', serverVersion: version.version, serverHash: version.hash, serverKeySaveVerified: true, metadataWriteReadback: true, externalMetadataReadback: true, offlineRuleWriteReadback: true, externalOfflineRuleReadback: true, retentionReadback: true, notificationReceipts: delivered, nodes: nodes.length, recentRecords: recent.length, storedHistoryRecords: history.length, wideWindowRecords: observed.serverHistory, fineWindowRecords: observed.fineHistory, importedObservations: observations.length, unauthorized: 'permission', origin: 'tauri://localhost', scope: 'isolated-loopback-synthetic-report-contract' }))
} catch {
  // Never dump request/response bodies or upstream logs: they can contain temporary secrets.
  console.error(`Komari live contract smoke failed during: ${stage}; counts=${JSON.stringify(observed)}`)
  process.exitCode = 1
} finally {
  try { await vite?.close() } catch { process.exitCode = 1 }
  if (receiver) await new Promise(resolve => receiver.close(resolve))
  const exited = await stop()
  await log.close()
  if (exited) await rm(root, { recursive: true, force: true })
  else { console.error(`Unable to confirm isolated server stopped; private state retained at ${root}`); process.exitCode = 1 }
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
}
