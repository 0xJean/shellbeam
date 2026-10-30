// UI navigation only. Detailed evidence must still pass the caller's original
// visible-row, source, Vault and sample-time checks after the genuine click.
const q = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
function check(value, code) { if (!value) throw new Error(`ops_ui_host_details_${code}`) }

// Active navigation only: a host card mounts before its async operational
// summary. Wait for the target summary, rather than passing that partial
// mount into the strict disclosure reader. Notification readers never call
// this preparation step and keep their existing scope/visibility assertions.
export async function waitForOpsUiHostOperations(driver, { hostId, vaultId }) {
  check(validId(hostId) && validId(vaultId), 'invalid_scope')
  const card = `[data-testid="host-card"][data-host-id=${q(hostId)}]`
  return driver.until(async () => {
    const cards = await driver.findAll(card)
    check(cards.length <= 1, 'ambiguous_host')
    if (!cards.length || !await driver.isDisplayed(cards[0])) return false
    check(await driver.attr(cards[0], 'data-vault-id') === vaultId, 'vault_mismatch')
    const summaries = await driver.findAll(`${card} [data-testid="host-ops-summary"]`)
    check(summaries.length <= 1, 'ambiguous_summary')
    if (!summaries.length) return false
    check(await driver.attr(summaries[0], 'data-vault-id') === vaultId
      && await driver.attr(summaries[0], 'data-host-id') === hostId, 'summary_scope_mismatch')
    return await driver.isDisplayed(summaries[0]) ? summaries[0] : false
  })
}

async function readSurface(driver, { hostId, vaultId }) {
  check(validId(hostId) && validId(vaultId), 'invalid_scope')
  const card = `[data-testid="host-card"][data-host-id=${q(hostId)}]`
  const toggle = `${card} [data-testid="host-ops-details-toggle"]`
  const details = `${card} [data-testid="host-ops-details"]`
  const cards = await driver.findAll(card)
  check(cards.length <= 1, 'ambiguous_host')
  if (!cards.length || !await driver.isDisplayed(cards[0])) return null
  const owner = await driver.attr(cards[0], 'data-vault-id')
  check(owner === null || owner === undefined || owner === vaultId, 'vault_mismatch')
  const toggles = await driver.findAll(toggle)
  const regions = await driver.findAll(details)
  // Grid cards already expose these rows. They need no disclosure click;
  // callers still require the actual evidence row to be visible and scoped.
  if (toggles.length === 0 && regions.length === 0) return { disclosed: true }
  check(owner === vaultId && toggles.length === 1 && regions.length === 1, 'scope_or_controls_mismatch')
  const controls = await driver.attr(toggles[0], 'aria-controls')
  check(typeof controls === 'string' && controls.length > 0
    && await driver.attr(regions[0], 'id') === controls, 'region_mismatch')
  const expanded = await driver.attr(toggles[0], 'aria-expanded')
  check(expanded === 'true' || expanded === 'false', 'invalid_expanded_state')
  return { disclosed: false, expanded: expanded === 'true', toggle: toggles[0], region: regions[0], selector: toggle }
}

// Notification capture guards must never focus/raise the app by clicking a
// disclosure after a native banner has appeared. Preparation is separate.
export async function isOpsUiHostDetailsVisible(driver, scope) {
  const current = await readSurface(driver, scope)
  return !!current && (current.disclosed || (current.expanded && await driver.isDisplayed(current.region)))
}

export async function ensureOpsUiHostDetails(driver, scope) {
  const current = await readSurface(driver, scope)
  if (!current) return false
  if (current.disclosed) return true
  if (!current.expanded) {
    check(await driver.isDisplayed(current.toggle), 'toggle_not_visible')
    await driver.click(current.selector)
  }
  // A host refresh can replace the row's data and collapse it again. Report
  // that as not yet visible, so a caller's bounded wait can open it once more.
  try {
    return await driver.until(async () => {
      const latest = await readSurface(driver, scope)
      check(latest && !latest.disclosed, 'surface_changed')
      return latest.expanded && await driver.isDisplayed(latest.region)
    }, { timeoutMs: 10_000 })
  } catch (error) {
    if (error?.code === 'timeout') return false
    throw error
  }
}
