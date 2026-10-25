// Control-flow/DOM contract unit tests only. These do not establish real SSH,
// native persistence, application restart or OS notification acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { ensureOpsUiHostDetails, isOpsUiHostDetailsVisible } from './ops-ui-host-details.mjs'
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

function disclosedHostUnit() {
  const state = scope(), now = Date.now() - 10, hostId = state.hostIds.direct
  const unit = domDriver(`<article data-testid="host-card" data-host-id="${hostId}" data-vault-id="${state.vaultId}">
    <div data-testid="host-ops-summary" data-host-id="${hostId}" data-vault-id="${state.vaultId}"></div>
    <button data-testid="host-ops-details-toggle" aria-expanded="false" aria-controls=":host-details:">Operations details</button>
    <section data-testid="host-ops-details" id=":host-details:" hidden>
      ${evaluation(state, 'direct', now)}
      <div data-testid="host-local-alert" data-rule-id="${rule}" data-host-id="${hostId}" data-vault-id="${state.vaultId}" data-metric="probe-provider" data-source="ssh-agentless" data-transport="direct" data-alert-status="active" data-updated-at="${now}">${state.hostNames.direct} · ${name} · Monitoring collection</div>
    </section>
  </article>`)
  const card = unit.document.querySelector('[data-testid="host-card"]')
  const toggle = unit.document.querySelector('button')
  const region = unit.document.querySelector('section')
  const clicks = []
  unit.driver.click = async selector => {
    const button = unit.document.querySelector(selector)
    assert.equal(button, toggle)
    assert(!button.closest('[hidden]'))
    clicks.push(selector)
    button.setAttribute('aria-expanded', 'true')
    region.hidden = false
  }
  unit.driver.until = async predicate => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await predicate()
      if (result) return result
    }
    throw new Error('unit timeout')
  }
  return { ...unit, state, now, card, toggle, region, clicks }
}

test('Probe readers genuinely expand the matching host once and preserve original evidence checks', async () => {
  const unit = disclosedHostUnit()
  try {
    assert(unit.region.hidden)
    assert.deepEqual(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct'), { state: 'healthy', sampledAt: unit.now })
    assert.deepEqual(await readOpsUiProbeAlert(unit.driver, unit.state, 'direct', 'active'), { jobId: null, updatedAt: unit.now, resolvedAt: null })
    assert.equal(unit.clicks.length, 1)
    assert.equal(unit.toggle.getAttribute('aria-expanded'), 'true')
    const evaluationRow = unit.document.querySelector('[data-testid="host-probe-evaluation"]')
    evaluationRow.hidden = true
    assert.equal(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct'), null)
    evaluationRow.hidden = false
    evaluationRow.dataset.sampledAt = String(Date.now() + 60_000)
    assert.equal(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct'), null)
    const alert = unit.document.querySelector('[data-testid="host-local-alert"]')
    alert.dataset.vaultId = 'foreign'
    await assert.rejects(readOpsUiProbeAlert(unit.driver, unit.state, 'direct', 'active'), /alert_vault_scope_mismatch/)
    assert.equal(unit.clicks.length, 1)
  } finally { unit.dom.window.close() }
})

test('read-only Probe readers and waits refuse collapsed or hidden details without falling back to disclosure clicks', async () => {
  const unit = disclosedHostUnit()
  const hostScope = { hostId: unit.state.hostIds.direct, vaultId: unit.state.vaultId }
  try {
    assert.equal(await isOpsUiHostDetailsVisible(unit.driver, hostScope), false)
    assert.equal(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct', 'metrics', { reveal: false }), null)
    assert.equal(await readOpsUiProbeAlert(unit.driver, unit.state, 'direct', 'active', { reveal: false }), null)
    await assert.rejects(waitForOpsUiProbeEvaluation(unit.driver, unit.state, 'direct', {
      status: 'healthy', boundary: unit.now, reveal: false,
    }), /unit timeout/)
    assert.equal(unit.clicks.length, 0)
    await ensureOpsUiHostDetails(unit.driver, hostScope)
    assert.equal(await isOpsUiHostDetailsVisible(unit.driver, hostScope), true)
    assert.deepEqual(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct', 'metrics', { reveal: false }), { state: 'healthy', sampledAt: unit.now })
    assert.deepEqual(await readOpsUiProbeAlert(unit.driver, unit.state, 'direct', 'active', { reveal: false }), { jobId: null, updatedAt: unit.now, resolvedAt: null })
    unit.region.hidden = true
    assert.equal(await isOpsUiHostDetailsVisible(unit.driver, hostScope), false)
    assert.equal(await readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct', 'metrics', { reveal: false }), null)
    assert.equal(await readOpsUiProbeAlert(unit.driver, unit.state, 'direct', 'active', { reveal: false }), null)
    assert.equal(unit.clicks.length, 1)
  } finally { unit.dom.window.close() }
})

test('read-only detail checks retain host, Vault and disclosure ownership validation without UI writes', async () => {
  for (const problem of ['foreign-vault', 'missing-vault', 'duplicate-host', 'duplicate-toggle', 'duplicate-region', 'missing-region', 'foreign-control', 'invalid-expanded']) {
    const unit = disclosedHostUnit()
    try {
      if (problem === 'foreign-vault') unit.card.dataset.vaultId = 'foreign'
      if (problem === 'missing-vault') unit.card.removeAttribute('data-vault-id')
      if (problem === 'duplicate-host') unit.card.after(unit.card.cloneNode(true))
      if (problem === 'duplicate-toggle') unit.toggle.after(unit.toggle.cloneNode(true))
      if (problem === 'duplicate-region') unit.region.after(unit.region.cloneNode(true))
      if (problem === 'missing-region') unit.region.remove()
      if (problem === 'foreign-control') unit.toggle.setAttribute('aria-controls', 'another-host-details')
      if (problem === 'invalid-expanded') unit.toggle.setAttribute('aria-expanded', 'maybe')
      await assert.rejects(isOpsUiHostDetailsVisible(unit.driver, { hostId: unit.state.hostIds.direct, vaultId: unit.state.vaultId }), /ops_ui_host_details_/)
      assert.equal(unit.clicks.length, 0, problem)
    } finally { unit.dom.window.close() }
  }
})

test('detail navigation refuses foreign, ambiguous or unlinked controls before clicking', async () => {
  for (const problem of ['foreign-vault', 'missing-vault', 'duplicate-host', 'duplicate-toggle', 'duplicate-region', 'missing-region', 'foreign-control', 'invalid-expanded', 'hidden-toggle']) {
    const unit = disclosedHostUnit()
    try {
      if (problem === 'foreign-vault') unit.card.dataset.vaultId = 'foreign'
      if (problem === 'missing-vault') unit.card.removeAttribute('data-vault-id')
      if (problem === 'duplicate-host') unit.card.after(unit.card.cloneNode(true))
      if (problem === 'duplicate-toggle') unit.toggle.after(unit.toggle.cloneNode(true))
      if (problem === 'duplicate-region') unit.region.after(unit.region.cloneNode(true))
      if (problem === 'missing-region') unit.region.remove()
      if (problem === 'foreign-control') unit.toggle.setAttribute('aria-controls', 'another-host-details')
      if (problem === 'invalid-expanded') unit.toggle.setAttribute('aria-expanded', 'maybe')
      if (problem === 'hidden-toggle') unit.toggle.hidden = true
      await assert.rejects(ensureOpsUiHostDetails(unit.driver, { hostId: unit.state.hostIds.direct, vaultId: unit.state.vaultId }), /ops_ui_host_details_/)
      assert.equal(unit.clicks.length, 0, problem)
    } finally { unit.dom.window.close() }
  }
})

test('detail navigation never forces a refused click, accepts hidden evidence or clicks again while waiting', async () => {
  const unit = disclosedHostUnit()
  const scope = { hostId: unit.state.hostIds.direct, vaultId: unit.state.vaultId }
  try {
    unit.driver.click = async () => { unit.clicks.push('attempt'); throw new Error('element not interactable') }
    await assert.rejects(ensureOpsUiHostDetails(unit.driver, scope), /element not interactable/)
    assert.equal(unit.clicks.length, 1)
    assert(unit.region.hidden)
    unit.driver.click = async () => { unit.clicks.push('attempt'); unit.toggle.setAttribute('aria-expanded', 'true') }
    await assert.rejects(ensureOpsUiHostDetails(unit.driver, scope), /unit timeout/)
    assert.equal(unit.clicks.length, 2)
    assert(unit.region.hidden)
    unit.region.hidden = false
    await ensureOpsUiHostDetails(unit.driver, scope)
    assert.equal(unit.clicks.length, 2)
    unit.card.hidden = true
    assert.equal(await ensureOpsUiHostDetails(unit.driver, scope), false)
    assert.equal(unit.clicks.length, 2)
  } finally { unit.dom.window.close() }
})

test('detail navigation rechecks the current Vault after the actual disclosure click', async () => {
  const unit = disclosedHostUnit()
  try {
    const click = unit.driver.click
    unit.driver.click = async selector => { await click(selector); unit.card.dataset.vaultId = 'foreign' }
    await assert.rejects(readOpsUiProbeEvaluation(unit.driver, unit.state, 'direct'), /vault_mismatch/)
    assert.equal(unit.clicks.length, 1)
  } finally { unit.dom.window.close() }
})

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
  const { dom, document, driver } = domDriver(`<div data-testid="host-card" data-host-id="${state.hostIds.via}"><div data-testid="host-local-alert" data-rule-id="${rule}" data-host-id="${state.hostIds.via}" data-vault-id="${state.vaultId}" data-metric="probe-provider" data-source="ssh-agentless" data-transport="proxy-jump" data-alert-status="active" data-updated-at="1">${state.hostNames.via} · ${name} · Monitoring collection</div></div>`)
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

function unitJourney(t, { disclosures = false } = {}) {
  let clock = 1_800_000_000_000
  t.mock.method(Date, 'now', () => ++clock)
  const state = scope(), hostFixture = fixture(), events = [], checkpoints = []
  const { dom, document, driver } = domDriver(`<button data-testid="pc-dashboard"></button><button data-testid="pc-nav-hosts"></button><button data-testid="pc-nav-activity"></button><section data-testid="operations-audit-center"><button data-testid="audit-tab"></button><select data-testid="operations-source-filter"><option value="all">All</option><option value="workspace">Workspace</option></select><select data-testid="operations-filter"><option value="all">All</option><option value="cancelled">Cancelled</option><option value="completed">Completed</option></select><button data-testid="operations-refresh">Refresh</button><span data-testid="operations-page">Page 1</span><button data-testid="operations-older" disabled>Older</button></section>${roles.map(role => `<article data-testid="host-card" data-host-id="${state.hostIds[role]}">${evaluation(state, role, clock - 1000)}</article>`).join('')}`)
  let pending = null, page = 'hosts', job = 0
  const node = input => typeof input === 'string' ? document.querySelector(input) : input
  const hostCard = role => document.querySelector(`[data-testid="host-card"][data-host-id="${state.hostIds[role]}"]`)
  if (disclosures) {
    for (const role of roles) {
      const card = hostCard(role), region = document.createElement('section')
      card.dataset.vaultId = state.vaultId
      region.dataset.testid = 'host-ops-details'; region.id = `${role}-details`; region.hidden = true
      region.append(...card.childNodes)
      card.append(region)
      card.insertAdjacentHTML('afterbegin', `<button data-testid="host-ops-details-toggle" aria-expanded="false" aria-controls="${region.id}">Operations details</button>`)
    }
  }
  const probe = role => hostCard(role).querySelector('[data-testid="host-probe-evaluation"]')
  const alert = role => hostCard(role).querySelector('[data-testid="host-local-alert"]')
  const setAlert = (role, status, jobId) => {
    let row = alert(role)
    if (!row) { row = document.createElement('div'); (hostCard(role).querySelector('[data-testid="host-ops-details"]') ?? hostCard(role)).append(row) }
    Object.assign(row.dataset, { testid: 'host-local-alert', ruleId: rule, hostId: state.hostIds[role], vaultId: state.vaultId, metric: 'probe-provider', source: 'ssh-agentless', transport: role === 'via' ? 'proxy-jump' : 'direct', alertStatus: status, updatedAt: String(clock), ...(status === 'resolved' ? { resolvedAt: String(clock) } : {}), ...(jobId ? { jobId } : {}) })
    row.textContent = `${state.hostNames[role].slice(0, 48)} · ${name} · Monitoring collection`
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
    if (element.dataset.testid === 'pc-nav-hosts') {
      // Returning from Activity remounts the production host list. Disclosure
      // state is local to that list and must be prepared again before recovery.
      if (disclosures && page !== 'hosts') {
        for (const role of roles) {
          hostCard(role).querySelector('[data-testid="host-ops-details-toggle"]').setAttribute('aria-expanded', 'false')
          hostCard(role).querySelector('[data-testid="host-ops-details"]').hidden = true
        }
      }
      page = 'hosts'
    }
    else if (element.dataset.testid === 'pc-nav-activity') page = 'activity'
    else if (element.dataset.testid === 'host-ops-details-toggle') {
      assert(!element.closest('[hidden]'))
      element.setAttribute('aria-expanded', 'true')
      element.closest('[data-testid="host-card"]').querySelector('[data-testid="host-ops-details"]').hidden = false
    }
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
  return { driver, fixture: hostFixture, resumeState: state, checkpoint, record: async (name, details) => events.push({ name, ...details }), events, checkpoints, alert, probe, hostCard, close: () => dom.window.close() }
}

test('journey prepares every affected host before failure and recovery and keeps each notification window free of UI writes', async t => {
  const unit = unitJourney(t, { disclosures: true }), windows = [], prepared = []
  let notificationWindow = null
  const checkpoint = unit.checkpoint
  for (const method of ['click', 'select', 'fill']) {
    const original = unit.driver[method]
    unit.driver[method] = async (...args) => {
      assert.equal(notificationWindow, null, `${method} must not alter focus or painting during ${notificationWindow}`)
      assert(original, `unexpected ${method} outside notification capture`)
      return original(...args)
    }
  }
  unit.checkpoint = async (kind, details) => {
    assert.equal(notificationWindow, null)
    const affected = details.role === 'via' ? ['via', 'jump'] : [details.role]
    for (const role of affected) {
      const card = unit.hostCard(role)
      assert.equal(card.querySelector('[data-testid="host-ops-details-toggle"]').getAttribute('aria-expanded'), 'true', `${kind}: ${role} not prepared`)
      assert.equal(card.querySelector('[data-testid="host-ops-details"]').hidden, false, `${kind}: ${role} hidden`)
    }
    prepared.push(`${kind}:${affected.join('+')}`)
    const result = await checkpoint(kind, details)
    notificationWindow = `${kind}:${details.role}`
    return result
  }
  const capture = async (role, event) => {
    assert.equal(notificationWindow, `${event === 'opened' ? 'probe-stop' : 'probe-restore'}:${role}`)
    for (const member of role === 'via' ? ['via', 'jump'] : [role]) {
      assert.equal(await isOpsUiHostDetailsVisible(unit.driver, { hostId: unit.resumeState.hostIds[member], vaultId: unit.resumeState.vaultId }), true)
      assert.equal(unit.alert(member).dataset.alertStatus, event === 'opened' ? 'active' : 'resolved')
    }
    windows.push(`${event}:${role}`)
    notificationWindow = null
  }
  try {
    const state = await runOpsUiProbeJourney({
      ...unit, onOpened: role => capture(role, 'opened'), onResolved: role => capture(role, 'resolved'),
    })
    assert.deepEqual(prepared, ['probe-stop:direct', 'probe-restore:direct', 'probe-stop:via+jump', 'probe-restore:via+jump'])
    assert.deepEqual(windows, ['opened:direct', 'resolved:direct', 'opened:via', 'resolved:via'])
    assert.equal(notificationWindow, null)
    assert.equal(state.hosts.direct.closed, unit.alert('direct').dataset.jobId)
    assert.equal(state.hosts.via.closed, unit.alert('via').dataset.jobId)
  } finally { unit.close() }
})

test('a host collapsing after the failure trigger cannot be reopened while waiting for notification evidence', async t => {
  const unit = unitJourney(t, { disclosures: true })
  const checkpoint = unit.checkpoint, click = unit.driver.click
  let triggered = false, hooks = 0, lateClicks = 0
  unit.driver.click = async (...args) => {
    if (triggered) { lateClicks++; throw new Error('forbidden late UI write') }
    return click(...args)
  }
  unit.checkpoint = async (kind, details) => {
    const result = await checkpoint(kind, details)
    if (kind === 'probe-stop') {
      triggered = true
      const card = unit.hostCard(details.role)
      card.querySelector('[data-testid="host-ops-details-toggle"]').setAttribute('aria-expanded', 'false')
      card.querySelector('[data-testid="host-ops-details"]').hidden = true
    }
    return result
  }
  try {
    await assert.rejects(runOpsUiProbeJourney({ ...unit, onOpened: async () => { hooks++ } }), /unit timeout/)
    assert.equal(lateClicks, 0)
    assert.equal(hooks, 0)
    assert.deepEqual(unit.checkpoints, ['probe-stop:direct', 'probe-restore:direct'])
    assert(!unit.events.some(event => typeof event === 'string' && event.startsWith('request:')))
  } finally { unit.close() }
})

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
  unit.fixture.desktopDir = '/private/owned-desktop'
  unit.fixture.artifactDir = '/private/owned-desktop/artifacts'
  const viewport = document.createElement('div')
  viewport.dataset.testid = 'host-list-scroll-viewport'
  unit.driver.horizontalScrollState = async css => { assert.equal(css, '[data-testid="host-list-scroll-viewport"]'); return { width: 300, contentWidth: 300, left: 0 } }
  document.body.append(viewport)
  viewport.insertAdjacentHTML('beforebegin', '<div data-testid="host-list-scroll-controls"></div>')
  unit.driver.rect = async () => ({ x: 10, y: 20, width: 300, height: 40 })
  for (const role of roles) {
    const card = document.querySelector(`article[data-host-id="${unit.resumeState.hostIds[role]}"]`)
    card.dataset.hostName = unit.fixture.hosts[role].name
    viewport.append(card)
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

test('inventory refresh retains partial geometry and one safe real failure screenshot without retrying an intercepted selection', async t => {
  const unit = await inventoryUnit(t), screenshots = [], checkpoints = []
  try {
    let attempts = 0
    const rect = unit.driver.rect
    unit.driver.rect = async element => {
      if (element.dataset.testid === 'host-ops-open') throw Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'element not interactable' })
      return rect(element)
    }
    unit.driver.select = async () => { attempts++; throw Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'element click intercepted' }) }
    unit.checkpoint = async name => { checkpoints.push(name); return `${unit.fixture.artifactDir}/${name}.png` }
    unit.driver.screenshot = async filename => screenshots.push(filename)
    await assert.rejects(settleOpsUiProbeInventory(unit), error => error.code === 'element click intercepted')
    assert.equal(attempts, 1)
    assert.deepEqual(checkpoints, ['inventory-jump-refresh-failed'])
    assert.deepEqual(screenshots, ['/private/owned-desktop/artifacts/inventory-jump-refresh-failed.png'])
    const geometry = unit.events.filter(event => event.name === 'ops-ui-probe-inventory-refresh-geometry')
    assert.deepEqual(geometry.map(event => event.phase), ['before', 'failed'])
    assert(geometry.every(event => event.card.width > 0 && event.summary.height > 0 && event.viewport.width > 0 && event.controls.width > 0))
    assert(geometry.every(event => event.menu.available === false && event.menu.reason === 'element-not-interactable'))
    assert.equal(unit.events.at(-1).captured, true)
    assert(!JSON.stringify(unit.events).includes('SYNTHETIC'))
    assert(!unit.events.some(event => event.name?.includes('inventory-settled')))
  } finally { unit.close() }
})

test('unknown geometry failures never replace the genuine selection or leak native errors', async t => {
  const unit = await inventoryUnit(t)
  try {
    let attempts = 0
    unit.driver.rect = async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'transport failure' }) }
    unit.driver.select = async () => { attempts++; throw Object.assign(new Error('fixed actual interception'), { code: 'element click intercepted' }) }
    await assert.rejects(settleOpsUiProbeInventory(unit), error => error.code === 'element click intercepted')
    assert.equal(attempts, 1)
    assert(unit.events.some(event => event.name === 'ops-ui-probe-inventory-refresh-geometry-unavailable' && event.phase === 'before'))
    assert(!JSON.stringify(unit.events).includes('SYNTHETIC'))
  } finally { unit.close() }
})

test('failure pixels are refused for foreign cards, scope, dialogs, credentials and paths without hiding the original selection error', async t => {
  for (const problem of ['vault', 'host', 'duplicate', 'card-name', 'foreign-card', 'other-vault', 'other-host', 'other-summary-missing', 'other-summary-duplicate', 'scope', 'checkpoint-scope', 'checkpoint-vault', 'checkpoint-other-vault', 'checkpoint-dialog', 'checkpoint-password', 'dialog', 'password', 'textarea', 'path']) {
    const unit = await inventoryUnit(t), screenshots = []
    try {
      let attempts = 0
      unit.checkpoint = async name => {
        if (problem === 'checkpoint-scope') unit.resumeState.vaultId = 'foreign'
        if (problem === 'checkpoint-vault') unit.document.querySelector(`[data-host-id="${unit.probeState.hostIds.jump}"] [data-testid="host-ops-summary"]`).dataset.vaultId = 'foreign'
        if (problem === 'checkpoint-other-vault') unit.document.querySelector(`[data-host-id="${unit.probeState.hostIds.direct}"] [data-testid="host-ops-summary"]`).dataset.vaultId = 'foreign'
        if (problem === 'checkpoint-dialog') unit.document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
        if (problem === 'checkpoint-password') unit.document.body.insertAdjacentHTML('beforeend', '<input type="password" value="SYNTHETIC_PRIVATE_DETAIL">')
        return problem === 'path' ? `/outside/${name}.png` : `${unit.fixture.artifactDir}/${name}.png`
      }
      unit.driver.screenshot = async filename => screenshots.push(filename)
      unit.driver.select = async () => {
        attempts++
        const target = unit.document.querySelector(`[data-testid="host-card"][data-host-id="${unit.probeState.hostIds.jump}"]`)
        const summary = target.querySelector('[data-testid="host-ops-summary"]')
        if (problem === 'vault') summary.dataset.vaultId = 'foreign'
        if (problem === 'host') summary.dataset.hostId = 'foreign'
        if (problem === 'duplicate') target.after(target.cloneNode(true))
        if (problem === 'card-name') target.dataset.hostName = 'SYNTHETIC_PRIVATE_DETAIL'
        if (problem === 'foreign-card') unit.document.body.insertAdjacentHTML('beforeend', '<article data-testid="host-card" data-host-id="foreign" data-host-name="SYNTHETIC_PRIVATE_DETAIL"></article>')
        const other = unit.document.querySelector(`[data-host-id="${unit.probeState.hostIds.direct}"] [data-testid="host-ops-summary"]`)
        if (problem === 'other-vault') other.dataset.vaultId = 'foreign'
        if (problem === 'other-host') other.dataset.hostId = 'foreign'
        if (problem === 'other-summary-missing') other.remove()
        if (problem === 'other-summary-duplicate') other.after(other.cloneNode(true))
        if (problem === 'scope') unit.resumeState.vaultId = 'foreign'
        if (problem === 'dialog') unit.document.body.insertAdjacentHTML('beforeend', '<dialog open></dialog>')
        if (problem === 'password' || problem === 'textarea') {
          unit.document.body.insertAdjacentHTML('beforeend', problem === 'password' ? '<input type="password">' : '<textarea></textarea>')
          unit.document.querySelector(problem === 'password' ? 'input[type="password"]' : 'textarea').value = 'SYNTHETIC_PRIVATE_DETAIL'
        }
        throw Object.assign(new Error('fixed actual interception'), { code: 'element click intercepted' })
      }
      await assert.rejects(settleOpsUiProbeInventory(unit), error => error.code === 'element click intercepted')
      assert.equal(attempts, 1)
      assert.deepEqual(screenshots, [])
      assert.equal(unit.events.at(-1).captured, false)
      assert(!JSON.stringify(unit.events).includes('SYNTHETIC'))
    } finally { unit.close() }
  }
})

test('a DOM scope change during diagnostic reads still blocks the real refresh before selecting', async t => {
  const unit = await inventoryUnit(t)
  try {
    const rect = unit.driver.rect
    unit.driver.rect = async element => {
      if (element.dataset.testid === 'host-list-scroll-controls') unit.document.querySelector(`[data-host-id="${unit.resumeState.hostIds.jump}"] [data-testid="host-ops-summary"]`).dataset.vaultId = 'foreign'
      return rect(element)
    }
    await assert.rejects(settleOpsUiProbeInventory(unit), /inventory_refresh_scope_mismatch/)
    assert.deepEqual(unit.selected, [])
  } finally { unit.close() }
})

test('inventory refresh waits for a future whole UTC second and preserves the genuine second-precision sample', async t => {
  for (const mode of ['fresh', 'same-second-cache', 'scope-change', 'clock-timeout']) {
    const unit = await inventoryUnit(t)
    try {
      let now = Math.ceil(Date.now() / 1000) * 1000 + 125
      t.mock.method(Date, 'now', () => now)
      const oldSample = Math.floor(now / 1000) * 1000
      for (const row of unit.document.querySelectorAll(`[data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"][data-testid="host-probe-evaluation"]`)) row.dataset.sampledAt = String(oldSample)
      const select = unit.driver.select, boundaries = [], collected = []
      unit.driver.until = async (predicate, options) => {
        if (options?.timeoutMs === 2000) {
          const expected = (Math.floor(now / 1000) + 1) * 1000
          boundaries.push(expected)
          const before = unit.selected.length
          assert.equal(await predicate(), false)
          assert.equal(unit.selected.length, before)
          if (mode === 'clock-timeout') throw new Error('unit boundary timeout')
          now = expected - 1
          assert.equal(await predicate(), false)
          assert.equal(unit.selected.length, before)
          now = expected
          if (mode === 'scope-change') unit.resumeState.vaultId = 'foreign'
          assert.equal(await predicate(), true)
          assert.equal(unit.selected.length, before)
          return true
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          const value = await predicate()
          if (value) return value
          now += 200
        }
        throw new Error('unit sample timeout')
      }
      unit.driver.select = async (selector, value) => {
        const index = unit.selected.length
        assert(now >= boundaries[index])
        await select(selector, value)
        const menu = unit.document.querySelector(selector)
        const row = menu.closest('article').querySelector(`[data-rule-id="${OPS_UI_PROBE_RULE_IDS.inventory}"][data-testid="host-probe-evaluation"]`)
        row.dataset.sampledAt = String(mode === 'same-second-cache' ? oldSample : Math.floor(now / 1000) * 1000)
        collected.push(Number(row.dataset.sampledAt))
      }
      if (mode === 'fresh') {
        assert.equal((await settleOpsUiProbeInventory(unit)).passed, true)
        assert.deepEqual(unit.selected, ['jump', 'direct', 'via'])
        assert(boundaries.every(boundary => boundary > oldSample && boundary % 1000 === 0))
        assert.deepEqual(collected, boundaries)
        const records = unit.events.filter(event => typeof event === 'object' && event.name.includes('inventory-settled'))
        assert.deepEqual(records.map(record => record.originalSampleAt), collected)
      } else {
        await assert.rejects(settleOpsUiProbeInventory(unit), mode === 'same-second-cache' ? /unit sample timeout/ : mode === 'scope-change' ? /scope_changed/ : /unit boundary timeout/)
        assert.deepEqual(unit.selected, mode === 'same-second-cache' ? ['jump'] : [])
        assert.equal(boundaries.length, 1)
        assert(!unit.events.some(event => typeof event === 'object' && event.name.includes('inventory-settled')))
      }
    } finally { unit.close() }
  }
})

test('inventory drain waits read-only for a deferred target summary mount before selecting its real refresh', async t => {
  const unit = await inventoryUnit(t)
  try {
    const target = unit.document.querySelector(`[data-testid="host-card"][data-host-id="${unit.resumeState.hostIds.jump}"]`)
    const summary = target.querySelector('[data-testid="host-ops-summary"]')
    summary.remove()
    const findAll = unit.driver.findAll, until = unit.driver.until, bounds = []
    let signalRead, releaseRead
    const started = new Promise(resolve => { signalRead = resolve })
    const pending = new Promise(resolve => { releaseRead = resolve })
    let deferred = false
    unit.driver.findAll = async selector => {
      if (!deferred && selector.includes(unit.resumeState.hostIds.jump) && selector.endsWith('[data-testid="host-ops-summary"]')) {
        deferred = true; signalRead()
        await pending
        return []
      }
      return findAll(selector)
    }
    unit.driver.until = async (predicate, options) => { bounds.push(options?.timeoutMs); return until(predicate) }
    const settling = settleOpsUiProbeInventory(unit)
    await started
    assert.deepEqual(unit.selected, [])
    assert(!unit.events.some(event => typeof event === 'object' && event.name.includes('inventory-settled')))
    target.append(summary)
    releaseRead()
    assert.deepEqual(await settling, { passed: true, profiles: 3, freshObservations: 3 })
    assert.deepEqual(unit.selected, ['jump', 'direct', 'via'])
    assert.equal(bounds.filter(value => value === 60_000).length, 3)
  } finally { unit.close() }
})

test('inventory drain permits a hidden target summary to become visible without refreshing early', async t => {
  const unit = await inventoryUnit(t)
  try {
    const summary = unit.document.querySelector(`[data-host-id="${unit.resumeState.hostIds.jump}"] [data-testid="host-ops-summary"]`)
    summary.hidden = true
    const displayed = unit.driver.isDisplayed
    let reads = 0
    unit.driver.isDisplayed = async element => {
      if (element === summary && ++reads === 2) {
        assert.deepEqual(unit.selected, [])
        summary.hidden = false
      }
      return displayed(element)
    }
    assert.equal((await settleOpsUiProbeInventory(unit)).passed, true)
    assert(reads >= 2)
    assert.deepEqual(unit.selected, ['jump', 'direct', 'via'])
  } finally { unit.close() }
})

test('inventory drain immediately refuses a displayed foreign summary or duplicate target before any menu refresh', async t => {
  for (const problem of ['vault', 'host', 'summary-duplicate', 'card-duplicate']) {
    const unit = await inventoryUnit(t)
    try {
      const target = unit.document.querySelector(`[data-testid="host-card"][data-host-id="${unit.resumeState.hostIds.jump}"]`)
      const summary = target.querySelector('[data-testid="host-ops-summary"]')
      if (problem === 'vault') summary.dataset.vaultId = 'foreign'
      if (problem === 'host') summary.dataset.hostId = unit.resumeState.hostIds.via
      if (problem === 'summary-duplicate') target.append(summary.cloneNode(true))
      if (problem === 'card-duplicate') target.after(target.cloneNode(true))
      const until = unit.driver.until
      let readinessPolls = 0
      unit.driver.until = async (predicate, options) => until(async () => {
        assert.equal(options?.timeoutMs, 60_000)
        readinessPolls++
        return predicate()
      })
      await assert.rejects(settleOpsUiProbeInventory(unit), /inventory_refresh_scope_mismatch/)
      assert.equal(readinessPolls, 1)
      assert.deepEqual(unit.selected, [])
      assert(!unit.events.some(event => typeof event === 'object' && event.name.includes('inventory-settled')))
    } finally { unit.close() }
  }
})

test('missing or never-displayed target summaries time out within the readiness bound without a refresh', async t => {
  for (const problem of ['missing', 'hidden']) {
    const unit = await inventoryUnit(t)
    try {
      const summary = unit.document.querySelector(`[data-host-id="${unit.resumeState.hostIds.jump}"] [data-testid="host-ops-summary"]`)
      if (problem === 'missing') summary.remove()
      else summary.hidden = true
      const until = unit.driver.until
      const bounds = []
      unit.driver.until = async (predicate, options) => { bounds.push(options?.timeoutMs); return until(predicate) }
      await assert.rejects(settleOpsUiProbeInventory(unit), /unit timeout/)
      assert.deepEqual(bounds, [60_000])
      assert.deepEqual(unit.selected, [])
      assert(!unit.events.some(event => typeof event === 'object' && event.name.includes('inventory-settled')))
    } finally { unit.close() }
  }
})

test('a Vault change during summary readiness fails before any host refresh', async t => {
  const unit = await inventoryUnit(t)
  try {
    const findAll = unit.driver.findAll
    unit.driver.findAll = async selector => {
      if (selector.endsWith('[data-testid="host-ops-summary"]')) {
        unit.resumeState.vaultId = 'foreign'
        return []
      }
      return findAll(selector)
    }
    await assert.rejects(settleOpsUiProbeInventory(unit), /scope_changed/)
    assert.deepEqual(unit.selected, [])
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
