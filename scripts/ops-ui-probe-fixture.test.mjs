// Protocol/file-state tests only. No SSH daemon, sudo or systemd runs here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createOpsUiProbeFixture, parseProbeUnitState, probeFixtureScope, requireProbeFixtureEnvironment } from './ops-ui-probe-fixture.mjs'

const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', SHELLBEAM_OPS_UI_LIVE: '1',
  SHELLBEAM_OPS_UI_UID: '1001', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: '/tmp/owned-runner',
  SHELLBEAM_OPS_UI_FIXTURE: '/tmp/owned-runner/shellbeam-ops-ui-live-123-1-a1b2c3d4/desktop/fixture.json' }
const clone = value => JSON.parse(JSON.stringify(value))
function protocol() {
  const fixtureId = 'shellbeam-ops-ui-live-123-1-a1b2c3d4'
  const root = `/tmp/owned-runner/${fixtureId}`
  const desktop = `${root}/desktop`
  const unitFiles = new Map()
  const state = new Map()
  const fixture = { schemaVersion: 1, sharedKernel: true, fixtureId, rootFixtureDir: root, desktopDir: desktop,
    observerKnownHostsPath: `${desktop}/observer-known-hosts`, hosts: {} }
  for (const [index, role] of ['jump', 'direct', 'via'].entries()) {
    const unit = `shellbeam-ui-ssh-123-1-a1b2c3d4-${role}.service`
    const content = `[Unit]\nDescription=ShellBeam disposable UI SSH ${fixtureId} ${role}\n[Service]\nType=exec\nExecStart=/usr/sbin/sshd -D -e -f ${root}/root/${role}/sshd_config\nRestart=no\nKillMode=control-group\nTimeoutStopSec=5\n`
    const bytes = Buffer.from(content)
    unitFiles.set(`/etc/systemd/system/${unit}`, { info: { uid: 0, mode: 0o100644 }, bytes })
    fixture.hosts[role] = { address: '127.0.0.1', user: 'root', port: 22001 + index,
      sshdUnit: unit, sshdUnitSha256: createHash('sha256').update(bytes).digest('hex'),
      privateKeyPath: `${desktop}/keys/${role}.pem`, observerKnownHostsPath: fixture.observerKnownHostsPath }
    state.set(unit, { activeState: 'active', mainPid: 100 + index, controlGroup: `/system.slice/${unit}` })
  }
  const calls = []
  const records = []
  let now = 1000
  let stopError = false
  let startError = false
  let listenerStillOpen = false
  let unknownSocket = false
  let residualProcess = false
  let manifest = fixture
  let unitFields = {}
  let directoryOverride
  const scope = probeFixtureScope(fixture, env, env.RUNNER_TEMP)
  const deps = {
    platform: 'linux', uid: () => 1001,
    readFile: async filename => {
      assert.equal(filename, '/etc/os-release')
      return 'ID=ubuntu\nVERSION_ID="22.04"\n'
    },
    realpath: async filename => filename,
    lstat: async filename => {
      assert([env.RUNNER_TEMP, root, desktop, '/etc/systemd/system'].includes(filename))
      return directoryOverride?.(filename) ?? { isDirectory: () => true, isSymbolicLink: () => false,
        uid: filename === desktop ? 1001 : 0, mode: filename === root ? 0o40711 : filename === desktop ? 0o40700 : 0o40755 }
    },
    boundedFile: async filename => {
      if (filename === env.SHELLBEAM_OPS_UI_FIXTURE) return { info: { uid: 1001, mode: 0o100600 }, bytes: Buffer.from(JSON.stringify(manifest)) }
      if (filename === fixture.observerKnownHostsPath) return { info: { uid: 1001, mode: 0o100600 }, bytes: Buffer.from('owned known host\n') }
      assert(unitFiles.has(filename), 'only exact owned unit files may be read')
      return unitFiles.get(filename)
    },
    exec: async (command, args, options) => {
      calls.push({ command, args, options })
      const unit = args.at(-1)
      assert(state.has(unit), 'never invoke an arbitrary unit')
      if (command === '/usr/bin/systemctl') {
        assert.deepEqual(args.slice(0, -1), ['show', '--no-pager', '--property=Id,LoadState,ActiveState,FragmentPath,KillMode,ControlGroup,MainPID', '--'])
        const row = state.get(unit)
        const fields = { Id: unit, LoadState: 'loaded', ActiveState: row.activeState, FragmentPath: `/etc/systemd/system/${unit}`,
          KillMode: 'control-group', ControlGroup: row.controlGroup, MainPID: row.mainPid, ...unitFields }
        return { stdout: Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n') + '\n' }
      }
      assert.equal(command, '/usr/bin/sudo')
      assert(['stop', 'start'].includes(args[3]))
      assert.deepEqual(args, ['-n', '--', '/usr/bin/systemctl', args[3], '--', unit])
      const action = args[3]
      if (action === 'stop') {
        state.set(unit, { activeState: 'inactive', mainPid: 0, controlGroup: '' })
        if (stopError) throw new Error('PRIVATE_FAILED_COMMAND_OUTPUT')
      } else {
        if (startError) throw new Error('PRIVATE_FAILED_COMMAND_OUTPUT')
        state.set(unit, { activeState: 'active', mainPid: 123, controlGroup: `/system.slice/${unit}` })
      }
      return { stdout: '', stderr: '' }
    },
    inspectEndpoint: async host => {
      if (unknownSocket) return { refused: false, ready: false }
      const active = state.get(host.unit).activeState === 'active'
      return { refused: !active && !listenerStillOpen, ready: active || listenerStillOpen }
    },
    readEmptyCgroup: async controlGroup => {
      assert(Object.values(scope.hosts).some(host => `/system.slice/${host.unit}` === controlGroup))
      return !residualProcess
    },
    now: () => now,
    delay: async ms => { now += ms },
  }
  const mutations = () => calls.filter(call => call.command === '/usr/bin/sudo')
  return { fixture, scope, state, calls, records, deps, mutations, unitFiles,
    create: () => createOpsUiProbeFixture({ fixture, env, record: (name, details) => { records.push({ name, details }) } }, deps),
    setStopError: value => { stopError = value }, setStartError: value => { startError = value },
    setListenerStillOpen: value => { listenerStillOpen = value }, setUnknownSocket: value => { unknownSocket = value },
    setResidual: value => { residualProcess = value }, setManifest: value => { manifest = value },
    setUnitFields: value => { unitFields = value }, setDirectory: value => { directoryOverride = value },
  }
}

test('refuses workstations, self-hosted runners, root, missing opt-in and forged run identity before any effects', async () => {
  assert.doesNotThrow(() => requireProbeFixtureEnvironment(env, 'linux', 1001))
  for (const [patch, platform, uid] of [[{}, 'darwin', 1001], [{}, 'linux', 0], [{ RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 1001],
    [{ SHELLBEAM_OPS_UI_LIVE: '0' }, 'linux', 1001], [{ GITHUB_ACTIONS: 'false' }, 'linux', 1001],
    [{ GITHUB_RUN_ID: '123;other' }, 'linux', 1001], [{ SHELLBEAM_OPS_UI_UID: '0' }, 'linux', 1001],
    [{ WEBKIT_INSPECTOR_SERVER: '127.0.0.1:1' }, 'linux', 1001]]) {
    assert.throws(() => requireProbeFixtureEnvironment({ ...env, ...patch }, platform, uid), /ops_ui_probe_fixture_/)
  }
  const io = protocol()
  await assert.rejects(createOpsUiProbeFixture({ fixture: io.fixture, env: { ...env, SHELLBEAM_OPS_UI_LIVE: '0' } }, { ...io.deps, readFile: () => { throw new Error('must not read') } }), /requires_isolated_hosted_linux/)
  assert.deepEqual(io.calls, [])
})

test('manifest scope binds every unit to the exact generated run, role, loopback port and existing root tree', () => {
  const { fixture } = protocol()
  for (const change of [value => { value.fixtureId = value.fixtureId.replace('123-1-', '999-1-') },
    value => { value.rootFixtureDir += '/..' }, value => { value.observerKnownHostsPath = '/tmp/foreign' },
    value => { value.hosts.direct.address = '192.0.2.1' }, value => { value.hosts.via.port = value.hosts.direct.port },
    value => { value.hosts.jump.sshdUnit = 'ssh.service' }, value => { value.hosts.direct.sshdUnit = value.hosts.jump.sshdUnit },
    value => { value.hosts.direct.sshdUnitSha256 = 'not-a-hash' }]) {
    const altered = clone(fixture); change(altered)
    assert.throws(() => probeFixtureScope(altered, env, env.RUNNER_TEMP), /ops_ui_probe_fixture_/)
  }
})

test('unit inspection rejects a loaded alias, foreign fragment, different KillMode or escaped cgroup', () => {
  const { scope } = protocol()
  const host = scope.hosts.direct
  const valid = `Id=${host.unit}\nLoadState=loaded\nActiveState=active\nFragmentPath=${host.fragment}\nKillMode=control-group\nControlGroup=/system.slice/${host.unit}\nMainPID=123\n`
  assert.equal(parseProbeUnitState(valid, host).mainPid, 123)
  for (const invalid of [valid.replace(`Id=${host.unit}`, 'Id=ssh.service'), valid.replace(host.fragment, '/etc/systemd/system/ssh.service'),
    valid.replace('control-group', 'process'), valid.replace(`/system.slice/${host.unit}`, '/user.slice/foreign'),
    valid.replace('MainPID=123', 'MainPID=unavailable'), valid + 'MainPID=123\n', valid.replace('LoadState=loaded', 'LoadState=not-found')]) {
    assert.throws(() => parseProbeUnitState(invalid, host), /ops_ui_probe_fixture_/)
  }
})

test('initialization checks saved manifest, root ownership, mode, content hash and systemd identity before sudo', async () => {
  for (const mutate of [io => { const changed = clone(io.fixture); changed.hosts.direct.port++; io.setManifest(changed) },
    io => { io.unitFiles.get(io.scope.hosts.direct.fragment).info.uid = 1001 },
    io => { io.unitFiles.get(io.scope.hosts.direct.fragment).info.mode = 0o100666 },
    io => { io.unitFiles.get(io.scope.hosts.direct.fragment).bytes = Buffer.from('changed') },
    io => { io.setUnitFields({ FragmentPath: '/etc/systemd/system/ssh.service' }) },
    io => { io.setUnitFields({ KillMode: 'process' }) },
    io => { io.setDirectory(filename => filename === io.scope.root ? { isDirectory: () => true, isSymbolicLink: () => false, uid: 1001, mode: 0o40711 } : undefined) },
    io => { io.setDirectory(filename => filename === io.scope.root ? { isDirectory: () => true, isSymbolicLink: () => true, uid: 0, mode: 0o40711 } : undefined) }]) {
    const io = protocol(); mutate(io)
    await assert.rejects(io.create(), /initialization_failed/)
    assert.deepEqual(io.mutations(), [])
  }
})

test('direct faults only its SSHD and via faults only its jump SSHD, then restores both exact units', async () => {
  const io = protocol()
  const controller = await io.create()
  assert.deepEqual(await controller.verify('via'), { role: 'via', available: true })
  assert.deepEqual(await controller.stop('direct'), { role: 'direct', stopped: true, boundary: 1000 })
  assert.deepEqual(await controller.stop('via'), { role: 'via', stopped: true, boundary: 1000 })
  assert.equal(io.state.get(io.fixture.hosts.via.sshdUnit).activeState, 'active')
  assert.deepEqual(await controller.restore(), { restored: true, count: 2 })
  assert.deepEqual(io.mutations().map(call => [call.args[3], call.args.at(-1)]), [
    ['stop', io.fixture.hosts.direct.sshdUnit], ['stop', io.fixture.hosts.jump.sshdUnit],
    ['start', io.fixture.hosts.direct.sshdUnit], ['start', io.fixture.hosts.jump.sshdUnit],
  ])
  for (const call of io.calls) {
    assert.equal(call.options.timeout, 15_000)
    assert.equal(call.options.killSignal, 'SIGKILL')
    assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' })
  }
  assert.deepEqual(await controller.restore(), { restored: true, count: 0 })
  assert(io.records.every(row => ['probe-fixture-stopped', 'probe-fixture-restored'].includes(row.name)
    && ['direct', 'via'].includes(row.details.role) && !JSON.stringify(row).includes('/')))
})

test('refuses arbitrary roles and invalid transitions without a privileged mutation', async () => {
  const io = protocol(), controller = await io.create()
  for (const role of ['jump', 'ssh.service', 'direct;stop ssh', '../via', null, {}]) await assert.rejects(controller.stop(role), /control_failed/)
  await assert.rejects(controller.start('direct'), /control_failed/)
  assert.deepEqual(io.mutations(), [])
  await controller.stop('direct')
  await assert.rejects(controller.stop('direct'), /control_failed/)
  assert.equal(io.mutations().length, 1)
  await controller.start('direct')
  assert.deepEqual(await controller.verify('direct'), { role: 'direct', available: true })
})

test('rechecks unit identity immediately before a mutation', async () => {
  const io = protocol(), controller = await io.create()
  io.unitFiles.get(io.scope.hosts.direct.fragment).bytes = Buffer.from('replaced after initialization')
  await assert.rejects(controller.stop('direct'), /control_failed/)
  assert.deepEqual(io.mutations(), [])
})

for (const [name, configure] of [['reachable listener', io => io.setListenerStillOpen(true)],
  ['unknown socket outcome', io => io.setUnknownSocket(true)], ['residual cgroup process', io => io.setResidual(true)]]) {
  test(`a stopped systemd state without proof of ${name === 'residual cgroup process' ? 'empty process tree' : 'listener refusal'} cannot pass (${name})`, async () => {
    const io = protocol(), controller = await io.create()
    configure(io)
    await assert.rejects(controller.stop('direct'), /control_failed/)
    assert(!io.records.some(row => row.name === 'probe-fixture-stopped'))
    io.setListenerStillOpen(false); io.setUnknownSocket(false); io.setResidual(false)
    await controller.restore()
    assert.equal(io.state.get(io.fixture.hosts.direct.sshdUnit).activeState, 'active')
  })
}

test('a timed-out or rejected stop is still restored in finally, and raw command errors never escape', async () => {
  const io = protocol(), controller = await io.create()
  io.setStopError(true)
  await assert.rejects(controller.stop('via'), error => error.message === 'ops_ui_probe_fixture_control_failed')
  io.setStopError(false)
  assert.deepEqual(await controller.restore(), { restored: true, count: 1 })
  assert.equal(io.mutations().at(-1).args.at(-1), io.fixture.hosts.jump.sshdUnit)
  assert(!JSON.stringify(io.records).includes('PRIVATE'))
})

test('restoration tries every affected unit and retains a failed unit for another recovery attempt', async () => {
  const io = protocol(), controller = await io.create()
  await controller.stop('direct'); await controller.stop('via')
  io.setStartError(true)
  await assert.rejects(controller.restore(), /control_failed/)
  assert.equal(io.mutations().filter(call => call.args[3] === 'start').length, 2)
  io.setStartError(false)
  assert.deepEqual(await controller.restore(), { restored: true, count: 2 })
  assert.deepEqual(await controller.restore(), { restored: true, count: 0 })
})

test('overlapping stop/start calls are serialized so a late stop cannot undo recovery', async () => {
  const io = protocol(), controller = await io.create()
  const stopped = controller.stop('direct')
  const restored = controller.start('direct')
  assert.equal((await stopped).stopped, true)
  assert.equal((await restored).ready, true)
  assert.deepEqual(io.mutations().map(call => call.args[3]), ['stop', 'start'])
  assert.deepEqual(await controller.restore(), { restored: true, count: 0 })
})
