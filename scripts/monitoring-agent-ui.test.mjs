import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rawCpuSamples, verifyFreshCpu, verifyServerIdentity, serverIdentity, reviewed } from './monitoring-agent-ui-evidence.mjs'
import { verifyMonitoringAgentUiReport } from './monitoring-agent-ui-report.mjs'
import { verifyAgentAuditScope, verifyAgentPolicyReadback } from './monitoring-agent-ui-journey.mjs'

test('policy readback requires a new native result, not an enabled pre-click frame or an existing draft', async () => {
  let phase = 'empty', stored = 'custom', clicks = 0, alert = false, key = 'public-key'
  const driver = {
    click: async () => { phase = 'pre-click'; clicks++ },
    isEnabled: async () => phase !== 'reading',
    until: async check => {
      assert.equal(await check(), false) // Enabled, but native read has not started.
      phase = 'reading'; assert.equal(await check(), false)
      phase = 'complete'; assert.equal(await check(), true)
    },
    attr: async selector => { assert.equal(phase, 'complete'); return selector === 'key' ? key : stored },
    findAll: async selector => selector === 'alert' ? (phase === 'complete' && alert ? ['error'] : []) : (phase === 'complete' ? ['source'] : []),
  }
  await verifyAgentPolicyReadback(driver, 'load', 'source', 'custom')
  assert.equal(clicks, 1)
  await assert.rejects(verifyAgentPolicyReadback(driver, 'load', 'source', 'custom'), /draft_not_discarded/)
  assert.equal(clicks, 1) // A pre-existing draft never triggers another read.
  phase = 'empty'; stored = 'official'
  await assert.rejects(verifyAgentPolicyReadback(driver, 'load', 'source', 'custom'), /policy_source_readback/)
  assert.equal(clicks, 2)
  phase = 'empty'; stored = 'custom'
  await verifyAgentPolicyReadback(driver, 'load', 'source', 'custom', [['key', 'public-key']], 'alert')
  phase = 'empty'; key = 'different-key'
  await assert.rejects(verifyAgentPolicyReadback(driver, 'load', 'source', 'custom', [['key', 'public-key']], 'alert'), /field_readback/)
  phase = 'empty'; key = 'public-key'; alert = true
  await assert.rejects(verifyAgentPolicyReadback(driver, 'load', 'source', 'custom', [['key', 'public-key']], 'alert'), /read_error/)
})

test('persisted audit scope binds the original Vault, host, action and route', () => {
  const expected = { hostId: 'host-a', action: 'monitoring.agent.install', transport: 'ssh-direct' }
  const actual = { ...expected, vaultId: '00000000-0000-0000-0000-000000000001' }
  const owner = verifyAgentAuditScope(actual, expected)
  assert.equal(verifyAgentAuditScope(actual, expected, owner), owner)
  for (const key of ['vaultId', 'hostId', 'action', 'transport']) assert.throws(() => verifyAgentAuditScope({ ...actual, [key]: 'other' }, expected, owner))
  assert.throws(() => verifyAgentAuditScope({ ...actual, vaultId: '00000000-0000-0000-0000-000000000002' }, expected, owner), /vault_changed/)
  const personal = { ...actual, vaultId: 'personal' }
  assert.equal(verifyAgentAuditScope(personal, expected), 'personal')
  assert.equal(verifyAgentAuditScope(personal, expected, 'personal'), 'personal')
  assert.throws(() => verifyAgentAuditScope(actual, expected, 'personal'), /vault_changed/)
  assert.throws(() => verifyAgentAuditScope(personal, expected, owner), /vault_changed/)
  for (const vaultId of [undefined, null, '', 'unknown']) assert.throws(() => verifyAgentAuditScope({ ...actual, vaultId }, expected), /vault_missing/)
})

test('original CPU proof accepts real zero but rejects heartbeat substitution and wrong node', () => {
  const time = '2026-10-23T06:00:00Z'
  assert.deepEqual(rawCpuSamples({ data: [{ uuid: 'n', cpu: { usage: 0 }, updated_at: time }] }, 'n'), [{ cpu: 0, time: Date.parse(time) }])
  assert.deepEqual(rawCpuSamples({ result: [{ uuid: 'n', cpu: {}, updated_at: time }, { uuid: 'n', load: 1, updated_at: time }] }, 'n'), [])
  assert.throws(() => rawCpuSamples({ uuid: 'other', cpu: { usage: 10 }, updated_at: time }, 'n'), /node_mismatch/)
  assert.throws(() => rawCpuSamples({ uuid: 'n', cpu: { usage: 10 } }, 'n'), /original_time_missing/)
  assert.throws(() => verifyFreshCpu({ cpu: 10, time: 100 }, { before: 100, started: 90, verifiedAt: 110 }), /not_fresh/)
  assert.throws(() => verifyFreshCpu({ cpu: 10, time: 100 }, { before: 0, started: 90, verifiedAt: 60101 }), /not_fresh/)
})
test('server compatibility version alone never identifies a ShellBeam build', () => {
  verifyServerIdentity({ ...serverIdentity })
  for (const key of Object.keys(serverIdentity)) assert.throws(() => verifyServerIdentity({ ...serverIdentity, [key]: 'other' }), /identity/)
})
test('runner refuses the real desktop before creating infrastructure', () => {
  const r = spawnSync('bash', ['scripts/ci-monitoring-agent-ui.sh'], { env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'false' }, encoding: 'utf8' })
  assert.equal(r.status, 1); assert.match(r.stdout, /requires opt-in/)
})
const names = ['agent-fresh-install', 'agent-old-install', 'agent-upgraded', 'agent-rolled-back', 'agent-reupgrade-recovered']
const report = () => ({
  success: true, cleanup: true, applicationStopped: true, headCommit: 'a'.repeat(40), checkedOutCommit: 'b'.repeat(40),
  journey: { passed: true, installedPackage: true, productionIpc: true, realVault: true, nativeShellBeamPages: true, installs: 2, upgrades: 2, rollbacks: 1, readonlyRecovery: 1, restoredAuditJobs: 8, noReplayMs: 5000 },
  screenshots: [...names, 'agent-audit-restored'].map(n => ({ file: n + '.png', sha256: 'a'.repeat(64), bytes: 10000, width: 1280, height: 900 })),
  events: [
    ...[0, 1].map(service => ({ name: 'agent-server-identity-verified', service, commit: serverIdentity.hash, product: serverIdentity.product, binarySha256: 'e'.repeat(64) })),
    { name: 'agent-production-release-verified', keyId: 'compatible-probe-2026-01', sequence: 1792594908585, version: '1.5.12', signatureVerified: true, historicalCatalogPinned: true, architecture: 'amd64' },
    { name: 'agent-no-user-key-configuration', passed: true },
    ...names.map((name, i) => { const version = [1, 3].includes(i) ? '1.5.11' : '1.5.12'; return { name, version, originalSampleAt: 12000, cpu: 12, before: 11000, started: 11500, verifiedAt: 12500, processSha256: reviewed[version].amd64.sha256, configurationRetained: true, nodeAndTokenRetained: true } }),
    { name: 'agent-interrupted-readonly-recovery', passed: true, noReplayMs: 5000, unknownAuditRetained: true },
    { name: 'agent-audit-restored', passed: true, noReplayMs: 5000, sameVaultOwnerRetained: true, auditScopesRetained: true, allProbesStopped: true, nodeCredentialsAndHistoryRetained: true, jobs: ['install', 'install', 'upgrade', 'rollback', 'upgrade', 'inspect', 'uninstall', 'uninstall'].map((action, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, hostId: `10000000-0000-0000-0000-00000000000${[0, 6].includes(i) ? 1 : 2}`, action: `monitoring.agent.${action}`, transport: [0, 6].includes(i) ? 'ssh-direct' : 'ssh-proxyjump', status: i === 4 ? 'unknown' : 'completed' })), auditRowVisible: true, auditRowJobId: '00000000-0000-0000-0000-000000000004', auditRowStatus: 'unknown' },
    ...['source', 'target'].map(role => ({ name: 'agent-history-retained', role, originalBuckets: [60000], retainedBuckets: 1, checkedAt: 120000 })),
    { name: 'transfer-fixture-cleaned', containersRemoved: true, networkRemoved: true, serversStopped: true },
  ],
})
test('complete synthetic report contract is accepted', () => assert(verifyMonitoringAgentUiReport(report())))
for (const [name, edit] of [
  ['unpromoted feed', r => { r.events[2].version = '1.5.11' }],
  ['changed production root', r => { r.events[2].keyId = 'fixture-key' }],
  ['wrong executable despite new version', r => { r.events[4].processSha256 = reviewed['1.5.11'].amd64.sha256 }],
  ['missing raw CPU', r => { delete r.events[4].cpu }],
  ['cached sample', r => { r.events[4].originalSampleAt = r.events[4].before }],
  ['changed configuration', r => { r.events[6].configurationRetained = false }],
  ['rewritten unknown audit', r => { r.events[10].jobs[4].status = 'completed' }],
  ['duplicate audit', r => { r.events[10].jobs[2] = r.events[10].jobs[1] }],
  ['changed Vault owner', r => { r.events[10].sameVaultOwnerRetained = false }],
  ['unverified audit scope', r => { r.events[10].auditScopesRetained = false }],
  ['audit action changed', r => { r.events[10].jobs[4].action = 'monitoring.agent.inspect' }],
  ['audit route changed', r => { r.events[10].jobs[1].transport = 'ssh-direct' }],
  ['audit host missing', r => { delete r.events[10].jobs[0].hostId }],
  ['partial visibility', r => { r.events[10].auditRowVisible = false }],
  ['history missing', r => { r.events[11].originalBuckets = [] }],
  ['not installed app', r => { r.journey.productionIpc = false }],
  ['no recovery', r => { r.journey.readonlyRecovery = 0 }],
  ['no replay window', r => { r.events[9].noReplayMs = 0 }],
  ['server substitution', r => { r.events[0].commit = 'b'.repeat(40) }],
  ['incomplete screenshots', r => { r.screenshots.pop() }],
  ['server running', r => { r.events.at(-1).serversStopped = false }],
  ['app running', r => { r.applicationStopped = false }],
]) test(`report rejects ${name}`, () => { const r = report(); edit(r); assert.throws(() => verifyMonitoringAgentUiReport(r)) })
