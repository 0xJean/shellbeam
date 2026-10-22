#!/usr/bin/env node
/** Opt-in isolated Linux systemd contract. Uses actual pinned official binaries,
 * synthetic credentials and the unchanged production helper; never an existing Vault. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signCompatibleAgent, verifyCompatibleCatalog } from './publish-komari-agent.mjs'
import { downloadPinned } from './prepare-komari-agent-release.mjs'

if (process.platform !== 'linux' || process.env.SHELLBEAM_KOMARI_LIFECYCLE_SMOKE !== '1') throw new Error('explicit_isolated_linux_opt_in_required')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pins = JSON.parse(await readFile(join(project, 'scripts/fixtures/komari-lifecycle-releases.json'), 'utf8'))
const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null
assert.ok(arch)
const directory = await mkdtemp(join(homedir(), '.shellbeam-komari-smoke-')); await chmod(directory, 0o700)
let deployment = randomUUID(); let managedRoot = join(homedir(), '.local/share/shellbeam/komari', deployment)
const ownedDeployments = [deployment]; let legacyUnitFile; let legacyUnitText; let legacyUnitName
const system = process.getuid() === 0 ? [] : ['--user']
const systemctl = (...args) => execFileSync('systemctl', [...system, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
const legacyPins = JSON.parse(await readFile(join(project, 'releases/compatible-probe-pins.json'))).versions
const helper = join(project, 'src-tauri/src/data/komari_agent/remote.py')
const { privateKey } = generateKeyPairSync('ed25519'); const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const delay = ms => new Promise(done => setTimeout(done, ms))
let child; let stopped = false; let stage = 'download pinned official binaries'; let inspected; let failed = false
const report = { result: 'running', server: pins.server.version, architecture: arch, serviceScope: process.getuid() === 0 ? 'system' : 'user', sourceCommit: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null, checks: [], freshReports: [], remoteChecks: [], cleanup: false, serverStopped: false }
const log = await open(join(directory, 'server.log'), 'wx', 0o600)
async function download(repo, name, version, pin) {
  const url = `https://github.com/komari-monitor/${repo}/releases/download/${version}/${name}`
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); assert.equal(r.status, 200)
  const bytes = Buffer.from(await r.arrayBuffer()); assert.equal(bytes.length, pin.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
  const file = join(directory, `${name}-${version}`); await writeFile(file, bytes, { mode: 0o700, flag: 'wx' })
  return { file, bytes, manifest: repo === 'komari-agent' ? signCompatibleAgent({ bytes, version, architecture: arch, url, expectedSha256: pin.sha256, expectedSize: pin.size, privateKey: privatePem }) : null }
}
async function remote(request) {
  return await new Promise((done, reject) => {
    const p = spawn('python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); let bytes = Buffer.alloc(0)
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('helper_timeout')) }, 120000)
    p.stdout.on('data', value => { bytes = Buffer.concat([bytes, value]); if (bytes.length > 131072) { p.kill(); reject(new Error('helper_output_bound')) } })
    p.once('error', () => { clearTimeout(timer); reject(new Error('helper_spawn')) })
    p.once('close', code => { clearTimeout(timer); try { assert.equal(code, 0); const value = JSON.parse(bytes); report.remoteChecks.push({ action: request.action, ok: value.ok, code: value.code, category: value.category, locations: value.locations, serviceStep: value.serviceStep, status: value.state?.status, active: value.state?.active, rollback: value.rollback }); done(value) } catch { reject(new Error('helper_response')) } })
    p.stdin.on('error', () => {}); p.stdin.end(JSON.stringify({ legacyPins, ...request, deployment }))
  })
}
async function inspect() { const result = await remote({ action: 'inspect' }); assert.equal(result.ok, true, 'inspection failed'); inspected = result; return result }
async function waitFor(fn, timeout = 60000) { const until = Date.now() + timeout; while (Date.now() < until) { try { const value = await fn(); if (value) return value } catch { /* bounded startup/report read */ } await delay(500) }; throw new Error('bounded_read_timeout') }
try {
  const binary = await download('komari', `komari-linux-${arch}`, pins.server.version, pins.server[arch])
  const artifacts = []
  for (const entry of pins.agents) artifacts.push(await download('komari-agent', `komari-agent-linux-${arch}`, entry.version, entry[arch]))
  if (process.env.SHELLBEAM_KOMARI_PRODUCTION_RELEASE === '1') {
    stage = 'verify anonymous production catalog and upgrade artifact'
    const root = JSON.parse(await readFile(join(project, 'src-tauri/src/data/komari_agent/official-trust.json')))
    const catalog = verifyCompatibleCatalog(JSON.parse(await downloadPinned(root.catalogUrl, null, 65536)), root)
    const manifest = catalog.artifacts.find(a => a.architecture === arch)
    const pinned = pins.agents.find(a => a.version === manifest.version)?.[arch]
    assert.ok(pinned); assert.equal(manifest.sha256, pinned.sha256); assert.equal(manifest.sizeBytes, pinned.size)
    const bytes = await downloadPinned(manifest.url, pinned)
    artifacts[1] = { bytes, manifest }
    report.productionRelease = { keyId: root.keyId, sequence: catalog.sequence, version: manifest.version, signatureVerified: true, bytesVerified: true, noUserConfiguration: true }
  }
  stage = 'initialize isolated loopback server'
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done)); const port = listener.address().port; await new Promise(done => listener.close(done))
  const endpoint = `http://127.0.0.1:${port}`
  child = spawn(binary.file, ['server', '--listen', `127.0.0.1:${port}`, '--database', join(directory, 'primary.db')], { cwd: directory, env: { PATH: process.env.PATH, TZ: 'UTC' }, stdio: ['ignore', log.fd, log.fd] }); child.on('close', () => { stopped = true })
  const request = async (path, body, auth = {}) => {
    const r = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    assert.equal(r.status, 200); const value = await r.json(); return { response: r, value, data: value?.data ?? value?.result ?? value }
  }
  await waitFor(async () => (await request('/api/install/status')).data?.required === true)
  const username = 'smoke-' + randomBytes(8).toString('hex'); const password = 'Sb1' + randomBytes(24).toString('hex'); const apiKey = randomBytes(32).toString('hex')
  stage = 'complete isolated installation'
  await request('/api/install/complete', { username, password, sitename: 'Isolated lifecycle test', metric_dsn: join(directory, 'metrics.db') })
  stage = 'verify installed version envelope'
  await waitFor(async () => (await request('/api/version')).data?.version === '1.6.0')
  stage = 'authenticate isolated administrator'
  const login = await request('/api/login', { username, password }); const cookie = login.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  stage = 'save isolated service API key'
  await request('/api/admin/settings', { api_key: apiKey, private_site: true, geo_ip_enabled: false, notification_enabled: false, eula_accepted: true }, { Cookie: cookie, Origin: endpoint })
  const auth = { Authorization: `Bearer ${apiKey}` }
  stage = 'create isolated monitoring node'
  const created = (await request('/api/admin/client/add', { name: 'isolated-lifecycle-node' }, auth)).data
  const nodeId = created.uuid; const token = created.token; assert.equal(typeof nodeId, 'string'); assert.equal(typeof token, 'string')
  const rpc = async (method) => (await request('/api/rpc2', { jsonrpc: '2.0', id: 1, method, params: { uuid: nodeId } }, auth)).value.result
  const originalNode = await rpc('admin:getClient'); const tokenBefore = (await rpc('admin:getClientToken')).token; assert.equal(token, tokenBefore)
  const config = { endpoint, token, disable_auto_update: true, disable_web_ssh: true, interval: 5, info_report_interval: 1, month_rotate: 0, get_ip_addr_from_nic: true }
  const latest = value => {
    if (Array.isArray(value)) return Math.max(0, ...value.map(latest))
    if (!value || typeof value !== 'object') return 0
    if (['cpu', 'ram', 'memory', 'disk', 'network', 'net', 'load'].some(key => key in value)) return Date.parse(value.time ?? value.updated_at ?? '') || 0
    return Math.max(0, ...['data', 'records', 'reports', 'result'].map(key => latest(value[key])))
  }
  const watermark = async () => latest((await request(`/api/recent/${nodeId}`, undefined, auth)).value)
  const fresh = async (version, before, started) => {
    const expectedSha256 = artifacts.find(a => a.manifest.version === version).manifest.sha256
    await waitFor(async () => {
      const node = await rpc('admin:getClient'); const time = await watermark()
      if (!(node.uuid === nodeId && node.created_at === originalNode.created_at && node.version?.replace(/^v/, '') === version && time > before && time >= started - 5000 && time <= Date.now() + 5000 && time >= Date.now() - 60000)) return false
      const current = await inspect()
      if (!(current.state.status === 'released' ? current.state.legacy?.sha256 === expectedSha256 : current.state.active && current.state.current?.sha256 === expectedSha256) || time < Date.now() - 60000 || time > Date.now() + 5000) return false
      report.freshReports.push({ version, nodeIdentityVerified: true, originalSampleAt: time, before, started, verifiedAt: Date.now(), processSha256: expectedSha256 })
      return true
    })
  }
  const operate = async (action, artifact, overrideBytes) => {
    const baseline = await inspect()
    const result = await remote({ action, identity: baseline.identity, expected: baseline.state, job: randomUUID(), release: artifact?.manifest, bytes: overrideBytes ?? artifact?.bytes?.toString('base64'), configuration: config })
    return result
  }
  stage = 'install actual 1.5.10 systemd service and verify fresh report'
  let before = await watermark(); let started = Date.now()
  const installed = await operate('install', artifacts[0]); assert.equal(installed.ok, true); assert.equal(installed.state.active, true); assert.equal(installed.rollback, 'not-needed')
  await fresh('1.5.10', before, started); report.checks.push('install-process-and-fresh-report')
  const configBytes = await readFile(join(managedRoot, 'config.json')); assert.equal((await stat(join(managedRoot, 'config.json'))).mode & 0o777, 0o600)
  stage = 'reject changed artifact before activation'
  const previous = await inspect(); const rejected = await operate('upgrade', artifacts[1], Buffer.from('changed artifact').toString('base64'))
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'artifact_hash_mismatch'); assert.deepEqual(await inspect(), previous); report.checks.push('hash-rejection-without-service-change')
  stage = 'upgrade actual 1.5.11 and verify original node identity'
  before = await watermark(); started = Date.now()
  const upgraded = await operate('upgrade', artifacts[1]); assert.equal(upgraded.ok, true); assert.equal(upgraded.state.active, true); assert.equal(upgraded.rollback, 'not-needed')
  await fresh('1.5.11', before, started); report.checks.push('upgrade-process-and-fresh-report')
  stage = 'rollback retained 1.5.10 without download'
  before = await watermark(); started = Date.now()
  const reverted = await operate('rollback', { manifest: artifacts[0].manifest }); assert.equal(reverted.ok, true); assert.equal(reverted.state.active, true)
  await fresh('1.5.10', before, started); report.checks.push('explicit-rollback-process-and-fresh-report')
  stage = 'failed activation automatically restores previous service'
  const brokenBytes = Buffer.from('controlled non-executable test artifact')
  const broken = { bytes: brokenBytes, manifest: signCompatibleAgent({ bytes: brokenBytes, version: '1.5.12', architecture: arch, url: 'https://fixture.invalid/broken', expectedSha256: createHash('sha256').update(brokenBytes).digest('hex'), expectedSize: brokenBytes.length, privateKey: privatePem }) }
  before = await watermark(); started = Date.now()
  const recovered = await operate('upgrade', broken); assert.equal(recovered.ok, true); assert.equal(recovered.error, 'activation_failed'); assert.equal(recovered.rollback, 'verified'); assert.equal(recovered.state.current.sha256, artifacts[0].manifest.sha256)
  await fresh('1.5.10', before, started); report.checks.push('failed-activation-verified-rollback')
  stage = 'new helper process reads without replay'
  const stateFile = join(managedRoot, 'state.json'); const savedState = await readFile(stateFile); const savedTime = (await stat(stateFile)).mtimeMs
  await inspect(); await inspect(); assert.deepEqual(await readFile(stateFile), savedState); assert.equal((await stat(stateFile)).mtimeMs, savedTime); report.checks.push('cross-process-read-only-recovery')
  stage = 'uninstall while retaining node, token, configuration, history and releases'
  before = await watermark(); const removed = await operate('uninstall'); assert.equal(removed.ok, true); assert.equal(removed.state.status, 'retired'); assert.equal(removed.state.active, false)
  assert.deepEqual(await readFile(join(managedRoot, 'config.json')), configBytes); assert.ok((await readdir(join(managedRoot, 'releases'))).length >= 3)
  assert.equal((await rpc('admin:getClientToken')).token, tokenBefore); assert.equal((await rpc('admin:getClient')).created_at, originalNode.created_at); assert.ok(await watermark() >= before)
  report.checks.push('uninstall-with-node-key-data-preservation')
  stage = 'create a direct same-account existing official probe service'
  deployment = randomUUID(); ownedDeployments.push(deployment); managedRoot = join(homedir(), '.local/share/shellbeam/komari', deployment)
  legacyUnitName = `komari-acceptance-${randomUUID()}.service`
  const unitDirectory = process.getuid() === 0 ? '/etc/systemd/system' : join(homedir(), '.config/systemd/user')
  await mkdir(unitDirectory, { recursive: true })
  legacyUnitFile = join(unitDirectory, legacyUnitName)
  const legacyConfigFile = join(directory, 'existing-config.json'); const legacyConfig = Buffer.from(JSON.stringify({ ...config, include_nics: 'lo' }))
  await writeFile(legacyConfigFile, legacyConfig, { mode: 0o600, flag: 'wx' })
  legacyUnitText = `[Unit]\nDescription=Isolated existing probe\nAfter=network.target\n[Service]\nType=simple\nExecStart=${artifacts[0].file} --config ${legacyConfigFile}\nWorkingDirectory=${directory}\nRestart=always\n[Install]\nWantedBy=${process.getuid() === 0 ? 'multi-user.target' : 'default.target'}\n`
  await writeFile(legacyUnitFile, legacyUnitText, { mode: 0o600, flag: 'wx' }); systemctl('daemon-reload'); systemctl('enable', '--now', legacyUnitName)
  await waitFor(async () => (await rpc('admin:getClient')).version?.replace(/^v/, '') === '1.5.10' && await watermark() > before)
  const originalPid = systemctl('show', legacyUnitName, '--property=MainPID', '--value').toString().trim(); assert.match(originalPid, /^[1-9][0-9]*$/)
  // Names only, never environment values or configuration/Token contents.
  report.legacyAgentEnvironmentNames = (await readFile(`/proc/${originalPid}/environ`)).toString().split('\0').map(value => value.split('=', 1)[0]).filter(name => /^AGENT_[A-Z0-9_]+$/.test(name))
  const prepareHandoff = async extra => { const r = await remote({ action: 'inspect', ...extra }); assert.equal(r.ok, true); return r }
  const handoff = async (action, artifact, extra = {}, tokenValue = token) => {
    const baseline = await prepareHandoff(extra)
    return await remote({ action, identity: baseline.identity, expected: baseline.state, job: randomUUID(), release: artifact?.manifest,
      bytes: artifact?.bytes?.toString('base64'), plannedConfig: baseline.plannedConfig, agentToken: tokenValue, ...extra })
  }
  stage = 'reject adoption of a different monitoring node without stopping existing service'
  const wrongNode = await handoff('adopt', artifacts[1], { legacyUnit: legacyUnitName }, 'wrong-isolated-node')
  assert.equal(wrongNode.ok, false); assert.equal(wrongNode.code, 'legacy_node_mismatch'); systemctl('is-active', legacyUnitName)
  report.checks.push('adoption-rejects-other-node-without-stopping-original')
  stage = 'failed adoption restores original service and a new original sample'
  before = await watermark(); started = Date.now()
  const failedAdoption = await handoff('adopt', broken, { legacyUnit: legacyUnitName })
  assert.equal(failedAdoption.ok, true); assert.equal(failedAdoption.rollback, 'verified'); assert.equal(failedAdoption.state.status, 'released')
  await fresh('1.5.10', before, started); report.checks.push('failed-adoption-restores-original-service-and-report')
  stage = 'adopt existing official probe into signed managed service'
  before = await watermark(); started = Date.now()
  const adopted = await handoff('adopt', artifacts[1], { legacyUnit: legacyUnitName })
  assert.equal(adopted.ok, true); assert.equal(adopted.state.active, true)
  await fresh('1.5.11', before, started)
  assert.deepEqual(await readFile(legacyConfigFile), legacyConfig); assert.equal(await readFile(legacyUnitFile, 'utf8'), legacyUnitText)
  assert.equal(JSON.parse(await readFile(join(managedRoot, 'config.json'))).token, token)
  assert.equal(JSON.parse(await readFile(join(managedRoot, 'config.json'))).include_nics, 'lo')
  report.checks.push('adoption-preserves-original-files-node-token-and-settings')
  stage = 'migrate address of same monitoring node and verify fresh sample'
  before = await watermark(); started = Date.now()
  const migrated = await handoff('migrate', null, { targetEndpoint: `http://localhost:${port}` })
  assert.equal(migrated.ok, true); assert.equal(migrated.state.endpoint, `http://localhost:${port}`)
  await fresh('1.5.11', before, started); report.checks.push('address-migration-with-fresh-report')
  stage = 'restore previous exact configuration without downloading an artifact'
  before = await watermark(); started = Date.now()
  const restoredConfig = await handoff('restore-config', null, { restoreConfig: true })
  assert.equal(restoredConfig.ok, true); assert.equal(restoredConfig.state.endpoint, endpoint)
  await fresh('1.5.11', before, started); report.checks.push('address-restore-with-fresh-report')
  stage = 'return ownership to untouched original service and verify new sample'
  before = await watermark(); started = Date.now()
  const returned = await handoff('restore-legacy')
  assert.equal(returned.ok, true); assert.equal(returned.state.status, 'released')
  await fresh('1.5.10', before, started)
  assert.equal(await readFile(legacyUnitFile, 'utf8'), legacyUnitText); assert.deepEqual(await readFile(legacyConfigFile), legacyConfig)
  assert.equal((await rpc('admin:getClientToken')).token, tokenBefore); assert.equal((await rpc('admin:getClient')).created_at, originalNode.created_at)
  const handoffState = join(managedRoot, 'state.json'); const journalBytes = await readFile(handoffState); const journalTime = (await stat(handoffState)).mtimeMs
  await inspect(); await inspect(); assert.deepEqual(await readFile(handoffState), journalBytes); assert.equal((await stat(handoffState)).mtimeMs, journalTime)
  report.checks.push('original-service-restoration-data-preservation-and-no-replay'); report.result = 'passed'
} catch { failed = true; report.result = 'failed'; report.failedStage = stage; process.exitCode = 1 }
finally {
  try {
    for (const owned of ownedDeployments) {
      deployment = owned; managedRoot = join(homedir(), '.local/share/shellbeam/komari', owned)
      const state = await inspect()
      if (!['absent', 'retired', 'released'].includes(state.state.status)) { const r = await remote({ action: 'uninstall', identity: state.identity, expected: state.state, job: randomUUID() }); assert.equal(r.ok, true) }
      const final = await inspect(); assert.ok(['absent', 'retired', 'released'].includes(final.state.status)); assert.equal(final.state.active, false)
      await rm(managedRoot, { recursive: true, force: true })
    }
    if (legacyUnitFile && legacyUnitText) {
      assert.equal(await readFile(legacyUnitFile, 'utf8'), legacyUnitText)
      systemctl('disable', '--now', legacyUnitName); await rm(legacyUnitFile); systemctl('daemon-reload')
      await rm(join(homedir(), '.local/share/shellbeam/komari', `.handoff-${legacyUnitName}.lock`), { force: true })
    }
    report.cleanup = true
  } catch { process.exitCode = 1; report.result = 'failed'; report.cleanup = false }
  if (child && !stopped) { child.kill('SIGTERM'); await waitFor(() => stopped, 15000).catch(() => { child.kill('SIGKILL') }); await delay(300) }
  report.serverStopped = !child || stopped
  await log.close()
  if (report.serverStopped && report.cleanup) await rm(directory, { recursive: true, force: true })
  else { report.result = 'failed'; process.exitCode = 1 }
  const out = process.env.SHELLBEAM_KOMARI_LIFECYCLE_REPORT
  if (out) { await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
  if (failed) process.exitCode = 1
}
