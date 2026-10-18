// Control-flow/DOM contract unit tests only. These do not establish real SSH,
// native persistence, application restart or OS notification acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  OPS_UI_PROBE_RULE_IDS, readOpsUiProbeAlert, readOpsUiProbeEvaluation,
  resumeOpsUiProbeJourney, runOpsUiProbeJourney, validateOpsUiProbeScope,
  verifyOpsUiProbeAudit, waitForOpsUiProbeEvaluation, settleOpsUiProbeInventory,
} from './ops-ui-probe-journey.mjs'

const roles = ['jump', 'direct', 'via']
const rule = OPS_UI_PROBE_RULE_IDS.metrics
const name = 'Metrics collection unavailable'
const scope = () => ({ vaultId: 'private-vault', hostIds: { jump: 'jump-profile', direct: 'direct-target', via: 'via-target' }, hostNames: Object.fromEntries(roles.map(role => [role, `ShellBeam UI ${role} fixture`])) })
const fixture = () => ({ schemaVersion: 1, hosts: Object.fromEntries(roles.map((role, index) => [role, { name: `ShellBeam UI ${role} fixture`, address: '127.0.0.1', port: 2201 + index, user: 'root' }])) })
const evaluation = (state, role, sampledAt, status = 'healthy') => `<span data-testid="host-probe-evaluation" data-rule-id="${rule}" data-host-id="${state.hostIds[role]}" data-vault-id="${state.vaultId}" data-state="${status}" data-sampled-at="${sampledAt}">Metrics · ${status}</span>`
function domDriver(html) {
  const dom = new JSDOM(html), document = dom.window.document
  return { dom, document, driver: {
    findAll: async (selector) => [...document.querySelectorAll(selector)],
    isDisplayed: async element => !element.closest('[hidden]'),
    attr: async (element, field) => { const row = typeof element === 'string' ? document.querySelector(element) : element; return field === 'value' ? row.value : row.getAttribute(field) },
    text: async element => (typeof element === 'string' ? document.querySelector(element) : element).textContent,
  } }
}

test('scope rejects non-private endpoints, duplicate ports and ambiguous or injected host/Vault identities before UI work', () => {
  assert.doesNotThrow(() => validateOpsUiProbeScope(fixture(), scope()))
  const remote = fixture(); remote.hosts.via.address = '192.0.2.1'
  const duplicate = fixture(); duplicate.hosts.via.port = duplicate.hosts.jump.port
  for (const [hostFixture, state] of [[remote, scope()], [duplicate, scope()], [fixture(), { ...scope(), vaultId: '' }], [fixture(), { ...scope(), hostIds: { ...scope().hostIds, via: 'jump-profile' } }], [fixture(), { ...scope(), hostIds: { ...scope().hostIds, via: 'host"]' } }]]) {
    assert.throws(() => validateOpsUiProbeScope(hostFixture, state), /ops_ui_probe_(fixture_endpoint_outside_isolation|fixture_endpoints_not_independent|invalid_fixture_scope|invalid_host_scope)/)
  }
})

test('evaluation reads only the actual displayed builtin metrics row in the matching host and Vault', async () => {
  const state = scope(), now = Date.now()
  const { dom, document, driver } = domDriver(`<div data-testid="host-card" data-host-id="${state.hostIds.direct}">${evaluation(state, 'direct', now)}${evaluation({ ...state, vaultId: 'foreign' }, 'direct', now + 1)}</div>`)
  try {
    assert.deepEqual(await readOpsUiProbeEvaluation(driver, state, 'direct'), { sampledAt: now, state: 'healthy' })
    const row = document.querySelector(`[data-vault-id="${state.vaultId}"]`)
    for (const value of ['', 'NaN', String(now + 60_000)]) { row.setAttribute('data-sampled-at', value); assert.equal(await readOpsUiProbeEvaluation(driver, state, 'direct'), null) }
    row.setAttribute('data-sampled-at', String(now)); row.hidden = true
    assert.equal(await readOpsUiProbeEvaluation(driver, state, 'direct'), null)
    row.hidden = false; row.setAttribute('data-rule-id', OPS_UI_PROBE_RULE_IDS.inventory)
    assert.equal(await readOpsUiProbeEvaluation(driver, state, 'direct'), null)
  } finally { dom.window.close() }
})

test('a healthy host or cached/future/unknown evaluation cannot satisfy the required post-recovery original sample', async () => {
  const state = scope(), now = Date.now()
  const { dom, document, driver } = domDriver(`<div data-testid="host-card" data-host-id="${state.hostIds.direct}" data-host-health="online">${evaluation(state, 'direct', now - 10_000)}</div>`)
  const row = document.querySelector('[data-testid="host-probe-evaluation"]')
  let polls = 0
  driver.until = async predicate => {
    for (const [at, status] of [[now - 10_000, 'healthy'], [now, 'unknown'], [now + 60_000, 'healthy'], [now, 'healthy']]) {
      row.setAttribute('data-sampled-at', String(at)); row.setAttribute('data-state', status); polls++
      const result = await predicate(); if (result) return result
    }
    throw new Error('unit timeout')
  }
  try {
    assert.deepEqual(await waitForOpsUiProbeEvaluation(driver, state, 'direct', { status: 'healthy', boundary: now, after: now - 1 }), { sampledAt: now, state: 'healthy' })
    assert.equal(polls, 4)
    await assert.rejects(waitForOpsUiProbeEvaluation(driver, state, 'direct', { status: 'healthy', boundary: 0 }), /invalid_sample_boundary/)
  } finally { dom.window.close() }
})

test('builtin alert evidence refuses a wrong section/source/route even when its name looks like the expected target', async () => {
  const state = scope()
  const { dom, document, driver } = domDriver(`<div data-testid="host-card" data-host-id="${state.hostIds.via}"><div data-testid="host-local-alert" data-rule-id="${rule}" data-host-id="${state.hostIds.via}" data-vault-id="${state.vaultId}" data-metric="probe-provider" data-source="ssh-agentless" data-transport="proxy-jump" data-alert-status="active" data-updated-at="1">${state.hostNames.via} · ${name} · ProbeProvider collection</div></div>`)
  const row = document.querySelector('[data-testid="host-local-alert"]')
  try {
    assert.deepEqual(await readOpsUiProbeAlert(driver, state, 'via', 'active'), { jobId: null, updatedAt: 1, resolvedAt: null })
    for (const [field, value] of [['data-transport', 'direct'], ['data-source', 'komari'], ['data-metric', 'cpu']]) {
      const before = row.getAttribute(field); row.setAttribute(field, value)
      await assert.rejects(readOpsUiProbeAlert(driver, state, 'via', 'active'), /alert_source_or_route_mismatch/)
      row.setAttribute(field, before)
    }
    for (const vaultId of ['foreign', null]) {
      if (vaultId === null) row.removeAttribute('data-vault-id')
      else row.dataset.vaultId = vaultId
      await assert.rejects(readOpsUiProbeAlert(driver, state, 'via', 'active'), /alert_vault_scope_mismatch/)
    }
    row.dataset.vaultId = state.vaultId
    row.setAttribute('data-rule-id', OPS_UI_PROBE_RULE_IDS.inventory)
    assert.equal(await readOpsUiProbeAlert(driver, state, 'via', 'active'), null)
  } finally { dom.window.close() }
})

function unitJourney(t) {
  let clock = 1_800_000_000_000
  t.mock.method(Date, 'now', () => ++clock)
  const state = scope(), hostFixture = fixture(), events = [], checkpoints = []
  const { dom, document, driver } = domDriver(`<button data-testid="pc-dashboard"></button><button data-testid="pc-nav-hosts"></button><button data-testid="pc-nav-activity"></button><section data-testid="operations-audit-center"><button data-testid="audit-tab"></button><select data-testid="operations-source-filter"><option value="all">All</option><option value="workspace">Workspace</option></select><select data-testid="operations-filter"><option value="all">All</option><option value="cancelled">Cancelled</option><option value="completed">Completed</option></select><button data-testid="operations-refresh">Refresh</button><span data-testid="operations-page">Page 1</span><button data-testid="operations-older" disabled>Older</button></section>${roles.map(role => `<article data-testid="host-card" data-host-id="${state.hostIds[role]}">${evaluation(state, role, clock - 1000)}</article>`).join('')}`)
  let pending = null, page = 'hosts', job = 0
  const node = input => typeof input === 'string' ? document.querySelector(input) : input
  const hostCard = role => document.querySelector(`[data-testid="host-card"][data-host-id="${state.hostIds[role]}"]`)
  const probe = role => hostCard(role).querySelector('[data-testid="host-probe-evaluation"]')
  const alert = role => hostCard(role).querySelector('[data-testid="host-local-alert"]')
  const setAlert = (role, status, jobId) => {
    let row = alert(role)
    if (!row) { row = document.createElement('div'); hostCard(role).append(row) }
    Object.assign(row.dataset, { testid: 'host-local-alert', ruleId: rule, hostId: state.hostIds[role], vaultId: state.vaultId, metric: 'probe-provider', source: 'ssh-agentless', transport: role === 'via' ? 'proxy-jump' : 'direct', alertStatus: status, updatedAt: String(clock), ...(status === 'resolved' ? { resolvedAt: String(clock) } : {}), ...(jobId ? { jobId } : {}) })
    row.textContent = `${state.hostNames[role].slice(0, 48)} · ${name} · ProbeProvider collection`
    if (status === 'active') row.insertAdjacentHTML('beforeend', `<button data-testid="local-host-alert-ack-${rule}">Acknowledge</button>`)
    if (status !== 'closed') row.insertAdjacentHTML('beforeend', `<button data-testid="local-host-alert-close-${rule}">Close</button>`)
  }
  driver.find = async selector => { const result = document.querySelector(selector); assert(result, 'unit element required'); return result }
  driver.waitFor = driver.find
  driver.select = async (selector, value) => { const select = node(selector); assert(select?.tagName === 'SELECT'); select.value = value }
  driver.isDisplayed = async element => {
    const row = node(element)
    return !!row && !row.closest('[hidden]') && (row.closest('[data-testid="host-card"]') ? page === 'hosts' : true)
  }
  driver.until = async predicate => {
    for (let attempt = 0; attempt < 4; attempt++) {
      clock += 1000
      for (const role of roles) if (probe(role).dataset.state === 'healthy') probe(role).dataset.sampledAt = String(clock)
      const value = await predicate(); if (value) return value
    }
    throw new Error('unit timeout')
  }
  driver.click = async selector => {
    const element = node(selector); assert(element, 'unit clickable control required')
    if (element.dataset.testid === 'pc-nav-hosts') page = 'hosts'
    else if (element.dataset.testid === 'pc-nav-activity') page = 'activity'
    else if (element.dataset.testid.startsWith('local-host-alert-')) {
      const hostId = element.closest('[data-testid="host-card"]').dataset.hostId
      const role = roles.find(role => state.hostIds[role] === hostId)
      pending = { role, action: element.dataset.testid.includes('-ack-') ? 'acknowledge' : 'close' }
      events.push(`request:${role}:${pending.action}`)
      document.body.insertAdjacentHTML('beforeend', `<dialog open><div data-testid="user-confirmation" data-vault-id="${state.vaultId}" data-host-id="${state.hostIds[role]}"><p data-testid="user-confirmation-message">${state.hostNames[role]} · ${name}: local lifecycle change</p><button data-testid="user-confirmation-cancel">Cancel</button><button data-testid="user-confirmation-accept">Confirm</button></div></dialog>`)
    } else if (element.dataset.testid === 'user-confirmation-cancel' || element.dataset.testid === 'user-confirmation-accept') {
      await respond(element.dataset.testid === 'user-confirmation-accept')
    }
  }
  const respond = async accepted => {
    assert(pending)
    const { role, action } = pending, id = `job-${++job}`, status = accepted ? 'completed' : 'cancelled'
    events.push(`${accepted ? 'accept' : 'reject'}:${role}:${action}`)
    if (accepted) setAlert(role, action === 'acknowledge' ? 'acknowledged' : 'closed', id)
    document.querySelector('[data-testid="operations-audit-center"]').insertAdjacentHTML('beforeend', `<div data-testid="operation-audit-row" data-vault-id="${state.vaultId}" data-host-id="${state.hostIds[role]}" data-job-id="${id}" data-target="${rule}" data-action="local-alert.${action}" data-status="${status}" data-confirmation="${accepted ? 'confirmed' : 'rejected'}" data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}">workspace · local-ops · ${role === 'via' ? 'proxy-jump' : 'direct'}</div>`)
    document.querySelector('dialog').remove()
    pending = null
  }
  const checkpoint = async (kind, { role }) => {
    checkpoints.push(`${kind}:${role}`)
    const boundary = ++clock
    for (const affected of role === 'via' ? ['via', 'jump'] : [role]) {
      probe(affected).dataset.state = kind === 'probe-stop' ? 'firing' : 'healthy'
      probe(affected).dataset.sampledAt = String(++clock)
      setAlert(affected, kind === 'probe-stop' ? 'active' : 'resolved', alert(affected)?.dataset.jobId)
    }
    return kind === 'probe-stop' ? { role, stopped: true, boundary } : { role, restored: true, ready: true, boundary }
  }
  return { driver, fixture: hostFixture, resumeState: state, checkpoint, record: async (name, details) => events.push({ name, ...details }), events, checkpoints, alert, probe, close: () => dom.window.close() }
}

test('journey orders cancellation/ack before genuine recovery, then closes; via also observes the saved-jump collateral', async t => {
  const unit = unitJourney(t), hooks = []
  try {
    const state = await runOpsUiProbeJourney({ ...unit,
      onOpened: async role => { hooks.push(`open:${role}`); assert.equal(unit.alert(role).dataset.alertStatus, 'active'); if (role === 'via') assert.equal(unit.alert('jump').dataset.alertStatus, 'active') },
      onResolved: async role => { hooks.push(`resolved:${role}`); assert.equal(unit.alert(role).dataset.alertStatus, 'resolved'); if (role === 'via') assert.equal(unit.alert('jump').dataset.alertStatus, 'resolved') },
    })
    assert.deepEqual(hooks, ['open:direct', 'resolved:direct', 'open:via', 'resolved:via'])
    assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct', 'probe-stop:via', 'probe-restore:via'])
    assert.equal(unit.alert('direct').dataset.alertStatus, 'closed')
    assert.equal(unit.alert('via').dataset.alertStatus, 'closed')
    assert.equal(unit.alert('jump').dataset.alertStatus, 'resolved')
    assert(state.hosts.direct.cancelled !== state.hosts.direct.acknowledged)
    assert(state.hosts.via.closed !== state.hosts.via.acknowledged)
    assert(state.hosts.jump.recoverySampleAt > state.hosts.jump.failedSampleAt)
    const result = await resumeOpsUiProbeJourney({ ...unit, probeState: state, restartedAfter: Date.now() })
    assert.deepEqual(result, { passed: true, scope: 'ssh-probe-metrics', targetHosts: 2, collateralJumpHosts: 1, profiles: 3, restoredJobs: 6, freshObservations: 3, actualMetricsLifecycleVerified: true, inventoryLifecycleVerified: false, osVisibilityVerified: false })
  } finally { unit.close() }
})

test('a failed evidence hook restores the exact stopped fixture and never proceeds to lifecycle writes or the next host', async t => {
  const unit = unitJourney(t)
  try {
    await assert.rejects(runOpsUiProbeJourney({ ...unit, onOpened: async () => { throw new Error('unit evidence rejected') } }), /unit evidence rejected/)
    assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct'])
    assert(!unit.events.some(event => typeof event === 'string' && event.startsWith('request:')))
  } finally { unit.close() }
})

test('a partial stop or unverifiable control boundary still attempts exact restoration and cannot pass', async t => {
  for (const failure of ['throw', 'future-boundary']) {
    const unit = unitJourney(t)
    const original = unit.checkpoint
    unit.checkpoint = async (kind, details) => {
      const result = await original(kind, details)
      if (kind === 'probe-stop') {
        if (failure === 'throw') throw new Error('unit stop partially failed')
        return { ...result, boundary: Date.now() + 60_000 }
      }
      return result
    }
    try {
      await assert.rejects(runOpsUiProbeJourney(unit), /unit stop partially failed|fixture_control_not_verified/)
      assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct'])
      assert(!unit.events.some(event => typeof event === 'string' && event.startsWith('request:')))
    } finally { unit.close() }
  }
})

test('a scope change in the visible-notification hook stops before confirmation and restores the fixture', async t => {
  const unit = unitJourney(t)
  try {
    await assert.rejects(runOpsUiProbeJourney({ ...unit, onOpened: async () => { unit.resumeState.vaultId = 'different-vault' } }), /scope_changed/)
    assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct'])
    assert(!unit.events.some(event => typeof event === 'string' && event.startsWith('request:')))
  } finally { unit.close() }
})

test('probe lifecycle refuses a foreign-host/Vault or wrong-target visible confirmation before any response or mutation', async t => {
  for (const problem of ['vault', 'host', 'target']) {
    const unit = unitJourney(t), click = unit.driver.click
    unit.driver.click = async selector => {
      await click(selector)
      const modal = unit.alert('direct')?.ownerDocument.querySelector('[data-testid="user-confirmation"]')
      if (modal) {
        if (problem === 'vault') modal.dataset.vaultId = 'foreign'
        if (problem === 'host') modal.dataset.hostId = unit.resumeState.hostIds.via
        if (problem === 'target') modal.querySelector('[data-testid="user-confirmation-message"]').textContent = 'Other collection'
      }
    }
    try {
      await assert.rejects(runOpsUiProbeJourney(unit), /confirmation_scope_mismatch|confirmation_target_mismatch/)
      assert.deepEqual(unit.events.filter(event => typeof event === 'string'), ['request:direct:acknowledge'])
      assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct'])
      assert.equal(unit.alert('direct').dataset.jobId, undefined)
    } finally { unit.close() }
  }
})

test('restart verification rejects an old healthy evaluation and a foreign scope instead of claiming restored freshness', async t => {
  const unit = unitJourney(t)
  try {
    const state = await runOpsUiProbeJourney(unit)
    const boundary = Date.now()
    const passiveDriver = { ...unit.driver, until: async predicate => { const result = await predicate(); if (result) return result; throw new Error('unit old sample refused') } }
    await assert.rejects(resumeOpsUiProbeJourney({ ...unit, driver: passiveDriver, probeState: state, restartedAfter: boundary }), /unit old sample refused/)
    await assert.rejects(resumeOpsUiProbeJourney({ ...unit, probeState: { ...state, vaultId: 'foreign' }, restartedAfter: boundary }), /invalid_restart_scope/)
  } finally { unit.close() }
})

test('audit verification refuses an unconfirmed or foreign-Vault record despite a matching job id', async t => {
  const unit = unitJourney(t)
  try {
    const state = await runOpsUiProbeJourney(unit)
    const jobId = state.hosts.direct.acknowledged
    const rows = unit.alert('direct').ownerDocument.querySelectorAll(`[data-job-id="${jobId}"][data-testid="operation-audit-row"]`)
    rows[0].dataset.confirmation = 'not_required'
    await assert.rejects(verifyOpsUiProbeAudit(unit.driver, state, 'direct', { action: 'acknowledge', status: 'completed', jobId }), /audit_record_missing/)
    rows[0].dataset.confirmation = 'confirmed'; rows[0].dataset.vaultId = 'foreign'
    await assert.rejects(verifyOpsUiProbeAudit(unit.driver, state, 'direct', { action: 'acknowledge', status: 'completed', jobId }), /audit_record_missing/)
  } finally { unit.close() }
})

async function inventoryUnit(t, { sampleMode = 'fresh', alertStatus, badField } = {}) {
  const unit = unitJourney(t)
  const probeState = await runOpsUiProbeJourney(unit)
  const document = unit.alert('direct').ownerDocument, selected = []
  for (const role of roles) {
    const card = document.querySelector(`article[data-host-id="${unit.resumeState.hostIds[role]}"]`)
    card.insertAdjacentHTML('beforeend', `<div data-testid="host-ops-summary" data-vault-id="${unit.resumeState.vaultId}" data-host-id="${unit.resumeState.hostIds[role]}"></div><select data-testid="host-ops-open"><option value="refresh">Refresh</option></select>${evaluation(unit.resumeState, role, Date.now() - 60_000).replace(rule, OPS_UI_PROBE_RULE_IDS.inventory)}`)
    const status = role === 'jump' ? alertStatus : role === 'direct' ? 'resolved' : 'closed'
    if (status) card.insertAdjacentHTML('beforeend', `<div data-testid="host-local-alert" data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}" data-vault-id="${unit.resumeState.vaultId}" data-host-id="${unit.resumeState.hostIds[role]}" data-metric="probe-provider" data-source="ssh-agentless" data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}" data-alert-status="${status}">Inventory collection unavailable</div>`)
  }
  if (badField) document.querySelector(`[data-host-id="${unit.resumeState.hostIds.jump}"] [data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"][data-testid="host-local-alert"]`).setAttribute(...badField)
  unit.driver.select = async (selector, value) => {
    assert.equal(value, 'refresh')
    const menu = document.querySelector(selector); assert(menu)
    const card = menu.closest('article')
    const role = roles.find(role => unit.resumeState.hostIds[role] === card.dataset.hostId)
    selected.push(role)
    const row = card.querySelector(`[data-testid="host-probe-evaluation"][data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"]`)
    if (sampleMode === 'fresh') row.dataset.sampledAt = String(Date.now())
    if (sampleMode === 'future') row.dataset.sampledAt = String(Date.now() + 60_000)
    if (sampleMode === 'unknown') { row.dataset.sampledAt = String(Date.now()); row.dataset.state = 'unknown' }
  }
  return { ...unit, probeState, selected, document }
}

test('inventory drain selects each real host refresh and permits no alert or an already resolved/closed inventory lifecycle', async t => {
  const unit = await inventoryUnit(t)
  try {
    const result = await settleOpsUiProbeInventory(unit)
    assert.deepEqual(result, { passed: true, profiles: 3, freshObservations: 3 })
    assert.deepEqual(unit.selected, ['jump', 'direct', 'via'])
    const rows = [...unit.document.querySelectorAll(`[data-testid="host-local-alert"][data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"]`)]
    assert.deepEqual(rows.map(row => row.dataset.alertStatus), ['resolved', 'closed'])
    const records = unit.events.filter(event => typeof event === 'object' && event.name.includes('inventory-settled'))
    assert.equal(records.length, 3)
    assert.deepEqual(records.map(record => record.inventoryAlertPresent), [false, true, true])
    assert(records.every(record => record.freshObservation && record.noOpenInventoryAlert))
  } finally { unit.close() }
})

test('inventory drain rejects cached/future/unknown inventory even while independent metrics keep producing fresh healthy samples', async t => {
  for (const sampleMode of ['cached', 'future', 'unknown']) {
    const unit = await inventoryUnit(t, { sampleMode })
    try {
      await assert.rejects(settleOpsUiProbeInventory(unit), /unit timeout/)
      assert.deepEqual(unit.selected, ['jump'])
      assert(!unit.events.some(event => typeof event === 'object' && event.name.includes('inventory-settled')))
    } finally { unit.close() }
  }
})

test('healthy inventory samples do not hide active or acknowledged inventory alerts', async t => {
  for (const alertStatus of ['active', 'acknowledged']) {
    const unit = await inventoryUnit(t, { alertStatus })
    try {
      await assert.rejects(settleOpsUiProbeInventory(unit), /unit timeout/)
      assert.deepEqual(unit.selected, ['jump'])
      assert.equal(unit.document.querySelector(`[data-testid="host-local-alert"][data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"]`).dataset.alertStatus, alertStatus)
    } finally { unit.close() }
  }
})

test('inventory drain refuses foreign Vault/source/route rows without silently treating them as absent', async t => {
  for (const badField of [['data-vault-id', 'foreign'], ['data-source', 'komari'], ['data-transport', 'proxy-jump']]) {
    const unit = await inventoryUnit(t, { alertStatus: 'resolved', badField })
    try {
      await assert.rejects(settleOpsUiProbeInventory(unit), /inventory_alert_scope_or_source_mismatch/)
      assert.deepEqual(unit.selected, ['jump'])
    } finally { unit.close() }
  }
})

test('inventory drain requires restored outage state and cancels a changed Vault before another host can refresh', async t => {
  const unit = await inventoryUnit(t)
  try {
    await assert.rejects(settleOpsUiProbeInventory({ ...unit, probeState: { ...unit.probeState, hosts: {} } }), /inventory_drain_before_recovery/)
    assert.deepEqual(unit.selected, [])
    const select = unit.driver.select
    unit.driver.select = async (...args) => { await select(...args); unit.resumeState.vaultId = 'foreign' }
    await assert.rejects(settleOpsUiProbeInventory(unit), /scope_changed/)
    assert.deepEqual(unit.selected, ['jump'])
  } finally { unit.close() }
})
