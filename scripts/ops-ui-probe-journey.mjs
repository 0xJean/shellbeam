// Real UI-only SSH ProbeProvider acceptance. No IPC, storage, provider event,
// application database or remote output is replaced. The injected checkpoint
// controls only the disposable fixture's existing exact SSHD services.
import { createHash } from 'node:crypto'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { closeOpsUiHostDrawer, findOpsUiAuditRow, respondOpsUiConfirmation, revealOpsUiHostActions, validateOpsUiServiceRect, waitForOpsUiConfirmation } from './ops-ui-journey.mjs'
import { ensureOpsUiHostDetails, isOpsUiHostDetailsVisible, waitForOpsUiHostOperations } from './ops-ui-host-details.mjs'

const ROLES = Object.freeze(['direct', 'via'])
const route = (role) => role === 'via' ? 'proxy-jump' : 'direct'
const q = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const tid = (name) => `[data-testid=${q(name)}]`
const card = (state, role) => `${tid('host-card')}[data-host-id=${q(state.hostIds[role])}]`
const digest = createHash('sha256').update(JSON.stringify(['ssh-agentless', 'ssh-agentless'])).digest('hex').slice(0, 32)
export const OPS_UI_PROBE_RULE_IDS = Object.freeze({ metrics: `probe:ssh-agentless:${digest}:metrics`, inventory: `probe:ssh-agentless:${digest}:inventory` })
const RULE = OPS_UI_PROBE_RULE_IDS.metrics
const NAME = 'Metrics collection unavailable'
const fail = (code) => new Error(`ops_ui_probe_${code}`)
function check(value, code) { if (!value) throw fail(code) }
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const sample = (value) => typeof value === 'string' && /^[0-9]{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null

export function validateOpsUiProbeScope(fixture, state) {
  check(fixture?.schemaVersion === 1 && fixture.hosts && state && validId(state.vaultId), 'invalid_fixture_scope')
  check(state.hostIds && Object.keys(state.hostIds).sort().join(',') === 'direct,jump,via'
    && ['jump', ...ROLES].every((role) => validId(state.hostIds[role])) && new Set(Object.values(state.hostIds)).size === 3, 'invalid_host_scope')
  for (const role of ['jump', ...ROLES]) {
    const host = fixture.hosts[role]
    check(host && host.address === '127.0.0.1' && Number.isInteger(host.port) && host.port > 1024 && host.port <= 65535
      && host.user === 'root' && typeof host.name === 'string' && host.name.length > 0 && host.name.length <= 160, 'fixture_endpoint_outside_isolation')
  }
  check(new Set(['jump', ...ROLES].map((role) => fixture.hosts[role].port)).size === 3, 'fixture_endpoints_not_independent')
  check(new Set(['jump', ...ROLES].map((role) => fixture.hosts[role].name)).size === 3, 'fixture_names_not_independent')
}

async function openPage(driver, page, state, role) {
  await closeOpsUiHostDrawer(driver)
  await driver.waitFor(tid('pc-dashboard'))
  await driver.click(tid('pc-dashboard'))
  await driver.click(tid(page === 'activity' ? 'pc-nav-activity' : 'pc-nav-hosts'))
  if (page === 'activity') {
    await driver.click(tid('history-tab-audit'))
    await driver.waitFor(tid('operations-audit-center'))
  }
  else if (state) await waitForOpsUiHostOperations(driver, { hostId: state.hostIds[role], vaultId: state.vaultId })
  else await driver.waitFor(tid('host-card'))
}
const evaluationSelector = (state, role, section) => `${card(state, role)} ${tid('host-probe-evaluation')}[data-rule-id=${q(OPS_UI_PROBE_RULE_IDS[section])}][data-host-id=${q(state.hostIds[role])}][data-vault-id=${q(state.vaultId)}]`
const alertSelector = (state, role) => `${card(state, role)} ${tid('host-local-alert')}[data-rule-id=${q(RULE)}][data-host-id=${q(state.hostIds[role])}]`

/** The marker displays the canonical builtin evaluation and its original
 * sample time. Host health alone, relative age and cached metrics never count. */
export async function readOpsUiProbeEvaluation(driver, state, role, section = 'metrics', { reveal = true, behindDrawer = false } = {}) {
  check([...ROLES, 'jump'].includes(role), 'invalid_role')
  check(section === 'metrics' || section === 'inventory', 'invalid_section')
  if (!behindDrawer && !await (reveal ? ensureOpsUiHostDetails : isOpsUiHostDetailsVisible)(driver, { hostId: state.hostIds[role], vaultId: state.vaultId })) return null
  const rows = await driver.findAll(evaluationSelector(state, role, section))
  if (rows.length !== 1 || (!behindDrawer && !await driver.isDisplayed(rows[0]))) return null
  const sampledAt = sample(await driver.attr(rows[0], 'data-sampled-at'))
  const status = await driver.attr(rows[0], 'data-state')
  if (!sampledAt || sampledAt > Date.now() || !['healthy', 'firing', 'unknown', 'recovering', 'pending'].includes(status)) return null
  return { sampledAt, state: status }
}

export async function waitForOpsUiProbeEvaluation(driver, state, role, { status, boundary, after = 0, timeoutMs = 240_000, section = 'metrics', reveal = true, behindDrawer = false }) {
  check(Number.isSafeInteger(boundary) && boundary > 0 && boundary <= Date.now() && Number.isSafeInteger(after) && after >= 0, 'invalid_sample_boundary')
  return driver.until(async () => {
    const observation = await readOpsUiProbeEvaluation(driver, state, role, section, { reveal, behindDrawer })
    return observation && observation.state === status && observation.sampledAt >= boundary && observation.sampledAt > after ? observation : false
  }, { timeoutMs })
}

async function inventoryRefreshSurface(driver, state, role) {
  const cards = await driver.findAll(card(state, role))
  const summaries = await driver.findAll(`${card(state, role)} ${tid('host-ops-summary')}`)
  const menus = await driver.findAll(`${card(state, role)} select${tid('host-ops-open')}`)
  const refreshOptions = await driver.findAll(`${card(state, role)} select${tid('host-ops-open')} option[value="refresh"]`)
  check(cards.length === 1 && summaries.length === 1 && menus.length === 1
    && refreshOptions.length === 1
    && await driver.isDisplayed(cards[0]) && await driver.isDisplayed(summaries[0])
    && await driver.attr(summaries[0], 'data-vault-id') === state.vaultId
    && await driver.attr(summaries[0], 'data-host-id') === state.hostIds[role], 'inventory_refresh_scope_mismatch')
  return { card: cards[0], summary: summaries[0], menu: menus[0] }
}

async function recordInventoryRefreshGeometry({ driver, state, role, record, phase }) {
  const surface = await inventoryRefreshSurface(driver, state, role)
  try {
    const viewports = await driver.findAll(tid('host-list-scroll-viewport'))
    const controls = await driver.findAll(tid('host-list-scroll-controls'))
    check(viewports.length === 1 && controls.length <= 1, 'inventory_refresh_geometry_surface_missing')
    const evidence = {}
    for (const [key, element] of Object.entries({ ...surface, viewport: viewports[0], ...(controls.length ? { controls: controls[0] } : {}) })) {
      try { evidence[key] = validateOpsUiServiceRect(await driver.rect(element)) }
      catch (error) {
        if (error?.code !== 'element not interactable') throw error
        evidence[key] = { available: false, reason: 'element-not-interactable' }
      }
    }
    await record('ops-ui-probe-inventory-refresh-geometry', { role, phase, ...evidence })
  } catch {
    // Diagnostics cannot replace or prevent the one genuine menu interaction.
    // Unknown geometry errors retain no native payload or invented rectangle.
    await record('ops-ui-probe-inventory-refresh-geometry-unavailable', { role, phase, available: false })
  }
}

async function captureInventoryRefreshFailure({ driver, fixture, state, role, record, checkpoint, assertScope }) {
  const assertCaptureSurface = async () => {
    assertScope()
    check((await driver.findAll('dialog[open]')).length === 0, 'inventory_refresh_capture_refused')
    await inventoryRefreshSurface(driver, state, role)
    const seen = new Set()
    for (const candidate of await driver.findAll(tid('host-card'))) {
      if (!await driver.isDisplayed(candidate)) continue
      const id = await driver.attr(candidate, 'data-host-id')
      const ownedRole = ['jump', ...ROLES].find(item => state.hostIds[item] === id)
      check(ownedRole && !seen.has(id) && await driver.attr(candidate, 'data-host-name') === fixture.hosts[ownedRole].name, 'inventory_refresh_capture_refused')
      const summaries = await driver.findAll(`${card(state, ownedRole)} ${tid('host-ops-summary')}`)
      check(summaries.length === 1 && await driver.attr(summaries[0], 'data-host-id') === id
        && await driver.attr(summaries[0], 'data-vault-id') === state.vaultId, 'inventory_refresh_capture_refused')
      seen.add(id)
    }
    check(seen.has(state.hostIds[role]) && seen.size <= 3, 'inventory_refresh_capture_refused')
    for (const input of await driver.findAll('input[type="password"], textarea')) {
      const value = await driver.attr(input, 'value')
      check(value === null || value === undefined || value === '', 'inventory_refresh_capture_refused')
    }
    assertScope()
  }
  check(typeof checkpoint === 'function', 'inventory_refresh_capture_refused')
  await assertCaptureSurface()
  const within = (parent, child) => { const part = relative(parent, child); return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part) }
  const desktop = fixture.desktopDir, artifacts = fixture.artifactDir
  check(typeof desktop === 'string' && isAbsolute(desktop) && typeof artifacts === 'string' && isAbsolute(artifacts)
    && within(desktop, artifacts), 'inventory_refresh_capture_path_invalid')
  const name = `inventory-${role}-refresh-failed`
  const output = await checkpoint(name)
  check(typeof output === 'string' && isAbsolute(output) && output === resolve(output)
    && within(artifacts, output) && basename(output) === `${name}.png`, 'inventory_refresh_capture_path_invalid')
  await assertCaptureSurface()
  await driver.screenshot(output)
  await record('ops-ui-probe-inventory-refresh-failure-capture', { role, captured: true, screenshot: basename(output) })
}

/** Drain genuine inventory recovery before recording the aggregate System
 * count. The host menu's refresh action is a forced inventory collection;
 * this does not claim inventory OS visibility or create another outage. */
export async function settleOpsUiProbeInventory({ driver, fixture, resumeState, probeState, record, checkpoint }) {
  validateOpsUiProbeScope(fixture, resumeState)
  check(typeof record === 'function' && probeState?.vaultId === resumeState.vaultId && probeState.ruleId === RULE
    && probeState.section === 'metrics' && ['jump', ...ROLES].every(role => probeState.hostIds?.[role] === resumeState.hostIds[role]
      && Number.isSafeInteger(probeState.hosts?.[role]?.recoveryBoundary) && probeState.hosts[role].recoveryBoundary > 0
      && probeState.hosts[role].recoveryBoundary <= Date.now()), 'inventory_drain_before_recovery')
  const identity = JSON.stringify([resumeState.vaultId, resumeState.hostIds])
  const assertScope = () => check(JSON.stringify([resumeState.vaultId, resumeState.hostIds]) === identity, 'scope_changed')
  for (const role of ['jump', ...ROLES]) {
    assertScope()
    await openPage(driver, 'hosts')
    // Hosts mount before their async operational views. Wait for the actual
    // target summary without treating that legitimate empty interval as a
    // Vault mismatch. A displayed foreign summary or duplicate is still fatal.
    await driver.until(async () => {
      assertScope()
      const targets = await driver.findAll(card(probeState, role))
      check(targets.length <= 1, 'inventory_refresh_scope_mismatch')
      if (!targets.length || !await driver.isDisplayed(targets[0])) return false
      const summaries = await driver.findAll(`${card(probeState, role)} ${tid('host-ops-summary')}`)
      check(summaries.length <= 1, 'inventory_refresh_scope_mismatch')
      if (!summaries.length || !await driver.isDisplayed(summaries[0])) return false
      check(await driver.attr(summaries[0], 'data-vault-id') === probeState.vaultId
        && await driver.attr(summaries[0], 'data-host-id') === probeState.hostIds[role], 'inventory_refresh_scope_mismatch')
      return summaries[0]
    }, { timeoutMs: 60_000 })
    assertScope()
    const previous = await readOpsUiProbeEvaluation(driver, probeState, role, 'inventory')
    const menu = `${card(probeState, role)} ${tid('host-ops-open')}`
    // Reading opened the host's details; its drawer covers the host list.
    await closeOpsUiHostDrawer(driver)
    await driver.waitFor(menu)
    await revealOpsUiHostActions(driver, menu)
    assertScope()
    // The actual collector reports whole UTC seconds. Begin the one forced
    // collection after a future whole-second boundary, never by rounding an
    // existing sample forward or accepting an earlier timestamp bucket.
    const boundary = (Math.floor(Math.max(Date.now(), previous?.sampledAt ?? 0) / 1000) + 1) * 1000
    await driver.until(() => {
      assertScope()
      return Date.now() >= boundary
    }, { timeoutMs: 2000 })
    assertScope()
    const diagnostics = { driver, fixture, state: probeState, role, record, checkpoint, assertScope }
    await recordInventoryRefreshGeometry({ ...diagnostics, phase: 'before' })
    assertScope()
    await inventoryRefreshSurface(driver, probeState, role)
    assertScope()
    try { await driver.select(menu, 'refresh') }
    catch (cause) {
      try { await recordInventoryRefreshGeometry({ ...diagnostics, phase: 'failed' }) }
      catch { await record('ops-ui-probe-inventory-refresh-geometry-unavailable', { role, phase: 'failed', available: false }) }
      try { assertScope(); await captureInventoryRefreshFailure(diagnostics) }
      catch { await record('ops-ui-probe-inventory-refresh-failure-capture', { role, captured: false }) }
      throw cause
    }
    assertScope()
    await waitForOpsUiProbeEvaluation(driver, probeState, role, { section: 'inventory', status: 'healthy', boundary, after: previous?.sampledAt ?? 0 })
    const result = await driver.until(async () => {
      assertScope()
      const observation = await readOpsUiProbeEvaluation(driver, probeState, role, 'inventory')
      if (!observation || observation.state !== 'healthy' || observation.sampledAt < boundary || observation.sampledAt <= (previous?.sampledAt ?? 0)) return false
      const alerts = await driver.findAll(`${card(probeState, role)} ${tid('host-local-alert')}[data-rule-id=${q(OPS_UI_PROBE_RULE_IDS.inventory)}]`)
      check(alerts.length <= 1, 'ambiguous_inventory_alert')
      if (!alerts.length) return { sampledAt: observation.sampledAt, alertPresent: false }
      const alert = alerts[0]
      check(await driver.isDisplayed(alert) && await driver.attr(alert, 'data-vault-id') === probeState.vaultId
        && await driver.attr(alert, 'data-host-id') === probeState.hostIds[role]
        && await driver.attr(alert, 'data-metric') === 'probe-provider' && await driver.attr(alert, 'data-source') === 'ssh-agentless'
        && await driver.attr(alert, 'data-transport') === route(role), 'inventory_alert_scope_or_source_mismatch')
      const status = await driver.attr(alert, 'data-alert-status')
      if (status === 'active' || status === 'acknowledged') return false
      check(status === 'resolved' || status === 'closed', 'invalid_inventory_alert_status')
      return { sampledAt: observation.sampledAt, alertPresent: true }
    }, { timeoutMs: 240_000 })
    await record(`ops-ui-probe-${role}-inventory-settled`, { passed: true, freshObservation: true, originalSampleAt: result.sampledAt, inventoryAlertPresent: result.alertPresent, noOpenInventoryAlert: true })
  }
  return { passed: true, profiles: 3, freshObservations: 3 }
}

export async function readOpsUiProbeAlert(driver, state, role, expectedStatus, { reveal = true, behindDrawer = false } = {}) {
  check([...ROLES, 'jump'].includes(role), 'invalid_role')
  if (!behindDrawer && !await (reveal ? ensureOpsUiHostDetails : isOpsUiHostDetailsVisible)(driver, { hostId: state.hostIds[role], vaultId: state.vaultId })) return null
  const rows = await driver.findAll(alertSelector(state, role))
  if (rows.length !== 1 || (!behindDrawer && !await driver.isDisplayed(rows[0]))) return null
  const row = rows[0]
  check(await driver.attr(row, 'data-vault-id') === state.vaultId, 'alert_vault_scope_mismatch')
  check(await driver.attr(row, 'data-metric') === 'probe-provider' && await driver.attr(row, 'data-source') === 'ssh-agentless'
    && await driver.attr(row, 'data-transport') === route(role), 'alert_source_or_route_mismatch')
  if (await driver.attr(row, 'data-alert-status') !== expectedStatus) return null
  if (!behindDrawer) {
    const text = await driver.text(row)
    const hostLabel = state.hostNames[role].replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 48)
    check(text.includes(`${hostLabel} · ${NAME}`) && text.includes('Monitoring collection'), 'unexpected_alert_label')
  }
  const jobId = await driver.attr(row, 'data-job-id')
  check(jobId === null || jobId === '' || validId(jobId), 'invalid_linked_job')
  return { jobId: jobId || null, updatedAt: sample(await driver.attr(row, 'data-updated-at')), resolvedAt: sample(await driver.attr(row, 'data-resolved-at')) }
}

async function waitForAlert(driver, state, role, status, options) {
  return driver.until(() => readOpsUiProbeAlert(driver, state, role, status, options), { timeoutMs: 240_000 })
}
async function enabled(driver, selector) {
  const disabled = await driver.attr(selector, 'disabled')
  return disabled === null || disabled === false || disabled === 'false'
}
async function respond(driver, fixture, state, role, action, accept) {
  const button = `${card(state, role)} ${tid(`local-host-alert-${action === 'acknowledge' ? 'ack' : 'close'}-${RULE}`)}`
  await driver.waitFor(button)
  await driver.until(() => enabled(driver, button))
  await driver.click(button)
  const confirmation = { driver, vaultId: state.vaultId, hostId: state.hostIds[role], expectedText: [NAME, fixture.hosts[role].name] }
  await waitForOpsUiConfirmation(confirmation)
  await respondOpsUiConfirmation({ ...confirmation, accept })
  await driver.until(async () => !(await driver.findAll(button)).length || await enabled(driver, button), { timeoutMs: 60_000 })
}

export async function verifyOpsUiProbeAudit(driver, state, role, { action, status, jobId }) {
  await openPage(driver, 'activity')
  await driver.click(tid('audit-tab'))
  const selector = `${tid('operation-audit-row')}[data-vault-id=${q(state.vaultId)}][data-host-id=${q(state.hostIds[role])}][data-target=${q(RULE)}][data-action=${q(`local-alert.${action}`)}][data-status=${q(status)}][data-confirmation=${q(status === 'cancelled' ? 'rejected' : 'confirmed')}][data-transport=${q(route(role))}]${jobId ? `[data-job-id=${q(jobId)}]` : ''}`
  const row = await findOpsUiAuditRow({ driver, selector, status })
  check(await driver.isDisplayed(row), 'audit_not_visible')
  const id = await driver.attr(row, 'data-job-id')
  check(validId(id) && (!jobId || jobId === id), 'audit_job_mismatch')
  check((await driver.text(row)).replace(/\s+/g, ' ').includes(`Workspace · local-ops · ${route(role)}`), 'audit_source_mismatch')
  return id
}

function validateBoundary(result, role, operation, requestedAt) {
  check(result && result.role === role && result[operation === 'stop' ? 'stopped' : 'restored'] === true
    && (operation === 'stop' || result.ready === true) && Number.isSafeInteger(result.boundary)
    && result.boundary >= requestedAt && result.boundary <= Date.now(), 'fixture_control_not_verified')
  return result.boundary
}

/** Refresh-probe in the current host menu collects inventory, not metrics.
 * This module deliberately waits for the production 60s metrics scheduler;
 * unrelated inventory lifecycles must be accounted for by notification owners. */
export async function runOpsUiProbeJourney({ driver, fixture, resumeState, record, checkpoint, onOpened, onResolved }) {
  validateOpsUiProbeScope(fixture, resumeState)
  check(typeof record === 'function' && typeof checkpoint === 'function'
    && (onOpened === undefined || typeof onOpened === 'function') && (onResolved === undefined || typeof onResolved === 'function'), 'invalid_callbacks')
  const identity = JSON.stringify([resumeState.vaultId, resumeState.hostIds])
  const state = { vaultId: resumeState.vaultId, hostIds: { ...resumeState.hostIds }, hostNames: Object.fromEntries(['jump', ...ROLES].map((role) => [role, fixture.hosts[role].name])), section: 'metrics', ruleId: RULE, hosts: {} }
  const assertScope = () => check(JSON.stringify([resumeState.vaultId, resumeState.hostIds]) === identity, 'scope_changed')
  const prepareDetails = async (role, phase) => {
    // Details are a modal drawer, so only the target host's can be open. The
    // jump host's rows stay mounted behind it and are read by their scoped data.
    const profiles = [role]
    // Navigation from Activity remounts collapsed list rows. Complete every
    // genuine disclosure click before the fixture emits either lifecycle.
    await driver.until(async () => {
      assertScope()
      for (const profile of profiles) {
        if (!await ensureOpsUiHostDetails(driver, { hostId: state.hostIds[profile], vaultId: state.vaultId })) return false
      }
      for (const profile of profiles) {
        if (!await isOpsUiHostDetailsVisible(driver, { hostId: state.hostIds[profile], vaultId: state.vaultId })) return false
      }
      assertScope()
      return true
    }, { timeoutMs: 60_000 })
    await record(`ops-ui-probe-${role}-details-prepared`, { passed: true, phase, profiles: profiles.length })
  }
  const readOnly = { reveal: false }
  const jumpReadOnly = { reveal: false, behindDrawer: true }
  const baselineBoundary = Date.now()
  for (const role of ROLES) {
    assertScope()
    await openPage(driver, 'hosts', state, role)
    await prepareDetails(role, 'before-stop')
    const baseline = await waitForOpsUiProbeEvaluation(driver, state, role, { status: 'healthy', boundary: baselineBoundary, ...readOnly })
    const jumpBaseline = role === 'via' ? await waitForOpsUiProbeEvaluation(driver, state, 'jump', { status: 'healthy', boundary: baselineBoundary, ...jumpReadOnly }) : null
    await record(`ops-ui-probe-${role}-baseline`, { passed: true, section: 'metrics', originalSampleAt: baseline.sampledAt })
    let restorationNeeded = true
    try {
      const stopAt = Date.now()
      const stopped = await checkpoint('probe-stop', { role })
      const faultBoundary = validateBoundary(stopped, role, 'stop', stopAt)
      assertScope()
      const failed = await waitForOpsUiProbeEvaluation(driver, state, role, { status: 'firing', boundary: faultBoundary, after: baseline.sampledAt, ...readOnly })
      const active = await waitForAlert(driver, state, role, 'active', readOnly)
      const jumpFailed = role === 'via' ? await waitForOpsUiProbeEvaluation(driver, state, 'jump', { status: 'firing', boundary: faultBoundary, after: jumpBaseline.sampledAt, ...jumpReadOnly }) : null
      if (role === 'via') await waitForAlert(driver, state, 'jump', 'active', jumpReadOnly)
      await record(`ops-ui-probe-${role}-opened`, { passed: true, route: route(role), freshFailure: true, cachedRecoveryRefused: true })
      if (onOpened) await onOpened(role)
      assertScope()
      await respond(driver, fixture, state, role, 'acknowledge', false)
      const cancelledState = await waitForAlert(driver, state, role, 'active')
      check(cancelledState.jobId === active.jobId, 'cancel_changed_lifecycle')
      const cancelled = await verifyOpsUiProbeAudit(driver, state, role, { action: 'acknowledge', status: 'cancelled' })
      await record(`ops-ui-probe-${role}-cancelled`, { passed: true, lifecycleUnchanged: true, jobId: cancelled })
      await openPage(driver, 'hosts', state, role)
      await waitForAlert(driver, state, role, 'active')
      await respond(driver, fixture, state, role, 'acknowledge', true)
      const acknowledged = await waitForAlert(driver, state, role, 'acknowledged')
      check(acknowledged.jobId && acknowledged.jobId !== active.jobId && acknowledged.jobId !== cancelled, 'ack_job_not_linked')
      await verifyOpsUiProbeAudit(driver, state, role, { action: 'acknowledge', status: 'completed', jobId: acknowledged.jobId })
      await openPage(driver, 'hosts', state, role)
      await prepareDetails(role, 'before-restore')
      const restoreAt = Date.now()
      const restored = await checkpoint('probe-restore', { role })
      const recoveryBoundary = validateBoundary(restored, role, 'restore', restoreAt)
      restorationNeeded = false
      assertScope()
      const recovery = await waitForOpsUiProbeEvaluation(driver, state, role, { status: 'healthy', boundary: recoveryBoundary, after: failed.sampledAt, ...readOnly })
      const resolved = await waitForAlert(driver, state, role, 'resolved', readOnly)
      check(resolved.resolvedAt !== null && resolved.resolvedAt >= recoveryBoundary && resolved.jobId === acknowledged.jobId, 'recovery_without_new_observation')
      if (role === 'via') {
        const jumpRecovery = await waitForOpsUiProbeEvaluation(driver, state, 'jump', { status: 'healthy', boundary: recoveryBoundary, after: jumpFailed.sampledAt, ...jumpReadOnly })
        const jumpResolved = await waitForAlert(driver, state, 'jump', 'resolved', jumpReadOnly)
        check(jumpResolved.resolvedAt !== null && jumpResolved.resolvedAt >= recoveryBoundary, 'jump_recovery_without_new_observation')
        state.hosts.jump = { failedSampleAt: jumpFailed.sampledAt, recoverySampleAt: jumpRecovery.sampledAt, recoveryBoundary, resolvedJobId: jumpResolved.jobId }
        await record('ops-ui-probe-jump-collateral-resolved', { passed: true, freshObservation: true, route: 'direct', lifecycleActions: 0 })
      }
      if (onResolved) await onResolved(role)
      assertScope()
      await respond(driver, fixture, state, role, 'close', true)
      const closed = await waitForAlert(driver, state, role, 'closed')
      check(closed.jobId && closed.jobId !== acknowledged.jobId && closed.jobId !== cancelled, 'close_job_not_linked')
      await verifyOpsUiProbeAudit(driver, state, role, { action: 'close', status: 'completed', jobId: closed.jobId })
      state.hosts[role] = { cancelled, acknowledged: acknowledged.jobId, closed: closed.jobId, failedSampleAt: failed.sampledAt, recoverySampleAt: recovery.sampledAt, recoveryBoundary }
      await record(`ops-ui-probe-${role}-resolved-and-closed`, { passed: true, freshObservation: true, linkedJobs: 2, cancelledJobs: 1, route: route(role) })
    } finally {
      // Also attempt restoration when stop itself failed after partially
      // stopping an owned fixture service. No application recovery is faked.
      if (restorationNeeded) {
        const requestedAt = Date.now()
        validateBoundary(await checkpoint('probe-restore', { role }), role, 'restore', requestedAt)
      }
    }
  }
  return state
}

/** The caller has relaunched and genuinely unlocked the same private app
 * profile before calling this function. It never injects a job or Vault. */
export async function resumeOpsUiProbeJourney({ driver, fixture, resumeState, probeState, record, restartedAfter }) {
  validateOpsUiProbeScope(fixture, resumeState)
  check(probeState?.vaultId === resumeState.vaultId && probeState.ruleId === RULE && probeState.section === 'metrics'
    && ['jump', ...ROLES].every((role) => probeState.hostIds[role] === resumeState.hostIds[role] && probeState.hostNames[role] === fixture.hosts[role].name && probeState.hosts[role]), 'invalid_restart_scope')
  check(Number.isSafeInteger(restartedAfter) && restartedAfter > 0 && restartedAfter <= Date.now(), 'invalid_restart_boundary')
  for (const role of ROLES) {
    const jobs = probeState.hosts[role]
    await verifyOpsUiProbeAudit(driver, probeState, role, { action: 'acknowledge', status: 'cancelled', jobId: jobs.cancelled })
    await verifyOpsUiProbeAudit(driver, probeState, role, { action: 'acknowledge', status: 'completed', jobId: jobs.acknowledged })
    await verifyOpsUiProbeAudit(driver, probeState, role, { action: 'close', status: 'completed', jobId: jobs.closed })
    await openPage(driver, 'hosts', probeState, role)
    const observation = await waitForOpsUiProbeEvaluation(driver, probeState, role, { status: 'healthy', boundary: restartedAfter, after: jobs.recoverySampleAt })
    const closed = await waitForAlert(driver, probeState, role, 'closed')
    check(closed.jobId === jobs.closed, 'restored_close_job_changed')
    await record(`ops-ui-probe-${role}-restored`, { passed: true, auditJobs: 3, freshObservation: true, originalSampleAt: observation.sampledAt, alertClosed: true })
  }
  await openPage(driver, 'hosts', probeState, 'jump')
  const jump = probeState.hosts.jump
  await waitForOpsUiProbeEvaluation(driver, probeState, 'jump', { status: 'healthy', boundary: restartedAfter, after: jump.recoverySampleAt })
  const resolved = await waitForAlert(driver, probeState, 'jump', 'resolved')
  check(resolved.jobId === jump.resolvedJobId, 'jump_unexpected_lifecycle_action')
  await record('ops-ui-probe-jump-restored', { passed: true, freshObservation: true, alertResolved: true, lifecycleActions: 0 })
  return { passed: true, scope: 'ssh-probe-metrics', targetHosts: 2, collateralJumpHosts: 1, profiles: 3, restoredJobs: 6, freshObservations: 3, actualMetricsLifecycleVerified: true, inventoryLifecycleVerified: false, osVisibilityVerified: false }
}
