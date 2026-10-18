// Actual SSH Probe metrics -> native notifications -> owned dunst -> X11
// framebuffer pixels. This does not verify inventory, Komari or read receipts.
import { setTimeout as delay } from 'node:timers/promises'
import { notificationDaemonConfig, startOwnedOpsUiNotificationDaemon } from './ops-ui-notifications.mjs'
import { readSystemDeliveryDiagnostic } from './ops-ui-alert-notifications.mjs'
import { OPS_UI_PROBE_RULE_IDS, validateOpsUiProbeScope } from './ops-ui-probe-journey.mjs'

const ROLES = Object.freeze(['direct', 'via', 'jump'])
const PHASES = Object.freeze(['direct:opened', 'direct:resolved', 'via:opened', 'via:resolved'])
const RULE = OPS_UI_PROBE_RULE_IDS.metrics
const SETTINGS = '[data-testid="notification-settings"]'
const SX = "//*[@data-testid='notification-settings']"
const input = label => `xpath=${SX}//label[normalize-space(.)='${label}']/input[@type='checkbox']`
const q = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const route = role => role === 'via' ? 'proxy-jump' : 'direct'
const fail = code => new Error(`ops_ui_probe_notifications_${code}`)
function check(value, code) { if (!value) throw fail(code) }

export function probeNotificationTitles(fixture, state) {
  validateOpsUiProbeScope(fixture, state)
  check(typeof fixture.fixtureId === 'string' && /^shellbeam-ops-ui-live-[a-z0-9-]{10,100}$/.test(fixture.fixtureId), 'invalid_fixture_title')
  const names = Object.fromEntries(ROLES.map(role => {
    const raw = fixture.hosts[role].name
    // Only root's fixed disposable fixture names may enter dunst rules or OCR.
    // These ASCII names need no escaping or normalization guess; slicing is
    // identical to production localAlertText(host.name).slice(0, 48).
    check(raw === `ShellBeam UI ${role} ${fixture.fixtureId}`, 'invalid_fixture_title')
    return [role, `${raw.slice(0, 48)} · Metrics collection unavailable`]
  }))
  check(new Set(Object.values(names)).size === 3, 'ambiguous_fixture_titles')
  return names
}

export function probeNotificationConfig(fixture, state) {
  const titles = probeNotificationTitles(fixture, state)
  const base = notificationDaemonConfig().split('[show_fixed_ui_test]')[0]
  return base + ROLES.flatMap(role => ['opened', 'resolved'].map(event => `
[probe_metrics_${role}_${event}]
appname = app.shellbeam
summary = ${titles[role]}
body = ${titles[role]}: ${event}
skip_display = false
history_ignore = false
fullscreen = show
timeout = 0
`)).join('')
}

export async function verifyProbeNotificationPolicy(driver) {
  check(await driver.isSelected(input('Enable notification delivery')) && await driver.isSelected(input('System'))
    && !await driver.isSelected(input('In-app')) && !await driver.isSelected(input('Webhook'))
    && await driver.isSelected(`${SETTINGS} [data-testid="notification-recovery-enabled"]`)
    && await driver.isSelected(`${SETTINGS} [data-testid="notification-recovery-channel-system"]`)
    && !await driver.isSelected(`${SETTINGS} [data-testid="notification-recovery-channel-local"]`)
    && !await driver.isSelected(`${SETTINGS} [data-testid="notification-recovery-channel-webhook"]`), 'policy_not_system_only')
  check(await driver.attr(`xpath=${SX}//label[contains(.,'Cooldown (minutes)')]/input`, 'value') === '5'
    && await driver.attr(`xpath=${SX}//label[contains(.,'Dedupe window (seconds)')]/input`, 'value') === '60', 'policy_timing_changed')
}

export async function assertSafeProbeNotificationUi(driver, { state, titles, profiles, event }) {
  check(['opened', 'resolved'].includes(event) && profiles.length > 0 && profiles.every(role => ROLES.includes(role)), 'invalid_pixel_scope')
  check((await driver.findAll('[data-testid="host-card"]')).length === 3, 'unexpected_host_page')
  for (const role of profiles) {
    const card = `[data-testid="host-card"][data-host-id=${q(state.hostIds[role])}]`
    const cards = await driver.findAll(card)
    check(cards.length === 1 && await driver.isDisplayed(cards[0]), 'unsafe_host_scope')
    const evaluations = await driver.findAll(`${card} [data-testid="host-probe-evaluation"][data-rule-id=${q(RULE)}][data-host-id=${q(state.hostIds[role])}][data-vault-id=${q(state.vaultId)}]`)
    check(evaluations.length === 1 && await driver.isDisplayed(evaluations[0]), 'unsafe_vault_scope')
    check(await driver.attr(evaluations[0], 'data-state') === (event === 'opened' ? 'firing' : 'healthy'), 'unexpected_evaluation_state')
    const rawSample = await driver.attr(evaluations[0], 'data-sampled-at')
    check(typeof rawSample === 'string' && /^[0-9]{1,16}$/.test(rawSample) && Number.isSafeInteger(Number(rawSample)) && Number(rawSample) > 0 && Number(rawSample) <= Date.now(), 'invalid_original_sample')
    const alerts = await driver.findAll(`${card} [data-testid="host-local-alert"][data-rule-id=${q(RULE)}][data-host-id=${q(state.hostIds[role])}]`)
    check(alerts.length === 1 && await driver.isDisplayed(alerts[0]), 'unsafe_alert_scope')
    const row = alerts[0]
    check(await driver.attr(row, 'data-vault-id') === state.vaultId, 'unsafe_alert_vault_scope')
    check(await driver.attr(row, 'data-metric') === 'probe-provider' && await driver.attr(row, 'data-source') === 'ssh-agentless'
      && await driver.attr(row, 'data-transport') === route(role) && await driver.attr(row, 'data-alert-status') === (event === 'opened' ? 'active' : 'resolved'), 'unexpected_alert_source')
    check((await driver.text(row)).includes(titles[role]), 'unexpected_alert_title')
  }
  for (const field of await driver.findAll('input[type="password"], textarea')) {
    const value = await driver.attr(field, 'value')
    check(value === null || value === undefined || value === '', 'unsafe_screenshot_ui')
  }
}

async function openSettings(driver) {
  await driver.waitFor('[data-testid="pc-dashboard"]')
  await driver.click('[data-testid="pc-dashboard"]')
  await driver.click("xpath=//aside//button[normalize-space(.)='Settings' or normalize-space(.)='设置']")
  await driver.waitFor(SETTINGS)
}

/** The public entry always binds the real owned OS helper and visible UI
 * reader. This private-CI coordinator has injectable dependencies only for its
 * Node control-flow tests; it is never imported by the production app. */
export function startOpsUiProbeNotifications(options) {
  return createOpsUiProbeNotificationOwner(options, { startDaemon: startOwnedOpsUiNotificationDaemon, readDiagnostic: readSystemDeliveryDiagnostic, now: Date.now, pause: delay })
}

export async function createOpsUiProbeNotificationOwner({ driver, fixture, record, checkpoint, resumeState }, { startDaemon, readDiagnostic, now, pause }) {
  check(typeof record === 'function' && typeof checkpoint === 'function', 'invalid_callbacks')
  const titles = probeNotificationTitles(fixture, resumeState)
  const state = { vaultId: resumeState.vaultId, hostIds: { ...resumeState.hostIds } }
  const identity = JSON.stringify([state.vaultId, state.hostIds, titles])
  const assertScope = () => check(JSON.stringify([resumeState.vaultId, resumeState.hostIds, probeNotificationTitles(fixture, resumeState)]) === identity, 'scope_changed')
  const daemon = await startDaemon({ fixture, record, configText: probeNotificationConfig(fixture, resumeState) })
  let activeDriver = driver, phase = 0, verified = 0, baseline, finalDelivered
  let stopped = false, verifying = false, preparedRestart = false, finished = false
  const until = async (read, code, timeoutMs = 30_000) => {
    const deadline = now() + timeoutMs
    do {
      try { const value = await read(); if (value) return value }
      catch (cause) { if (!['no such element', 'stale element reference'].includes(cause?.code)) throw cause }
      await pause(100)
    } while (now() < deadline)
    throw fail(code)
  }
  const diagnostic = () => readDiagnostic(activeDriver, { record })
  const empty = async expectedHistory => {
    const counts = await daemon.counts()
    return counts.displayed === 0 && counts.waiting === 0 && await daemon.history() === expectedHistory && await daemon.geometry() === null
  }
  const stop = async () => { if (!stopped) { await daemon.stop(); stopped = true } }
  const verify = async (role, event) => {
    check(!stopped && !verifying && !preparedRestart && PHASES[phase] === `${role}:${event}`, 'invalid_verification_phase')
    assertScope(); verifying = true
    const profiles = role === 'via' ? ['via', 'jump'] : ['direct']
    const safeUi = currentDriver => { assertScope(); return assertSafeProbeNotificationUi(currentDriver, { state, titles, profiles, event }) }
    try {
      await safeUi(activeDriver)
      await until(async () => {
        const counts = await daemon.counts()
        return counts.displayed === profiles.length && counts.waiting === 0 && await daemon.history() === verified
      }, 'metrics_banner_group_not_unique')
      const geometry = await until(() => daemon.geometry(), 'metrics_banner_not_viewable')
      // Each read must contain that host's full separate title AND body in
      // one OCR mode. Two different hosts or partial modes are never joined.
      for (const profile of profiles) {
        const evidence = await daemon.capture({ driver: activeDriver, checkpoint, name: `notification-probe-${profile}-${event}`, geometry, expectedVisible: true,
          expectedTitle: titles[profile], expectedBody: `${titles[profile]}: ${event}`, assertSafeUi: safeUi })
        await record(`notification-probe-${profile}-${event}`, { passed: true, x11Viewable: true, groupDisplayed: profiles.length, ...evidence })
      }
      await daemon.closeAll()
      await until(() => empty(verified + profiles.length), 'metrics_banner_group_not_closed')
      verified += profiles.length; phase++
      await record(`notification-probe-${role}-${event}-group`, { passed: true, displayed: 0, waiting: 0, history: verified, groupSize: profiles.length })
    } finally { verifying = false }
  }
  try {
    await until(() => empty(0), 'new_daemon_not_empty')
    await openSettings(activeDriver)
    await verifyProbeNotificationPolicy(activeDriver)
    baseline = (await diagnostic()).delivered
    await record('notification-probe-policy-verified', { enabled: true, systemOnly: true, recoveryEnabled: true, defaultCooldown: true, defaultDedupe: true, initialDelivered: baseline })
    return {
      verifyOpened: role => verify(role, 'opened'), verifyResolved: role => verify(role, 'resolved'),
      async beforeRestart() {
        check(!stopped && !verifying && !preparedRestart && phase === 4 && verified === 6, 'incomplete_lifecycle_before_restart')
        assertScope()
        await openSettings(activeDriver); await verifyProbeNotificationPolicy(activeDriver)
        const committed = await until(async () => {
          assertScope(); check(await empty(6), 'unexpected_metrics_replay')
          const current = await diagnostic()
          return current.delivered >= baseline + 6 ? current : false
        }, 'metrics_delivery_journal_incomplete')
        let last = committed.delivered, stableSince = now()
        await until(async () => {
          assertScope(); check(await empty(6), 'unexpected_metrics_replay')
          const current = (await diagnostic()).delivered
          check(current >= last, 'delivery_journal_regressed')
          if (current !== last) { last = current; stableSince = now() }
          return now() - stableSince >= 5000
        }, 'delivery_journal_not_stable')
        finalDelivered = last; preparedRestart = true
        await record('notification-probe-before-restart', { history: 6, metricsVisible: 6, finalDelivered, initialDelivered: baseline, countsStableMs: 5000, localStorageJournal: true })
      },
      async afterRestart({ driver: restartedDriver }) {
        check(!stopped && !verifying && preparedRestart && !finished && restartedDriver && restartedDriver !== activeDriver, 'invalid_restart_boundary')
        activeDriver = restartedDriver; assertScope()
        await openSettings(activeDriver); await verifyProbeNotificationPolicy(activeDriver)
        const deadline = now() + 5000
        do {
          assertScope(); check(await empty(6), 'metrics_notification_replayed')
          check((await diagnostic()).delivered === finalDelivered, 'delivery_count_changed_after_restart')
          await pause(200)
        } while (now() < deadline)
        finished = true
        const result = { passed: true, scope: 'ssh-probe-metrics-linux-x11', profiles: 3, metricsVisible: 6, history: 6, displayed: 0, waiting: 0,
          initialDelivered: baseline, restoredDelivered: finalDelivered, actualAlertLifecycleVerified: true, inventoryLifecycleVerified: false,
          komariLifecycleVerified: false, readReceiptVerified: false, localStorageJournal: true, noReplayObservedMs: 5000 }
        await record('notification-probe-restored-without-replay', result)
        return result
      },
      stop,
    }
  } catch (cause) { await stop(); throw cause }
}
