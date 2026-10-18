// These tests exercise refusal paths and the actual embedded report helper.
// They never bypass the Linux guard or start systemd, SSH, Xvfb or an app.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./ci-ops-ui-live.sh', import.meta.url))
const source = readFileSync(script, 'utf8')
const pythonBlocks = [...source.matchAll(/<<'PY'\n([\s\S]*?)\nPY/g)].map(match => match[1])
const reportHelper = pythonBlocks.find(body => body.includes('path, root, uid, gid, started, result, cleanup, stage ='))
assert(reportHelper, 'test must use the actual production report helper')

test('shell syntax and embedded Python compile without executing the fixture', () => {
  execFileSync('bash', ['-n', script], { stdio: 'pipe' })
  for (const body of pythonBlocks) {
    execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "fixture-helper", "exec")'], { input: body, stdio: 'pipe' })
  }
})

test('the actual manifest builder records independent generated SSHD units and their root-provided checksums', () => {
  const builder = pythonBlocks.find(body => body.includes("hosts['via']['jumpHostName']"))
  assert(builder)
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shellbeam-ui-manifest-test-')))
  try {
    const desktop = path.join(root, 'desktop'), keys = path.join(desktop, 'keys')
    mkdirSync(keys, { recursive: true })
    for (const role of ['jump', 'direct', 'via']) writeFileSync(path.join(keys, `${role}-host.pub`), `ssh-rsa ${Buffer.from('fixture public bytes').toString('base64')} fixture\n`)
    const fixtureId = 'shellbeam-ops-ui-live-123-1-a1b2c3d4'
    const filename = path.join(desktop, 'fixture.json')
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
    execFileSync('python3', ['-c', builder, filename, root, desktop, '/run/fixture', fixtureId, '/usr/bin/app', '/usr/bin/driver',
      path.join(root, 'report.json'), path.join(desktop, 'observer-known-hosts'), '22001', '22002', '22003',
      '00-shellbeam-ui-123-1-a1b2c3d4-direct.service', '00-shellbeam-ui-123-1-a1b2c3d4-via.service', ...hashes], { stdio: 'pipe' })
    const manifest = JSON.parse(readFileSync(filename, 'utf8'))
    for (const [index, role] of ['jump', 'direct', 'via'].entries()) {
      assert.equal(manifest.hosts[role].sshdUnit, `shellbeam-ui-ssh-123-1-a1b2c3d4-${role}.service`)
      assert.equal(manifest.hosts[role].sshdUnitSha256, hashes[index])
    }
    assert.equal(lstatSync(filename).mode & 0o777, 0o600)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const [name, values, reason] of [
  ['no opt-in', { GITHUB_ACTIONS: 'false', SHELLBEAM_OPS_UI_LIVE: '1' }, 'requires explicit GitHub Actions'],
  ['self-hosted', { GITHUB_ACTIONS: 'true', SHELLBEAM_OPS_UI_LIVE: '1', RUNNER_ENVIRONMENT: 'self-hosted' }, 'self-hosted runners'],
  ['non-Linux runner', { GITHUB_ACTIONS: 'true', SHELLBEAM_OPS_UI_LIVE: '1', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows' }, 'requires root on the disposable Linux runner'],
]) {
  test(`refuses ${name} before fixture setup`, () => {
    const result = spawnSync('bash', [script], { env: { ...process.env, ...values }, encoding: 'utf8', timeout: 5_000 })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert(result.stderr.includes(reason))
    assert(!result.stderr.includes('required dependency'))
  })
}

function fixture(run) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shellbeam-ui-report-test-')))
  chmodSync(root, 0o700)
  const filename = path.join(root, 'shellbeam-ops-ui-live-report.json')
  const started = String(BigInt(Date.now() - 1_000) * 1_000_000n)
  const invoke = (result = '0', cleanup = '0', stage = 'finalize') => spawnSync('python3', ['-c', reportHelper,
    filename, root, String(process.getuid()), String(process.getgid()), started, result, cleanup, stage,
  ], { encoding: 'utf8', timeout: 5_000 })
  const put = (value = { schemaVersion: 1, success: true, events: [{ name: 'real-ui-assertion' }], cleanup: 'pending' }) => {
    writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o644, flag: 'wx' })
    chmodSync(filename, 0o644)
  }
  try { run({ root, filename, invoke, put }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('successful cleanup retains UI assertions, separately records passed cleanup', () => fixture(({ filename, invoke, put }) => {
  put()
  assert.equal(invoke().status, 0)
  const report = JSON.parse(readFileSync(filename, 'utf8'))
  assert.equal(report.success, true)
  assert.equal(report.cleanup, 'passed')
  assert.deepEqual(report.events, [{ name: 'real-ui-assertion' }])
  assert.equal(lstatSync(filename).mode & 0o777, 0o644)
}))

for (const [name, result, cleanup] of [['cleanup failure', '0', '1'], ['runner failure', '1', '0']]) {
  test(`${name} cannot preserve success`, () => fixture(({ filename, invoke, put }) => {
    put()
    assert.equal(invoke(result, cleanup).status, 0)
    const report = JSON.parse(readFileSync(filename, 'utf8'))
    assert.equal(report.success, false)
    assert.equal(report.cleanup, cleanup === '0' ? 'passed' : 'failed')
  }))
}

test('missing report becomes a failed bounded report, never an inferred UI success', () => fixture(({ filename, invoke }) => {
  assert.equal(invoke('1', '0', 'check').status, 0)
  assert.equal(existsSync(filename), false)
  assert.equal(invoke('1').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')), {
    schemaVersion: 1, success: false, events: [], cleanup: 'passed', reason: 'ui-runner-did-not-complete',
  })
}))

test('check mode validates without changing a pending report', () => fixture(({ filename, invoke, put }) => {
  put()
  const before = readFileSync(filename, 'utf8')
  assert.equal(invoke('0', '0', 'check').status, 0)
  assert.equal(readFileSync(filename, 'utf8'), before)
}))

for (const kind of ['symlink', 'hardlink', 'stale', 'private-mode', 'invalid-schema', 'oversized']) {
  test(`refuses ${kind} reports without altering their contents`, () => fixture(({ root, filename, invoke, put }) => {
    let outside
    if (kind === 'symlink' || kind === 'hardlink') {
      outside = path.join(root, 'unrelated.json')
      writeFileSync(outside, '{"mustRemain":true}\n', { mode: 0o644 })
      chmodSync(outside, 0o644)
      if (kind === 'symlink') symlinkSync(outside, filename)
      else linkSync(outside, filename)
    } else {
      put(kind === 'invalid-schema' ? { schemaVersion: 2, success: true } : undefined)
      if (kind === 'stale') utimesSync(filename, new Date(0), new Date(0))
      if (kind === 'private-mode') chmodSync(filename, 0o600)
      if (kind === 'oversized') writeFileSync(filename, 'x'.repeat(262_145))
    }
    const before = readFileSync(filename, 'utf8')
    assert.notEqual(invoke('0', '1').status, 0)
    assert.equal(readFileSync(filename, 'utf8'), before)
    if (outside) assert.equal(readFileSync(outside, 'utf8'), '{"mustRemain":true}\n')
  }))
}
