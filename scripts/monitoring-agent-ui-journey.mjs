// Installed production app, real SSH/systemd and original server observations.
// All lifecycle changes, release policy and Vault recovery use visible UI.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { openTransferTools, revealTransferObservations } from './probe-transfer-ui-journey.mjs'
import { wait } from './probe-transfer-ui-fixture.mjs'
import { downloadPinned } from './prepare-komari-agent-release.mjs'
import { verifyCompatibleCatalog } from './publish-komari-agent.mjs'
import { historicalCatalog, historicalCatalogPin, rawCpuSamples, reviewed, verifyFreshCpu } from './monitoring-agent-ui-evidence.mjs'
import { revealExtensionAudit } from './extension-ui-journey.mjs'

export function verifyAgentAuditScope(actual, expected, vaultId) {
  // The product's default Vault is "personal"; additional Vaults use UUIDs.
  assert(actual.vaultId === 'personal' || /^[a-f0-9-]{36}$/.test(actual.vaultId), 'agent_ui_audit_vault_missing')
  if (vaultId) assert.equal(actual.vaultId, vaultId, 'agent_ui_audit_vault_changed')
  for (const key of ['hostId', 'action', 'transport']) assert.equal(actual[key], expected[key], `agent_ui_audit_${key}_changed`)
  return actual.vaultId
}

async function readAgentPolicy(d, load, select, alerts) {
  // A fresh panel has no policy form until the native read returns. An enabled
  // button alone can still be the pre-click frame before React commits busy.
  assert.equal((await d.findAll(select)).length, 0, 'agent_ui_policy_draft_not_discarded')
  await d.click(load)
  await d.until(async () => {
    if (alerts) assert.equal((await d.findAll(alerts)).length, 0, 'agent_ui_policy_read_error')
    return (await d.findAll(select)).length === 1 && await d.isEnabled(load)
  })
}
export async function verifyAgentPolicyReadback(d, load, select, source, fields = [], alerts) {
  await readAgentPolicy(d, load, select, alerts)
  const actual = await d.attr(select, 'value')
  assert.equal(actual, source, 'agent_ui_policy_source_readback')
  for (const [selector, expected] of fields) assert.equal(await d.attr(selector, 'value'), expected, 'agent_ui_policy_field_readback')
}

const id = name => `[data-testid="${name}"]`
const panel = h => `${id('host-card')}[data-host-id="${h.id}"] ${id('compatible-agent-panel')}`
const control = (h, name) => `${panel(h)} ${id('compatible-agent-' + name)}`
async function confirm(d, names, accept = true) {
  const dialog = `dialog[open] ${id('user-confirmation')}`
  await d.waitFor(dialog, { timeoutMs: 120000 }); assert.equal(await d.attr(dialog, 'data-risk'), 'high')
  const message = await d.text(id('user-confirmation-message'))
  for (const name of names) assert(message.includes(name), 'agent_ui_confirmation_scope')
  await d.click(id('user-confirmation-' + (accept ? 'accept' : 'cancel')))
  await d.until(async () => !(await d.findAll(dialog)).length)
}
async function policy(d, h, f, source) {
  await openTransferTools(d, h)
  const box = control(h, 'policy')
  const tools = `${id('host-card')}[data-host-id="${h.id}"] ${id('compatible-agent-tools')}`
  const reopen = async () => {
    // Use the real disclosure to unmount the editor, not a second read over
    // the same draft. No IPC, state injection or replayed save is involved.
    await d.click(tools + ' > summary')
    await d.until(async () => !(await d.findAll(panel(h))).length)
    await d.click(tools + ' > summary'); await d.waitFor(panel(h))
    await d.click(box + ' > summary')
  }
  await reopen()
  await readAgentPolicy(d, control(h, 'policy-load'), control(h, 'policy-source'), panel(h) + ' [role="alert"]')
  await d.select(control(h, 'policy-source'), source)
  const fields = source === 'custom' ? Object.entries({ manifestUrl: historicalCatalog, trustedPublicKey: f.trust.publicKey, allowedHosts: f.trust.allowedHosts.join(', ') }).map(([key, value]) => [control(h, 'policy-' + key), value]) : []
  if (source === 'custom') {
    // Public production key and immutable original catalog, never a fixture key
    // or a rollback of the current production catalog / monotonic watermark.
    for (const [selector, value] of fields) {
      await d.fill(selector, value, { keyboardClear: true })
      assert.equal(await d.attr(selector, 'value'), value, 'agent_ui_policy_field_not_entered')
    }
  }
  assert.equal(await d.attr(control(h, 'policy-source'), 'value'), source, 'agent_ui_policy_source_not_selected')
  assert(await d.isSelected(box + ' input[type="checkbox"]'), 'agent_ui_policy_disabled')
  await d.click(control(h, 'policy-save')); await confirm(d, ['trusted publisher and download sources'])
  await d.until(async () => {
    assert.equal((await d.findAll(panel(h) + ' [role="alert"]')).length, 0, 'agent_ui_policy_save_error')
    for (const status of await d.findAll(panel(h) + ' [role="status"]')) {
      if (await d.text(status) === 'Release trust saved.' && await d.isEnabled(control(h, 'policy-save'))) return true
    }
    return false
  })
  await reopen()
  await verifyAgentPolicyReadback(d, control(h, 'policy-load'), control(h, 'policy-source'), source, fields, panel(h) + ' [role="alert"]')
  await d.click(box + ' > summary')
}
async function audit(d, jobs, vaultId) {
  await d.click(id('pc-dashboard')); await d.click(id('pc-nav-activity')); await d.click(id('history-tab-audit')); await d.click(id('audit-tab')); await d.click(id('operations-refresh'))
  const found = new Set(); let selected
  for (let page = 0; page < 20; page++) {
    await d.waitFor(id('operation-audit-row')); selected = undefined
    for (const row of await d.findAll(id('operation-audit-row'))) {
      const job = await d.attr(row, 'data-job-id'), status = await d.attr(row, 'data-status')
      const expected = jobs.get(job)
      if (expected?.status === status) {
        const actual = { vaultId: await d.attr(row, 'data-vault-id'), hostId: await d.attr(row, 'data-host-id'), action: await d.attr(row, 'data-action'), transport: await d.attr(row, 'data-transport') }
        vaultId = verifyAgentAuditScope(actual, expected, vaultId)
        found.add(job); selected = { id: job, status, vaultId }
      }
    }
    if (found.size === jobs.size) { assert(selected); return selected }
    if (!await d.isEnabled(id('operations-older'))) break
    const before = await d.text(id('operations-page')); await d.click(id('operations-older')); await d.until(async () => await d.text(id('operations-page')) !== before)
  }
  assert.fail('agent_ui_persisted_audit_missing')
}
export async function runMonitoringAgentUiJourney({ driver, fixture: f, state: session, record, restart, checkpoint }) {
  let d = driver
  assert.equal(f.release.version, '1.5.13', 'agent_ui_production_release_not_promoted')
  const oldBytes = await downloadPinned(historicalCatalog, historicalCatalogPin, 65536), oldRaw = JSON.parse(oldBytes)
  // Historical catalog is pinned byte-for-byte. Check its signatures at issue
  // time, as a historical document; current official feed still uses wall time.
  const old = verifyCompatibleCatalog(oldRaw, f.trust, oldRaw.publishedAt).artifacts.find(m => m.architecture === f.architecture)
  assert.equal(old.version, '1.5.11'); assert.equal(old.sha256, reviewed['1.5.11'][f.architecture].sha256)
  const { source: fresh, target: upgrade } = f.hosts, jobs = new Map(), original = new Map()
  let vaultId
  record('agent-production-release-verified', { keyId: f.trust.keyId, sequence: f.catalog.sequence, version: f.release.version, architecture: f.architecture, signatureVerified: true, historicalCatalogPinned: true, server: 'ShellBeam Server' })
  const snapshot = () => Object.fromEntries(Object.values(f.hosts).map(h => [h.role, f.observe(h)]))
  const stable = async before => { await delay(5000); assert.deepEqual(snapshot(), before, 'agent_ui_unexpected_remote_replay') }
  const sample = async h => rawCpuSamples((await f.servers[h.service].request(`/api/recent/${h.node}`)).value, h.node).sort((a, b) => b.time - a.time)[0]
  const remember = async (h, action, status = 'completed') => {
    const job = await d.attr(panel(h), 'data-job-id'); assert(/^[a-f0-9-]{36}$/.test(job)); assert(!jobs.has(job), 'agent_ui_reused_audit')
    jobs.set(job, { status, hostId: h.id, action: `monitoring.agent.${action}`, transport: h.jump ? 'ssh-proxyjump' : 'ssh-direct' }); return job
  }
  const prove = async (h, version, before, started, name) => {
    const pin = reviewed[version][f.architecture]
    const evidence = await wait(async () => {
      const cpu = await sample(h), states = f.observe(h), active = states.filter(s => s.processes.length)
      if (!cpu || cpu.time <= before || cpu.time < started - 5000 || cpu.time < Date.now() - 60000 || active.length !== 1) return false
      const value = active[0]; assert.equal(value.processes.length, 1); assert.equal(value.processes[0].sha256, pin.sha256); assert.equal(value.version, version)
      const verifiedAt = Date.now(); verifyFreshCpu(cpu, { before, started, verifiedAt })
      const node = await h.rpc('admin:getClient'); assert.equal(node.uuid, h.node); assert.equal(node.created_at, h.original.created_at); assert.equal(node.version.replace(/^v/, ''), version)
      await f.retained()
      if (original.has(h.role)) { assert.equal(value.deployment, original.get(h.role).deployment); assert.equal(value.configSha256, original.get(h.role).configSha256) } else original.set(h.role, value)
      return { version, cpu: cpu.cpu, originalSampleAt: cpu.time, before, started, verifiedAt, processSha256: value.processes[0].sha256, configurationRetained: true, nodeAndTokenRetained: true }
    }, 90000)
    await h.history.capture()
    assert.equal(await d.attr(panel(h), 'data-version'), version)
    assert.equal(await d.attr(panel(h), 'data-product'), version === '1.5.13' ? 'shellbeam' : 'upstream')
    assert((await d.text(control(h, 'origin'))).includes(version === '1.5.13' ? 'ShellBeam Monitoring Agent' : 'Komari Agent (compatible)'))
    record(name, evidence)
    await revealTransferObservations(d, control(h, 'identity'), control(h, 'endpoint') + ' + span')
    for (const field of await d.findAll('input[type="password"],textarea,#komari-api-key')) assert(!await d.attr(field, 'value'), 'agent_ui_secret_visible')
    assert.equal((await d.findAll('iframe')).length, 0)
    await checkpoint(name)
  }
  const operate = async (h, action, version, name) => {
    await openTransferTools(d, h)
    if (action === 'install' || action === 'adopt') await d.fill(control(h, 'endpoint'), f.servers[h.service].agentEndpoint)
    if (action === 'adopt') {
      const handoff = `${panel(h)} [data-testid="compatible-agent-handoff"]`
      if (await d.attr(handoff, 'open') === null) await d.click(handoff + ' > summary')
      await d.fill(`${panel(h)} input[aria-label="Existing systemd service"]`, legacy.unit)
    }
    const before = (await sample(h))?.time ?? 0, started = Date.now()
    await d.click(action === 'adopt' ? `${panel(h)} button[data-testid="compatible-agent-adopt"]` : control(h, action)); await confirm(d, [h.name, h.node, version])
    await d.until(async () => await d.attr(panel(h), 'data-status') === 'active' && await d.attr(panel(h), 'data-version') === version && await d.isEnabled(control(h, 'inspect')), { timeoutMs: 120000 })
    await remember(h, action); await prove(h, version, before, started, name)
  }
  // Fresh production install has never opened or configured publisher policy.
  await operate(fresh, 'install', '1.5.13', 'agent-fresh-install')
  // Capture the real owner from the first persisted audit before any restart;
  // subsequent reads must retain that owner and each operation's host/route.
  vaultId = (await audit(d, jobs)).vaultId
  record('agent-no-user-key-configuration', { passed: true })
  const legacy = await f.prepareLegacy(upgrade, old)
  await policy(d, upgrade, f, 'custom')
  await operate(upgrade, 'adopt', '1.5.11', 'agent-existing-adopted')
  legacy.retained()
  record('agent-legacy-checkpoint-preserved', { passed: true, sameReviewedBinary: true, originalFilesRetained: true })
  await policy(d, upgrade, f, 'official'); await operate(upgrade, 'upgrade', '1.5.13', 'agent-upgraded')
  assert.equal(await d.attr(panel(upgrade), 'data-previous-version'), '1.5.11')
  await operate(upgrade, 'rollback', '1.5.11', 'agent-rolled-back')
  assert.equal(await d.attr(panel(upgrade), 'data-previous-version'), '1.5.13')
  const before = (await sample(upgrade)).time, started = Date.now(), release = f.hold(upgrade, '1.5.13')
  await d.click(control(upgrade, 'upgrade')); await confirm(d, [upgrade.name, upgrade.node, '1.5.13'])
  await wait(() => f.servers[upgrade.service].gate.held > 0, 120000)
  assert.equal(f.observe(upgrade)[0].processes[0].sha256, f.release.sha256)
  const interrupted = snapshot(); d = await restart(session.password); release(); await stable(interrupted)
  await openTransferTools(d, upgrade); assert(['dispatched', 'unknown'].includes(await d.attr(panel(upgrade), 'data-status')))
  const unknown = await remember(upgrade, 'upgrade', 'unknown'); await audit(d, new Map([[unknown, jobs.get(unknown)]]), vaultId)
  await openTransferTools(d, upgrade); await d.click(control(upgrade, 'inspect'))
  await d.until(async () => await d.attr(panel(upgrade), 'data-status') === 'active' && await d.isEnabled(control(upgrade, 'inspect')), { timeoutMs: 120000 })
  await remember(upgrade, 'inspect'); await stable(interrupted)
  await prove(upgrade, '1.5.13', before, started, 'agent-reupgrade-recovered')
  assert.equal(await d.attr(panel(upgrade), 'data-previous-version'), '1.5.11')
  record('agent-interrupted-readonly-recovery', { passed: true, noReplayMs: 5000, unknownAuditRetained: true })
  for (const h of [fresh, upgrade]) {
    await openTransferTools(d, h); await d.click(control(h, 'uninstall')); await confirm(d, [h.name, h.node])
    await d.until(async () => await d.attr(panel(h), 'data-status') === 'retired' && await d.isEnabled(control(h, 'inspect')), { timeoutMs: 120000 }); await remember(h, 'uninstall')
    assert(f.observe(h).every(s => s.processes.length === 0)); assert.equal(f.observe(h)[0].configSha256, original.get(h.role).configSha256)
    record('agent-history-retained', { role: h.role, ...await h.history.retained() })
  }
  legacy.retained(); await f.retained(); const final = snapshot(); d = await restart(session.password); await stable(final)
  assert.equal(jobs.size, 8); const selected = await audit(d, jobs, vaultId); const visible = await revealExtensionAudit(d, selected)
  await checkpoint('agent-audit-restored')
  record('agent-audit-restored', { ...visible, passed: true, noReplayMs: 5000, jobs: [...jobs].map(([id, scope]) => ({ id, ...scope })), sameVaultOwnerRetained: true, auditScopesRetained: true, allProbesStopped: true, nodeCredentialsAndHistoryRetained: true })
  return { passed: true, installedPackage: true, productionIpc: true, realVault: true, nativeShellBeamPages: true, installs: 1, adoptions: 1, upgrades: 2, rollbacks: 1, readonlyRecovery: 1, restoredAuditJobs: 8, noReplayMs: 5000 }
}
