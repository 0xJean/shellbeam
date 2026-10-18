import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { assertSafeLocalServiceUi, localServiceNotificationConfig, localServiceNotificationScope, parseSystemDeliveryDiagnostic, parseSystemDeliveryFields, readSystemDeliveryDiagnostic } from './ops-ui-alert-notifications.mjs'
import {
  evidencePathIsOwned,
  notificationDaemonConfig,
  notificationOcrMatches,
  notificationTextOcrMatches,
  inspectNotificationOcrModes,
  parsePinnedDunstVersion,
  pinnedDunstPaths,
  parseDunstCount,
  parseDunstGeometry,
  requireNotificationFixtureEnvironment,
  runOpsUiNotifications,
  startOpsUiAlertNotifications,
} from './ops-ui-notifications.mjs'

test('the exact supported upstream banner is parsed without accepting the incompatible Jammy daemon or arbitrary version text', () => {
  assert.equal(parsePinnedDunstVersion('Dunst - A customizable and lightweight notification-daemon 1.7.3 (2021-12-08)\n'), '1.7.3')
  assert.equal(parsePinnedDunstVersion('Dunst - A customizable and lightweight notification-daemon 1.7.3\r\n'), '1.7.3')
  for (const value of ['', null, '1.7.3', 'warning: expected version 1.7.3', 'Dunst - A customizable and lightweight notification-daemon 1.5.0\n', 'Dunst - A customizable and lightweight notification-daemon 1.7.30\n', 'Dunst - A customizable and lightweight notification-daemon 1.7.3\nerror']) {
    assert.throws(() => parsePinnedDunstVersion(value), /unsupported_daemon_version/)
  }
})

test('the helper selects the private pinned daemon and matching control CLI with no system-package fallback', () => {
  assert.deepEqual(pinnedDunstPaths('/private/runner-temp'), { directory: '/private/runner-temp/shellbeam-ui-dunst-1.7.3', binary: '/private/runner-temp/shellbeam-ui-dunst-1.7.3/dunst', control: '/private/runner-temp/shellbeam-ui-dunst-1.7.3/dunstctl' })
  for (const value of [undefined, '', 'relative', '/private/../outside', '/private/runner-temp/']) assert.throws(() => pinnedDunstPaths(value), /invalid_pinned_daemon_path/)
})

test('executing the installer without explicit opt-in refuses before any download, build or installation', () => {
  const refused = spawnSync('/bin/bash', [fileURLToPath(new URL('./install-ops-ui-dunst.sh', import.meta.url))], { env: { ...process.env, SHELLBEAM_OPS_UI_LIVE: '0' }, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /^ShellBeam UI dunst: requires explicit disposable ordinary-user Linux acceptance\n$/)
})

test('notification acceptance refuses workstations, root, remote displays and sandbox overrides', () => {
  const env = { RUNNER_OS: 'Linux', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', SHELLBEAM_OPS_UI_LIVE: '1', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/owned/bus' }
  assert.doesNotThrow(() => requireNotificationFixtureEnvironment(env, 'linux', 1001))
  for (const [patch, platform, uid] of [
    [{ GITHUB_ACTIONS: 'false' }, 'linux', 1001],
    [{ RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 1001],
    [{ SHELLBEAM_OPS_UI_LIVE: '' }, 'linux', 1001],
    [{ DISPLAY: 'remote:0' }, 'linux', 1001],
    [{ DBUS_SESSION_BUS_ADDRESS: 'tcp:host=remote' }, 'linux', 1001],
    [{ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', 1001],
    [{ WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' }, 'linux', 1001],
    [{}, 'darwin', 1001], [{}, 'linux', 0],
  ]) assert.throws(() => requireNotificationFixtureEnvironment({ ...env, ...patch }, platform, uid), /ops_ui_notifications_requires_isolated_hosted_linux/)
})

test('OS screenshots cannot escape the owned artifact tree or overwrite arbitrary file types', () => {
  assert(evidencePathIsOwned('/private/desktop', '/private/desktop/artifacts/notification-visible.png'))
  for (const path of ['/private/desktop', '/private/desktop-other/notification-visible.png', '/private/desktop/../outside.png', '/private/desktop/state.json', '/etc/notification.png', 'relative.png', '/private/desktop/token secret.png']) {
    assert(!evidencePathIsOwned('/private/desktop', path))
  }
})

test('OCR requires the actual fixed title and body, rather than a displayed count or UI ACK', () => {
  assert.deepEqual(notificationOcrMatches('SHELLBEAM notification test\nThe system notification channel\naccepted this test.'), { title: true, body: true })
  assert.deepEqual(notificationOcrMatches('Submitted to the system. Display depends on OS notification settings.\nSend test notification'), { title: false, body: false })
  assert.deepEqual(notificationOcrMatches('ShellBeam notification test\nThe system notification channel queued this test.'), { title: true, body: false })
})

test('bounded OCR segmentation accepts complete exact pixels in either mode without joining partial reads', async () => {
  const title = 'ShellBeam notification test'
  const body = 'The system notification channel accepted this test.'
  const calls = []
  const complete = await inspectNotificationOcrModes(async (mode) => { calls.push(mode); return mode === 6 ? `${title}\n${body}` : title }, { title, body, expectedVisible: true })
  assert.equal(complete.accepted, true)
  assert.deepEqual(calls, [6, 11])
  assert.deepEqual(complete.modes, [{ mode: 6, titleMatched: true, bodyMatched: true }, { mode: 11, titleMatched: true, bodyMatched: false }])
  const fallback = await inspectNotificationOcrModes(async (mode) => mode === 11 ? `${title}\n${body}` : '', { title, body, expectedVisible: true })
  assert.equal(fallback.accepted, true)
  const split = await inspectNotificationOcrModes(async (mode) => mode === 6 ? title : body, { title, body, expectedVisible: true })
  assert.equal(split.titleMatched, true)
  assert.equal(split.bodyMatched, true)
  assert.equal(split.accepted, false)
})

test('negative pixel proof requires both OCR modes to miss both strings and never hides a detected banner', async () => {
  const title = 'ShellBeam notification test'
  const body = 'The system notification channel accepted this test.'
  assert.equal((await inspectNotificationOcrModes(async () => 'Submitted to the system.', { title, body, expectedVisible: false })).accepted, true)
  for (const [mode, visible] of [[6, title], [11, body], [11, `${title}\n${body}`]]) {
    const result = await inspectNotificationOcrModes(async (current) => current === mode ? visible : '', { title, body, expectedVisible: false })
    assert.equal(result.accepted, false)
  }
  await assert.rejects(inspectNotificationOcrModes(async () => { throw new Error('fixed test OCR failure') }, { title, body, expectedVisible: false }), /fixed test OCR failure/)
})

test('strict dunst counts never convert failed or malformed daemon output into displayed zero', () => {
  assert.equal(parseDunstCount(' 0\n'), 0)
  assert.equal(parseDunstCount('1\n'), 1)
  for (const value of ['', '-1', 'unavailable', 'false', '0\nerror', 'NaN', '1000000']) assert.throws(() => parseDunstCount(value), /invalid_daemon_count/)
})

test('only mapped bounded X11 daemon geometry can provide a banner crop', () => {
  const facts = '  Absolute upper-left X: 480\n  Absolute upper-left Y: 18\n  Relative upper-left X: 0\n  Relative upper-left Y: 0\n  Width: 780\n  Height: 120\n  Map State: IsViewable\n'
  assert.deepEqual(parseDunstGeometry(facts), { x: 480, y: 18, width: 780, height: 120 })
  assert.equal(parseDunstGeometry(facts.replace('IsViewable', 'IsUnMapped')), null)
  assert.throws(() => parseDunstGeometry(facts.replace('X: 480', 'X: -1')), /invalid_daemon_geometry/)
  assert.throws(() => parseDunstGeometry(facts.replace('Width: 780', 'Width: 99999')), /invalid_daemon_geometry/)
  assert.throws(() => parseDunstGeometry(facts.replace('  Width: 780\n', '')), /invalid_daemon_geometry/)
})

test('the isolated daemon accepts only the exact credential-free app test into its visible window', () => {
  const config = notificationDaemonConfig()
  assert(config.indexOf('[ignore_unrelated]') < config.indexOf('[show_fixed_ui_test]'))
  assert.match(config, /\[ignore_unrelated\]\nskip_display = true\nhistory_ignore = true/)
  assert.match(config, /\[show_fixed_ui_test\]\nappname = app\.shellbeam\nsummary = ShellBeam notification test\nbody = The system notification channel accepted this test\./)
  assert.match(config, /skip_display = false\nhistory_ignore = false\nfullscreen = show\ntimeout = 0/)
  assert(!/^\s*script\s*=/m.test(config))
})

test('the UI helper exports the real runner entry without starting processes on import', () => {
  assert.equal(typeof runOpsUiNotifications, 'function')
  assert.equal(typeof startOpsUiAlertNotifications, 'function')
})

const serviceState = () => ({ hostIds: { direct: 'host-direct', via: 'host-via' }, vaultId: 'vault-one', ruleNames: { direct: 'ShellBeam UI direct service', via: 'ShellBeam UI via service' } })

test('service notification configuration refuses arbitrary names/hosts and permits only the four fixed lifecycle banners', () => {
  const state = serviceState()
  assert.deepEqual(localServiceNotificationScope(state), state.hostIds)
  for (const bad of [
    { ...state, ruleNames: { ...state.ruleNames, direct: 'arbitrary service' } },
    { ...state, ruleNames: { ...state.ruleNames, via: 'ShellBeam UI via service\nscript=/bin/sh' } },
    { ...state, ruleNames: { ...state.ruleNames, another: 'other' } },
    { ...state, hostIds: { direct: 'same', via: 'same' } },
    { ...state, hostIds: { direct: 'host-direct', via: 'bad"host' } },
  ]) assert.throws(() => localServiceNotificationConfig(bad), /invalid_(rule_names|host_scope)/)
  const config = localServiceNotificationConfig(state)
  const sections = new Map()
  let current
  for (const line of config.split('\n')) {
    const heading = line.match(/^\[([^\]]+)\]$/)
    if (heading) { current = {}; sections.set(heading[1], current) }
    const field = line.match(/^([a-z_]+) = (.*)$/)
    if (field) current[field[1]] = field[2]
  }
  assert.equal(sections.get('ignore_unrelated').skip_display, 'true')
  const allowed = [...sections.values()].filter((section) => section.skip_display === 'false')
  assert.equal(allowed.length, 4)
  assert.deepEqual(allowed.map((section) => [section.appname, section.summary, section.body, section.timeout]), [
    ['app.shellbeam', state.ruleNames.direct, `${state.ruleNames.direct}: opened`, '0'],
    ['app.shellbeam', state.ruleNames.direct, `${state.ruleNames.direct}: resolved`, '0'],
    ['app.shellbeam', state.ruleNames.via, `${state.ruleNames.via}: opened`, '0'],
    ['app.shellbeam', state.ruleNames.via, `${state.ruleNames.via}: resolved`, '0'],
  ])
  assert.equal(sections.has('show_fixed_ui_test'), false)
})

test('service OCR requires the separate title and the exact role/lifecycle body', () => {
  const title = serviceState().ruleNames.direct
  const body = `${title}: opened`
  assert.deepEqual(notificationTextOcrMatches(`${title}\n${body}`, title, body), { title: true, body: true })
  assert.deepEqual(notificationTextOcrMatches(body, title, body), { title: false, body: true })
  assert.deepEqual(notificationTextOcrMatches(`${title}\n${title}: resolved`, title, body), { title: true, body: false })
  assert.deepEqual(notificationTextOcrMatches('ShellBeam UI via service\nShellBeam UI via service: opened', title, body), { title: false, body: false })
})

test('delivery diagnostics retain the actual count and distinguish accepted from failed outcomes', () => {
  assert.deepEqual(parseSystemDeliveryDiagnostic('System: 6\nAccepted'), { delivered: 6, accepted: true })
  assert.deepEqual(parseSystemDeliveryDiagnostic('\r\n\t System:\n\u00a0 6 \nAccepted \r\n'), { delivered: 6, accepted: true })
  assert.deepEqual(parseSystemDeliveryDiagnostic('System: 2\nFailed · System channel unavailable'), { delivered: 2, accepted: false })
  for (const value of ['', '\r\n \t', null, 'System: unavailable', 'System: -1', 'System: 1000000', 'System: 2extra', 'Webhooks: 4\nAccepted']) assert.throws(() => parseSystemDeliveryDiagnostic(value), /invalid_system_delivery_diagnostic/)
})

test('delivery diagnostic readiness scrolls the inert visible card into view and waits for a real numeric observation', async () => {
  const card = {}, count = {}, outcome = {}
  const events = []
  let reads = 0
  const driver = {
    waitFor: async (target) => { events.push('wait'); assert.match(target, /notification-channel-system/); return card },
    click: async (target) => { events.push('scroll'); assert.match(target, /notification-channel-system/) },
    find: async () => card,
    findAll: async (target, parent) => { assert.equal(parent, card); return target.includes('-count') ? [count] : [outcome] },
    isDisplayed: async () => true,
    text: async (target) => { assert.notEqual(target, card); events.push('read'); return target === count ? reads++ === 0 ? '\r\n \t' : ' 3\n' : 'Failed' },
  }
  assert.deepEqual(await readSystemDeliveryDiagnostic(driver, { timeoutMs: 500 }), { delivered: 3, accepted: false })
  assert.deepEqual(events, ['wait', 'scroll', 'read', 'read', 'read', 'read'])
})

test('blank, hidden or malformed diagnostics fail without inventing zero deliveries or accepted status', async () => {
  const card = {}, count = {}, outcome = {}
  for (const [visible, text] of [[true, ''], [false, '0'], [true, 'unavailable']]) {
    const driver = {
      waitFor: async () => card, click: async () => {}, find: async () => card,
      findAll: async (target) => target.includes('-count') ? [count] : [outcome],
      isDisplayed: async () => visible,
      text: async (target) => { assert.equal(visible, true); assert.notEqual(target, card); return target === count ? text : 'Accepted' },
    }
    await assert.rejects(readSystemDeliveryDiagnostic(driver, { timeoutMs: 1 }), /system_delivery_diagnostic_not_ready/)
  }
  await assert.rejects(readSystemDeliveryDiagnostic({}, { timeoutMs: 0 }), /invalid_diagnostic_timeout/)
})

test('visible child diagnostic protocol accepts only decimal counts and exact outcome text', () => {
  assert.deepEqual(parseSystemDeliveryFields(' \n7\u00a0', ' Accepted\r\n'), { delivered: 7, accepted: true })
  assert.deepEqual(parseSystemDeliveryFields('0', 'Failed'), { delivered: 0, accepted: false })
  assert.deepEqual(parseSystemDeliveryFields('0', 'Blocked'), { delivered: 0, accepted: false })
  for (const [count, outcome] of [[null, 'Accepted'], ['', 'Accepted'], ['System: 7', 'Accepted'], ['7e2', 'Accepted'], ['1000000', 'Accepted'], ['7', ''], ['7', 'Not Accepted'], ['7', 'Accepted · Channel unavailable']]) {
    assert.throws(() => parseSystemDeliveryFields(count, outcome), /invalid_system_delivery_diagnostic/)
  }
})

test('diagnostic contract reads only visible System descendants and never borrows another channel or hidden value', async () => {
  const dom = new JSDOM('<section data-testid="notification-settings"><div data-testid="notification-channel-webhook"><span data-testid="notification-channel-count">99</span><span data-testid="notification-channel-outcome">Accepted</span></div><div data-testid="notification-channel-system">irrelevant icon/label prefix<span data-testid="notification-channel-count">3</span><span data-testid="notification-channel-outcome">Failed</span></div></section>')
  const document = dom.window.document
  const driver = {
    waitFor: async (target) => document.querySelector(target), click: async () => {},
    find: async (target) => document.querySelector(target),
    findAll: async (target, parent) => [...(parent ?? document).querySelectorAll(target)],
    isDisplayed: async (target) => !target.closest('[hidden]'),
    text: async (target) => { assert(target.matches('[data-testid="notification-channel-count"], [data-testid="notification-channel-outcome"]')); return target.textContent },
  }
  try {
    assert.deepEqual(await readSystemDeliveryDiagnostic(driver), { delivered: 3, accepted: false })
    const count = document.querySelector('[data-testid="notification-channel-system"] [data-testid="notification-channel-count"]')
    count.hidden = true
    const events = []
    await assert.rejects(readSystemDeliveryDiagnostic(driver, { timeoutMs: 1, record: async (name, details) => events.push({ name, ...details }) }), /system_delivery_diagnostic_not_ready/)
    assert.equal(events[0].countVisible, false)
    assert.equal(events[0].fieldsValid, false)
    assert(!JSON.stringify(events).includes('irrelevant'))
    count.remove()
    await assert.rejects(readSystemDeliveryDiagnostic(driver, { timeoutMs: 1 }), /system_delivery_diagnostic_not_ready/)
  } finally { dom.window.close() }
})

test('Network screenshot guard requires the displayed scoped lifecycle and refuses any retained credential value', async () => {
  const dom = new JSDOM(`<section data-testid="local-alert-rules" data-host-id="host-direct" data-vault-id="vault-one"><div data-testid="local-alert-row" data-alert-name="ShellBeam UI direct service" data-alert-status="active" data-transport="direct">ShellBeam UI direct service · Active · ssh-agentless · direct</div></section><input type="password"><textarea></textarea>`)
  const document = dom.window.document
  const driver = {
    findAll: async (selector) => [...document.querySelectorAll(selector)],
    isDisplayed: async (element) => !element.closest('[hidden]'),
    text: async (element) => element.textContent,
    attr: async (element, name) => name === 'value' ? element.value : element.getAttribute(name),
  }
  const scope = { hostId: 'host-direct', vaultId: 'vault-one', name: 'ShellBeam UI direct service', status: 'active', role: 'direct' }
  try {
    await assertSafeLocalServiceUi(driver, scope)
    await assert.rejects(assertSafeLocalServiceUi(driver, { ...scope, vaultId: 'vault-other' }), /unsafe_network_scope/)
    await assert.rejects(assertSafeLocalServiceUi(driver, { ...scope, status: 'resolved' }), /unsafe_alert_scope/)
    await assert.rejects(assertSafeLocalServiceUi(driver, { ...scope, role: 'via' }), /unexpected_alert_source/)
    // The rule's own name contains "direct"; it must not hide a wrong route.
    document.querySelector('[data-testid="local-alert-row"]').setAttribute('data-transport', 'proxy-jump')
    await assert.rejects(assertSafeLocalServiceUi(driver, scope), /unexpected_alert_source/)
    document.querySelector('[data-testid="local-alert-row"]').setAttribute('data-transport', 'direct')
    document.querySelector('section').hidden = true
    await assert.rejects(assertSafeLocalServiceUi(driver, scope), /unsafe_network_scope/)
    document.querySelector('section').hidden = false
    document.querySelector('input').value = 'fixture-private-value'
    await assert.rejects(assertSafeLocalServiceUi(driver, scope), /unsafe_screenshot_ui/)
    document.querySelector('input').value = ''
    document.querySelector('textarea').value = 'fixture-private-value'
    await assert.rejects(assertSafeLocalServiceUi(driver, scope), /unsafe_screenshot_ui/)
  } finally { dom.window.close() }
})
