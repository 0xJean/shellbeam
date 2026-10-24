// Real packaged Tauri UI acceptance on an explicitly enabled disposable Linux
// runner. The only automation surface is the external standard WebDriver.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { constants } from 'node:fs'
import { open, readFile, readdir, readlink, realpath, lstat, mkdir, copyFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { OpsUiDriver } from './ops-ui-driver.mjs'

const exec = promisify(execFile)
const ownUid = () => process.getuid?.()
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9 _:.=-]{1,180}$/.test(value)

export function guardUiEnvironment(env = process.env, platform = process.platform, uid = ownUid()) {
  if (platform !== 'linux' || uid === 0 || uid == null || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux' || env.SHELLBEAM_OPS_UI_LIVE !== '1'
    || String(uid) !== env.SHELLBEAM_OPS_UI_UID || !/^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^\d{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('requires disposable ordinary-user Linux UI acceptance')
  if (env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS || env.WEBKIT_FORCE_SANDBOX || env.WEBKIT_INSPECTOR_SERVER) throw new Error('sandbox and inspector overrides are refused')
  if (!env.DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS || !env.XDG_RUNTIME_DIR) throw new Error('isolated desktop session is required')
  if (!path.isAbsolute(env.RUNNER_TEMP ?? '') || !path.isAbsolute(env.SHELLBEAM_OPS_UI_FIXTURE ?? '')) throw new Error('private fixture is required')
}

async function privateFile(filename) {
  const info = await lstat(filename)
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === ownUid() && info.nlink === 1 && (info.mode & 0o777) === 0o600, 'private fixture ownership')
  return info
}

export function safeDetails(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return safeToken(value) || /^[a-z0-9-]{1,100}\.png$/.test(value) ? value : '[redacted]'
  if (depth > 4) return '[bounded]'
  if (Array.isArray(value)) return value.slice(0, 64).map(item => safeDetails(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64)
    .filter(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,60}$/.test(key) && (typeof item === 'boolean' || !/password|secret|token|credential|stdout|stderr|payload|body|title|url|keyPath/i.test(key)))
    .map(([key, item]) => [key, safeDetails(item, depth + 1)]))
  return null
}

async function readFixture(env) {
  const release = await readFile('/etc/os-release', 'utf8')
  assert(/^ID=ubuntu$/m.test(release) && /^VERSION_ID="22\.04"$/m.test(release), 'requires Ubuntu 22.04')
  const source = env.SHELLBEAM_OPS_UI_FIXTURE
  const info = await privateFile(source)
  assert(info.size <= 32_768, 'bounded fixture manifest')
  const fixture = JSON.parse(await readFile(source, 'utf8'))
  assert(fixture.schemaVersion === 1 && fixture.sharedKernel === true, 'fixture schema')
  assert(/^shellbeam-ops-ui-live-[a-z0-9-]{10,100}$/.test(fixture.fixtureId), 'fixture identity')
  const temp = await realpath(env.RUNNER_TEMP)
  assert(fixture.rootFixtureDir === path.join(temp, fixture.fixtureId), 'fixture root scope')
  assert(fixture.desktopDir === path.join(fixture.rootFixtureDir, 'desktop') && source === path.join(fixture.desktopDir, 'fixture.json'), 'fixture manifest scope')
  assert(fixture.artifactDir === path.join(fixture.desktopDir, 'artifacts'), 'private artifact scope')
  assert(fixture.reportPath === path.join(temp, 'shellbeam-ops-ui-live-report.json') && fixture.reportPath === env.SHELLBEAM_OPS_UI_REPORT, 'report scope')
  for (const [kind, variable] of [['data', 'XDG_DATA_HOME'], ['config', 'XDG_CONFIG_HOME'], ['cache', 'XDG_CACHE_HOME'], ['state', 'XDG_STATE_HOME'], ['runtime', 'XDG_RUNTIME_DIR']]) {
    assert(fixture.xdgPaths[kind] === env[variable], 'isolated profile scope')
    const directory = await lstat(fixture.xdgPaths[kind])
    assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === ownUid() && (directory.mode & 0o777) === 0o700, 'private profile ownership')
  }
  assert(path.isAbsolute(fixture.appPath) && path.isAbsolute(fixture.driverPath), 'absolute executable paths')
  assert(fixture.appPath === '/usr/bin/shellbeam-ops-ui-acceptance', 'installed package binary required')
  for (const role of ['jump', 'direct', 'via']) {
    const host = fixture.hosts[role]
    assert(host.address === '127.0.0.1' && host.user === 'root' && Number.isInteger(host.port) && host.port > 1024 && host.port < 65536, 'loopback fixture host')
    assert(host.privateKeyPath === path.join(fixture.desktopDir, 'keys', `${role}.pem`), 'fixture credential scope')
    await privateFile(host.privateKeyPath)
    assert(/^SHA256:[A-Za-z0-9+/]{43}=$/.test(host.expectedFingerprint), 'exact fingerprint')
    assert(host.sshdUnit === `shellbeam-ui-ssh-${fixture.fixtureId.slice('shellbeam-ops-ui-live-'.length)}-${role}.service`
      && /^[a-f0-9]{64}$/.test(host.sshdUnitSha256 ?? ''), 'owned SSHD unit identity')
    if (role !== 'jump') {
      assert(/^00-shellbeam-ui-[a-z0-9-]+-(direct|via)\.service$/.test(host.serviceUnit), 'owned service unit')
      assert(host.serviceStartCountPath === path.join(fixture.rootFixtureDir, 'root', 'services', role, 'start-count'), 'owned service counter')
    }
  }
  assert(new Set(Object.values(fixture.hosts).map(host => host.port)).size === 3, 'independent endpoints')
  await privateFile(fixture.observerKnownHostsPath)
  return fixture
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`
async function verifyFixtureAuthentication(fixture, record) {
  for (const role of ['jump', 'direct', 'via']) {
    const host = fixture.hosts[role]
    // Validate fixture setup independently, without sharing this observer's
    // pinned known-hosts with the app or replacing its graphical trust flow.
    await exec('ssh', ['-F', '/dev/null', '-oBatchMode=yes', '-oIdentitiesOnly=yes',
      '-oStrictHostKeyChecking=yes', `-oUserKnownHostsFile=${fixture.observerKnownHostsPath}`,
      '-oGlobalKnownHostsFile=/dev/null', '-oConnectTimeout=5', '-oLogLevel=ERROR',
      '-i', host.privateKeyPath, '-p', String(host.port), `${host.user}@${host.address}`, 'true'],
    { timeout: 10_000, maxBuffer: 4096 }).catch(() => { throw new Error('ops_ui_fixture_authentication_failed') })
    record('fixture-authentication-verified', { role, independentlyPinned: true })
  }
}
async function observe(fixture, role) {
  const host = fixture.hosts[role]
  const { stdout } = await exec('ssh', [
    '-F', '/dev/null', '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oStrictHostKeyChecking=yes',
    `-oUserKnownHostsFile=${fixture.observerKnownHostsPath}`, '-oGlobalKnownHostsFile=/dev/null',
    '-oConnectTimeout=5', '-oLogLevel=ERROR', '-i', host.privateKeyPath, '-p', String(host.port),
    `${host.user}@${host.address}`,
    `systemctl show --property=ActiveState,ExecMainStartTimestampMonotonic -- ${quote(host.serviceUnit)} && cat -- ${quote(host.serviceStartCountPath)}`,
  ], { timeout: 10_000, maxBuffer: 4096, encoding: 'utf8' }).catch(() => { throw new Error('independent fixture observation failed') })
  const activeState = /^ActiveState=(\w+)$/m.exec(stdout)?.[1]
  const timestamp = /^ExecMainStartTimestampMonotonic=(\d+)$/m.exec(stdout)?.[1]
  const counter = Number(/(?:^|\n)(\d+)\s*$/.exec(stdout)?.[1])
  assert(['failed', 'active'].includes(activeState) && timestamp && Number.isInteger(counter), 'bounded observation schema')
  return Object.freeze({ role, activeState, timestamp, counter })
}

export async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function appProcesses(appPath) {
  const result = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const [info, executable] = await Promise.all([lstat(`/proc/${entry}`), readlink(`/proc/${entry}/exe`)])
      if (info.uid === ownUid() && executable === appPath) result.push(Number(entry))
    } catch { /* Process exited or belongs to another UID. */ }
  }
  return result
}

export async function stopProcessGroup(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  const until = Date.now() + 5000
  while (Date.now() < until && child.exitCode === null && child.signalCode === null) await delay(100)
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)])
  assert(child.exitCode !== null || child.signalCode !== null, 'driver process must exit')
}

export async function main(env = process.env) {
  guardUiEnvironment(env)
  assert(process.argv.length === 2, 'UI runner accepts no arguments')
  const fixture = await readFixture(env)
  const report = { schemaVersion: 1, success: false, cleanup: 'pending', runId: env.GITHUB_RUN_ID,
    checkedOutCommit: env.GITHUB_SHA, headCommit: env.SHELLBEAM_OPS_UI_HEAD_SHA ?? env.GITHUB_SHA,
    sharedKernel: true, productionIpc: false, realVault: false, events: [] }
  const record = (name, details = {}) => {
    if (typeof name === 'object') { details = name; name = details.case ?? details.name ?? 'checkpoint' }
    assert(safeToken(name), 'fixed event name')
    report.events.push({ name, ...safeDetails(details) })
    if (report.events.length > 300) throw new Error('bounded acceptance report')
  }
  let stage = 'initialization'
  let driver
  let child
  let log
  let alertNotifications
  let probeNotifications
  let probeFixture
  const baselines = new Map()
  const screenshots = new Set()
  const checkpoint = async (name, details) => {
    if (details === undefined) {
      assert(/^[a-z0-9-]{1,80}$/.test(name), 'fixed screenshot checkpoint')
      const destination = path.join(fixture.artifactDir, `${name}.png`)
      assert(!screenshots.has(destination), 'single-use screenshot checkpoint')
      screenshots.add(destination)
      return destination
    }
    const { role, unit, baseline } = details
    if (name === 'probe-stop' || name === 'probe-restore') {
      assert(probeFixture && ['direct', 'via'].includes(role) && Object.keys(details).length === 1, 'owned Probe fixture control')
      return name === 'probe-stop' ? probeFixture.stop(role) : probeFixture.start(role)
    }
    assert(['direct', 'via'].includes(role) && unit === fixture.hosts[role].serviceUnit, 'owned observation target')
    const current = await observe(fixture, role)
    if (name === 'before-cancel') {
      assert(current.activeState === 'failed' && current.counter === 1, 'real initial failed service')
      baselines.set(role, current)
      record('service-initially-failed', { role, counter: current.counter })
      return current
    }
    assert(baselines.get(role) === baseline, 'same observation baseline')
    if (name === 'after-cancel') {
      assert.deepEqual(current, baseline, 'cancellation sent no mutation')
      record('service-cancel-zero-mutation', { role, unchanged: true })
    } else if (name === 'after-confirm') {
      assert(current.activeState === 'active' && current.counter === baseline.counter + 1 && current.timestamp !== baseline.timestamp, 'one real restart with fresh post-state')
      record('service-confirmed-once', { role, counter: current.counter, active: true })
    } else throw new Error('unknown observation checkpoint')
    return current
  }
  const launch = async () => {
    assert((await appProcesses(fixture.appPath)).length === 0, 'old application must exit before launch')
    const port = await freePort()
    const nativePort = await freePort()
    assert(port !== nativePort, 'independent WebDriver ports')
    log = await open(path.join(fixture.desktopDir, `driver-${report.events.length}.log`), 'wx', 0o600)
    child = spawn(fixture.driverPath, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', '/usr/bin/WebKitWebDriver'], {
      detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...env, TAURI_WEBVIEW_AUTOMATION: 'true' },
    })
    let spawnFailed = false
    child.on('error', () => { spawnFailed = true })
    driver = new OpsUiDriver(`http://127.0.0.1:${port}`)
    await driver.until(async () => {
      if (spawnFailed || child.exitCode !== null) throw new Error('external WebDriver exited')
      try { const status = await driver.request('GET', '/status'); return status.ready === true } catch { return false }
    }, { timeoutMs: 20_000 })
    await driver.start(fixture.appPath)
    assert((await appProcesses(fixture.appPath)).length === 1, 'one actual installed application process')
    record('installed-application-started', { ordinaryUser: true, sandboxOverride: false })
  }
  const stop = async () => {
    if (driver?.sessionId) {
      driver.requestTimeoutMs = 5000
      try { await driver.stop() } catch { /* Still stop the owned process group. */ }
    }
    await stopProcessGroup(child)
    child = null
    // Only the exact fixture app executable under this ordinary UID may be
    // terminated. The enclosing root-owned cgroup is the final cleanup gate.
    for (const pid of await appProcesses(fixture.appPath)) { try { process.kill(pid, 'SIGTERM') } catch { /* raced with exit */ } }
    const deadline = Date.now() + 5000
    while ((await appProcesses(fixture.appPath)).length && Date.now() < deadline) await delay(100)
    assert((await appProcesses(fixture.appPath)).length === 0, 'application exit confirmed')
    if (log) await log.close()
    log = null
  }
  try {
    const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { timeout: 5000 })
    assert(commit.trim() === env.GITHUB_SHA, 'exact checked-out commit')
    const { setupOpsUiJourney, activateOpsUiRules, runOpsUiIncidents, resumeOpsUiJourney } = await import('./ops-ui-journey.mjs')
    const { runOpsUiNotifications, startOpsUiAlertNotifications } = await import('./ops-ui-notifications.mjs')
    const { createOpsUiProbeFixture } = await import('./ops-ui-probe-fixture.mjs')
    const { runOpsUiProbeJourney, resumeOpsUiProbeJourney, settleOpsUiProbeInventory } = await import('./ops-ui-probe-journey.mjs')
    const { startOpsUiProbeNotifications } = await import('./ops-ui-probe-notifications.mjs')
    stage = 'fixture-authentication'
    await verifyFixtureAuthentication(fixture, record)
    stage = 'launch'
    console.log('ShellBeam UI: launch installed application')
    await launch()
    stage = 'vault-and-host-setup'
    const resumeState = await setupOpsUiJourney({ driver, fixture, record, checkpoint })
    report.productionIpc = true
    report.realVault = true
    stage = 'notifications'
    report.notifications = safeDetails(await runOpsUiNotifications({ driver, fixture, record, checkpoint }))
    // Save the real notification policy and start the owned OS daemon before
    // creating rules. Enabling a channel later must not backfill old events.
    stage = 'alert-notification-policy'
    alertNotifications = await startOpsUiAlertNotifications({ driver, fixture, record, checkpoint, resumeState })
    stage = 'rule-activation'
    report.rules = safeDetails(await activateOpsUiRules({ driver, fixture, record, resumeState,
      onOpened: role => alertNotifications.verifyOpened(role) }))
    stage = 'incident-operations'
    report.journey = safeDetails(await runOpsUiIncidents({ driver, fixture, record, checkpoint, resumeState,
      onRecovered: role => alertNotifications.verifyResolved(role) }))
    stage = 'alert-delivery-before-restart'
    await alertNotifications.beforeRestart()
    stage = 'application-restart'
    await stop()
    record('application-exit-confirmed')
    const restartedAfter = Date.now()
    await launch()
    stage = 'unlock-and-audit-recovery'
    report.recovery = safeDetails(await resumeOpsUiJourney({ driver, fixture, record, checkpoint, resumeState, restartedAfter }))
    assert(report.recovery.freshObservations === 2, 'both rules require real post-restart observations')
    stage = 'alert-delivery-after-restart'
    report.alertNotifications = safeDetails(await alertNotifications.afterRestart({ driver }))
    await alertNotifications.stop()
    alertNotifications = null
    // A new owned daemon distinguishes the metrics lifecycle from the service
    // rules. The actual saved jump profile is also monitored: stopping its
    // SSHD affects both that profile and the host routed through it.
    stage = 'probe-fixture-setup'
    probeFixture = await createOpsUiProbeFixture({ fixture, record })
    await probeFixture.verify('direct'); await probeFixture.verify('via')
    stage = 'probe-notification-policy'
    probeNotifications = await startOpsUiProbeNotifications({ driver, fixture, record, checkpoint, resumeState })
    stage = 'probe-failure-and-recovery'
    const probeState = await runOpsUiProbeJourney({ driver, fixture, record, checkpoint, resumeState,
      onOpened: role => probeNotifications.verifyOpened(role), onResolved: role => probeNotifications.verifyResolved(role) })
    stage = 'probe-inventory-settle'
    report.probeInventory = safeDetails(await settleOpsUiProbeInventory({ driver, fixture, record, checkpoint, resumeState, probeState }))
    assert(report.probeInventory.passed === true && report.probeInventory.freshObservations === 3, 'all inventory observations must settle before restart')
    stage = 'probe-delivery-before-restart'
    await probeNotifications.beforeRestart()
    stage = 'probe-application-restart'
    await stop()
    record('probe-application-exit-confirmed')
    const probeRestartedAfter = Date.now()
    await launch()
    // This performs the real Vault unlock and also reconfirms that fault
    // injection did not restart either independent business service again.
    stage = 'probe-unlock-and-service-audit-recovery'
    report.postProbeServiceRecovery = safeDetails(await resumeOpsUiJourney({ driver, fixture, record, checkpoint, resumeState, restartedAfter: probeRestartedAfter }))
    stage = 'probe-scoped-audit-recovery'
    report.probeRecovery = safeDetails(await resumeOpsUiProbeJourney({ driver, fixture, record, resumeState, probeState, restartedAfter: probeRestartedAfter }))
    assert(report.probeRecovery.freshObservations === 3 && report.probeRecovery.restoredJobs === 6, 'all Probe profiles and jobs require real restart evidence')
    stage = 'probe-delivery-after-restart'
    report.probeNotifications = safeDetails(await probeNotifications.afterRestart({ driver }))
    for (const role of ['direct', 'via']) assert(report.events.some(event => event.name === 'service-confirmed-once' && event.role === role), 'both routes exercised')
    assert(report.notifications?.passed === true, 'all real notification cases must pass')
    assert(report.rules?.passed === true && report.alertNotifications?.passed === true, 'real alert notification lifecycle must pass')
    assert(report.journey?.passed === true && report.recovery?.passed === true, 'incident and recovery assertions must pass')
    assert(report.probeRecovery?.passed === true && report.probeNotifications?.passed === true
      && report.probeNotifications.metricsVisible === 6 && report.probeNotifications.profiles === 3, 'real Probe lifecycle and visible notifications must pass')
    report.success = true
  } catch (error) {
    report.failure = { stage, code: error?.code && /^[a-z ]{1,64}$/.test(error.code) ? error.code : /^ops_ui_[a-z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : 'acceptance-failed' }
    report.lastInteraction = safeDetails(driver?.lastInteraction)
    report.clickGeometry = safeDetails(driver?.lastClickDiagnostics)
    report.hostNavigation = safeDetails(driver?.lastHostNavigation)
    console.error(`ShellBeam UI: ${stage} failed`)
  } finally {
    if (probeNotifications) {
      try { await probeNotifications.stop() }
      catch { report.success = false; record('probe-notification-daemon-cleanup-failed') }
    }
    if (probeFixture) {
      try { await probeFixture.restore() }
      catch { report.success = false; record('probe-fixture-cleanup-failed') }
    }
    if (alertNotifications) {
      try { await alertNotifications.stop() }
      catch { report.success = false; record('alert-notification-daemon-cleanup-failed') }
    }
    try { await stop(); report.applicationStopped = true }
    catch { report.applicationStopped = false; report.success = false }
    const artifactRoot = path.join(await realpath(env.RUNNER_TEMP), 'shellbeam-ops-ui-artifacts')
    assert(!env.SHELLBEAM_OPS_UI_ARTIFACTS || env.SHELLBEAM_OPS_UI_ARTIFACTS === artifactRoot, 'artifact output scope')
    await mkdir(artifactRoot, { mode: 0o700 }) // Refuse reuse, including symlinks.
    report.screenshots = []
    for (const source of screenshots) {
      try {
        const info = await lstat(source)
        assert(info.isFile() && !info.isSymbolicLink() && info.uid === ownUid() && info.nlink === 1 && info.size <= 8 * 1024 * 1024, 'owned bounded screenshot')
        const signature = await open(source, 'r')
        const header = Buffer.alloc(8)
        try { await signature.read(header, 0, 8, 0) } finally { await signature.close() }
        assert(header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG screenshot')
        const basename = path.basename(source)
        const destination = path.join(artifactRoot, basename)
        await copyFile(source, destination, constants.COPYFILE_EXCL)
        await chmod(destination, 0o644)
        report.screenshots.push(basename)
      } catch { report.success = false; record('safe-screenshot-export-failed') }
    }
    const output = await open(fixture.reportPath, 'wx', 0o644)
    try { await output.chmod(0o644); await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.sync() } finally { await output.close() }
  }
  if (!report.success) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('ShellBeam UI: fixture or cleanup gate failed'); process.exitCode = 1 })
}
