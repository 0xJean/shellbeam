// Node contracts and mocked OS-owner control flow only. Real dunst ownership,
// X11 display, OCR pixels and app restart still require hosted Linux CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { ensureOpsUiHostDetails } from './ops-ui-host-details.mjs'
import { OPS_UI_PROBE_RULE_IDS } from './ops-ui-probe-journey.mjs'
import {
  assertSafeProbeNotificationUi, createOpsUiProbeNotificationOwner,
  probeNotificationConfig, probeNotificationTitles, verifyProbeNotificationPolicy,
} from './ops-ui-probe-notifications.mjs'

const roles = ['direct', 'via', 'jump']
const id = 'shellbeam-ops-ui-live-abcdef0123456789-0123456789'
const rule = OPS_UI_PROBE_RULE_IDS.metrics
function scope() {
  return { fixture: { schemaVersion: 1, fixtureId: id, hosts: Object.fromEntries(roles.map((role, index) => [role, { name: `ShellBeam UI ${role} ${id}`, address: '127.0.0.1', port: 2231 + index, user: 'root' }])) }, resumeState: { vaultId: 'private-vault', hostIds: { direct: 'direct-target', via: 'via-target', jump: 'jump-profile' } } }
}
function ui() {
  const options = scope(), titles = probeNotificationTitles(options.fixture, options.resumeState)
  const dom = new JSDOM(`<button data-testid="pc-dashboard"></button><section data-testid="notification-settings"></section>${roles.map(role => `<article data-testid="host-card" data-host-id="${options.resumeState.hostIds[role]}"><span data-testid="host-probe-evaluation" data-rule-id="${rule}" data-vault-id="${options.resumeState.vaultId}" data-host-id="${options.resumeState.hostIds[role]}" data-state="firing" data-sampled-at="${Date.now() - 1}">Metrics</span><div data-testid="host-local-alert" data-host-id="${options.resumeState.hostIds[role]}" data-vault-id="${options.resumeState.vaultId}" data-rule-id="${rule}" data-metric="probe-provider" data-source="ssh-agentless" data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}" data-alert-status="active">${titles[role]} · Monitoring collection</div></article>`).join('')}<input type="password"><textarea></textarea>`)
  const document = dom.window.document
  const navigation = []
  let monitoringOpen = false
  const driver = {
    findAll: async selector => [...document.querySelectorAll(selector)],
    isDisplayed: async element => !element.closest('[hidden]'),
    attr: async (element, field) => {
      if (typeof element === 'string' && element.startsWith('xpath=')) return element.includes('Cooldown') ? '5' : '60'
      return field === 'value' ? element.value : element.getAttribute(field)
    },
    text: async element => element.textContent,
    waitFor: async target => {
      navigation.push(['wait', target])
      if (target === '[data-testid="notification-settings"]') assert(monitoringOpen, 'notification settings cannot be read before their category is opened')
      return {}
    },
    click: async target => {
      navigation.push(['click', target])
      if (target.includes('//aside//button')) monitoringOpen = false
      if (target === '[data-testid="settings-category-monitoring"]') monitoringOpen = true
    },
    isSelected: async selector => selector.includes("='Send reminders from this device'") || selector.includes("='System'") || /notification-recovery-(?:enabled|channel-system)/.test(selector),
  }
  const transition = (role, event) => {
    const card = document.querySelector(`[data-host-id="${options.resumeState.hostIds[role]}"]`)
    card.querySelector('[data-testid="host-probe-evaluation"]').dataset.state = event === 'opened' ? 'firing' : 'healthy'
    card.querySelector('[data-testid="host-local-alert"]').dataset.alertStatus = event === 'opened' ? 'active' : 'resolved'
  }
  return { ...options, titles, dom, document, driver, transition, navigation }
}

test('only fixed fixture titles, production 48-character host context and six exact metrics lifecycle messages enter the real daemon rules', () => {
  const { fixture, resumeState } = scope()
  const titles = probeNotificationTitles(fixture, resumeState)
  assert.equal(titles.direct, `${fixture.hosts.direct.name.slice(0, 48)} · Metrics collection unavailable`)
  assert.notEqual(titles.via, titles.jump)
  const config = probeNotificationConfig(fixture, resumeState)
  const sections = new Map(); let current
  for (const line of config.split('\n')) {
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) { current = {}; sections.set(section[1], current) }
    const field = line.match(/^([a-z_]+) = (.*)$/)
    if (field) current[field[1]] = field[2]
  }
  assert.equal(sections.get('ignore_unrelated').skip_display, 'true')
  assert.equal(sections.get('ignore_unrelated').history_ignore, 'true')
  assert.equal(sections.get('global').notification_limit, '2')
  const allowed = [...sections.values()].filter(section => section.skip_display === 'false')
  assert.deepEqual(allowed.map(section => [section.appname, section.summary, section.body, section.timeout]), roles.flatMap(role => ['opened', 'resolved'].map(event => ['app.shellbeam', titles[role], `${titles[role]}: ${event}`, '0'])))
  assert(!sections.has('show_fixed_ui_test'))
  for (const name of ['arbitrary host', `${fixture.hosts.direct.name}\nscript=/bin/sh`, fixture.hosts.direct.name.replace('direct', 'via')]) {
    assert.throws(() => probeNotificationTitles({ ...fixture, hosts: { ...fixture.hosts, direct: { ...fixture.hosts.direct, name } } }, resumeState), /invalid_fixture_title|fixture_names_not_independent/)
  }
})

test('policy verification is read-only and refuses changed channels or timing instead of silently repairing settings', async () => {
  const unit = ui()
  try {
    unit.driver.click = async () => { throw new Error('no policy writes allowed') }
    await verifyProbeNotificationPolicy(unit.driver)
    await assert.rejects(verifyProbeNotificationPolicy({ ...unit.driver, isSelected: async () => true }), /policy_not_system_only/)
    await assert.rejects(verifyProbeNotificationPolicy({ ...unit.driver, attr: async () => '0' }), /policy_timing_changed/)
  } finally { unit.dom.window.close() }
})

test('pixel safety requires each actual metrics host/Vault/source/route/state and refuses hidden UI or retained credential contents', async () => {
  const unit = ui(), context = { state: unit.resumeState, titles: unit.titles, profiles: ['via', 'jump'], event: 'opened' }
  const row = unit.document.querySelector('[data-transport="proxy-jump"]')
  try {
    await assertSafeProbeNotificationUi(unit.driver, context)
    row.dataset.transport = 'direct'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unexpected_alert_source/)
    row.dataset.transport = 'proxy-jump'; row.dataset.source = 'komari'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unexpected_alert_source/)
    row.dataset.source = 'ssh-agentless'; row.dataset.metric = 'cpu'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unexpected_alert_source/)
    row.dataset.metric = 'probe-provider'
    row.dataset.vaultId = 'foreign'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_alert_vault_scope/)
    row.removeAttribute('data-vault-id')
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_alert_vault_scope/)
    row.dataset.vaultId = unit.resumeState.vaultId
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, { ...context, state: { ...unit.resumeState, vaultId: 'foreign' } }), /unsafe_vault_scope/)
    row.hidden = true
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_alert_scope/)
    row.hidden = false; unit.document.querySelector('input').value = 'unit-private-value'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_screenshot_ui/)
    unit.document.querySelector('input').value = ''; unit.document.querySelector('textarea').value = 'unit-private-value'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_screenshot_ui/)
  } finally { unit.dom.window.close() }
})

test('notification capture only reads prepared host details, never expands them, and still refuses hidden or foreign evidence', async () => {
  const unit = ui(), context = { state: unit.resumeState, titles: unit.titles, profiles: ['via', 'jump'], event: 'opened' }
  const clicks = []
  try {
    for (const role of roles) {
      const card = unit.document.querySelector(`[data-testid="host-card"][data-host-id="${unit.resumeState.hostIds[role]}"]`)
      card.dataset.vaultId = unit.resumeState.vaultId
      const section = unit.document.createElement('section')
      section.dataset.testid = 'host-ops-details'; section.id = `${role}-details`; section.hidden = true
      section.append(...card.childNodes)
      card.append(section)
      card.insertAdjacentHTML('afterbegin', `<button data-testid="host-ops-details-toggle" aria-expanded="false" aria-controls="${section.id}">Details</button>`)
    }
    unit.driver.click = async selector => {
      const toggle = unit.document.querySelector(selector)
      assert(toggle && !toggle.closest('[hidden]'))
      const card = toggle.closest('[data-testid="host-card"]')
      clicks.push(card.dataset.hostId)
      toggle.setAttribute('aria-expanded', 'true')
      card.querySelector('[data-testid="host-ops-details"]').hidden = false
    }
    unit.driver.until = async predicate => { const value = await predicate(); assert(value, 'unit disclosure not visible'); return value }
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_host_scope/)
    assert.equal(clicks.length, 0, 'capture must not change native focus by expanding a collapsed host')
    await ensureOpsUiHostDetails(unit.driver, { hostId: unit.resumeState.hostIds.via, vaultId: unit.resumeState.vaultId })
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_host_scope/)
    assert.deepEqual(clicks, [unit.resumeState.hostIds.via], 'capture must not expand the other group member')
    await ensureOpsUiHostDetails(unit.driver, { hostId: unit.resumeState.hostIds.jump, vaultId: unit.resumeState.vaultId })
    await assertSafeProbeNotificationUi(unit.driver, context)
    await assertSafeProbeNotificationUi(unit.driver, context)
    assert.deepEqual(clicks, [unit.resumeState.hostIds.via, unit.resumeState.hostIds.jump])
    assert(unit.document.getElementById('direct-details').hidden)
    const alert = unit.document.querySelector('[data-transport="proxy-jump"]')
    alert.hidden = true
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_alert_scope/)
    alert.hidden = false; alert.dataset.vaultId = 'foreign'
    await assert.rejects(assertSafeProbeNotificationUi(unit.driver, context), /unsafe_alert_vault_scope/)
    assert.equal(clicks.length, 2)
  } finally { unit.dom.window.close() }
})

function harness() {
  const unit = ui(), records = [], captures = []
  let clock = Date.now(), displayed = 0, waiting = 0, history = 0, stops = 0, delivered = 12, visible = true
  const geometry = { x: 20, y: 20, width: 800, height: 400 }
  const daemon = {
    counts: async () => ({ displayed, waiting }), history: async () => history,
    geometry: async () => displayed && visible ? geometry : null,
    captureGroup: async options => {
      await options.assertSafeUi(options.driver)
      captures.push(options)
      // This fake return tests coordinator flow only; never proves OS pixels.
      return options.expectations.map(() => ({ screenshot: `${options.name}.png`, bannerScreenshot: `${options.name}-banner.png`, sha256: 'a'.repeat(64), bannerSha256: 'b'.repeat(64), ocrAccepted: true, ocrTitleMatched: true, ocrBodyMatched: true }))
    },
    closeAll: async () => { history += displayed; displayed = 0 }, stop: async () => { stops++ },
  }
  return { ...unit, records, captures, daemon,
    options: { ...unit, record: async (name, details) => records.push({ name, ...details }), checkpoint: async () => { throw new Error('capture is mocked in this unit test') } },
    dependencies: { startDaemon: async () => daemon, readDiagnostic: async () => ({ delivered, accepted: false }), now: () => clock, pause: async ms => { clock += ms } },
    emit: (role, event) => { const group = role === 'via' ? ['via', 'jump'] : ['direct']; for (const member of group) unit.transition(member, event); displayed = group.length; delivered += group.length },
    setCounts: values => { ({ displayed = displayed, waiting = waiting, history = history } = values) },
    setVisible: value => { visible = value }, setDelivered: value => { delivered = value }, stopCount: () => stops,
  }
}
async function verifyAll(owner, unit) {
  for (const [role, event] of [['direct', 'opened'], ['direct', 'resolved'], ['via', 'opened'], ['via', 'resolved']]) {
    unit.emit(role, event)
    await owner[event === 'opened' ? 'verifyOpened' : 'verifyResolved'](role)
  }
}

test('Probe notification startup and both restart boundaries use the visible monitoring category', async () => {
  const unit = harness()
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    await verifyAll(owner, unit)
    await owner.beforeRestart()
    await owner.afterRestart({ driver: { ...unit.driver } })
    const visits = unit.navigation.filter(([, target]) => target === '[data-testid="settings-category-monitoring"]' || target === '[data-testid="notification-settings"]')
    assert.deepEqual(visits, Array.from({ length: 3 }, () => [
      ['wait', '[data-testid="settings-category-monitoring"]'],
      ['click', '[data-testid="settings-category-monitoring"]'],
      ['wait', '[data-testid="notification-settings"]'],
    ]).flat())
    await owner.stop()
  } finally { unit.dom.window.close() }
})

test('one/direct and two/via+jump visible groups each require every full independent title/body and total exactly six history rows', async () => {
  const unit = harness()
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    await assert.rejects(owner.verifyResolved('direct'), /invalid_verification_phase/)
    await verifyAll(owner, unit)
    assert.equal(unit.captures.length, 4)
    assert.deepEqual(unit.captures.map(capture => capture.expectations.length), [1, 1, 2, 2])
    assert.deepEqual(unit.captures.flatMap(capture => capture.expectations.map(item => [item.title, item.body])), [
      ...['opened', 'resolved'].map(event => [unit.titles.direct, `${unit.titles.direct}: ${event}`]),
      ...['opened', 'resolved'].flatMap(event => ['via', 'jump'].map(role => [unit.titles[role], `${unit.titles[role]}: ${event}`])),
    ])
    assert(unit.captures.every(capture => capture.expectedVisible && typeof capture.assertSafeUi === 'function'))
    const visible = unit.records.filter(item => item.x11Viewable)
    assert.equal(visible.length, 6)
    for (const event of ['opened', 'resolved']) {
      const group = visible.filter(item => ['via', 'jump'].some(role => item.name === `notification-probe-${role}-${event}`))
      assert.equal(group.length, 2)
      assert.equal(group[0].screenshot, group[1].screenshot)
      assert.equal(group[0].sha256, group[1].sha256)
      assert.equal(group[0].bannerScreenshot, group[1].bannerScreenshot)
      assert.equal(group[0].bannerSha256, group[1].bannerSha256)
    }
    // Extra actual accepted metadata notifications are permitted. The current
    // outcome may be Blocked/Failed; counts still must be real and durable.
    unit.setDelivered(23)
    await owner.beforeRestart()
    const result = await owner.afterRestart({ driver: { ...unit.driver } })
    assert.equal(result.restoredDelivered, 23)
    assert.equal(result.history, 6)
    assert.equal(result.metricsVisible, 6)
    assert.equal(result.inventoryLifecycleVerified, false)
    assert.equal(result.komariLifecycleVerified, false)
    assert.equal(result.readReceiptVerified, false)
    assert.equal(result.noReplayObservedMs, 5000)
    assert(!JSON.stringify(unit.records).includes('Metrics collection unavailable'))
    await owner.stop(); await owner.stop()
    assert.equal(unit.stopCount(), 1)
  } finally { unit.dom.window.close() }
})

test('wrong daemon displayed/waiting/history and missing OS window cannot be substituted for pixel evidence', async () => {
  for (const problem of ['waiting', 'extra-banner', 'history', 'window']) {
    const unit = harness()
    try {
      const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
      unit.emit('direct', 'opened')
      if (problem === 'waiting') unit.setCounts({ waiting: 1 })
      if (problem === 'extra-banner') unit.setCounts({ displayed: 2 })
      if (problem === 'history') unit.setCounts({ history: 1 })
      if (problem === 'window') unit.setVisible(false)
      await assert.rejects(owner.verifyOpened('direct'), /metrics_banner_group_not_unique|metrics_banner_not_viewable/)
      assert.equal(unit.captures.length, 0)
      await owner.stop()
    } finally { unit.dom.window.close() }
  }
})

test('missing one group member OCR fails the group without marking it verified or closing its banners', async () => {
  const unit = harness()
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    for (const event of ['opened', 'resolved']) { unit.emit('direct', event); await owner[event === 'opened' ? 'verifyOpened' : 'verifyResolved']('direct') }
    const capture = unit.daemon.captureGroup
    unit.daemon.captureGroup = async options => { if (options.expectations.some(item => item.title === unit.titles.jump)) throw new Error('unit exact pixels missing'); return capture(options) }
    unit.emit('via', 'opened')
    await assert.rejects(owner.verifyOpened('via'), /unit exact pixels missing/)
    assert.deepEqual(await unit.daemon.counts(), { displayed: 2, waiting: 0 })
    assert.equal(await unit.daemon.history(), 2)
    await assert.rejects(owner.beforeRestart(), /incomplete_lifecycle_before_restart/)
    await owner.stop()
  } finally { unit.dom.window.close() }
})

test('a displayed group cannot join OCR evidence from different source frames or crops', async () => {
  for (const changed of ['sha256', 'bannerSha256', 'screenshot', 'bannerScreenshot']) {
    const unit = harness()
    try {
      const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
      for (const event of ['opened', 'resolved']) { unit.emit('direct', event); await owner[event === 'opened' ? 'verifyOpened' : 'verifyResolved']('direct') }
      const capture = unit.daemon.captureGroup
      unit.daemon.captureGroup = async options => {
        const evidence = await capture(options)
        evidence[1][changed] = changed.endsWith('256') ? 'c'.repeat(64) : 'another-frame.png'
        return evidence
      }
      unit.emit('via', 'opened')
      await assert.rejects(owner.verifyOpened('via'), /invalid_group_pixel_evidence/)
      assert.deepEqual(await unit.daemon.counts(), { displayed: 2, waiting: 0 })
      assert.equal(await unit.daemon.history(), 2)
      assert.equal(unit.records.filter(item => item.x11Viewable).length, 2)
      await assert.rejects(owner.beforeRestart(), /incomplete_lifecycle_before_restart/)
      await owner.stop()
    } finally { unit.dom.window.close() }
  }
})

test('restart rejects any replay, changed durable count, missing lifecycle or reused driver instead of inferring success', async () => {
  for (const problem of ['display', 'waiting', 'history', 'count', 'same-driver']) {
    const unit = harness()
    try {
      const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
      await assert.rejects(owner.beforeRestart(), /incomplete_lifecycle_before_restart/)
      await verifyAll(owner, unit); await owner.beforeRestart()
      if (problem === 'display') unit.setCounts({ displayed: 1 })
      if (problem === 'waiting') unit.setCounts({ waiting: 1 })
      if (problem === 'history') unit.setCounts({ history: 7 })
      if (problem === 'count') unit.setDelivered(19)
      await assert.rejects(owner.afterRestart({ driver: problem === 'same-driver' ? unit.driver : { ...unit.driver } }), /metrics_notification_replayed|delivery_count_changed_after_restart|invalid_restart_boundary/)
      await owner.stop()
    } finally { unit.dom.window.close() }
  }
})

test('six visible OS messages cannot substitute for missing durable System delivery records', async () => {
  const unit = harness()
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    await verifyAll(owner, unit)
    unit.setDelivered(17) // Initial 12 requires at least six actual new records.
    await assert.rejects(owner.beforeRestart(), /metrics_delivery_journal_incomplete/)
    await owner.stop()
  } finally { unit.dom.window.close() }
})

test('a scope switch cancels verification and startup policy failure stops the owned daemon', async () => {
  const unit = harness()
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    unit.resumeState.vaultId = 'foreign'
    await assert.rejects(owner.verifyOpened('direct'), /scope_changed/)
    assert.equal(unit.captures.length, 0)
    await owner.stop()
  } finally { unit.dom.window.close() }
  const bad = harness()
  bad.driver.isSelected = async () => false
  try {
    await assert.rejects(createOpsUiProbeNotificationOwner(bad.options, bad.dependencies), /policy_not_system_only/)
    assert.equal(bad.stopCount(), 1)
  } finally { bad.dom.window.close() }
})

test('overlapping verification cannot capture the same notification twice and cleanup failures remain visible', async () => {
  const unit = harness()
  let release
  const pending = new Promise(done => { release = done })
  const capture = unit.daemon.captureGroup
  unit.daemon.captureGroup = async options => { await pending; return capture(options) }
  try {
    const owner = await createOpsUiProbeNotificationOwner(unit.options, unit.dependencies)
    unit.emit('direct', 'opened')
    const first = owner.verifyOpened('direct')
    await assert.rejects(owner.verifyOpened('direct'), /invalid_verification_phase/)
    release()
    await first
    assert.equal(unit.captures.length, 1)
    assert.equal(await unit.daemon.history(), 1)
    unit.daemon.stop = async () => { throw new Error('unit owned daemon cleanup failed') }
    await assert.rejects(owner.stop(), /unit owned daemon cleanup failed/)
  } finally { release(); unit.dom.window.close() }
})
