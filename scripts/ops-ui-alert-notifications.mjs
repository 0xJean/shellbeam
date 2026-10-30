/** Actual local Service rules -> production native notification -> owned X11
 * daemon -> visible pixels -> persistent delivery diagnostics. This is not a
 * ProbeProvider/Komari notification acceptance or an OS read receipt. */
import { setTimeout as delay } from 'node:timers/promises'
import {
  notificationDaemonConfig,
  openOpsUiNotificationSettings,
  startOwnedOpsUiNotificationDaemon,
} from './ops-ui-notifications.mjs'

const NAMES = Object.freeze({ direct: 'ShellBeam UI direct service', via: 'ShellBeam UI via service' })
const ROLES = Object.freeze(['direct', 'via'])
const SETTINGS = '[data-testid="notification-settings"]'
const SETTINGS_XPATH = "//*[@data-testid='notification-settings']"
const SYSTEM = `${SETTINGS} [data-testid="notification-channel-system"]`
const attrString = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const labelInput = (label) => `xpath=${SETTINGS_XPATH}//label[normalize-space(.)='${label}']/input[@type='checkbox']`
const POLICY_ENABLE = `${SETTINGS} input[aria-label="Send reminders from this device"]`
const SYSTEM_ENABLE = labelInput('System')
const LOCAL_ENABLE = labelInput('In-app')
const WEBHOOK_ENABLE = labelInput('Webhook')
const RECOVERY = `${SETTINGS} [data-testid="notification-recovery-enabled"]`
const recoveryChannel = (channel) => `${SETTINGS} [data-testid="notification-recovery-channel-${channel}"]`
const cooldown = `${SETTINGS} input[aria-label="Cooldown (minutes)"]`
const dedupe = `${SETTINGS} input[aria-label="Dedupe window (seconds)"]`

function fail(stage) { return new Error(`ops_ui_alert_notifications_${stage}`) }
function requireFact(value, stage) { if (!value) throw fail(stage) }
async function until(read, stage, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  do {
    try { const value = await read(); if (value) return value }
    catch (cause) {
      if (!['no such element', 'stale element reference'].includes(cause?.code)) throw cause
    }
    await delay(100)
  } while (Date.now() < deadline)
  throw fail(stage)
}

export function localServiceNotificationScope(state) {
  requireFact(state && state.ruleNames && Object.keys(state.ruleNames).sort().join(',') === 'direct,via'
    && ROLES.every((role) => state.ruleNames[role] === NAMES[role]), 'invalid_rule_names')
  requireFact(state.hostIds && ROLES.every((role) => typeof state.hostIds[role] === 'string'
    && /^[A-Za-z0-9_-]{1,120}$/.test(state.hostIds[role])) && state.hostIds.direct !== state.hostIds.via, 'invalid_host_scope')
  return { direct: state.hostIds.direct, via: state.hostIds.via }
}

export function localServiceNotificationConfig(state) {
  localServiceNotificationScope(state)
  // Keep the known X11 appearance and deny-by-default rule, replacing the
  // test-button allow rule with only the four exact lifecycle messages.
  const base = notificationDaemonConfig().split('[show_fixed_ui_test]')[0]
  return base + ROLES.flatMap((role) => ['opened', 'resolved'].map((event) => `
[local_service_${role}_${event}]
appname = app.shellbeam
summary = ${NAMES[role]}
body = ${NAMES[role]}: ${event}
skip_display = false
history_ignore = false
fullscreen = show
timeout = 0
`)).join('')
}

export function parseSystemDeliveryDiagnostic(text) {
  const match = typeof text === 'string' && text.trim().match(/^System:\s*([0-9]{1,6})(?:\s|$)/)
  requireFact(match, 'invalid_system_delivery_diagnostic')
  return { delivered: Number(match[1]), accepted: /\bAccepted\b/.test(text) }
}

export function parseSystemDeliveryFields(countText, outcomeText) {
  requireFact(typeof countText === 'string' && /^[0-9]{1,6}$/.test(countText.trim()), 'invalid_system_delivery_diagnostic')
  requireFact(typeof outcomeText === 'string' && ['Accepted', 'Failed', 'Blocked'].includes(outcomeText.trim()), 'invalid_system_delivery_diagnostic')
  return { delivered: Number(countText.trim()), accepted: outcomeText.trim() === 'Accepted' }
}

export async function readSystemDeliveryDiagnostic(driver, { timeoutMs = 8_000, record } = {}) {
  requireFact(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid_diagnostic_timeout')
  await driver.waitFor(SYSTEM, { timeoutMs })
  // The rendered summary is below the policy controls. A native W3C click on
  // this inert div scrolls it into view; neither text presence nor an offscreen
  // lookup alone is evidence that its diagnostics are visible to the user.
  await driver.click(SYSTEM)
  let readiness = { cardVisible: false, countElements: 0, outcomeElements: 0, countVisible: false, outcomeVisible: false, countLength: 0, outcomeLength: 0, fieldsValid: false }
  try { return await until(async () => {
    const card = await driver.find(SYSTEM)
    readiness.cardVisible = await driver.isDisplayed(card)
    if (!readiness.cardVisible) return false
    // Read the actual displayed child spans, not the card's concatenated
    // flex/icon text, attributes, hidden data or application state.
    const counts = await driver.findAll('[data-testid="notification-channel-count"]', card)
    const outcomes = await driver.findAll('[data-testid="notification-channel-outcome"]', card)
    readiness.countElements = counts.length; readiness.outcomeElements = outcomes.length
    if (counts.length !== 1 || outcomes.length !== 1) return false
    readiness.countVisible = await driver.isDisplayed(counts[0]); readiness.outcomeVisible = await driver.isDisplayed(outcomes[0])
    if (!readiness.countVisible || !readiness.outcomeVisible) return false
    const countText = await driver.text(counts[0]), outcomeText = await driver.text(outcomes[0])
    readiness.countLength = countText.length; readiness.outcomeLength = outcomeText.length
    try { const result = parseSystemDeliveryFields(countText, outcomeText); readiness.fieldsValid = true; return result }
    catch (cause) {
      if (cause?.message === 'ops_ui_alert_notifications_invalid_system_delivery_diagnostic') return false
      throw cause
    }
  }, 'system_delivery_diagnostic_not_ready', timeoutMs) }
  catch (cause) {
    if (record) await record('notification-system-diagnostic-readiness', readiness)
    throw cause
  }
}

export async function assertSafeLocalServiceUi(driver, { hostId, vaultId, name, status, role }) {
  const root = `[data-testid="local-alert-rules"][data-host-id=${attrString(hostId)}][data-vault-id=${attrString(vaultId)}]`
  const panel = await driver.findAll(root)
  requireFact(panel.length === 1 && await driver.isDisplayed(panel[0]), 'unsafe_network_scope')
  const row = `${root} [data-testid="local-alert-row"][data-alert-name=${attrString(name)}][data-alert-status=${attrString(status)}]`
  const alerts = await driver.findAll(row)
  requireFact(alerts.length === 1 && await driver.isDisplayed(alerts[0]), 'unsafe_alert_scope')
  const text = await driver.text(alerts[0])
  requireFact(text.includes('ssh-agentless') && await driver.attr(alerts[0], 'data-transport') === (role === 'via' ? 'proxy-jump' : 'direct'), 'unexpected_alert_source')
  for (const field of await driver.findAll('input[type="password"], textarea')) {
    // Read only for the safety gate. Never retain/report the field value.
    const value = await driver.attr(field, 'value')
    requireFact(value === null || value === undefined || value === '', 'unsafe_screenshot_ui')
  }
}

async function openSettings(driver) {
  await openOpsUiNotificationSettings(driver, { english: true })
}
async function checked(driver, target, value) {
  if (await driver.isSelected(target) !== value) await driver.click(target)
  requireFact(await driver.isSelected(target) === value, 'policy_control_not_applied')
}
async function verifyPolicy(driver) {
  requireFact(await driver.isSelected(POLICY_ENABLE) && await driver.isSelected(SYSTEM_ENABLE)
    && !await driver.isSelected(LOCAL_ENABLE) && !await driver.isSelected(WEBHOOK_ENABLE)
    && await driver.isSelected(RECOVERY) && await driver.isSelected(recoveryChannel('system'))
    && !await driver.isSelected(recoveryChannel('local')) && !await driver.isSelected(recoveryChannel('webhook')), 'policy_not_system_only')
  requireFact(await driver.attr(cooldown, 'value') === '5' && await driver.attr(dedupe, 'value') === '60', 'default_policy_timing_changed')
}
async function saveSystemPolicy(driver) {
  await openSettings(driver)
  await checked(driver, POLICY_ENABLE, true)
  // Enable System before removing In-app: the production form keeps at least
  // one configured channel and otherwise restores its default local channel.
  await checked(driver, SYSTEM_ENABLE, true)
  await checked(driver, LOCAL_ENABLE, false)
  await checked(driver, WEBHOOK_ENABLE, false)
  await checked(driver, RECOVERY, true)
  await checked(driver, recoveryChannel('system'), true)
  await checked(driver, recoveryChannel('local'), false)
  await checked(driver, recoveryChannel('webhook'), false)
  await verifyPolicy(driver)
  await driver.click(`xpath=${SETTINGS_XPATH}//button[normalize-space(.)='Save notification policy']`)
  await until(async () => (await driver.text(SETTINGS)).includes('Notification policy saved'), 'policy_not_saved')
  // A real remount rereads the saved production policy; it is not an assertion
  // against the same unsaved React checkbox state.
  await driver.click('[data-testid="pc-nav-hosts"]')
  await openSettings(driver)
  await verifyPolicy(driver)
}

export async function startOpsUiAlertNotifications({ driver, fixture, record, checkpoint, resumeState }) {
  const hosts = localServiceNotificationScope(resumeState)
  const daemon = await startOwnedOpsUiNotificationDaemon({ fixture, configText: localServiceNotificationConfig(resumeState), record })
  let activeDriver = driver
  let vaultId = null
  let baseline = null
  let beforeRestartDone = false
  let afterRestartDone = false
  let stopped = false
  const verified = new Set()
  const diagnostic = (currentDriver) => readSystemDeliveryDiagnostic(currentDriver, { record })
  const assertScope = () => {
    const current = localServiceNotificationScope(resumeState)
    requireFact(ROLES.every((role) => current[role] === hosts[role]), 'host_scope_changed')
    const currentVault = resumeState.vaultId
    requireFact(typeof currentVault === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(currentVault) && (!vaultId || vaultId === currentVault), 'vault_scope_changed')
    vaultId = currentVault
  }
  const empty = async (history) => {
    const counts = await daemon.counts()
    return counts.displayed === 0 && counts.waiting === 0 && await daemon.history() === history && await daemon.geometry() === null
  }
  const stop = async () => {
    if (stopped) return
    await daemon.stop()
    stopped = true
  }
  const verify = async (role, event) => {
    requireFact(!stopped && ROLES.includes(role) && !beforeRestartDone, 'invalid_verification_phase')
    assertScope()
    const key = `${role}:${event}`
    requireFact(!verified.has(key) && (event !== 'resolved' || verified.has(`${role}:opened`)), 'duplicate_or_unopened_transition')
    const safeUi = (currentDriver) => assertSafeLocalServiceUi(currentDriver, { hostId: hosts[role], vaultId, name: NAMES[role], status: event === 'opened' ? 'active' : 'resolved', role })
    await safeUi(activeDriver)
    const countBefore = verified.size
    await until(async () => { const counts = await daemon.counts(); return counts.displayed === 1 && counts.waiting === 0 && await daemon.history() === countBefore }, 'lifecycle_banner_not_unique')
    const geometry = await until(() => daemon.geometry(), 'lifecycle_banner_not_viewable')
    const evidence = await daemon.capture({ driver: activeDriver, checkpoint, name: `notification-service-${role}-${event}`, geometry, expectedVisible: true, expectedTitle: NAMES[role], expectedBody: `${NAMES[role]}: ${event}`, assertSafeUi: safeUi })
    await daemon.closeAll()
    await until(() => empty(countBefore + 1), 'lifecycle_banner_not_closed')
    verified.add(key)
    await record(`notification-local-service-${role}-${event}`, { passed: true, x11Viewable: true, displayed: 1, waiting: 0, history: verified.size, ...evidence })
  }
  try {
    await until(() => empty(0), 'new_daemon_not_empty')
    await saveSystemPolicy(activeDriver)
    baseline = (await diagnostic(activeDriver)).delivered
    await record('notification-local-service-policy-saved', { enabled: true, systemOnly: true, recoveryEnabled: true, defaultCooldown: true, defaultDedupe: true, baselineDelivered: baseline })
    return {
      verifyOpened: (role) => verify(role, 'opened'),
      verifyResolved: (role) => verify(role, 'resolved'),
      async beforeRestart() {
        requireFact(!stopped && !beforeRestartDone && verified.size === 4, 'incomplete_lifecycle_before_restart')
        assertScope()
        await openSettings(activeDriver)
        await verifyPolicy(activeDriver)
        await until(async () => { const value = await diagnostic(activeDriver); return value.delivered === baseline + 4 && value.accepted }, 'delivery_journal_not_complete')
        requireFact(await empty(4), 'unexpected_lifecycle_replay')
        beforeRestartDone = true
        await record('notification-local-service-journal-before-restart', { persistedDelivered: baseline + 4, lifecycleDelivered: 4, history: 4, accepted: true })
      },
      async afterRestart({ driver: restartedDriver }) {
        requireFact(!stopped && beforeRestartDone && !afterRestartDone && restartedDriver && restartedDriver !== activeDriver, 'invalid_restart_boundary')
        activeDriver = restartedDriver
        assertScope()
        await openSettings(activeDriver)
        await verifyPolicy(activeDriver)
        await until(async () => { const value = await diagnostic(activeDriver); return value.delivered === baseline + 4 && value.accepted }, 'delivery_journal_not_restored')
        // The caller already observed genuinely newer post-restart samples.
        // Also observe a bounded quiet window so asynchronously queued sends
        // cannot pass an instantaneous zero-count assertion. timeout=0 keeps
        // any unexpected banner present until this owner explicitly closes it.
        const quietWindowMs = 5000
        const deadline = Date.now() + quietWindowMs
        do {
          requireFact(await empty(4), 'notification_replayed_after_restart')
          const value = await diagnostic(activeDriver)
          requireFact(value.delivered === baseline + 4 && value.accepted, 'delivery_replayed_after_restart')
          await delay(200)
        } while (Date.now() < deadline)
        afterRestartDone = true
        await record('notification-local-service-restored-without-replay', { passed: true, restoredDelivered: baseline + 4, lifecycleDelivered: 4, history: 4, displayed: 0, waiting: 0, localStorageJournal: true, noReplayObservedMs: quietWindowMs })
        return { passed: true, scope: 'local-service-alerts-linux-x11', actualAlertLifecycleVerified: true, lifecycleDelivered: 4, baselineDelivered: baseline, restoredDelivered: baseline + 4, history: 4, displayed: 0, waiting: 0, localStorageJournal: true, noReplayObservedMs: quietWindowMs }
      },
      stop,
    }
  } catch (cause) { await stop(); throw cause }
}
