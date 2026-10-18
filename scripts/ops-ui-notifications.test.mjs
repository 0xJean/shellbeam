import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  evidencePathIsOwned,
  notificationDaemonConfig,
  notificationOcrMatches,
  parsePinnedDunstVersion,
  pinnedDunstPaths,
  parseDunstCount,
  parseDunstGeometry,
  requireNotificationFixtureEnvironment,
  runOpsUiNotifications,
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

test('strict dunst counts never convert failed or malformed daemon output into displayed zero', () => {
  assert.equal(parseDunstCount(' 0\n'), 0)
  assert.equal(parseDunstCount('1\n'), 1)
  for (const value of ['', '-1', 'unavailable', 'false', '0\nerror', 'NaN', '1000000']) assert.throws(() => parseDunstCount(value), /invalid_daemon_count/)
})

test('only mapped bounded X11 daemon geometry can provide a banner crop', () => {
  const facts = '  Absolute upper-left X: 480\n  Absolute upper-left Y: 18\n  Width: 780\n  Height: 120\n  Map State: IsViewable\n'
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
})
