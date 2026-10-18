// Real UI-only acceptance. The injected driver speaks W3C WebDriver to the
// production Tauri app; this module never evaluates JS, invokes IPC directly,
// edits storage, seeds a database, or substitutes remote results.
import { randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const OPS_UI_SELECTORS = Object.freeze({
  welcome: '[data-testid="welcome-enter"]',
  vaultForm: 'dialog[open] [data-testid="vault-password-form"]',
  vaultPassword: 'dialog[open] [data-testid="vault-master-password"]',
  vaultSubmit: 'dialog[open] [data-testid="vault-submit"]',
  biometricSkip: 'dialog[open] [data-testid="vault-biometric-skip"]',
  dashboard: '[data-testid="pc-dashboard"]',
  hosts: '[data-testid="pc-nav-hosts"]',
  activity: '[data-testid="pc-nav-activity"]',
  create: '[data-tour="host-create"]',
  hostForm: 'dialog[open] [data-testid="host-form"]',
  hostKey: 'dialog[open] [data-testid="host-key-confirm"]',
  fingerprint: 'dialog[open] [data-testid="host-key-fingerprint"]',
  trust: 'dialog[open] [data-testid="host-key-accept"]',
  audit: '[data-testid="operations-audit-center"]',
  auditTab: '[data-testid="audit-tab"]',
  confirmation: 'dialog[open] [data-testid="user-confirmation"]',
})
const S = OPS_UI_SELECTORS
const roles = ['jump', 'direct', 'via']
const incidentRoles = ['direct', 'via']
const q = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\n\r\f]/g, (character) => `\\${character.codePointAt(0).toString(16)} `)}"`
const testId = (id) => `[data-testid=${q(id)}]`
const byHost = (id) => `${testId('host-card')}[data-host-id=${q(id)}]`
const serviceRoot = (id) => `${testId('workspace-services-app')}[data-host-id=${q(id)}]`
const serviceRow = (id, unit) => `${serviceRoot(id)} ${testId('workspace-service-row')}[data-service-unit=${q(unit)}]`
const ruleRoot = (id) => `${testId('local-alert-rules')}[data-host-id=${q(id)}]`
const normalizeFingerprint = (value) => String(value).trim().replace(/^SHA256:/, '').replace(/=+$/, '')
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
function check(value, code) { if (!value) throw new Error(`ops_ui_${code}`) }
async function exists(driver, css) { return (await driver.findAll(css)).length > 0 }
async function visible(driver, css) { return await exists(driver, css) && await driver.isDisplayed(css) }
async function enabled(driver, css) { const value = await driver.attr(css, 'disabled'); return value === null || value === false || value === 'false' }
async function waitEnabled(driver, css) { await driver.waitFor(css); await driver.until(() => enabled(driver, css)) }

// Read only the error already displayed to the user, then discard its text.
// Report only these fixed categories; remote errors may contain private data.
export function classifyOpsUiConnectionFailure(value) {
  const text = String(value)
  for (const stage of ['target', 'jump']) {
    for (const operation of ['credential_unavailable', 'unreachable', 'session_failed', 'handshake_failed', 'auth_failed', 'host_key_failed']) {
      if (text.includes(`SSH ${stage} ${operation}`)) return `${stage}_${operation}`
    }
  }
  for (const code of ['VAULT_LOCKED', 'JUMP_HOST_NOT_FOUND', 'HOST_NOT_FOUND', 'JUMP_CHAIN_UNSUPPORTED', 'MISSING_CREDENTIAL', 'UNSUPPORTED_AUTH_TYPE']) {
    if (text.includes(code)) return code.toLowerCase()
  }
  return 'connection_error'
}

function validateFixture(fixture) {
  check(fixture && fixture.hosts && fixture.schemaVersion === 1, 'invalid_fixture')
  for (const role of roles) {
    const host = fixture.hosts[role]
    check(host && typeof host.name === 'string' && typeof host.privateKeyPath === 'string' && typeof host.expectedFingerprint === 'string', 'invalid_fixture_host')
    check(host.address === '127.0.0.1' && Number.isInteger(host.port) && host.port > 1024 && host.port <= 65535 && host.user === 'root', 'fixture_endpoint_outside_isolation')
  }
  check(new Set(roles.map((role) => fixture.hosts[role].port)).size === 3, 'fixture_endpoints_not_independent')
  check(new Set(roles.map((role) => fixture.hosts[role].name)).size === 3, 'fixture_names_not_independent')
  for (const role of incidentRoles) check(/^00-shellbeam-ui-[A-Za-z0-9.-]+\.service$/.test(fixture.hosts[role].serviceUnit ?? ''), 'fixture_service_not_owned')
  check(fixture.hosts.direct.serviceUnit !== fixture.hosts.via.serviceUnit, 'fixture_services_not_independent')
}

async function openDashboardPage(driver, page) {
  // Sessions stay mounted. The real dashboard tab makes its sidebar visible;
  // clicking a hidden sidebar item would bypass the actual product path.
  await driver.waitFor(S.dashboard)
  await driver.click(S.dashboard)
  const target = page === 'activity' ? S.activity : S.hosts
  await driver.waitFor(target)
  await driver.click(target)
  if (page === 'hosts') await driver.waitFor(S.create)
  else await driver.waitFor(S.audit)
}

async function createHost(driver, fixture, role, state, record) {
  const host = fixture.hosts[role]
  await openDashboardPage(driver, 'hosts')
  await driver.click(S.create)
  await driver.waitFor(S.hostForm)
  await driver.fill(testId('host-address'), host.address)
  await driver.fill(testId('host-port'), String(host.port))
  await driver.fill(testId('host-username'), host.user)
  await driver.fill(testId('host-name'), host.name)
  check(await driver.attr(testId('host-address'), 'value') === host.address
    && Number(await driver.attr(testId('host-port'), 'value')) === host.port
    && await driver.attr(testId('host-username'), 'value') === host.user
    && await driver.attr(testId('host-name'), 'value') === host.name, 'host_fields_not_entered')
  await driver.click(testId('host-auth-private-key'))
  await driver.waitFor(testId('host-private-key'))
  // Only the disposable fixture key enters the genuine credential form. Do
  // not screenshot, dump a DOM, report a value or serialize this scope.
  const privateKey = await readFile(host.privateKeyPath, 'utf8')
  check(privateKey.length > 100 && privateKey.length <= 65536 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey), 'invalid_fixture_key')
  await driver.fill(testId('host-private-key'), privateKey)
  check(String(await driver.attr(testId('host-private-key'), 'value')).replaceAll('\r\n', '\n') === privateKey.replaceAll('\r\n', '\n'), 'private_key_ui_roundtrip_failed')
  await driver.fill(testId('host-secret-name'), `ops-ui-${role}-private-key`)
  check(await driver.attr(testId('host-secret-name'), 'value') === `ops-ui-${role}-private-key`, 'secret_reference_not_explicit')
  if (role === 'via') {
    await driver.click(testId('host-jump-toggle'))
    await driver.waitFor(testId('host-jump-profile'))
    await driver.select(testId('host-jump-profile'), state.hostIds.jump)
    check(await driver.attr(testId('host-jump-profile'), 'value') === state.hostIds.jump, 'jump_reference_not_saved')
  }
  await waitEnabled(driver, testId('host-save'))
  await driver.click(testId('host-save'))
  await driver.until(async () => !(await exists(driver, S.hostForm)), { timeoutMs: 30000 })
  const card = `${testId('host-card')}[data-host-name=${q(host.name)}]`
  await driver.waitFor(card)
  const id = await driver.attr(card, 'data-host-id')
  check(typeof id === 'string' && id.length > 0, 'saved_host_id_missing')
  state.hostIds[role] = id
  await record(`ops-ui-${role}-host-saved`, { passed: true, explicitReference: true, privateKeyRoundtrip: true, jumpProfileSelected: role === 'via' })
}

async function connectAndVerify(driver, fixture, role, state, record) {
  await openDashboardPage(driver, 'hosts')
  await driver.click(`${byHost(state.hostIds[role])} ${testId('host-connect')}`)
  await record(`ops-ui-${role}-connection-clicked`, { passed: true })
  const tab = `${testId('pc-session-tab')}[data-host-id=${q(state.hostIds[role])}]`
  let lastTabState = null
  await driver.until(async () => {
    if (await exists(driver, S.hostKey)) {
      const address = await driver.attr(S.hostKey, 'data-host')
      const port = Number(await driver.attr(S.hostKey, 'data-port'))
      const endpoint = roles.find((candidate) => fixture.hosts[candidate].address === address && fixture.hosts[candidate].port === port)
      check(endpoint && await driver.attr(S.hostKey, 'data-code') === 'host_key_unknown', 'host_key_endpoint_or_change_rejected')
      const expected = normalizeFingerprint(fixture.hosts[endpoint].expectedFingerprint)
      check(normalizeFingerprint(await driver.text(S.fingerprint)) === expected, 'host_key_fingerprint_mismatch')
      await record(`ops-ui-${role}-fingerprint-verified`, { endpoint, matched: true })
      state.verifiedEndpoints.add(endpoint)
      await driver.click(S.trust)
      await record(`ops-ui-${role}-fingerprint-trusted`, { endpoint, accepted: true })
      return false
    }
    if (await exists(driver, tab)) {
      const status = await driver.attr(tab, 'data-status')
      const stage = await driver.attr(tab, 'data-connection-stage')
      const safeStatus = ['connecting', 'connected', 'error', 'disconnected'].includes(status) ? status : 'unknown'
      const safeStage = ['resolve_host', 'open_tcp', 'verify_host', 'secure_session', 'authenticate', 'prepare_workspace'].includes(stage) ? stage : 'unknown'
      const tabState = `${safeStatus}:${safeStage}`
      if (lastTabState !== tabState) {
        await record(`ops-ui-${role}-session-state`, { status: safeStatus, stage: safeStage })
        lastTabState = tabState
      }
      if (status === 'error') {
        const message = await exists(driver, testId('session-connection-error')) ? await driver.text(testId('session-connection-error')) : ''
        const code = classifyOpsUiConnectionFailure(message)
        await record(`ops-ui-${role}-connection-failed`, { code })
        throw new Error(`ops_ui_${code}`)
      }
    }
    return exists(driver, `${testId('terminal-session')}[data-host-id=${q(state.hostIds[role])}][data-status="connected"]`)
  }, { timeoutMs: 90000 })
  check(state.verifiedEndpoints.has(role), 'target_fingerprint_not_verified')
  if (role === 'via') check(state.verifiedEndpoints.has('jump'), 'jump_fingerprint_not_verified')
}

async function configureRule(driver, fixture, role, state) {
  await openDashboardPage(driver, 'hosts')
  await driver.select(`${byHost(state.hostIds[role])} ${testId('host-ops-open')}`, 'network')
  const root = ruleRoot(state.hostIds[role])
  await driver.waitFor(root, { timeoutMs: 60000 })
  const vaultId = await driver.attr(root, 'data-vault-id')
  check(typeof vaultId === 'string' && vaultId.length > 0 && (!state.vaultId || state.vaultId === vaultId), 'rule_vault_scope_mismatch')
  state.vaultId = vaultId
  await driver.select(`${root} ${testId('local-rule-metric')}`, 'service')
  await driver.fill(`${root} ${testId('local-rule-name')}`, state.ruleNames[role])
  await driver.fill(`${root} ${testId('local-rule-service')}`, fixture.hosts[role].serviceUnit)
  await driver.fill(`${root} ${testId('local-rule-duration')}`, '0')
  await driver.fill(`${root} ${testId('local-rule-recovery-duration')}`, '0')
  await driver.select(`${root} ${testId('local-rule-severity')}`, 'critical')
  await driver.click(`${root} ${testId('local-rule-add')}`)
  await driver.waitFor(`${root} ${testId('local-rule-row')}[data-rule-name=${q(state.ruleNames[role])}]`)
  await driver.waitFor(`${root} ${testId('local-alert-row')}[data-alert-name=${q(state.ruleNames[role])}][data-alert-status="active"][data-transport=${q(role === 'via' ? 'proxy-jump' : 'direct')}]`, { timeoutMs: 120000 })
}

// The providers mount the Vault modal alongside the animated Welcome page.
// Wait for showModal's real open state and complete that top-layer flow before
// touching Welcome; DOM presence alone does not make either control usable.
export async function initializeOpsUiVault({ driver, password, record }) {
  let initialized = false
  let initializeSubmitted = false
  let biometricSkipSubmitted = false
  let welcomeDismissed = false
  await record('ops-ui-startup-waiting', { passed: true })
  await driver.until(async () => {
    if (await visible(driver, S.biometricSkip)) {
      check(initializeSubmitted, 'unexpected_biometric_enrollment')
      if (biometricSkipSubmitted) return false
      await record('ops-ui-biometric-skip-ready', { visible: true })
      await driver.click(S.biometricSkip)
      biometricSkipSubmitted = true
      await record('ops-ui-biometric-skipped', { passed: true })
      return false
    }
    if (await visible(driver, S.vaultForm)) {
      const mode = await driver.attr(S.vaultForm, 'data-mode')
      if (mode === 'biometric-opt-in') return false
      check(mode === 'initialize', 'existing_vault_refused')
      if (!initializeSubmitted) {
        await record('ops-ui-vault-initialize-visible', { visible: true })
        await driver.fill(S.vaultPassword, password)
        check(await driver.attr(S.vaultPassword, 'value') === password, 'vault_password_ui_roundtrip_failed')
        await record('ops-ui-vault-password-entered', { roundtrip: true })
        await waitEnabled(driver, S.vaultSubmit)
        await record('ops-ui-vault-initialize-submit-ready', { enabled: true })
        await driver.click(S.vaultSubmit)
        initializeSubmitted = true
        await record('ops-ui-vault-initialize-submitted', { passed: true })
      }
      return false
    }
    // Even a hidden/transitional modal must finish closing before we can
    // interact with the page underneath it. Never retry a write or consent.
    if (await exists(driver, 'dialog')) return false
    if (!initializeSubmitted) return false
    if (!initialized) {
      initialized = true
      await record('ops-ui-vault-initialized', { passed: true })
    }
    if (!welcomeDismissed && await visible(driver, S.welcome)) {
      await record('ops-ui-welcome-dismiss-ready', { visible: true })
      await driver.click(S.welcome)
      welcomeDismissed = true
      await record('ops-ui-welcome-dismissed', { passed: true })
      return false
    }
    return initialized && welcomeDismissed && visible(driver, S.dashboard)
  }, { timeoutMs: 60000 })
  await record('ops-ui-dashboard-visible', { passed: true })
  return { initialized, welcomeDismissed }
}

/** Starts with a fresh app profile. The password is deliberately non-enumerable
 * and is retained only in runner memory for the real app restart/unlock. */
export async function setupOpsUiJourney({ driver, fixture, record }) {
  validateFixture(fixture)
  check(typeof record === 'function', 'record_callback_missing')
  const state = { hostIds: {}, ruleNames: { direct: 'ShellBeam UI direct service', via: 'ShellBeam UI via service' }, verifiedEndpoints: new Set(), jobs: {}, vaultId: null }
  Object.defineProperty(state, 'vaultPassword', { value: randomBytes(32).toString('base64url'), enumerable: false })
  const { initialized, welcomeDismissed } = await initializeOpsUiVault({ driver, password: state.vaultPassword, record })
  await openDashboardPage(driver, 'hosts')
  check((await driver.findAll(testId('host-card'))).length === 0, 'existing_hosts_refused')
  await record('ops-ui-fresh-vault', { initialized, welcomeDismissed, existingHosts: 0 })
  for (const role of roles) {
    await createHost(driver, fixture, role, state, record)
    await connectAndVerify(driver, fixture, role, state, record)
    await record(`ops-ui-${role}-connection`, { passed: true, fingerprintHash: hash(normalizeFingerprint(fixture.hosts[role].expectedFingerprint)) })
  }
  return state
}

/** The real notification channel must be ready before the first rule opens.
 * Hooks receive only a fixed role and run while its actual Network UI is open. */
export async function activateOpsUiRules({ driver, fixture, record, resumeState: state, onOpened }) {
  validateFixture(fixture)
  check(state && roles.every((role) => state.hostIds?.[role]) && typeof record === 'function', 'rule_activation_context_missing')
  check(onOpened === undefined || typeof onOpened === 'function', 'opened_callback_invalid')
  for (const role of incidentRoles) {
    await configureRule(driver, fixture, role, state)
    await record(`ops-ui-${role}-rule-opened`, { passed: true, routeVerified: true })
    if (onOpened) await onOpened(role)
  }
  await record('ops-ui-rules-active', { count: 2, independentSecretReferences: 3, nativeCollectors: true })
  return { passed: true, rules: 2 }
}

async function openServices(driver, role, state) {
  await openDashboardPage(driver, 'hosts')
  await driver.click(`${byHost(state.hostIds[role])} ${testId('host-services-open')}`)
  await driver.waitFor(serviceRoot(state.hostIds[role]), { timeoutMs: 60000 })
  check(await driver.attr(serviceRoot(state.hostIds[role]), 'data-vault-id') === state.vaultId, 'service_vault_scope_mismatch')
}

function serviceSelectionScope(fixture, state, role) {
  const id = state?.hostIds?.[role], unit = fixture?.hosts?.[role]?.serviceUnit
  check(incidentRoles.includes(role) && typeof state?.vaultId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(state.vaultId)
    && typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)
    && typeof unit === 'string' && /^00-shellbeam-ui-[A-Za-z0-9.-]+\.service$/.test(unit), 'service_selection_scope_invalid')
  return { id, unit }
}

export function validateOpsUiServiceRect(value) {
  check(value && typeof value === 'object' && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && Math.abs(value.x) <= 32768 && Math.abs(value.y) <= 32768
    && value.width > 0 && value.width <= 16384 && value.height > 0 && value.height <= 16384, 'service_selection_rect_invalid')
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

async function visibleOpsUiServiceRoot({ driver, fixture, state, role }) {
  const { id, unit } = serviceSelectionScope(fixture, state, role)
  // PcLayout keeps desktop/mobile and inactive session surfaces mounted. Only
  // the one genuinely displayed host surface is eligible for geometry/pixels.
  const roots = []
  for (const root of await driver.findAll(serviceRoot(id))) if (await driver.isDisplayed(root)) roots.push(root)
  check(roots.length === 1
    && await driver.attr(roots[0], 'data-vault-id') === state.vaultId
    && await driver.attr(roots[0], 'data-host-id') === id, 'service_selection_scope_mismatch')
  return { id, unit, root: roots[0] }
}

async function visibleOpsUiServiceWindow(driver, id) {
  const windows = []
  for (const window of await driver.findAll(testId('workspace-desktop-window-services'))) {
    if (await driver.isDisplayed(window) && (await driver.findAll(serviceRoot(id), window)).length === 1) windows.push(window)
  }
  check(windows.length === 1, 'service_selection_surface_missing')
  return windows[0]
}

export async function readOpsUiServiceSelection({ driver, fixture, state, role }) {
  const { id, unit, root } = await visibleOpsUiServiceRoot({ driver, fixture, state, role })
  const rows = await driver.findAll(`${testId('workspace-service-row')}[data-service-unit=${q(unit)}]`, root)
  const lists = await driver.findAll(testId('workspace-services-list'), root)
  const window = await visibleOpsUiServiceWindow(driver, id)
  check(rows.length === 1 && lists.length === 1
    && await driver.isDisplayed(rows[0]) && await driver.isDisplayed(lists[0]), 'service_selection_surface_missing')
  const bodies = await driver.findAll(testId('workspace-window-body'), window)
  check(bodies.length === 1 && await driver.isDisplayed(bodies[0]), 'service_selection_body_missing')
  const pressed = await driver.attr(rows[0], 'aria-pressed')
  check(pressed === 'true' || pressed === 'false', 'service_selection_pressed_invalid')
  const evidence = { selected: await driver.attr(root, 'data-selected-service') === unit, pressed: pressed === 'true' }
  // "content" is the actual window body rectangle; report redaction reserves
  // keys named "body" for secret-bearing notification/message payloads.
  for (const [key, element] of Object.entries({ row: rows[0], list: lists[0], service: root, window, content: bodies[0] })) {
    evidence[key] = validateOpsUiServiceRect(await driver.rect(element))
  }
  return evidence
}

async function captureOpsUiServiceSelectionFailure({ driver, fixture, state, role, record, checkpoint }) {
  check(typeof checkpoint === 'function' && (await driver.findAll('dialog[open]')).length === 0, 'service_selection_capture_refused')
  const { id, root, unit } = await visibleOpsUiServiceRoot({ driver, fixture, state, role })
  await visibleOpsUiServiceWindow(driver, id)
  // A clipped row or invalid layout response is precisely what this screenshot
  // must explain. Require its owned target to exist in the visible scoped app,
  // but do not pretend it is interactable merely to allow failure evidence.
  check((await driver.findAll(`${testId('workspace-service-row')}[data-service-unit=${q(unit)}]`, root)).length === 1, 'service_selection_capture_refused')
  for (const input of await driver.findAll('input[type="password"], textarea')) {
    const value = await driver.attr(input, 'value')
    check(value === null || value === undefined || value === '', 'service_selection_capture_refused')
  }
  const name = `service-${role}-selection-failed`
  const output = await checkpoint(name)
  const desktop = fixture.desktopDir, artifacts = fixture.artifactDir ?? (typeof desktop === 'string' ? join(desktop, 'artifacts') : '')
  const within = (parent, child) => { const part = relative(parent, child); return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part) }
  check(typeof desktop === 'string' && isAbsolute(desktop) && isAbsolute(artifacts) && within(desktop, artifacts)
    && typeof output === 'string' && isAbsolute(output) && output === resolve(output) && within(artifacts, output)
    && basename(output) === `${name}.png`, 'service_selection_capture_path_invalid')
  // This is the actual WebDriver framebuffer, never rendered DOM or substituted
  // pixels. Only this scoped, credential-free failure surface may be exported.
  await driver.screenshot(output)
  await record('ops-ui-service-selection-failure-capture', { role, captured: true, screenshot: basename(output) })
}

export async function selectOpsUiServiceRow({ driver, fixture, state, role, record, checkpoint }) {
  serviceSelectionScope(fixture, state, role)
  const context = { driver, fixture, state, role }
  try {
    await record('ops-ui-service-selection-geometry', { role, phase: 'before', ...await readOpsUiServiceSelection(context) })
    let previous
    await driver.until(async () => {
      const evidence = await readOpsUiServiceSelection(context), signature = JSON.stringify(evidence)
      const stable = signature === previous
      previous = signature
      return stable ? evidence : false
    }, { timeoutMs: 5000 })
    // One real click, including a default-selected row. Geometry readiness is
    // read-only; no scroll, keyboard action, retry or automatic consent occurs.
    await driver.click(serviceRow(state.hostIds[role], fixture.hosts[role].serviceUnit))
    const selected = await driver.until(async () => {
      const evidence = await readOpsUiServiceSelection(context)
      return evidence.selected && evidence.pressed ? evidence : false
    }, { timeoutMs: 5000 })
    await record('ops-ui-service-selection-geometry', { role, phase: 'selected', ...selected })
  } catch (cause) {
    try { await record('ops-ui-service-selection-geometry', { role, phase: 'failed', ...await readOpsUiServiceSelection(context) }) }
    catch { await record('ops-ui-service-selection-geometry-unavailable', { role, available: false }) }
    try { await captureOpsUiServiceSelectionFailure({ ...context, record, checkpoint }) }
    catch { await record('ops-ui-service-selection-failure-capture', { role, captured: false }) }
    throw cause
  }
}

/** Traverse the real, source/status-filtered Activity journal. Background
 * monitor reads can fill its latest page; no enlarged query or direct IPC is
 * used to retrieve an old consent record. Native audit retention is 10k and
 * this view displays 100 rows, so 100 pages is the complete bounded search. */
export async function findOpsUiAuditRow({ driver, selector, status }) {
  check(['cancelled', 'completed'].includes(status), 'audit_status_invalid')
  const root = S.audit
  const source = `${root} ${testId('operations-source-filter')}`
  const filter = `${root} ${testId('operations-filter')}`
  const refresh = `${root} ${testId('operations-refresh')}`
  const page = `${root} ${testId('operations-page')}`
  const older = `${root} ${testId('operations-older')}`
  await driver.waitFor(source)
  await driver.select(source, 'workspace')
  await driver.select(filter, status)
  await waitEnabled(driver, refresh)
  // Refresh resets any retained history cursor even when select's current
  // value was already correct and the browser emitted no change event.
  await driver.click(refresh)
  for (let number = 1; number <= 100; number++) {
    await driver.until(async () => await enabled(driver, refresh)
      && (await driver.text(page)).trim() === `Page ${number}`
      && await driver.attr(source, 'value') === 'workspace' && await driver.attr(filter, 'value') === status, { timeoutMs: 30000 })
    check((await driver.findAll(`${root} ${testId('operations-error')}`)).length === 0, 'audit_load_failed')
    const rows = await driver.findAll(selector)
    check(rows.length <= 1, 'audit_record_ambiguous')
    if (rows.length === 1 && await driver.isDisplayed(rows[0])) return rows[0]
    if (number === 100 || !await enabled(driver, older)) break
    await driver.click(older)
  }
  throw new Error('ops_ui_audit_record_missing')
}

async function auditJob(driver, role, state, unit, status, jobId) {
  await openDashboardPage(driver, 'activity')
  await driver.click(S.auditTab)
  const row = `${testId('operation-audit-row')}[data-host-id=${q(state.hostIds[role])}][data-vault-id=${q(state.vaultId)}][data-action="service.restart"][data-target=${q(unit)}][data-status=${q(status)}][data-confirmation=${q(status === 'cancelled' ? 'rejected' : 'confirmed')}][data-transport=${q(role === 'via' ? 'proxy-jump' : 'direct')}]${jobId ? `[data-job-id=${q(jobId)}]` : ''}`
  const match = await findOpsUiAuditRow({ driver, selector: row, status })
  const id = await driver.attr(match, 'data-job-id')
  check(typeof id === 'string' && id.length > 0 && (!jobId || id === jobId), 'operation_job_missing')
  return id
}

/** Read the app's actual visible consent surface. A native dialog ACK, hidden
 * node, matching name in another Vault or typed file-operation prompt cannot
 * substitute for this single-host operation review. Raw text is discarded. */
export async function waitForOpsUiConfirmation({ driver, vaultId, hostId, expectedText }) {
  check(typeof vaultId === 'string' && vaultId.length > 0 && typeof hostId === 'string' && hostId.length > 0
    && Array.isArray(expectedText) && expectedText.length > 0 && expectedText.every(value => typeof value === 'string' && value.length > 0), 'confirmation_context_missing')
  return driver.until(async () => {
    const dialogs = await driver.findAll(S.confirmation)
    if (!dialogs.length) return false
    check(dialogs.length === 1, 'confirmation_ambiguous')
    if (!await driver.isDisplayed(dialogs[0])) return false
    check(await driver.attr(dialogs[0], 'data-vault-id') === vaultId
      && await driver.attr(dialogs[0], 'data-host-id') === hostId, 'confirmation_scope_mismatch')
    check((await driver.findAll(`${S.confirmation} ${testId('user-confirmation-token')}`)).length === 0, 'confirmation_unexpected_token')
    const messages = await driver.findAll(`${S.confirmation} ${testId('user-confirmation-message')}`)
    check(messages.length === 1, 'confirmation_message_missing')
    if (!await driver.isDisplayed(messages[0])) return false
    const message = await driver.text(messages[0])
    check(typeof message === 'string' && expectedText.every(value => message.includes(value)), 'confirmation_target_mismatch')
    return dialogs[0]
  }, { timeoutMs: 30000 })
}

export async function respondOpsUiConfirmation({ driver, vaultId, hostId, expectedText, accept }) {
  check(typeof accept === 'boolean', 'confirmation_response_invalid')
  const button = `${S.confirmation} ${testId(accept ? 'user-confirmation-accept' : 'user-confirmation-cancel')}`
  await waitEnabled(driver, button)
  // Recheck the same scope immediately before the single real button click.
  await waitForOpsUiConfirmation({ driver, vaultId, hostId, expectedText })
  await driver.click(button)
  await driver.until(async () => !(await driver.findAll(S.confirmation)).length, { timeoutMs: 30000 })
}

export async function reviewOpsUiServiceConfirmation({ driver, css, unit, hostName, hostId, vaultId, accept, record, role }) {
  let phase = 'ready'
  const note = () => record('ops-ui-service-confirmation-stage', { role, accept, phase })
  try {
    await note()
    await waitEnabled(driver, css)
    phase = 'click'; await note()
    await driver.click(css)
    phase = 'prompt'; await note()
    const confirmation = { driver, vaultId, hostId, expectedText: [unit, hostName] }
    await waitForOpsUiConfirmation(confirmation)
    phase = 'respond'; await note()
    await respondOpsUiConfirmation({ ...confirmation, accept })
    phase = 'settle'; await note()
    await waitEnabled(driver, css)
    phase = 'complete'; await note()
  } catch {
    let errorVisible = false, cancelledOutput = false, errorCategory = 'unavailable'
    try {
      const root = css.slice(0, css.lastIndexOf(' '))
      const errors = await driver.findAll(`${root} [data-testid="workspace-services-error"]`)
      errorVisible = errors.length === 1 && await driver.isDisplayed(errors[0])
      if (errorVisible) {
        // Inspect only the existing visible error, then discard it. Never put
        // native/provider messages, endpoints or credential details in reports.
        const text = await driver.text(errors[0])
        errorCategory = text.includes('VAULT_LOCKED') ? 'vault-locked' : text.includes('INVALID_OPERATION') ? 'invalid-operation'
          : /database/i.test(text) ? 'database-unavailable' : 'other'
      }
      const outputs = await driver.findAll(`${root} [data-testid="workspace-services-output"]`)
      cancelledOutput = outputs.length === 1 && await driver.isDisplayed(outputs[0])
        && (await driver.text(outputs[0])).trim() === 'Operation cancelled before execution.'
    } catch { /* An actual open modal may refuse element inspection. */ }
    await record('ops-ui-service-confirmation-failed', { role, accept, phase, errorVisible, errorCategory, cancelledOutput })
    throw new Error(`ops_ui_service_confirmation_${phase}_failed`)
  }
}

export async function runOpsUiIncidents({ driver, fixture, record, checkpoint, resumeState: state, onRecovered }) {
  validateFixture(fixture)
  check(state?.vaultId && typeof checkpoint === 'function', 'incident_context_missing')
  check(onRecovered === undefined || typeof onRecovered === 'function', 'recovered_callback_invalid')
  for (const role of incidentRoles) {
    const id = state.hostIds[role]
    const unit = fixture.hosts[role].serviceUnit
    await openDashboardPage(driver, 'hosts')
    await driver.waitFor(`${byHost(id)} ${testId('host-ops-local-alerts')}[data-severity="critical"]`, { timeoutMs: 120000 })
    check(Number(await driver.attr(`${byHost(id)} ${testId('host-ops-local-alerts')}`, 'data-open-count')) > 0, 'host_incident_not_visible')
    await driver.until(async () => await driver.attr(byHost(id), 'data-host-health') === 'online', { timeoutMs: 150000 })
    // Count actual clicks after the anomaly is visible. The dedicated Services
    // button avoids hiding a native select's open + option choice in one step:
    // open Services (1), select this unit (2), request its real status (3).
    let steps = 0
    await driver.click(`${byHost(id)} ${testId('host-services-open')}`); steps++
    await driver.waitFor(serviceRow(id, unit), { timeoutMs: 60000 })
    check(await driver.attr(serviceRoot(id), 'data-vault-id') === state.vaultId, 'diagnostic_vault_scope_mismatch')
    check(await driver.attr(serviceRow(id, unit), 'data-active-state') === 'failed', 'fixture_service_not_failed')
    await selectOpsUiServiceRow({ driver, fixture, state, role, record, checkpoint }); steps++
    await waitEnabled(driver, `${serviceRoot(id)} ${testId('workspace-service-status')}`)
    await driver.click(`${serviceRoot(id)} ${testId('workspace-service-status')}`); steps++
    const output = `${serviceRoot(id)} ${testId('workspace-services-output')}`
    await driver.until(async () => {
      const value = await driver.text(output)
      return value.includes(unit) && /Active:\s+failed\b/.test(value)
    }, { timeoutMs: 30000 })
    check(steps <= 3, 'diagnosis_step_budget_exceeded')
    await record(`ops-ui-${role}-diagnosis`, { passed: true, steps })
    const baseline = await checkpoint('before-cancel', { role, unit })
    check(baseline && typeof baseline === 'object', 'observer_baseline_missing')
    await reviewOpsUiServiceConfirmation({ driver, css: `${serviceRoot(id)} ${testId('workspace-service-restart')}`, unit, hostName: fixture.hosts[role].name, hostId: id, vaultId: state.vaultId, accept: false, record, role })
    await checkpoint('after-cancel', { role, unit, baseline })
    const cancelled = await auditJob(driver, role, state, unit, 'cancelled')
    await record(`ops-ui-${role}-cancelled`, { passed: true, jobId: cancelled, mutations: 0 })
    await openServices(driver, role, state)
    await driver.waitFor(serviceRow(id, unit))
    await selectOpsUiServiceRow({ driver, fixture, state, role, record, checkpoint })
    await reviewOpsUiServiceConfirmation({ driver, css: `${serviceRoot(id)} ${testId('workspace-service-restart')}`, unit, hostName: fixture.hosts[role].name, hostId: id, vaultId: state.vaultId, accept: true, record, role })
    await driver.until(async () => (await driver.text(output)).includes('status=completed'), { timeoutMs: 60000 })
    await driver.waitFor(`${serviceRow(id, unit)}[data-active-state="active"]`, { timeoutMs: 30000 })
    await checkpoint('after-confirm', { role, unit, baseline })
    const completed = await auditJob(driver, role, state, unit, 'completed')
    check(completed !== cancelled, 'confirmation_jobs_not_independent')
    state.jobs[role] = { cancelled, completed, baseline }
    await record(`ops-ui-${role}-confirmed`, { passed: true, jobId: completed, verifiedActive: true })
    await openDashboardPage(driver, 'hosts')
    await driver.select(`${byHost(id)} ${testId('host-ops-open')}`, 'network')
    await driver.waitFor(`${ruleRoot(id)} ${testId('local-alert-row')}[data-alert-name=${q(state.ruleNames[role])}][data-alert-status="resolved"][data-transport=${q(role === 'via' ? 'proxy-jump' : 'direct')}]`, { timeoutMs: 120000 })
    await record(`ops-ui-${role}-recovered`, { passed: true })
    if (onRecovered) await onRecovered(role)
  }
  return { passed: true, incidents: 2, cancelledJobs: 2, completedJobs: 2, resolvedAlerts: 2, maximumDiagnosisSteps: 3 }
}

/** Called only after the runner stops and relaunches the actual application
 * with the same isolated profile. No persisted job or credential is injected. */
export async function resumeOpsUiJourney({ driver, fixture, record, checkpoint, resumeState: state, restartedAfter }) {
  validateFixture(fixture)
  check(state?.vaultPassword && state.jobs.direct && state.jobs.via, 'resume_context_missing')
  check(Number.isSafeInteger(restartedAfter) && restartedAfter > 0 && restartedAfter <= Date.now(), 'restart_boundary_missing')
  await driver.waitFor(S.vaultForm, { timeoutMs: 60000 })
  check(await driver.attr(S.vaultForm, 'data-mode') === 'unlock', 'vault_was_not_restored')
  await driver.fill(S.vaultPassword, state.vaultPassword)
  await driver.click(S.vaultSubmit)
  await driver.until(async () => !(await exists(driver, S.vaultForm)), { timeoutMs: 30000 })
  check(!(await exists(driver, S.welcome)), 'welcome_was_not_persisted')
  await record('ops-ui-vault-unlocked-after-restart', { passed: true })
  for (const role of incidentRoles) {
    const unit = fixture.hosts[role].serviceUnit
    await auditJob(driver, role, state, unit, 'cancelled', state.jobs[role].cancelled)
    await auditJob(driver, role, state, unit, 'completed', state.jobs[role].completed)
    await checkpoint('after-confirm', { role, unit, baseline: state.jobs[role].baseline })
    await openDashboardPage(driver, 'hosts')
    const id = state.hostIds[role]
    await driver.select(`${byHost(id)} ${testId('host-ops-open')}`, 'network')
    await driver.waitFor(ruleRoot(id), { timeoutMs: 60000 })
    check(await driver.attr(ruleRoot(id), 'data-vault-id') === state.vaultId, 'restored_rule_vault_scope_mismatch')
    await driver.waitFor(`${ruleRoot(id)} ${testId('local-alert-row')}[data-alert-name=${q(state.ruleNames[role])}][data-alert-status="resolved"][data-transport=${q(role === 'via' ? 'proxy-jump' : 'direct')}]`, { timeoutMs: 120000 })
    const rule = `${ruleRoot(id)} ${testId('local-rule-row')}[data-rule-name=${q(state.ruleNames[role])}]`
    await driver.waitFor(rule, { timeoutMs: 60000 })
    await driver.until(async () => {
      if (await driver.attr(rule, 'data-rule-state') !== 'healthy') return false
      const raw = await driver.attr(rule, 'data-sampled-at')
      const sampledAt = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
      return Number.isSafeInteger(sampledAt) && sampledAt >= restartedAfter && sampledAt <= Date.now()
    }, { timeoutMs: 120000 })
    await record(`ops-ui-${role}-restored`, { passed: true, auditJobs: 2, alertResolved: true, freshObservation: true })
  }
  return { passed: true, hosts: 3, incidents: 2, restoredJobs: 4, freshObservations: 2, maximumDiagnosisSteps: 3 }
}

export async function runOpsUiJourney(options) {
  const resumeState = await setupOpsUiJourney(options)
  await activateOpsUiRules({ ...options, resumeState })
  await runOpsUiIncidents({ ...options, resumeState })
  return resumeState
}
