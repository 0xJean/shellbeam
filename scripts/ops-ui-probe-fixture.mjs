// Fault injection for the existing disposable hosted-runner SSH fixture only.
// This module never reads a Vault, sends an app IPC or accepts a command/unit.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const ROLES = Object.freeze(['jump', 'direct', 'via'])
const CONTROL_ROLES = Object.freeze({ direct: 'direct', via: 'jump' })
const fail = code => new Error(`ops_ui_probe_fixture_${code}`)
function requireFact(value, code) { if (!value) throw fail(code) }

export function requireProbeFixtureEnvironment(env = process.env, platform = process.platform, uid = process.getuid?.()) {
  requireFact(platform === 'linux' && Number.isSafeInteger(uid) && uid > 0
    && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux'
    && env.SHELLBEAM_OPS_UI_LIVE === '1' && env.SHELLBEAM_OPS_UI_UID === String(uid)
    && /^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? '') && /^[0-9]{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && path.isAbsolute(env.RUNNER_TEMP ?? '') && path.isAbsolute(env.SHELLBEAM_OPS_UI_FIXTURE ?? ''), 'requires_isolated_hosted_linux')
  requireFact(!env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS && !env.WEBKIT_FORCE_SANDBOX && !env.WEBKIT_INSPECTOR_SERVER, 'unsafe_environment')
}

export function probeFixtureScope(fixture, env, runnerTemp) {
  requireFact(fixture && fixture.schemaVersion === 1 && fixture.sharedKernel === true, 'invalid_manifest')
  const prefix = `shellbeam-ops-ui-live-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-`
  requireFact(typeof fixture.fixtureId === 'string' && fixture.fixtureId.startsWith(prefix)
    && /^[a-f0-9]{8}$/.test(fixture.fixtureId.slice(prefix.length)), 'invalid_fixture_identity')
  requireFact(path.isAbsolute(runnerTemp) && runnerTemp === path.normalize(runnerTemp)
    && fixture.rootFixtureDir === path.join(runnerTemp, fixture.fixtureId)
    && fixture.desktopDir === path.join(fixture.rootFixtureDir, 'desktop')
    && env.SHELLBEAM_OPS_UI_FIXTURE === path.join(fixture.desktopDir, 'fixture.json')
    && fixture.observerKnownHostsPath === path.join(fixture.desktopDir, 'observer-known-hosts'), 'invalid_fixture_scope')
  const suffix = fixture.fixtureId.slice('shellbeam-ops-ui-live-'.length)
  const hosts = {}
  for (const role of ROLES) {
    const host = fixture.hosts?.[role]
    const unit = `shellbeam-ui-ssh-${suffix}-${role}.service`
    requireFact(host && host.address === '127.0.0.1' && host.user === 'root'
      && Number.isInteger(host.port) && host.port > 1024 && host.port <= 65535
      && host.sshdUnit === unit && /^[a-f0-9]{64}$/.test(host.sshdUnitSha256 ?? '')
      && host.privateKeyPath === path.join(fixture.desktopDir, 'keys', `${role}.pem`)
      && host.observerKnownHostsPath === fixture.observerKnownHostsPath, 'invalid_fixture_host')
    hosts[role] = Object.freeze({ address: '127.0.0.1', port: host.port, role, unit,
      checksum: host.sshdUnitSha256, fragment: `/etc/systemd/system/${unit}`,
      config: path.join(fixture.rootFixtureDir, 'root', role, 'sshd_config') })
  }
  requireFact(new Set(ROLES.map(role => hosts[role].port)).size === ROLES.length, 'endpoints_not_independent')
  return Object.freeze({ fixtureId: fixture.fixtureId, root: fixture.rootFixtureDir, desktop: fixture.desktopDir, hosts: Object.freeze(hosts) })
}

export function parseProbeUnitState(text, host) {
  requireFact(typeof text === 'string' && text.length <= 16_384, 'invalid_unit_state')
  const entries = text.trimEnd().split('\n').map(line => {
    const separator = line.indexOf('=')
    requireFact(separator > 0, 'invalid_unit_state')
    return [line.slice(0, separator), line.slice(separator + 1)]
  })
  const names = ['Id', 'LoadState', 'ActiveState', 'FragmentPath', 'KillMode', 'ControlGroup', 'MainPID']
  requireFact(entries.length === names.length && new Set(entries.map(([name]) => name)).size === names.length
    && entries.every(([name]) => names.includes(name)), 'invalid_unit_state')
  const fields = Object.fromEntries(entries)
  requireFact(fields.Id === host.unit && fields.LoadState === 'loaded' && fields.FragmentPath === host.fragment
    && fields.KillMode === 'control-group' && ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(fields.ActiveState)
    && /^(0|[1-9][0-9]{0,9})$/.test(fields.MainPID)
    && (!fields.ControlGroup || fields.ControlGroup === `/system.slice/${host.unit}`), 'unit_identity_mismatch')
  return { activeState: fields.ActiveState, mainPid: Number(fields.MainPID), controlGroup: fields.ControlGroup || `/system.slice/${host.unit}` }
}

async function boundedFile(filename, maxBytes = 32_768) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    requireFact(info.isFile() && info.nlink === 1 && info.size <= maxBytes, 'invalid_file')
    const bytes = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    requireFact(bytesRead <= maxBytes, 'invalid_file')
    return { info, bytes: bytes.subarray(0, bytesRead) }
  } finally { await handle.close() }
}

async function readEmptyCgroup(controlGroup) {
  let mounts = 0
  for (const mount of ['/sys/fs/cgroup', '/sys/fs/cgroup/systemd']) {
    let mountInfo
    try { mountInfo = await lstat(mount) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    requireFact(mountInfo.isDirectory() && !mountInfo.isSymbolicLink(), 'invalid_cgroup')
    mounts++
    const directory = `${mount}${controlGroup}`
    async function empty(current) {
      let entries
      try { entries = await readdir(current, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
      for (const entry of entries) {
        requireFact(!entry.isSymbolicLink(), 'invalid_cgroup')
        if (entry.isDirectory() && !await empty(path.join(current, entry.name))) return false
        if (entry.isFile() && ['cgroup.procs', 'tasks'].includes(entry.name)) {
          const text = await readFile(path.join(current, entry.name), 'utf8')
          if (text.trim()) return false
        }
        if (entry.isFile() && entry.name === 'cgroup.events') {
          const text = await readFile(path.join(current, entry.name), 'utf8')
          const populated = /^populated ([01])$/m.exec(text)?.[1]
          requireFact(populated !== undefined, 'invalid_cgroup')
          if (populated !== '0') return false
        }
      }
      return true
    }
    if (!await empty(directory)) return false
  }
  requireFact(mounts > 0, 'invalid_cgroup')
  return true
}

function inspectEndpoint(host) {
  return new Promise(resolve => {
    const socket = createConnection({ host: host.address, port: host.port })
    let settled = false
    let connected = false
    let buffer = Buffer.alloc(0)
    const finish = (result) => {
      if (settled) return
      settled = true; socket.destroy(); resolve(result)
    }
    socket.setTimeout(500)
    socket.once('connect', () => { connected = true })
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data])
      if (buffer.length > 256 || buffer.includes(10)) finish({ refused: false, ready: buffer.length <= 256 && /^SSH-2\.0-[^\r\n]+\r?\n/.test(buffer.toString('ascii')) })
    })
    socket.once('error', error => finish({ refused: !connected && error.code === 'ECONNREFUSED', ready: false }))
    socket.once('timeout', () => finish({ refused: false, ready: false }))
    socket.once('end', () => finish({ refused: false, ready: false }))
    socket.once('close', () => finish({ refused: false, ready: false }))
  })
}

const defaults = { platform: process.platform, uid: () => process.getuid?.(), readFile,
  lstat, realpath, boundedFile, exec, inspectEndpoint, readEmptyCgroup, now: Date.now, delay }

/** Dependencies are injectable for protocol tests; default execution always
 * performs OS/file/unit checks before the first mutation. No work on import. */
export async function createOpsUiProbeFixture({ fixture, env = process.env, record = () => {} }, dependencies = {}) {
  const io = { ...defaults, ...dependencies }
  requireProbeFixtureEnvironment(env, io.platform, io.uid())
  try {
    const release = await io.readFile('/etc/os-release', 'utf8')
    requireFact(/^ID=ubuntu$/m.test(release) && /^VERSION_ID="22\.04"$/m.test(release), 'unsupported_distribution')
    const temp = await io.realpath(env.RUNNER_TEMP)
    const scope = probeFixtureScope(fixture, env, temp)
    for (const [directory, uid, mode] of [[temp, null, null], [scope.root, 0, 0o711], [scope.desktop, io.uid(), 0o700], ['/etc/systemd/system', 0, null]]) {
      const info = await io.lstat(directory)
      requireFact(info.isDirectory() && !info.isSymbolicLink() && (uid === null || info.uid === uid)
        && (mode === null || (info.mode & 0o777) === mode), 'invalid_directory_ownership')
      requireFact(await io.realpath(directory) === directory, 'invalid_directory_scope')
    }
    const { info, bytes } = await io.boundedFile(env.SHELLBEAM_OPS_UI_FIXTURE)
    requireFact(info.uid === io.uid() && (info.mode & 0o777) === 0o600, 'invalid_manifest_ownership')
    const saved = probeFixtureScope(JSON.parse(bytes.toString('utf8')), env, temp)
    requireFact(JSON.stringify(scope) === JSON.stringify(saved), 'manifest_changed')
    const known = await io.boundedFile(fixture.observerKnownHostsPath)
    requireFact(known.info.uid === io.uid() && (known.info.mode & 0o777) === 0o600 && known.bytes.length > 0, 'invalid_known_hosts')

    const options = { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 16_384, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }
    async function inspect(host) {
      const file = await io.boundedFile(host.fragment)
      requireFact(file.info.uid === 0 && (file.info.mode & 0o777) === 0o644
        && createHash('sha256').update(file.bytes).digest('hex') === host.checksum, 'unit_file_mismatch')
      const content = file.bytes.toString('utf8')
      requireFact(content.split('\n').filter(line => line.startsWith('ExecStart=')).join('') === `ExecStart=/usr/sbin/sshd -D -e -f ${host.config}`
        && content.split('\n').filter(line => line.startsWith('Description=')).join('') === `Description=ShellBeam disposable UI SSH ${scope.fixtureId} ${host.role}`, 'unit_file_mismatch')
      const { stdout } = await io.exec('/usr/bin/systemctl', ['show', '--no-pager', '--property=Id,LoadState,ActiveState,FragmentPath,KillMode,ControlGroup,MainPID', '--', host.unit], options)
      return parseProbeUnitState(stdout, host)
    }
    for (const role of ROLES) await inspect(scope.hosts[role])
    const affected = new Set()
    let queue = Promise.resolve()
    const enqueue = fn => {
      const work = queue.catch(() => undefined).then(fn)
      queue = work.then(() => undefined, () => undefined)
      return work.catch(() => { throw fail('control_failed') })
    }
    function controlHost(role) {
      requireFact(Object.hasOwn(CONTROL_ROLES, role), 'invalid_role')
      return scope.hosts[CONTROL_ROLES[role]]
    }
    async function until(test) {
      const deadline = io.now() + 15_000
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await test()) return
        if (io.now() >= deadline) break
        await io.delay(100)
      }
      throw fail('verification_timeout')
    }
    async function start(role) {
      const host = controlHost(role)
      requireFact(affected.has(role), 'invalid_transition')
      await inspect(host)
      const boundary = io.now()
      await io.exec('/usr/bin/sudo', ['-n', '--', '/usr/bin/systemctl', 'start', '--', host.unit], options)
      await until(async () => {
        const state = await inspect(host)
        return state.activeState === 'active' && state.mainPid > 0 && (await io.inspectEndpoint(host)).ready === true
      })
      affected.delete(role)
      await record('probe-fixture-restored', { role, restored: true })
      return { role, ready: true, restored: true, boundary }
    }
    return {
      verify(role) {
        return enqueue(async () => {
          const host = controlHost(role)
          const state = await inspect(host)
          requireFact(state.activeState === 'active' && state.mainPid > 0 && (await io.inspectEndpoint(host)).ready === true, 'endpoint_not_ready')
          return { role, available: true }
        })
      },
      stop(role) {
        return enqueue(async () => {
          const host = controlHost(role)
          requireFact(!affected.has(role), 'invalid_transition')
          await inspect(host)
          const boundary = io.now()
          // Register before exec: even a timed-out stop may have killed the
          // daemon. The caller's finally must attempt an exact owned restart.
          affected.add(role)
          await io.exec('/usr/bin/sudo', ['-n', '--', '/usr/bin/systemctl', 'stop', '--', host.unit], options)
          await until(async () => {
            const state = await inspect(host)
            return ['inactive', 'failed'].includes(state.activeState) && state.mainPid === 0
              && (await io.inspectEndpoint(host)).refused === true && await io.readEmptyCgroup(state.controlGroup)
          })
          await record('probe-fixture-stopped', { role, stopped: true })
          return { role, stopped: true, boundary }
        })
      },
      start(role) { return enqueue(() => start(role)) },
      restore() {
        return enqueue(async () => {
          let failed = false
          const count = affected.size
          for (const role of [...affected]) { try { await start(role) } catch { failed = true } }
          requireFact(!failed, 'restore_failed')
          return { restored: true, count }
        })
      },
    }
  } catch { throw fail('initialization_failed') }
}
