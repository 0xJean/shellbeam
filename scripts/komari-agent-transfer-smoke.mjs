#!/usr/bin/env node
/** Opt-in isolated two-machine/container SSH + real systemd contract. Synthetic
 * credentials only; the production helper is sent unchanged over pinned SSH. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadPinned } from './prepare-komari-agent-release.mjs'
import { verifyCompatibleCatalog } from './publish-komari-agent.mjs'
import { transferHistory } from './probe-transfer-history.mjs'
if (process.env.SHELLBEAM_KOMARI_TRANSFER_SMOKE !== '1') throw new Error('explicit_isolated_transfer_opt_in_required')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'shellbeam-probe-transfer-')); const prefix = 'sb-transfer-' + randomBytes(5).toString('hex')
const network = prefix + '-net'; const machines = [prefix + '-a', prefix + '-b']; const deployments = []
const report = { result: 'running', sourceCommit: process.env.GITHUB_SHA ?? null, checks: [], freshReports: [], remoteChecks: [], cleanup: false, serverStopped: false }
let stage = 'create isolated machines'; const delay = ms => new Promise(r => setTimeout(r, ms)); const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const command = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }).trim()
const docker = (...args) => command('docker', args)
const wait = async (fn, timeout = 60000) => { const until = Date.now() + timeout; while (Date.now() < until) { try { const r = await fn(); if (r) return r } catch { /* bounded readiness only */ } await delay(500) } throw new Error('bounded_read_timeout') }
const rawHelper = await readFile(join(project, 'src-tauri/src/data/komari_agent/remote.py'), 'utf8'); const helper = "python3 -I -c '" + rawHelper.replaceAll("'", "'\\''") + "'"
const pins = JSON.parse(await readFile(join(project, 'scripts/fixtures/komari-lifecycle-releases.json')))
const legacyPins = JSON.parse(await readFile(join(project, 'releases/compatible-probe-pins.json'))).versions
const key = join(dir, 'id'); const configPath = join(dir, 'ssh-config')
async function remote(end, action, extra = {}) {
  const request = { deployment: end.deployment, legacyPins, action, ...extra }
  const result = await new Promise((done, reject) => {
    const p = spawn('ssh', ['-F', configPath, end.ssh, helper], { stdio: ['pipe', 'pipe', 'ignore'] }); let out = Buffer.alloc(0)
    const timer = setTimeout(() => { p.kill(); reject(new Error('ssh_timeout')) }, 120000)
    p.stdout.on('data', b => { out = Buffer.concat([out, b]); if (out.length > 131072) p.kill() }); p.stdin.on('error', () => {})
    p.once('error', () => { clearTimeout(timer); reject(new Error('ssh_spawn')) }); p.once('close', code => { clearTimeout(timer); try { assert.equal(code, 0); done(JSON.parse(out)) } catch { reject(new Error('ssh_response')) } }); p.stdin.end(JSON.stringify(request))
  })
  report.remoteChecks.push({ action, ok: result.ok, code: result.code, role: end.ssh, status: result.state?.status, active: result.state?.active })
  return result
}
const inspect = async end => { const r = await remote(end, 'inspect'); assert.equal(r.ok, true); return r }
const mutate = async (end, action, extra = {}) => { const before = await inspect(end); return remote(end, action, { identity: before.identity, expected: before.state, job: randomUUID(), ...extra }) }
const canonical = config => JSON.stringify(config, Object.keys(config).sort())
let artifact
try {
  const image = process.env.SHELLBEAM_TRANSFER_IMAGE ?? 'shellbeam-probe-transfer-fixture:local'
  docker('network', 'create', network)
  for (const name of machines) {
    docker('run', '-d', '--name', name, '--hostname', name, '--network', network, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--memory', '768m', '--cpus', '1', '--pids-limit', '512', '-p', '127.0.0.1::22', '-p', '127.0.0.1::25700', image)
    await wait(() => docker('exec', name, 'systemctl', 'is-active', 'ssh') === 'active')
    docker('exec', name, 'loginctl', 'enable-linger', 'probe'); docker('exec', name, 'systemctl', 'start', `user@${docker('exec', name, 'id', '-u', 'probe')}.service`)
  }
  stage = 'prepare pinned SSH routes and account identity'
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]); const pub = await readFile(key + '.pub')
  for (const name of machines) {
    docker('exec', name, 'mkdir', '-p', '/root/.ssh', '/home/probe/.ssh', '/opt/fixture')
    command('docker', ['exec', '-i', name, 'tee', '/root/.ssh/authorized_keys'], pub)
    command('docker', ['exec', '-i', name, 'tee', '/home/probe/.ssh/authorized_keys'], pub)
    docker('exec', name, 'chown', '-R', 'probe:probe', '/home/probe/.ssh'); docker('exec', name, 'chmod', '700', '/root/.ssh', '/home/probe/.ssh')
  }
  const ports = machines.map(n => docker('port', n, '22').split(':').at(-1)); const apiPorts = machines.map(n => docker('port', n, '25700').split(':').at(-1))
  const targetIP = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', machines[1])
  const known = join(dir, 'known_hosts'); await writeFile(known, machines.map((n, i) => `machine-${i} ${docker('exec', n, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')}`).join('\n') + '\n', { mode: 0o600 })
  await writeFile(configPath, `Host *\n IdentityFile ${key}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${known}\n ConnectTimeout 10\nHost source\n HostName 127.0.0.1\n Port ${ports[0]}\n User probe\n HostKeyAlias machine-0\nHost target\n HostName ${targetIP}\n Port 22\n User probe\n HostKeyAlias machine-1\n ProxyJump source\nHost target-root\n HostName ${targetIP}\n Port 22\n User root\n HostKeyAlias machine-1\n ProxyJump source\n`, { mode: 0o600 })
  assert.equal(command('ssh', ['-F', configPath, 'target', 'id -u']), docker('exec', machines[1], 'id', '-u', 'probe'));  assert.equal(command('ssh', ['-F', configPath, 'target-root', 'id -u']), '0')
  report.checks.push('pinned-direct-and-proxyjump-two-accounts')
  const machineIds = machines.map(n => docker('exec', n, 'cat', '/etc/machine-id')); assert.notEqual(machineIds[0], machineIds[1]); report.machineIdentitiesDistinct = true
  const architecture = docker('exec', machines[0], 'uname', '-m') === 'aarch64' ? 'arm64' : 'amd64'; report.architecture = architecture
  stage = 'verify production release and fixed official servers'
  const root = JSON.parse(await readFile(join(project, 'src-tauri/src/data/komari_agent/official-trust.json')))
  const catalog = verifyCompatibleCatalog(JSON.parse(await downloadPinned(root.catalogUrl, null, 65536)), root); const manifest = catalog.artifacts.find(a => a.architecture === architecture)
  const pin = pins.agents.find(a => a.version === manifest.version)[architecture]; assert.equal(manifest.sha256, pin.sha256)
  artifact = { manifest, bytes: await downloadPinned(manifest.url, pin) }; report.productionRelease = { keyId: root.keyId, sequence: catalog.sequence, version: manifest.version, signatureVerified: true, bytesVerified: true, noUserConfiguration: true }
  stage = 'download fixed official server'
  const serverBytes = await downloadPinned(`https://github.com/komari-monitor/komari/releases/download/${pins.server.version}/komari-linux-${architecture}`, pins.server[architecture], 64 * 1024 * 1024)
  const serverFile = join(dir, 'server'); await writeFile(serverFile, serverBytes, { mode: 0o700 })
  const servers = []
  for (let i = 0; i < 2; i++) {
    stage = 'initialize isolated monitoring service ' + i
    const name = machines[i]; docker('cp', serverFile, name + ':/opt/fixture/server')
    docker('exec', '-d', name, '/opt/fixture/server', 'server', '--listen', '0.0.0.0:25700', '--database', '/opt/fixture/primary.db')
    const local = `http://127.0.0.1:${apiPorts[i]}`; const endpoint = `http://${name}:25700`; const apiKey = randomBytes(32).toString('hex')
    const request = async (path, body, headers = { Authorization: `Bearer ${apiKey}` }) => { const r = await fetch(local + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) }); if(r.status!==200) { report.startupHttpResponses ??= []; if(report.startupHttpResponses.length < 32) report.startupHttpResponses.push({ path, status:r.status }) }; assert.equal(r.status, 200); const v = await r.json(); return { response: r, value: v, data: v.data ?? v.result ?? v } }
    await wait(async () => (await request('/api/install/status')).data.required === true)
    const username = 'fixture'; const password = 'Sb1' + randomBytes(24).toString('hex')
    await request('/api/install/complete', { username, password, sitename: 'Isolated transfer test', metric_dsn: '/opt/fixture/metrics.db' })
    await wait(async () => (await request('/api/version')).data.version === '1.6.0')
    const login = await request('/api/login', { username, password }); const cookie = login.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
    await request('/api/admin/settings', { api_key: apiKey, private_site: true, geo_ip_enabled: false, notification_enabled: false, eula_accepted: true }, { Cookie: cookie, Origin: local })
    const created = (await request('/api/admin/client/add', { name: `transfer-${i}` })).data
    const rpc = async method => (await request('/api/rpc2', { jsonrpc: '2.0', id: 1, method, params: { uuid: created.uuid } })).value.result
    const original = await rpc('admin:getClient')
    const latest = v => Array.isArray(v) ? Math.max(0, ...v.map(latest)) : !v || typeof v !== 'object' ? 0 : ['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some(k => k in v) ? Date.parse(v.time ?? v.updated_at ?? '') || 0 : Math.max(0, ...['records', 'reports', 'data', 'result'].map(k => latest(v[k])))
    servers.push({ history: transferHistory(request, created.uuid, wait), endpoint, token: created.token, node: created.uuid, rpc, original, mark: async () => latest((await request(`/api/recent/${created.uuid}`)).value) })
  }
  assert.notEqual(servers[0].token, servers[1].token)
  const fresh = async (end, before, started) => wait(async () => {
    const s = servers[end.server]; const node = await s.rpc('admin:getClient'); const t = await s.mark(); const now = Date.now()
    if (!(node.uuid === s.node && node.created_at === s.original.created_at && node.version?.replace(/^v/, '') === artifact.manifest.version && t > before && t >= started - 5000 && t <= now + 5000 && t >= now - 60000)) return false
    const r = await inspect(end); if (!r.state.active || r.state.current?.sha256 !== artifact.manifest.sha256) return false
    const verifiedAt = Date.now(); await s.history.capture()
    report.freshReports.push({ scope: end.ssh, server: end.server, nodeIdentityVerified: true, originalSampleAt: t, before, started, verifiedAt, processSha256: artifact.manifest.sha256 }); return true
  })
  const end = (ssh, server) => { const e = { ssh, server, deployment: randomUUID() }; deployments.push(e); return e }
  const base = { disable_auto_update: true, disable_web_ssh: true, interval: 5, info_report_interval: 1, month_rotate: 0, get_ip_addr_from_nic: true, include_nics: 'lo' }
  const config = e => ({ ...base, endpoint: servers[e.server].endpoint, token: servers[e.server].token })
  let current = end('source', 0); let before = await servers[0].mark(); let started = Date.now()
  const installed = await mutate(current, 'install', { release: artifact.manifest, bytes: artifact.bytes.toString('base64'), configuration: config(current) }); assert.equal(installed.ok, true); await fresh(current, before, started)
  report.checks.push('source-install-production-process-and-fresh-report')
  const saved = new Map()
  const saveSource = async e => { const r = await inspect(e); saved.set(e.deployment, { root: r.identity.root, bytes: command('ssh', ['-F', configPath, e.ssh, `cat '${r.identity.root}/config.json'`]), sha: r.state.configSha256 }); return r }
  const move = async (source, target, label, fail = false) => {
    stage = label; const original = await saveSource(source); const transferId = randomUUID()
    const exported = await remote(source, 'export-settings', { identity: original.identity, expected: original.state, agentToken: servers[source.server].token }); assert.equal(exported.ok, true); assert.equal(exported.settings.include_nics, 'lo'); assert.equal(exported.settings.token, undefined)
    const reserve = await mutate(source, 'transfer-reserve', { transferId }); assert.equal(reserve.ok, true)
    const targetConfig = { ...exported.settings, endpoint: servers[target.server].endpoint, token: servers[target.server].token, disable_auto_update: true, disable_web_ssh: true }
    if (fail) report.faultInjection = 'Non-executable target bytes at the helper boundary only; native signature verification remains unchanged'
    const content = fail ? Buffer.from('controlled activation failure') : artifact.bytes
    const release = fail ? { ...artifact.manifest, version: '1.5.12', sha256: hash(content), sizeBytes: content.length } : artifact.manifest
    const staged = await mutate(target, 'transfer-stage', { transferId, release, bytes: content.toString('base64'), configuration: targetConfig, configSha256: hash(canonical(targetConfig)) }); assert.equal(staged.ok, true); assert.equal(staged.state.active, false); assert.equal((await inspect(source)).state.active, true)
    const stopped = await mutate(source, 'transfer-stop', { transferId }); assert.equal(stopped.ok, true); assert.equal(stopped.state.active, false)
    const mark = await servers[target.server].mark(); const start = Date.now(); const activated = await mutate(target, 'transfer-activate', { transferId })
    if (fail) {
      assert.equal(activated.ok, false); assert.equal(activated.code, 'activation_failed')
      const observed = await inspect(target); const repeated = await inspect(target); assert.deepEqual(repeated, observed)
      assert.equal((await mutate(target, 'transfer-abort', { transferId })).ok, true)
      const m = await servers[source.server].mark(); const t = Date.now(); assert.equal((await mutate(source, 'transfer-resume', { transferId })).ok, true); await fresh(source, m, t); assert.equal((await inspect(target)).state.active, false)
      report.checks.push(label); return source
    }
    assert.equal(activated.ok, true); await fresh(target, mark, start)
    const observed = await inspect(target); const statePath = observed.identity.root + '/state.json'
    const bytes = command('ssh', ['-F', configPath, target.ssh, `cat '${statePath}'`]); await delay(5000); assert.deepEqual(await inspect(target), observed); assert.equal(command('ssh', ['-F', configPath, target.ssh, `cat '${statePath}'`]), bytes)
    assert.equal((await mutate(target, 'transfer-complete', { transferId })).ok, true); assert.equal((await mutate(source, 'transfer-complete', { transferId })).ok, true)
    assert.equal((await inspect(source)).state.active, false); assert.equal(command('ssh', ['-F', configPath, source.ssh, `cat '${original.identity.root}/config.json'`]), saved.get(source.deployment).bytes)
    report.checks.push(label); return target
  }
  current = await move(current, end('source', 1), 'cross-service-distinct-token-history-retained')
  current = await move(current, end('target', 1), 'cross-machine-proxyjump-same-node')
  current = await move(current, end('target-root', 1), 'cross-account-user-to-system-same-node')
  current = await move(current, end('source', 1), 'failed-target-stopped-source-restored-fresh-report', true)
  stage = 'verify retained identities credentials history and stop final target'
  for (const s of servers) { assert.equal((await s.rpc('admin:getClientToken')).token, s.token); assert.equal((await s.rpc('admin:getClient')).created_at, s.original.created_at); report.retainedHistory ??= []; report.retainedHistory.push(await s.history.retained()) }
  assert.equal((await mutate(current, 'uninstall')).ok, true); report.checks.push('all-nodes-tokens-history-retained-and-final-target-stopped'); report.result = 'passed'
} catch (e) { report.result = 'failed'; report.failedStage = stage; report.errorClass = e?.name; report.errorCode = e?.code; report.failureLocation = String(e?.stack ?? '').split('\n').find(l => l.includes('komari-agent-transfer-smoke.mjs:'))?.match(/komari-agent-transfer-smoke\.mjs:[0-9:]+/)?.[0]; process.exitCode = 1 }
finally {
  for (const name of machines) { try { docker('rm', '-f', name) } catch { /* verify absence below */ } }
  try { docker('network', 'rm', network) } catch { /* verify absence below */ }
  report.cleanup = machines.every(name => { try { docker('inspect', name); return false } catch { return true } })
  report.serverStopped = report.cleanup
  try { docker('network', 'inspect', network); report.cleanup = false } catch { /* removed */ }
  await rm(dir, { recursive: true, force: true }); if (!report.cleanup) { report.result = 'failed'; process.exitCode = 1 }
  if (process.env.SHELLBEAM_KOMARI_TRANSFER_REPORT) { const out = resolve(process.env.SHELLBEAM_KOMARI_TRANSFER_REPORT); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
}
