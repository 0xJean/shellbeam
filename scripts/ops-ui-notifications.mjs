/** Real UI -> native zbus -> owned dunst -> X11 pixel acceptance.
 * Only the disposable Linux runner may call this helper. No invoke, OS backend,
 * provider event, notification payload, or app persistence is replaced here.
 * This exercises the explicit test button, not an alert lifecycle/policy test. */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const SERVICE = 'org.freedesktop.Notifications'
const WINDOW_TITLE = 'ShellBeam Ops UI Notification'
export const NOTIFICATION_TEST_TITLE = 'ShellBeam notification test'
export const NOTIFICATION_TEST_BODY = 'The system notification channel accepted this test.'
const SETTINGS = '[data-testid="notification-settings"]'
const XPATH_SETTINGS = "//*[@data-testid='notification-settings']"
const TEST_BUTTON = `xpath=${XPATH_SETTINGS}//button[normalize-space(.)='Send test notification']`
const SYSTEM_CHECKBOX = `xpath=${XPATH_SETTINGS}//label[normalize-space(.)='System']/input[@type='checkbox']`
const ACCEPTED = 'Submitted to the system. Display depends on OS notification settings.'
const FAILED = 'Test could not be submitted. Check the channel diagnostics below.'
const UNKNOWN = 'System-managed; per-app permission status is unavailable'
const UNAVAILABLE = 'Unavailable in this runtime'
const CHANNEL = '[data-testid="notification-channel-system"]'

export function pinnedDunstPaths(runnerTemp) {
  requireFact(typeof runnerTemp === 'string' && isAbsolute(runnerTemp) && runnerTemp === resolve(runnerTemp), 'invalid_pinned_daemon_path')
  const directory = join(runnerTemp, 'shellbeam-ui-dunst-1.7.3')
  return { directory, binary: join(directory, 'dunst'), control: join(directory, 'dunstctl') }
}

export function parsePinnedDunstVersion(value) {
  // Upstream src/dunst.c prints this banner; Makefile at the pinned commit
  // supplies the release date. Never match an arbitrary warning containing a
  // version or accept Jammy's 1.5.0, which lacks the real count interface.
  const match = typeof value === 'string' && value.match(/^Dunst - A customizable and lightweight notification-daemon (1\.7\.3)(?: \(2021-12-08\))?\r?\n?$/)
  requireFact(match, 'unsupported_daemon_version')
  return match[1]
}

function fail(stage) { return new Error(`ops_ui_notifications_${stage}`) }
function requireFact(value, stage) { if (!value) throw fail(stage) }

export function requireNotificationFixtureEnvironment(env = process.env, platform = process.platform, uid = process.getuid?.()) {
  requireFact(platform === 'linux' && uid > 0 && env.RUNNER_OS === 'Linux'
    && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.SHELLBEAM_OPS_UI_LIVE === '1' && /^:[0-9]+(?:\.[0-9]+)?$/.test(env.DISPLAY ?? '')
    && /^unix:/.test(env.DBUS_SESSION_BUS_ADDRESS ?? '')
    && !env.WAYLAND_DISPLAY && !env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS && !env.WEBKIT_FORCE_SANDBOX,
  'requires_isolated_hosted_linux')
}

function within(parent, child) {
  const value = relative(parent, child)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

export function evidencePathIsOwned(parent, target) {
  return typeof target === 'string' && isAbsolute(target) && target === resolve(target)
    && within(parent, target) && /^[a-z0-9][a-z0-9._-]{0,95}\.png$/.test(basename(target))
}

export function notificationOcrMatches(text) {
  return notificationTextOcrMatches(text, NOTIFICATION_TEST_TITLE, NOTIFICATION_TEST_BODY)
}

export function notificationTextOcrMatches(text, title, body) {
  // Only whitespace, punctuation and case are normalized. Do not fuzzy-match
  // missing/changed words or weaken pixel evidence to a D-Bus acknowledgement.
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const normalized = normalize(text)
  const heading = normalize(title)
  // Service bodies repeat the rule name. Seeing that body alone must not also
  // be accepted as proof that the separate title was painted on screen.
  const titleOccurrences = heading ? normalized.split(heading).length - 1 : 0
  return {
    title: titleOccurrences >= (normalize(body).includes(heading) ? 2 : 1),
    body: normalized.includes(normalize(body)),
  }
}

/** OCR segmentation can differ for a two-line banner and sparse text. Both
 * modes read the same real pixels; no words are combined between results. A
 * negative visibility assertion requires both independent reads to be absent. */
export async function inspectNotificationOcrModes(read, { title, body, expectedVisible }) {
  const modes = []
  for (const mode of [6, 11]) {
    const matched = notificationTextOcrMatches(await read(mode), title, body)
    modes.push({ mode, titleMatched: matched.title, bodyMatched: matched.body })
  }
  const complete = modes.some((result) => result.titleMatched && result.bodyMatched)
  const titleMatched = modes.some((result) => result.titleMatched)
  const bodyMatched = modes.some((result) => result.bodyMatched)
  return { accepted: expectedVisible ? complete : !titleMatched && !bodyMatched, titleMatched, bodyMatched, modes }
}

function validateNotificationCaptureGroup(expectations, expectedVisible) {
  requireFact(Array.isArray(expectations) && expectations.length > 0 && expectations.length <= 3
    && expectations.every(item => item && /^[a-z0-9-]{1,80}$/.test(item.name)
      && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 200
      && typeof item.body === 'string' && item.body.length > 0 && item.body.length <= 400)
    && new Set(expectations.map(item => item.name)).size === expectations.length
    && new Set(expectations.map(item => item.title)).size === expectations.length
    && typeof expectedVisible === 'boolean', 'invalid_capture_group')
}

/** Every member reads the same immutable crop in both modes. Keep matches
 * independent: neither hosts nor incomplete modes may supply another's text. */
export async function inspectNotificationGroupOcrModes(read, expectations, { expectedVisible }) {
  validateNotificationCaptureGroup(expectations, expectedVisible)
  const texts = new Map()
  for (const mode of [6, 11]) texts.set(mode, await read(mode))
  const results = []
  for (const item of expectations) {
    results.push(await inspectNotificationOcrModes(mode => texts.get(mode), { title: item.title, body: item.body, expectedVisible }))
  }
  return results
}

export function parseDunstCount(value) {
  requireFact(/^\s*[0-9]{1,6}\s*$/.test(value), 'invalid_daemon_count')
  return Number(value.trim())
}

export function parseDunstGeometry(value) {
  const number = (label) => {
    const match = value.match(new RegExp(`^\\s*${label}:\\s*(-?[0-9]+)\\s*$`, 'm'))
    return match ? Number(match[1]) : null
  }
  const geometry = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), width: number('Width'), height: number('Height') }
  const viewable = /Map State:\s*IsViewable\b/.test(value)
  if (!viewable) return null
  requireFact(Object.values(geometry).every(Number.isInteger) && geometry.x >= 0 && geometry.y >= 0
    && geometry.width >= 100 && geometry.height >= 30 && geometry.width <= 2048 && geometry.height <= 1024,
  'invalid_daemon_geometry')
  return geometry
}

/** dunst 1.7.3 rules are evaluated in file order. Only this known, credential-free
 * test message may become a visible banner during this phase. Timeout=0 in the
 * matching rule overrides the native client's 5s expiry, keeping OCR bounded but
 * independent of runner load. Official CLI: dunst v1.7.3 docs/dunstctl.pod. */
export function notificationDaemonConfig() {
  return `[global]
monitor = 0
follow = none
width = 760
height = 300
origin = top-right
offset = 18x18
notification_limit = 2
font = DejaVu Sans 16
markup = no
format = "%s\\n%b"
word_wrap = yes
alignment = left
padding = 14
horizontal_padding = 16
frame_width = 3
frame_color = "#ffffff"
separator_height = 0
transparency = 0
icon_position = off
stack_duplicates = false
show_age_threshold = -1
ignore_dbusclose = false
always_run_script = false
mouse_left_click = none
mouse_middle_click = none
mouse_right_click = none
title = ${WINDOW_TITLE}
class = ShellBeamOpsUiNotification
[urgency_low]
background = "#14202b"
foreground = "#ffffff"
timeout = 0
[urgency_normal]
background = "#14202b"
foreground = "#ffffff"
timeout = 0
[urgency_critical]
background = "#14202b"
foreground = "#ffffff"
timeout = 0
[ignore_unrelated]
skip_display = true
history_ignore = true
[show_fixed_ui_test]
appname = app.shellbeam
summary = ${NOTIFICATION_TEST_TITLE}
body = ${NOTIFICATION_TEST_BODY}
skip_display = false
history_ignore = false
fullscreen = show
timeout = 0
`
}

async function command(binary, args, stage, timeout = 5_000) {
  try {
    const result = await execute(binary, args, { encoding: 'utf8', timeout, maxBuffer: 65_536, env: process.env })
    return result.stdout
  } catch { throw fail(stage) } // Never copy command output, native errors, paths or payloads.
}

async function until(read, stage, timeout = 8_000) {
  const end = Date.now() + timeout
  do {
    try { if (await read()) return }
    catch (cause) {
      // A React render may replace an element between find/text calls. Only
      // standard transient W3C lookup failures may be retried, never a UI click.
      if (cause?.code !== 'no such element' && cause?.code !== 'stale element reference') throw cause
    }
    await delay(80)
  } while (Date.now() < end)
  throw fail(stage)
}

async function notificationOwner() {
  const result = await command('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', SERVICE], 'bus_owner_query')
  requireFact(/^\(\s*(true|false),?\s*\)\s*$/.test(result), 'invalid_bus_owner')
  return result.includes('true')
}

async function notificationOwnerPid() {
  const result = await command('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', SERVICE], 'bus_pid_query')
  const match = result.match(/^\(\s*uint32 ([0-9]+),?\s*\)\s*$/)
  requireFact(match && Number.isSafeInteger(Number(match[1])), 'invalid_bus_pid')
  return Number(match[1])
}

async function daemonCounts(control) {
  const displayed = parseDunstCount(await command(control, ['count', 'displayed'], 'daemon_count'))
  const waiting = parseDunstCount(await command(control, ['count', 'waiting'], 'daemon_count'))
  return { displayed, waiting }
}

async function windowGeometry() {
  try { return parseDunstGeometry(await command('/usr/bin/xwininfo', ['-name', WINDOW_TITLE, '-stats'], 'daemon_window_query', 2_000)) }
  catch (cause) {
    if (cause.message === 'ops_ui_notifications_daemon_window_query') return null // Dunst may destroy its unmapped window.
    throw cause
  }
}

async function privateDirectory(path) {
  requireFact(typeof path === 'string' && isAbsolute(path) && path === resolve(path), 'invalid_private_directory')
  const stat = await lstat(path).catch(() => { throw fail('invalid_private_directory') })
  requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
    && await realpath(path) === path, 'invalid_private_directory')
}

async function screenshotSafeUi(driver) {
  requireFact((await driver.findAll(SETTINGS)).length === 1, 'unsafe_screenshot_ui')
  // Do not export any values. Refuse capture if a visible-or-hidden password or
  // private-key textarea still contains data from a prior fixture setup step.
  for (const field of await driver.findAll('input[type="password"], textarea')) {
    const value = await driver.attr(field, 'value')
    requireFact(value === null || value === undefined || value === '', 'unsafe_screenshot_ui')
  }
}

async function reserveEvidencePath({ checkpoint, fixture, name }) {
  const path = await checkpoint(name)
  const artifactDir = fixture.artifactDir ?? join(fixture.desktopDir, 'artifacts')
  requireFact(evidencePathIsOwned(fixture.desktopDir, path) && within(artifactDir, path), 'invalid_screenshot_path')
  await privateDirectory(dirname(path))
  const handle = await open(path, 'wx', 0o600).catch(() => { throw fail('screenshot_path_exists') })
  await handle.close()
  return path
}

async function captureRoot(options) {
  const { name, expectedTitle = NOTIFICATION_TEST_TITLE, expectedBody = NOTIFICATION_TEST_BODY } = options
  const [evidence] = await captureRootGroup({ ...options, expectations: [{ name, title: expectedTitle, body: expectedBody }] })
  return evidence
}

async function captureRootGroup({ driver, checkpoint, fixture, scratch, name, geometry, expectedVisible, record, assertSafeUi = screenshotSafeUi, expectations }) {
  validateNotificationCaptureGroup(expectations, expectedVisible)
  await assertSafeUi(driver)
  const path = await reserveEvidencePath({ checkpoint, fixture, name })
  const banner = await reserveEvidencePath({ checkpoint, fixture, name: `${name}-banner` })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assertSafeUi(driver)
    // X11 can map/unmap before its next paint reaches the framebuffer. Retry
    // pixels only; never resend the notification or manufacture a display ACK.
    await command('/usr/bin/import', ['-window', 'root', `png:${path}`], 'root_capture', 8_000)
    await chmod(path, 0o600)
    const png = await readFile(path)
    requireFact(png.length > 100 && png.length <= 15_000_000
      && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'invalid_root_capture')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    requireFact(width > 0 && height > 0 && width <= 4096 && height <= 2160
      && geometry.x + geometry.width <= width && geometry.y + geometry.height <= height, 'root_capture_bounds')
    // OCR only the daemon's known banner rectangle from the real root screenshot,
    // rather than collecting arbitrary text from the app/settings underneath it.
    // Preserve the untransformed, bounded daemon rectangle as safe failure
    // evidence. OCR input is separate and never exported with its text.
    await command('/usr/bin/convert', [path, '-crop', `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`, '+repage', `png:${banner}`], 'root_crop', 8_000)
    await chmod(banner, 0o600)
    const crop = join(scratch, `${name}-ocr.png`)
    await command('/usr/bin/convert', [banner, '-resize', '200%', '-colorspace', 'Gray', '-negate', `png:${crop}`], 'root_preprocess', 8_000)
    const bannerPng = await readFile(banner)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const bannerSha256 = createHash('sha256').update(bannerPng).digest('hex')
    const matches = await inspectNotificationGroupOcrModes((mode) => command('/usr/bin/tesseract', [crop, 'stdout', '-l', 'eng', '--psm', String(mode)], 'root_ocr', 8_000), expectations, { expectedVisible })
    // A group may retry a new frame, but evidence can never combine members
    // from different attempts or a crop changed after its source was hashed.
    requireFact(createHash('sha256').update(await readFile(path)).digest('hex') === sha256
      && createHash('sha256').update(await readFile(banner)).digest('hex') === bannerSha256, 'capture_changed_during_inspection')
    const evidence = []
    for (const [index, matched] of matches.entries()) {
      const diagnostics = { attempt: attempt + 1, geometry, expectedVisible, ocrModes: matched.modes, bannerScreenshot: basename(banner), bannerSha256, bannerScreenshotBytes: bannerPng.length, ocrAccepted: matched.accepted, ocrTitleMatched: matched.titleMatched, ocrBodyMatched: matched.bodyMatched }
      const current = { screenshot: basename(path), sha256, screenshotBytes: png.length, width, height, ...diagnostics }
      if (record) await record(`${expectations[index].name}-pixel-inspection`, current)
      evidence.push(current)
    }
    if (matches.every(matched => matched.accepted)) {
      return evidence
    }
    await delay(120)
  }
  throw fail(expectedVisible ? 'visible_text_missing' : 'suppressed_text_visible')
}

/** Shared actual daemon lifecycle for the separate test-button and local-rule
 * acceptance phases. It never substitutes the app's invoke or notification OS
 * adapter, and does not install a desktop notification service. */
export async function startOwnedOpsUiNotificationDaemon({ fixture, configText, record }) {
  requireNotificationFixtureEnvironment()
  await privateDirectory(fixture?.desktopDir)
  const artifactDir = fixture.artifactDir ?? join(fixture.desktopDir, 'artifacts')
  requireFact(within(fixture.desktopDir, artifactDir), 'invalid_artifact_directory')
  await privateDirectory(artifactDir)
  requireFact(!await notificationOwner(), 'foreign_notification_service')
  const tools = pinnedDunstPaths(process.env.RUNNER_TEMP)
  await privateDirectory(tools.directory)
  for (const tool of [tools.binary, tools.control]) {
    const info = await lstat(tool).catch(() => { throw fail('pinned_daemon_missing') })
    requireFact(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o022) === 0 && (info.mode & 0o111) !== 0 && await realpath(tool) === tool, 'invalid_pinned_daemon')
  }
  const version = parsePinnedDunstVersion(await command(tools.binary, ['--version'], 'daemon_version'))
  const scratch = await mkdtemp(join(fixture.desktopDir, 'notification-runtime-'))
  let daemon
  let stopped = false
  const stop = async () => {
    if (stopped) return
    if (daemon) await daemon.stop()
    await until(async () => !await notificationOwner(), 'daemon_cleanup_failed')
    await rm(scratch, { recursive: true, force: true })
    stopped = true
    if (record) await record('notification-daemon-cleanup', { ownedDaemonExited: true, busNameReleased: true })
  }
  try {
    const config = join(scratch, 'dunstrc')
    await writeFile(config, configText, { flag: 'wx', mode: 0o600 })
    daemon = ownDaemon(config, tools.binary)
    await until(async () => { daemon.assertAlive(); return notificationOwner() }, 'daemon_not_ready')
    requireFact(await notificationOwnerPid() === daemon.child.pid, 'foreign_notification_service')
    await command(tools.control, ['set-paused', 'false'], 'daemon_unpause')
    return {
      version,
      async counts() { daemon.assertAlive(); return daemonCounts(tools.control) },
      async history() { daemon.assertAlive(); return parseDunstCount(await command(tools.control, ['count', 'history'], 'daemon_history_count')) },
      async closeAll() { daemon.assertAlive(); await command(tools.control, ['close-all'], 'daemon_close_all') },
      async geometry() { daemon.assertAlive(); return windowGeometry() },
      capture(options) { daemon.assertAlive(); return captureRoot({ ...options, fixture, scratch, record }) },
      captureGroup(options) { daemon.assertAlive(); return captureRootGroup({ ...options, fixture, scratch, record }) },
      stop,
    }
  } catch (cause) { await stop(); throw cause }
}

export async function startOpsUiAlertNotifications(options) {
  const { startOpsUiAlertNotifications: start } = await import('./ops-ui-alert-notifications.mjs')
  return start(options)
}

function ownDaemon(config, binary) {
  const child = spawn(binary, ['-conf', config], { env: process.env, stdio: ['ignore', 'ignore', 'ignore'] })
  let exited = false
  let spawnFailed = false
  const exit = new Promise((done) => {
    child.once('error', () => { spawnFailed = true; exited = true; done() })
    child.once('exit', () => { exited = true; done() })
  })
  return {
    child,
    assertAlive() { requireFact(!exited && !spawnFailed, 'daemon_exited') },
    async stop() {
      if (exited) return
      child.kill('SIGTERM')
      if (await Promise.race([exit.then(() => true), delay(3_000, undefined, { ref: false }).then(() => false)]) === false) {
        child.kill('SIGKILL')
        requireFact(await Promise.race([exit.then(() => true), delay(2_000, undefined, { ref: false }).then(() => false)]), 'daemon_cleanup_failed')
      }
      requireFact(exited, 'daemon_cleanup_failed')
    },
  }
}

/** Navigate through the production settings categories using native clicks.
 * A category must be visibly available before opening it; no hidden settings
 * reads or fallback path may bypass the same navigation used by the user. */
export async function openOpsUiNotificationSettings(driver, { english = false } = {}) {
  const dashboard = '[data-testid="pc-dashboard"]'
  const settings = "xpath=//aside//button[normalize-space(.)='Settings' or normalize-space(.)='设置']"
  const general = '[data-testid="settings-category-general"]'
  const monitoring = '[data-testid="settings-category-monitoring"]'
  const language = "xpath=//button[normalize-space(.)='English']"
  await driver.waitFor(dashboard)
  await driver.click(dashboard)
  await driver.waitFor(settings)
  await driver.click(settings)
  if (english) {
    await driver.waitFor(general)
    await driver.click(general)
    await driver.waitFor(language)
    await driver.click(language)
  }
  await driver.waitFor(monitoring)
  await driver.click(monitoring)
  await driver.click('[data-testid="monitor-tab-local"]')
  await driver.waitFor(SETTINGS)
}

async function uiStatusContains(driver, text) { return (await driver.text(SETTINGS)).includes(text) }
async function clickTest(driver, accepted) {
  await until(async () => !await driver.attr(TEST_BUTTON, 'disabled'), 'test_button_busy')
  await driver.click(TEST_BUTTON)
  await until(async () => !await driver.attr(TEST_BUTTON, 'disabled') && await uiStatusContains(driver, accepted ? ACCEPTED : FAILED), 'test_result_missing', 15_000)
}

export async function runOpsUiNotifications({ driver, record, checkpoint, fixture }) {
  requireNotificationFixtureEnvironment()
  await privateDirectory(fixture?.desktopDir)
  const artifactDir = fixture.artifactDir ?? join(fixture.desktopDir, 'artifacts')
  requireFact(within(fixture.desktopDir, artifactDir), 'invalid_artifact_directory')
  await privateDirectory(artifactDir)
  requireFact(!await notificationOwner(), 'foreign_notification_service')
  const tools = pinnedDunstPaths(process.env.RUNNER_TEMP)
  await privateDirectory(tools.directory)
  for (const tool of [tools.binary, tools.control]) {
    const info = await lstat(tool).catch(() => { throw fail('pinned_daemon_missing') })
    requireFact(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o022) === 0 && (info.mode & 0o111) !== 0 && await realpath(tool) === tool, 'invalid_pinned_daemon')
  }
  const version = parsePinnedDunstVersion(await command(tools.binary, ['--version'], 'daemon_version'))
  const scratch = await mkdtemp(join(fixture.desktopDir, 'notification-runtime-'))
  let daemon
  const checks = []
  const evidence = async (name, details) => { checks.push({ case: name, ...details }); await record(name, details) }
  try {
    const config = join(scratch, 'dunstrc')
    await writeFile(config, notificationDaemonConfig(), { flag: 'wx', mode: 0o600 })
    daemon = ownDaemon(config, tools.binary)
    await until(async () => { daemon.assertAlive(); return notificationOwner() }, 'daemon_not_ready')
    requireFact(await notificationOwnerPid() === daemon.child.pid, 'foreign_notification_service')
    await command(tools.control, ['set-paused', 'false'], 'daemon_unpause')

    // The preceding real Ops journey leaves a Workspace tab active. Return via
    // its actual Dashboard tab before interacting with the desktop sidebar.
    await openOpsUiNotificationSettings(driver, { english: true })
    if (!await driver.isSelected(SYSTEM_CHECKBOX)) await driver.click(SYSTEM_CHECKBOX)
    await command(tools.control, ['close-all'], 'daemon_close_all')
    await until(async () => { const value = await daemonCounts(tools.control); return value.displayed === 0 && value.waiting === 0 }, 'daemon_not_empty')

    await clickTest(driver, true)
    await until(() => uiStatusContains(driver, UNKNOWN), 'linux_permission_not_unknown')
    requireFact(!await uiStatusContains(driver, 'Permission granted'), 'linux_permission_claimed_granted')
    await until(async () => (await daemonCounts(tools.control)).displayed === 1, 'normal_banner_not_displayed')
    let normalGeometry
    await until(async () => Boolean(normalGeometry = await windowGeometry()), 'normal_banner_not_viewable')
    const normalCapture = await captureRoot({ driver, checkpoint, fixture, scratch, record, name: 'notification-visible', geometry: normalGeometry, expectedVisible: true })
    await evidence('notification-visible', { backendAccepted: true, permissionUnknown: true, x11Viewable: true, ...await daemonCounts(tools.control), ...normalCapture })

    await command(tools.control, ['close-all'], 'daemon_close_all')
    await command(tools.control, ['set-paused', 'true'], 'daemon_pause')
    requireFact((await command(tools.control, ['is-paused'], 'daemon_pause_state')).trim() === 'true', 'daemon_not_paused')
    await clickTest(driver, true)
    await until(async () => { const value = await daemonCounts(tools.control); return value.displayed === 0 && value.waiting === 1 }, 'paused_banner_not_queued')
    await until(async () => await windowGeometry() === null, 'paused_banner_viewable')
    const pausedCapture = await captureRoot({ driver, checkpoint, fixture, scratch, record, name: 'notification-paused', geometry: normalGeometry, expectedVisible: false })
    await evidence('notification-paused-accepted-not-displayed', { backendAccepted: true, paused: true, x11Viewable: false, ...await daemonCounts(tools.control), ...pausedCapture })

    await command(tools.control, ['set-paused', 'false'], 'daemon_unpause')
    await until(async () => { const value = await daemonCounts(tools.control); return value.displayed === 1 && value.waiting === 0 }, 'resumed_banner_not_displayed')
    let resumedGeometry
    await until(async () => Boolean(resumedGeometry = await windowGeometry()), 'resumed_banner_not_viewable')
    const resumedCapture = await captureRoot({ driver, checkpoint, fixture, scratch, record, name: 'notification-resumed', geometry: resumedGeometry, expectedVisible: true })
    await evidence('notification-resumed-visible', { backendAccepted: true, sameQueuedNotification: true, x11Viewable: true, ...await daemonCounts(tools.control), ...resumedCapture })

    await command(tools.control, ['close-all'], 'daemon_close_all')
    await daemon.stop()
    await until(async () => !await notificationOwner(), 'daemon_name_not_released')
    await clickTest(driver, false)
    await until(() => uiStatusContains(driver, UNAVAILABLE), 'unavailable_permission_missing')
    await until(async () => { const text = await driver.text(CHANNEL); return text.includes('Failed') && text.includes('System channel unavailable') }, 'unavailable_diagnostics_missing')
    // A real W3C element click scrolls this inert diagnostic card into view; it
    // has no action handler. Do not call an offscreen text lookup "visible UI".
    await driver.click(CHANNEL)
    requireFact(!await notificationOwner() && await windowGeometry() === null, 'daemon_unexpectedly_reactivated')
    const unavailableCapture = await captureRoot({ driver, checkpoint, fixture, scratch, record, name: 'notification-unavailable', geometry: normalGeometry, expectedVisible: false })
    await evidence('notification-unavailable-failed', { backendAccepted: false, permissionUnavailable: true, diagnosticsVisible: true, daemonExited: true, x11Viewable: false, displayed: null, waiting: null, ...unavailableCapture })
    return { passed: true, daemonVersion: version, checks, scope: 'explicit-test-button-linux-x11', actualAlertLifecycleVerified: false }
  } catch (cause) {
    if (cause instanceof Error && /^ops_ui_notifications_[a-z0-9_]+$/.test(cause.message)) throw cause
    throw fail('stage_failed')
  } finally {
    if (daemon) {
      // stop() must confirm exit before removing its configuration directory.
      // Failure deliberately leaves the directory for the owning shell cleanup.
      await daemon.stop()
      await until(async () => !await notificationOwner(), 'daemon_cleanup_failed')
    }
    await rm(scratch, { recursive: true, force: true })
    if (daemon) await record('notification-daemon-cleanup', { ownedDaemonExited: true, busNameReleased: true })
  }
}
