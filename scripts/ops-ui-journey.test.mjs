import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { activateOpsUiRules, classifyOpsUiConnectionFailure, findOpsUiAuditRow, initializeOpsUiVault, OPS_UI_SELECTORS, readOpsUiServiceSelection, resumeOpsUiJourney, reviewOpsUiServiceConfirmation, revealOpsUiHostActions, runOpsUiIncidents, selectOpsUiServiceRow, validateOpsUiServiceRect } from './ops-ui-journey.mjs'

function confirmationUnit({ problem } = {}) {
  const dom = new JSDOM('<div data-testid="workspace-services-app" data-host-id="host"><button data-testid="workspace-service-restart">Restart</button><div data-testid="workspace-services-error">INVALID_OPERATION: private credential detail</div></div>')
  const { document } = dom.window, clicks = [], events = []
  const css = '[data-testid="workspace-services-app"][data-host-id="host"] [data-testid="workspace-service-restart"]'
  const element = value => typeof value === 'string' ? document.querySelector(value) : value
  const driver = {
    async findAll(selector) { return [...document.querySelectorAll(selector)] },
    async waitFor(selector) { const row = element(selector); assert(row); return row },
    async isDisplayed(value) { const row = element(value); return !!row && !row.closest('[hidden]') },
    async attr(value, field) { return element(value).getAttribute(field) },
    async text(value) { return element(value).textContent },
    async until(read) { const value = await read(); if (!value) throw new Error('private timeout detail'); return value },
    async click(value) {
      const row = element(value); assert(row); clicks.push(row.dataset.testid)
      if (row.dataset.testid === 'workspace-service-restart') {
        document.body.insertAdjacentHTML('beforeend', `<dialog ${problem === 'closed' ? '' : 'open'}><div data-testid="user-confirmation" data-vault-id="${problem === 'vault' ? 'foreign' : 'vault'}" data-host-id="${problem === 'host' ? 'foreign' : 'host'}" ${problem === 'hidden' ? 'hidden' : ''}><p data-testid="user-confirmation-message">${problem === 'target' ? 'other.service' : 'unit.service'} · ${problem === 'host-name' ? 'other host' : 'isolated host'}</p>${problem === 'token' ? '<input data-testid="user-confirmation-token">' : ''}<button data-testid="user-confirmation-cancel">Cancel</button><button data-testid="user-confirmation-accept">Confirm</button></div></dialog>`)
        if (problem === 'ambiguous') document.body.append(document.querySelector('dialog').cloneNode(true))
      } else row.closest('dialog').remove()
    },
  }
  return { dom, driver, clicks, events, options: { driver, css, unit: 'unit.service', hostName: 'isolated host', hostId: 'host', vaultId: 'vault', role: 'direct', record: async (name, details) => events.push({ name, ...details }) } }
}

test('service confirmation requires one actual visible same-host/Vault target dialog and never retries or consents after failure', async () => {
  for (const problem of ['closed', 'hidden', 'vault', 'host', 'target', 'host-name', 'token', 'ambiguous']) {
    const unit = confirmationUnit({ problem })
    try {
      await assert.rejects(reviewOpsUiServiceConfirmation({ ...unit.options, accept: true }), /ops_ui_service_confirmation_prompt_failed/)
      assert.deepEqual(unit.clicks, ['workspace-service-restart'])
      assert.deepEqual(unit.events.at(-1), { name: 'ops-ui-service-confirmation-failed', role: 'direct', accept: true, phase: 'prompt', errorVisible: true, errorCategory: 'invalid-operation', cancelledOutput: false })
      assert(!JSON.stringify(unit.events).includes('private'))
    } finally { unit.dom.window.close() }
  }
})

test('service confirmation clicks the single actual cancel/accept control and reports each boundary in order', async () => {
  for (const accept of [false, true]) {
    const unit = confirmationUnit()
    try {
      await reviewOpsUiServiceConfirmation({ ...unit.options, accept })
      assert.deepEqual(unit.events.map(event => event.phase), ['ready', 'click', 'prompt', 'respond', 'settle', 'complete'])
      assert.deepEqual(unit.clicks, ['workspace-service-restart', `user-confirmation-${accept ? 'accept' : 'cancel'}`])
      assert.equal(unit.dom.window.document.querySelector('dialog'), null)
    } finally { unit.dom.window.close() }
  }
})

test('service confirmation does not click a response if the visible dialog changes Vault after review', async () => {
  const unit = confirmationUnit()
  try {
    unit.options.record = async (name, detail) => {
      unit.events.push({ name, ...detail })
      if (detail.phase === 'respond') unit.dom.window.document.querySelector('[data-testid="user-confirmation"]').dataset.vaultId = 'foreign'
    }
    await assert.rejects(reviewOpsUiServiceConfirmation({ ...unit.options, accept: true }), /ops_ui_service_confirmation_respond_failed/)
    assert.deepEqual(unit.clicks, ['workspace-service-restart'])
  } finally { unit.dom.window.close() }
})

function auditPages({ targetPage = 2, pages = 3, problem } = {}) {
  const dom = new JSDOM('<section data-testid="operations-audit-center"><select data-testid="operations-source-filter"><option value="all">All</option><option value="workspace">Workspace</option></select><select data-testid="operations-filter"><option value="all">All</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><button data-testid="operations-refresh">Refresh</button><span data-testid="operations-page"></span><button data-testid="operations-older">Older</button><div data-testid="page-rows"></div></section>')
  const document = dom.window.document, actions = []
  let page = pages
  const element = value => typeof value === 'string' ? document.querySelector(value) : value
  const render = () => {
    document.querySelector('[data-testid="operations-page"]').textContent = `Page ${page}`
    document.querySelector('[data-testid="operations-older"]').disabled = page >= pages
    const rows = document.querySelector('[data-testid="page-rows"]')
    rows.replaceChildren()
    if (page === targetPage) rows.insertAdjacentHTML('beforeend', `<div data-testid="operation-audit-row" data-job-id="saved-job">Saved consent audit</div>${problem === 'ambiguous' ? '<div data-testid="operation-audit-row" data-job-id="saved-job">Duplicate</div>' : ''}`)
    if (problem === 'load') rows.insertAdjacentHTML('beforeend', '<div data-testid="operations-error">Fixed test failure</div>')
  }
  render()
  const driver = {
    async findAll(selector) { return [...document.querySelectorAll(selector)] },
    async waitFor(selector) { const row = element(selector); assert(row); return row },
    async attr(value, field) { const row = element(value); return field === 'value' ? row.value : row.getAttribute(field) },
    async isDisplayed(value) { return !element(value).hidden },
    async text(value) { return element(value).textContent },
    async select(selector, value) { element(selector).value = value; actions.push([element(selector).dataset.testid, value]); page = 1; render() },
    async click(selector) { const row = element(selector); assert(!row.disabled); actions.push(row.dataset.testid); page = row.dataset.testid === 'operations-refresh' ? 1 : page + 1; render() },
    async until(read) { const result = await read(); assert(result, 'unit visible UI state required'); return result },
  }
  return { dom, document, driver, actions, options: { driver, selector: '[data-testid="operation-audit-row"][data-job-id="saved-job"]', status: 'completed' } }
}

test('audit lookup uses actual Workspace/status controls, resets old pages and finds the exact retained record through visible pagination', async () => {
  const unit = auditPages()
  try {
    const row = await findOpsUiAuditRow(unit.options)
    assert.equal(row.dataset.jobId, 'saved-job')
    assert.deepEqual(unit.actions, [['operations-source-filter', 'workspace'], ['operations-filter', 'completed'], 'operations-refresh', 'operations-older'])
    assert.equal(unit.document.querySelector('[data-testid="operations-page"]').textContent, 'Page 2')
    await findOpsUiAuditRow(unit.options)
    assert.deepEqual(unit.actions.slice(-4), [['operations-source-filter', 'workspace'], ['operations-filter', 'completed'], 'operations-refresh', 'operations-older'])
  } finally { unit.dom.window.close() }
})

test('audit lookup refuses missing, ambiguous and failed data and never traverses past the 100-page retention bound', async () => {
  for (const [options, reason] of [[{ targetPage: 4 }, /audit_record_missing/], [{ targetPage: 1, problem: 'ambiguous' }, /audit_record_ambiguous/], [{ problem: 'load' }, /audit_load_failed/], [{ targetPage: 101, pages: 101 }, /audit_record_missing/]]) {
    const unit = auditPages(options)
    try {
      await assert.rejects(findOpsUiAuditRow(unit.options), reason)
      assert(unit.actions.filter(action => action === 'operations-older').length <= 99)
      if (options.pages === 101) assert.equal(unit.actions.filter(action => action === 'operations-older').length, 99)
    } finally { unit.dom.window.close() }
  }
})

test('connection diagnostics retain only fixed native endpoint categories', () => {
  for (const stage of ['target', 'jump']) {
    for (const operation of ['credential_unavailable', 'unreachable', 'session_failed', 'handshake_failed', 'auth_failed', 'host_key_failed']) {
      assert.equal(classifyOpsUiConnectionFailure(`SSH ${stage} ${operation}: private remote detail`), `${stage}_${operation}`)
    }
  }
  assert.equal(classifyOpsUiConnectionFailure('Operation failed: VAULT_LOCKED'), 'vault_locked')
  assert.equal(classifyOpsUiConnectionFailure('Operation failed: JUMP_HOST_NOT_FOUND'), 'jump_host_not_found')
})

test('unrecognized errors cannot enter diagnostic events or assertion messages', () => {
  for (const detail of ['private endpoint and credential detail', '{"message":"private detail"}', '', null, undefined]) {
    assert.equal(classifyOpsUiConnectionFailure(detail), 'connection_error')
  }
})

test('startup waits for the real modal, skips enrollment once, then dismisses visible Welcome once', async () => {
  // A control-flow unit test only; live acceptance still uses external W3C
  // elements and the installed application's real Vault and native modal.
  const S = OPS_UI_SELECTORS
  const password = 'PRIVATE_TEST_VALUE'
  const events = []
  const writes = []
  let phase = 'portal-before-open'
  let entered = false
  const dialogPhases = ['portal-before-open', 'opening', 'initialize', 'opt-in-portal', 'opt-in-transient', 'opt-in', 'opt-in-closing']
  const driver = {
    async findAll(css) {
      const present = css === 'dialog' ? dialogPhases.includes(phase)
        : css === S.vaultForm ? ['opening', 'initialize', 'opt-in-transient'].includes(phase)
        : css === S.biometricSkip ? ['opt-in', 'opt-in-closing'].includes(phase)
        : css === S.welcome ? phase !== 'dashboard'
        : css === S.dashboard ? phase === 'dashboard'
        : css === S.vaultSubmit ? phase === 'initialize' : false
      return present ? [{}] : []
    },
    async isDisplayed(css) {
      return css === S.vaultForm ? ['initialize', 'opt-in-transient'].includes(phase)
        : css === S.biometricSkip ? ['opt-in', 'opt-in-closing'].includes(phase)
        : css === S.welcome ? phase === 'welcome-visible'
        : css === S.dashboard ? phase === 'dashboard' : false
    },
    async attr(css, name) {
      if (css === S.vaultForm && name === 'data-mode') return phase === 'opt-in-transient' ? 'biometric-opt-in' : 'initialize'
      if (css === S.vaultPassword && name === 'value') return entered ? password : ''
      if (css === S.vaultSubmit && name === 'disabled') return entered ? null : 'true'
      throw new Error('unexpected read')
    },
    async fill(css, value) {
      assert.equal(phase, 'initialize')
      assert.equal(css, S.vaultPassword)
      assert.equal(value, password)
      writes.push('fill')
      entered = true
    },
    async click(css) {
      if (css === S.vaultSubmit) { assert.equal(phase, 'initialize'); phase = 'opt-in-portal' }
      else if (css === S.biometricSkip) { assert.equal(phase, 'opt-in'); phase = 'opt-in-closing' }
      else if (css === S.welcome) { assert.equal(phase, 'welcome-visible'); phase = 'dashboard' }
      else throw new Error('unexpected click')
      writes.push(css)
    },
    async waitFor(css) { assert.equal(css, S.vaultSubmit) },
    async until(fn) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await fn()
        if (result) return result
        phase = ({ 'portal-before-open': 'opening', opening: 'initialize', 'opt-in-portal': 'opt-in-transient', 'opt-in-transient': 'opt-in', 'opt-in-closing': 'welcome-hidden', 'welcome-hidden': 'welcome-visible' })[phase] ?? phase
      }
      throw new Error('test timeout')
    },
  }
  const result = await initializeOpsUiVault({ driver, password, record: async (name, detail) => events.push({ name, ...detail }) })
  assert.deepEqual(result, { initialized: true, welcomeDismissed: true })
  assert.deepEqual(writes, ['fill', S.vaultSubmit, S.biometricSkip, S.welcome])
  assert.equal(JSON.stringify(events).includes(password), false)
  assert.equal(events.at(-1).name, 'ops-ui-dashboard-visible')
})

test('startup refuses an existing Vault without filling or dismissing Welcome', async () => {
  const driver = {
    async findAll(css) { return css === OPS_UI_SELECTORS.vaultForm ? [{}] : [] },
    async isDisplayed() { return true },
    async attr() { return 'unlock' },
    async until(fn) { return fn() },
    async fill() { assert.fail('existing Vault must not receive a password') },
    async click() { assert.fail('existing Vault must not be dismissed') },
  }
  await assert.rejects(initializeOpsUiVault({ driver, password: 'PRIVATE_TEST_VALUE', record: async () => {} }), /^Error: ops_ui_existing_vault_refused$/)
})

test('first run creates the Vault on Welcome, then dismisses Welcome once', async () => {
  const S = OPS_UI_SELECTORS
  const password = 'PRIVATE_TEST_VALUE'
  const writes = []
  const values = new Map()
  let phase = 'form'
  const present = (css) => (phase === 'form' && [S.welcomeVaultForm, S.welcomePassword, S.welcomeConfirm, S.welcomeAck, S.welcomeCreate, S.welcome].includes(css))
    || (phase === 'host' && css === S.welcome)
    || (phase === 'dashboard' && css === S.dashboard)
  const driver = {
    async findAll(css) { return present(css) ? [{ css }] : [] },
    async isDisplayed(css) { return present(css) },
    async waitFor() {},
    async until(check) { for (let i = 0; i < 20; i += 1) if (await check()) return; assert.fail('never reached the dashboard') },
    async attr(css, name) { return name === 'value' ? values.get(css) : null },
    async fill(css, value) { writes.push(css); values.set(css, value) },
    async click(css) {
      writes.push(css)
      if (css === S.welcomeCreate) phase = 'host'
      if (css === S.welcome) phase = 'dashboard'
    },
  }
  const result = await initializeOpsUiVault({ driver, password, record: async () => {} })
  assert.deepEqual(result, { initialized: true, welcomeDismissed: true })
  assert.deepEqual(writes, [S.welcomePassword, S.welcomeConfirm, S.welcomeAck, S.welcomeCreate, S.welcome])
})

function journeyContext() {
  const fixture = { schemaVersion: 1, hosts: Object.fromEntries(['jump', 'direct', 'via'].map((role, index) => [role, {
    name: `isolated ${role}`, address: '127.0.0.1', port: 22_001 + index, user: 'root', privateKeyPath: `/private/${role}.pem`, expectedFingerprint: 'SHA256:public-test-fingerprint',
    ...(role === 'jump' ? {} : { serviceUnit: `00-shellbeam-ui-unit-${role}.service` }),
  }])) }
  const state = { hostIds: { jump: 'jump-host', direct: 'direct-host', via: 'via-host' }, ruleNames: { direct: 'direct-rule', via: 'via-rule' }, vaultId: 'vault', jobs: {} }
  Object.defineProperty(state, 'vaultPassword', { value: 'PRIVATE_TEST_VALUE', enumerable: false })
  return { fixture, state }
}

function serviceWindows(fixture, state) {
  return ['direct', 'via'].map(role => `<section data-testid="workspace-desktop-window-services" data-role="${role}" ${role === 'direct' ? '' : 'hidden'}><div data-testid="workspace-window-body"><div data-testid="workspace-services-app" data-vault-id="${state.vaultId}" data-host-id="${state.hostIds[role]}" data-selected-service="${fixture.hosts.direct.serviceUnit}"><div data-testid="workspace-services-list">${['direct', 'via'].map(target => `<button data-testid="workspace-service-row" data-service-unit="${fixture.hosts[target].serviceUnit}" data-active-state="failed" aria-pressed="${target === 'direct'}">Service row</button>`).join('')}</div></div></div></section>`).join('')
}

function serviceSelectionUnit({ role = 'via', problem } = {}) {
  const { fixture, state } = journeyContext()
  fixture.desktopDir = '/private/owned-desktop'; fixture.artifactDir = '/private/owned-desktop/artifacts'
  const dom = new JSDOM(serviceWindows(fixture, state)), document = dom.window.document
  const records = [], clicks = [], screenshots = [], checkpoints = []
  for (const window of document.querySelectorAll('section')) window.hidden = window.dataset.role !== role
  const element = value => typeof value === 'string' ? document.querySelector(value) : value
  let reads = 0
  const rect = row => {
    const shifted = problem === 'moving' && reads <= 3 ? reads * 8 : 0
    return row.dataset.testid === 'workspace-service-row' ? { x: 210, y: 510 + shifted, width: 600, height: 56 }
      : row.dataset.testid === 'workspace-services-list' ? { x: 210, y: 440 + shifted, width: 600, height: 448 }
      : row.dataset.testid === 'workspace-services-app' ? { x: 196, y: 190 + shifted, width: 1040, height: 1000 }
      : row.dataset.testid === 'workspace-window-body' ? { x: 176, y: 172, width: 1080, height: 486 }
      : { x: 176, y: 120, width: 1080, height: 540 }
  }
  const driver = {
    async waitFor() {},
    async findAll(selector, parent = document) { return [...parent.querySelectorAll(selector)] },
    async isDisplayed(value) { return !element(value).closest('[hidden]') },
    async attr(value, field) { const row = element(value); return field === 'value' ? row.value : row.getAttribute(field) },
    async rect(value) { const row = element(value); if (row.dataset.testid === 'workspace-service-row') reads++; return rect(row) },
    async until(read) { for (let attempt = 0; attempt < 12; attempt++) { const result = await read(); if (result) return result } throw new Error('fixed_readiness_failed') },
    async click(selector) {
      const row = element(selector); assert(row); clicks.push(selector)
      if (problem && !['moving', 'post-selection'].includes(problem)) throw new Error('fixed_click_failed')
      const root = row.closest('[data-testid="workspace-services-app"]')
      if (problem !== 'post-selection') {
        root.dataset.selectedService = row.dataset.serviceUnit
        for (const item of root.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === row))
      }
    },
    async screenshot(filename) { screenshots.push(filename) },
  }
  const options = { driver, fixture, state, role, record: async (name, details) => records.push({ name, ...details }), checkpoint: async name => { checkpoints.push(name); return `${fixture.artifactDir}/${name}.png` } }
  return { dom, document, fixture, state, driver, options, records, clicks, screenshots, checkpoints, reads: () => reads }
}

test('service rectangle evidence rejects non-finite, coerced, empty or unbounded layouts without retaining arbitrary fields', () => {
  assert.deepEqual(validateOpsUiServiceRect({ x: 12.5, y: -100, width: 300, height: 56, privateDetail: 'discard' }), { x: 12.5, y: -100, width: 300, height: 56 })
  for (const bad of [null, { x: NaN, y: 0, width: 30, height: 30 }, { x: 0, y: Infinity, width: 30, height: 30 }, { x: '0', y: 0, width: 30, height: 30 }, { x: 32769, y: 0, width: 30, height: 30 }, { x: 0, y: 0, width: 0, height: 30 }, { x: 0, y: 0, width: 30, height: -1 }, { x: 0, y: 0, width: 20000, height: 30 }]) assert.throws(() => validateOpsUiServiceRect(bad), /service_selection_rect_invalid/)
})

test('service selection waits for bounded stable geometry and clicks both default and second rows exactly once before verifying actual selection', async () => {
  for (const role of ['direct', 'via']) {
    const unit = serviceSelectionUnit({ role, problem: 'moving' })
    try {
      // PcLayout also mounts a hidden mobile copy for the same host. Its stale
      // selection/geometry must neither count as ambiguity nor become evidence.
      const mobile = unit.document.querySelector(`[data-role="${role}"] [data-testid="workspace-services-app"]`).cloneNode(true)
      mobile.hidden = true
      unit.document.body.append(mobile)
      const before = await readOpsUiServiceSelection(unit.options)
      assert.equal(before.selected, role === 'direct')
      await selectOpsUiServiceRow(unit.options)
      assert.equal(unit.clicks.length, 1)
      assert(unit.reads() >= 5)
      assert.equal(unit.screenshots.length, 0)
      const final = unit.records.at(-1)
      assert.equal(final.phase, 'selected'); assert.equal(final.selected, true); assert.equal(final.pressed, true)
      assert.deepEqual(Object.keys(final).sort(), ['content', 'list', 'name', 'phase', 'pressed', 'role', 'row', 'selected', 'service', 'window'])
      assert(!JSON.stringify(unit.records).includes(unit.fixture.hosts[role].serviceUnit))
    } finally { unit.dom.window.close() }
  }
})

test('each unavailable WebKit rectangle retains partial geometry without blocking the one real row click', async () => {
  const fields = { row: 'workspace-service-row', list: 'workspace-services-list', service: 'workspace-services-app', window: 'workspace-desktop-window-services', content: 'workspace-window-body' }
  for (const [field, testId] of Object.entries(fields)) {
    const unit = serviceSelectionUnit()
    try {
      const realRect = unit.driver.rect, inspected = new Set()
      unit.driver.rect = async element => {
        inspected.add(element.dataset.testid)
        if (element.dataset.testid === testId) throw Object.assign(new Error('SYNTHETIC_PRIVATE_WEBDRIVER_DETAIL'), { code: 'element not interactable' })
        return realRect(element)
      }
      await selectOpsUiServiceRow(unit.options)
      assert.equal(unit.clicks.length, 1)
      assert.equal(unit.screenshots.length, 0)
      assert.equal(inspected.size, 5)
      const final = unit.records.at(-1)
      assert.equal(final.phase, 'selected'); assert.equal(final.selected, true); assert.equal(final.pressed, true)
      assert.deepEqual(final[field], { available: false, reason: 'element-not-interactable' })
      for (const other of Object.keys(fields).filter(key => key !== field)) assert(final[other].width > 0)
      assert(!JSON.stringify(unit.records).includes('SYNTHETIC'))
    } finally { unit.dom.window.close() }
  }
})

test('an unavailable ancestor rectangle never converts an actual row click failure into success', async () => {
  const unit = serviceSelectionUnit({ problem: 'click' })
  try {
    const realRect = unit.driver.rect
    unit.driver.rect = async element => {
      if (element.dataset.testid === 'workspace-services-list') throw Object.assign(new Error('SYNTHETIC_PRIVATE_WEBDRIVER_DETAIL'), { code: 'element not interactable' })
      return realRect(element)
    }
    await assert.rejects(selectOpsUiServiceRow(unit.options), /fixed_click_failed/)
    assert.equal(unit.clicks.length, 1)
    assert.equal(unit.screenshots.length, 1)
    const failed = unit.records.find(row => row.phase === 'failed')
    assert.deepEqual(failed.list, { available: false, reason: 'element-not-interactable' })
    assert(failed.row.width > 0 && failed.content.height > 0)
    assert.equal(failed.selected, false); assert.equal(failed.pressed, false)
    assert.equal(unit.records.at(-1).captured, true)
    assert(!JSON.stringify(unit.records).includes('SYNTHETIC'))
  } finally { unit.dom.window.close() }
})

test('unrelated rectangle errors and invalid rectangle responses still stop selection before clicking', async () => {
  for (const problem of ['transport', 'invalid']) {
    const unit = serviceSelectionUnit()
    try {
      const realRect = unit.driver.rect
      unit.driver.rect = async element => {
        if (element.dataset.testid !== 'workspace-services-list') return realRect(element)
        if (problem === 'transport') throw Object.assign(new Error('fixed_rect_transport_failed'), { code: 'transport failure' })
        return { x: 0, y: 0, width: 0, height: 448 }
      }
      await assert.rejects(selectOpsUiServiceRow(unit.options), problem === 'transport' ? /fixed_rect_transport_failed/ : /service_selection_rect_invalid/)
      assert.equal(unit.clicks.length, 0)
      assert.equal(unit.screenshots.length, 1)
      assert(unit.records.some(row => row.name === 'ops-ui-service-selection-geometry-unavailable'))
      assert.equal(unit.records.at(-1).captured, true)
    } finally { unit.dom.window.close() }
  }
})

test('selection failure reads post-failure rectangles and reserves one scoped actual screenshot without retrying the row click', async () => {
  for (const problem of ['click', 'post-selection']) {
    const unit = serviceSelectionUnit({ problem })
    try {
      await assert.rejects(selectOpsUiServiceRow(unit.options), /fixed_click_failed|fixed_readiness_failed/)
      assert.equal(unit.clicks.length, 1)
      assert.deepEqual(unit.checkpoints, ['service-via-selection-failed'])
      assert.deepEqual(unit.screenshots, ['/private/owned-desktop/artifacts/service-via-selection-failed.png'])
      assert(unit.records.some(row => row.phase === 'failed' && row.content.height > 0))
      assert.equal(unit.records.at(-1).captured, true)
    } finally { unit.dom.window.close() }
  }
})

test('failure pixels are refused for dialogs, retained credentials, foreign scope or paths', async () => {
  for (const problem of ['dialog', 'password', 'textarea', 'vault', 'host', 'path']) {
    const unit = serviceSelectionUnit({ problem: 'click' })
    try {
      if (problem === 'dialog') unit.document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
      if (problem === 'password' || problem === 'textarea') {
        unit.document.body.insertAdjacentHTML('beforeend', problem === 'password' ? '<input type="password">' : '<textarea></textarea>')
        unit.document.querySelector(problem === 'password' ? 'input' : 'textarea').value = 'SYNTHETIC_PRIVATE_INPUT'
      }
      if (problem === 'vault') unit.document.querySelector('[data-role="via"] [data-testid="workspace-services-app"]').dataset.vaultId = 'foreign'
      if (problem === 'host') unit.document.querySelector('[data-role="via"] [data-testid="workspace-services-app"]').dataset.hostId = 'foreign'
      if (problem === 'path') unit.options.checkpoint = async () => '/outside/service-via-selection-failed.png'
      await assert.rejects(selectOpsUiServiceRow(unit.options))
      assert.equal(unit.screenshots.length, 0)
      assert.equal(unit.records.at(-1).captured, false)
      assert(!JSON.stringify(unit.records).includes('SYNTHETIC'))
      if (['vault', 'host'].includes(problem)) assert.equal(unit.clicks.length, 0)
    } finally { unit.dom.window.close() }
  }
})

test('a clipped row, zero-size or malformed rectangle still permits safe failure pixels of the real scoped service surface and never clicks', async () => {
  for (const problem of ['clipped', 'zero', 'rect']) {
    const unit = serviceSelectionUnit()
    try {
      if (problem === 'clipped') unit.document.querySelector('[data-role="via"] [data-service-unit$="-via.service"]').hidden = true
      else unit.driver.rect = async () => ({ x: problem === 'rect' ? NaN : 0, y: 0, width: problem === 'zero' ? 0 : 1, height: 1 })
      await assert.rejects(selectOpsUiServiceRow(unit.options), /service_selection_(surface_missing|rect_invalid)/)
      assert.equal(unit.clicks.length, 0)
      assert.equal(unit.records.at(-1).captured, true)
      assert.equal(unit.screenshots.length, 1)
    } finally { unit.dom.window.close() }
  }
})

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function ruleActivationDriver() {
  let selected = null
  const events = []
  return {
    events,
    async horizontalScrollState() { return { width: 1054, contentWidth: 1054, left: 0 } },
    async until(fn) { assert(await fn()) },
    async findAll(css) {
      if (css === '[data-testid="host-ops-drawer-close"]') return []
      assert.equal(css, '[data-testid="host-list-scroll-controls"] input[type="range"]')
      return []
    },
    async waitFor(css) {
      if (css.includes('local-alert-row')) {
        assert(css.includes('data-alert-status="active"'))
        assert(css.includes(`data-transport="${selected === 'via' ? 'proxy-jump' : 'direct'}"`))
        events.push(`observed-${selected}`)
      }
    },
    async click(css) { if (css.includes('local-rule-add')) events.push(`created-${selected}`) },
    async select(css) { if (css.includes('host-ops-open')) selected = css.includes('direct-host') ? 'direct' : 'via' },
    async fill() {},
    async attr() { return 'vault' },
  }
}

test('rule activation observes each real UI route and awaits its notification hook before the next host', async () => {
  const { fixture, state } = journeyContext()
  const driver = ruleActivationDriver()
  const opened = deferred()
  const release = deferred()
  const callbacks = []
  const work = activateOpsUiRules({ driver, fixture, resumeState: state, record: async () => {}, onOpened: async role => {
    assert(driver.events.includes(`observed-${role}`))
    callbacks.push(role)
    if (role === 'direct') { opened.resolve(); await release.promise }
  } })
  await opened.promise
  assert.deepEqual(callbacks, ['direct'])
  assert.equal(driver.events.includes('created-via'), false)
  release.resolve()
  assert.deepEqual(await work, { passed: true, rules: 2 })
  assert.deepEqual(callbacks, ['direct', 'via'])
})

test('failed opened notification evidence stops activation before creating another rule', async () => {
  const { fixture, state } = journeyContext()
  const driver = ruleActivationDriver()
  await assert.rejects(activateOpsUiRules({ driver, fixture, resumeState: state, record: async () => {}, onOpened: async () => { throw new Error('notification_evidence_failed') } }), /notification_evidence_failed/)
  assert.deepEqual(driver.events, ['created-direct', 'observed-direct'])
})

function recoveryDriver(state, restartedAfter, allowFresh) {
  const samples = [{ state: 'unknown', sample: restartedAfter - 1 }, { state: 'healthy', sample: restartedAfter - 1 }, { state: 'healthy', sample: Date.now() + 60_000 }, ...(allowFresh ? [{ state: 'healthy', sample: restartedAfter }] : [])]
  let selected = null
  let sampleRead = false
  let index = 0
  let auditStatus = 'all'
  const reads = []
  return {
    reads,
    async horizontalScrollState() { return { width: 1054, contentWidth: 1054, left: 0 } },
    async waitFor() {}, async fill() {}, async click() {},
    async findAll(css) { return css.includes('operation-audit-row') ? [css] : [] },
    async isDisplayed() { return true },
    async text(css) { assert(css.includes('operations-page')); return 'Page 1' },
    async select(css, value) {
      if (css.includes('operations-filter')) auditStatus = value
      else if (!css.includes('operations-source-filter')) { selected = css.includes('direct-host') ? 'direct' : 'via'; index = 0 }
    },
    async attr(css, name) {
      if (name === 'disabled') return null
      if (name === 'value') return css.includes('operations-source-filter') ? 'workspace' : auditStatus
      if (name === 'data-mode') return 'unlock'
      if (name === 'data-vault-id') return state.vaultId
      if (name === 'data-job-id') return /\[data-job-id="([^"]+)"\]/.exec(css)?.[1]
      if (name === 'data-rule-state') { sampleRead = true; reads.push({ role: selected, ...samples[index] }); return samples[index].state }
      if (name === 'data-sampled-at') return String(samples[index].sample)
      throw new Error('unexpected read')
    },
    async until(fn) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        sampleRead = false
        const result = await fn()
        if (result) return result
        if (sampleRead) index = Math.min(index + 1, samples.length - 1)
      }
      throw new Error('observation_timeout')
    },
  }
}

test('recovery waits for both post-restart healthy observations rather than cached or future samples', async () => {
  const { fixture, state } = journeyContext()
  for (const role of ['direct', 'via']) state.jobs[role] = { cancelled: `cancelled-${role}`, completed: `completed-${role}`, baseline: {} }
  const restartedAfter = Date.now() - 1_000
  const driver = recoveryDriver(state, restartedAfter, true)
  const events = []
  const result = await resumeOpsUiJourney({ driver, fixture, resumeState: state, restartedAfter, record: async (name, detail) => events.push({ name, ...detail }), checkpoint: async () => {} })
  assert.equal(result.freshObservations, 2)
  for (const role of ['direct', 'via']) {
    assert.deepEqual(driver.reads.filter(row => row.role === role).map(row => row.state), ['unknown', 'healthy', 'healthy', 'healthy'])
    assert.equal(events.find(row => row.name === `ops-ui-${role}-restored`)?.freshObservation, true)
  }
  assert.equal(JSON.stringify(events).includes(state.vaultPassword), false)
})

test('recovery never passes solely on a persisted healthy cache or without a restart boundary', async () => {
  const { fixture, state } = journeyContext()
  for (const role of ['direct', 'via']) state.jobs[role] = { cancelled: `cancelled-${role}`, completed: `completed-${role}`, baseline: {} }
  const restartedAfter = Date.now() - 1_000
  const driver = recoveryDriver(state, restartedAfter, false)
  const events = []
  const options = { driver, fixture, resumeState: state, record: async name => events.push(name), checkpoint: async () => {} }
  await assert.rejects(resumeOpsUiJourney(options), /^Error: ops_ui_restart_boundary_missing$/)
  assert.deepEqual(events, [])
  await assert.rejects(resumeOpsUiJourney({ ...options, restartedAfter }), /observation_timeout/)
  assert.equal(events.some(name => name.endsWith('-restored')), false)
})

test('incident recovery awaits its evidence hook only after the matching resolved route is visible', async () => {
  const { fixture, state } = journeyContext()
  const dom = new JSDOM('<section data-testid="operations-audit-center"><select data-testid="operations-source-filter"><option value="all">All</option><option value="workspace">Workspace</option></select><select data-testid="operations-filter"><option value="all">All</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><button data-testid="operations-refresh">Refresh</button><span data-testid="operations-page">Page 1</span><button data-testid="operations-older" disabled>Older</button></section>'), document = dom.window.document
  document.body.insertAdjacentHTML('beforeend', serviceWindows(fixture, state))
  let role = 'direct'
  let confirmed = false
  const observed = []
  const diagnosed = []
  const responses = [], requests = []
  const driver = {
    async horizontalScrollState() { return { width: 1054, contentWidth: 1054, left: 0 } },
    async waitFor(css) { if (css.includes('data-alert-status="resolved"')) { assert(css.includes(`data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}"`)); observed.push(role) } },
    async select(css, value) {
      if (css.includes('operations-')) document.querySelector(css).value = value
      else role = css.includes('direct-host') ? 'direct' : 'via'
    },
    async click(css) {
      if (css.includes('host-services-open')) {
        role = css.includes('direct-host') ? 'direct' : 'via'; confirmed = false; diagnosed.push(role)
        for (const window of document.querySelectorAll('[data-testid="workspace-desktop-window-services"]')) window.hidden = window.dataset.role !== role
      }
      else if (css.includes('workspace-service-row')) {
        const row = document.querySelector(css); assert(row)
        const root = row.closest('[data-testid="workspace-services-app"]')
        root.dataset.selectedService = row.dataset.serviceUnit
        for (const item of root.querySelectorAll('[data-testid="workspace-service-row"]')) item.setAttribute('aria-pressed', String(item === row))
      }
      else if (css.includes('workspace-service-restart')) {
        requests.push(role)
        document.body.insertAdjacentHTML('beforeend', `<dialog open><div data-testid="user-confirmation" data-vault-id="${state.vaultId}" data-host-id="${state.hostIds[role]}"><p data-testid="user-confirmation-message">Restart ${fixture.hosts[role].serviceUnit} · ${fixture.hosts[role].name}</p><button data-testid="user-confirmation-cancel">Cancel</button><button data-testid="user-confirmation-accept">Confirm</button></div></dialog>`)
      } else if (css.includes('user-confirmation-accept') || css.includes('user-confirmation-cancel')) {
        const button = document.querySelector(css); assert(button)
        const accept = button.dataset.testid === 'user-confirmation-accept'
        responses.push(`${role}:${accept ? 'accept' : 'cancel'}`)
        if (accept) confirmed = true
        document.querySelector('[data-testid="operations-audit-center"]').insertAdjacentHTML('beforeend', `<div data-testid="operation-audit-row" data-vault-id="${state.vaultId}" data-host-id="${state.hostIds[role]}" data-action="service.restart" data-target="${fixture.hosts[role].serviceUnit}" data-status="${accept ? 'completed' : 'cancelled'}" data-confirmation="${accept ? 'confirmed' : 'rejected'}" data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}" data-job-id="${accept ? 'completed' : 'cancelled'}-${role}"></div>`)
        button.closest('dialog').remove()
      }
    },
    async findAll(css, parent = document) { return [...parent.querySelectorAll(css)] },
    async isDisplayed(row) { return !row.closest('[hidden]') },
    async rect() { return { x: 100, y: 150, width: 600, height: 60 } },
    async attr(css, name) {
      if (typeof css !== 'string') return css.getAttribute(name)
      if (css.includes('user-confirmation')) return document.querySelector(css).getAttribute(name)
      if (name === 'value') return document.querySelector(css).value
      if (name === 'data-open-count') return '1'
      if (name === 'data-host-health') return 'online'
      if (name === 'data-vault-id') return state.vaultId
      if (name === 'data-active-state') return 'failed'
      if (name === 'disabled') return null
      if (name === 'data-job-id') return `${css.includes('data-status="cancelled"') ? 'cancelled' : 'completed'}-${role}`
      throw new Error('unexpected read')
    },
    async text(row) { return typeof row !== 'string' ? row.textContent : row.includes('operations-page') ? document.querySelector(row).textContent : confirmed ? 'status=completed' : `${fixture.hosts[role].serviceUnit}\nActive: failed (Result: exit-code)` },
    async until(fn) { for (let attempt = 0; attempt < 12; attempt++) { const result = await fn(); if (result) return result } throw new Error('unit visible state missing') },
  }
  const first = deferred()
  const release = deferred()
  const recovered = []
  const work = runOpsUiIncidents({ driver, fixture, resumeState: state, record: async () => {}, checkpoint: async () => ({}), onRecovered: async current => {
    assert(observed.includes(current))
    recovered.push(current)
    if (current === 'direct') { first.resolve(); await release.promise }
  } })
  try {
    await Promise.race([first.promise, work.then(() => { throw new Error('unit recovery hook never called') })])
    assert.deepEqual(recovered, ['direct'])
    assert.equal(diagnosed.includes('via'), false)
    release.resolve()
    assert.equal((await work).passed, true)
    assert.deepEqual(recovered, ['direct', 'via'])
    assert.deepEqual(requests, ['direct', 'direct', 'via', 'via'])
    assert.deepEqual(responses, ['direct:cancel', 'direct:accept', 'via:cancel', 'via:accept'])
    assert.equal(document.querySelector('dialog'), null)
  } finally { release.resolve(); dom.window.close() }
})


function hostNavigationDriver() {
  const range = {}, actions = [], waits = []
  let position = 0
  const driver = {
    async waitFor(css) { waits.push(css) },
    async horizontalScrollState(css) { assert.equal(css, '[data-testid="host-list-scroll-viewport"]'); return { width: 1054, contentWidth: 1184, left: position } },
    async findAll(css) { assert.equal(css, '[data-testid="host-list-scroll-controls"] input[type="range"]'); return [range] },
    async isDisplayed(element) { assert.equal(element, range); return true },
    async attr(element, field) { assert.equal(element, range); assert(['value', 'max'].includes(field)); return String(field === 'max' ? 130 : position) },
    async click(element) { assert.equal(element, range); actions.push('range-click'); position = 65 },
    route(path) { return '/session/test' + path },
    async request(method, path, body) { assert.equal(method, 'POST'); assert.equal(path, '/session/test/actions'); actions.push(body); position = 130 },
    async until(read) { for (let i = 0; i < 4; i++) if (await read()) return; throw new Error('readiness_timeout') },
  }
  return { driver, range, actions, waits }
}

test('host connection navigation waits for the target and viewport, then uses one range click and End', async () => {
  const { driver, actions, waits } = hostNavigationDriver()
  await revealOpsUiHostActions(driver, 'target-host-action')
  assert.deepEqual(waits, ['target-host-action', '[data-testid="host-list-scroll-viewport"]'])
  assert.deepEqual(driver.lastHostNavigation, { rangeCount: 1, max: 130, value: 0, width: 1054, contentWidth: 1184, left: 0, decision: 'range-and-end', settled: true })
  assert.deepEqual(actions, ['range-click', { actions: [{ type: 'key', id: 'host-list-navigation', actions: [
    { type: 'keyDown', value: '\uE010' }, { type: 'keyUp', value: '\uE010' },
  ] }] }])
  await revealOpsUiHostActions(driver, 'target-host-action')
  assert.equal(actions.length, 2)
  assert.equal(driver.lastHostNavigation.decision, 'already-at-end')
  assert.equal(driver.lastHostNavigation.settled, true)
})

test('a header before list mount cannot turn missing controls into a no-overflow decision', async () => {
  const { driver, actions } = hostNavigationDriver(), mounted = deferred(), waiting = deferred()
  const originalWait = driver.waitFor, originalFind = driver.findAll
  let reads = 0
  driver.waitFor = async css => { if (css === 'target-host-action') { waiting.resolve(); await mounted.promise } await originalWait(css) }
  driver.findAll = async css => { reads++; return originalFind(css) }
  const work = revealOpsUiHostActions(driver, 'target-host-action')
  try {
    await waiting.promise
    assert.equal(reads, 0); assert.equal(actions.length, 0)
    assert.equal(driver.lastHostNavigation.decision, 'waiting-for-host')
    mounted.resolve(); await work
    assert.equal(driver.lastHostNavigation.decision, 'range-and-end')
    assert.equal(actions.length, 2)
  } finally { mounted.resolve() }
})

test('overflow waits for mounted controls and matching geometry; only measured no-overflow may omit navigation', async () => {
  const { driver, actions, range } = hostNavigationDriver()
  let reads = 0
  driver.findAll = async () => ++reads === 1 ? [] : [range]
  const originalAttr = driver.attr
  driver.attr = async (element, field) => reads === 2 && field === 'max' ? '20' : originalAttr(element, field)
  await revealOpsUiHostActions(driver, 'target')
  assert.equal(reads, 3); assert.equal(actions.length, 2)
  driver.findAll = async () => []
  driver.horizontalScrollState = async () => ({ width: 1054, contentWidth: 1054, left: 0 })
  await revealOpsUiHostActions(driver, 'target')
  assert.equal(driver.lastHostNavigation.decision, 'no-overflow')
  assert.equal(actions.length, 2)
})

test('missing controls with overflow and missing layout never proceed to an operation', async () => {
  for (const width of [0, 1054]) {
    const { driver, actions } = hostNavigationDriver()
    driver.horizontalScrollState = async () => ({ width, contentWidth: 1184, left: 0 })
    driver.findAll = async () => []
    await assert.rejects(revealOpsUiHostActions(driver, 'target'), /readiness_timeout/)
    assert.equal(actions.length, 0); assert.equal(driver.lastHostNavigation.settled, false)
  }
})

test('range state at the end cannot replace actual viewport scroll confirmation', async () => {
  const { driver, actions } = hostNavigationDriver()
  let reads = 0
  driver.horizontalScrollState = async () => ({ width: 1054, contentWidth: 1184, left: ++reads < 3 ? 0 : 130 })
  await revealOpsUiHostActions(driver, 'target')
  assert.equal(reads, 3); assert.equal(actions.length, 2)
  const stuck = hostNavigationDriver()
  stuck.driver.horizontalScrollState = async () => ({ width: 1054, contentWidth: 1184, left: 0 })
  await assert.rejects(revealOpsUiHostActions(stuck.driver, 'target'), /readiness_timeout/)
  assert.equal(stuck.actions.length, 2, 'failed scroll confirmation does not repeat the click or key')
})

test('host navigation rejects ambiguous controls and preserves a failed single range click', async () => {
  const { driver, range } = hostNavigationDriver()
  let clicks = 0, keys = 0
  driver.click = async () => { clicks++; throw new Error('native-click-failed') }
  driver.request = async () => { keys++ }
  await assert.rejects(revealOpsUiHostActions(driver, 'target'), /native-click-failed/)
  assert.equal(driver.lastHostNavigation.settled, false)
  assert.equal(clicks, 1); assert.equal(keys, 0)
  await assert.rejects(revealOpsUiHostActions({ ...driver, async findAll() { return [range, range] } }, 'target'), /host_scroll_control_ambiguous/)
  await assert.rejects(revealOpsUiHostActions({ ...driver, async isDisplayed() { return false } }, 'target'), /host_scroll_control_ambiguous/)
  await assert.rejects(revealOpsUiHostActions({ ...driver, async attr() { return 'invalid' } }, 'target'), /host_scroll_range_invalid/)
  await assert.rejects(revealOpsUiHostActions({ ...driver, async horizontalScrollState() { return { width: 'private', contentWidth: 1184, left: 0 } } }, 'target'), /host_scroll_geometry_invalid/)
  await assert.rejects(revealOpsUiHostActions(driver), /host_navigation_target_missing/)
  assert.equal(clicks, 1); assert.equal(keys, 0)
})
