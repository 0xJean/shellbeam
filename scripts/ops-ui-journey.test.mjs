import assert from 'node:assert/strict'
import test from 'node:test'
import { activateOpsUiRules, classifyOpsUiConnectionFailure, initializeOpsUiVault, OPS_UI_SELECTORS, resumeOpsUiJourney, runOpsUiIncidents } from './ops-ui-journey.mjs'

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

function journeyContext() {
  const fixture = { schemaVersion: 1, hosts: Object.fromEntries(['jump', 'direct', 'via'].map((role, index) => [role, {
    name: `isolated ${role}`, address: '127.0.0.1', port: 22_001 + index, user: 'root', privateKeyPath: `/private/${role}.pem`, expectedFingerprint: 'SHA256:public-test-fingerprint',
    ...(role === 'jump' ? {} : { serviceUnit: `00-shellbeam-ui-unit-${role}.service` }),
  }])) }
  const state = { hostIds: { jump: 'jump-host', direct: 'direct-host', via: 'via-host' }, ruleNames: { direct: 'direct-rule', via: 'via-rule' }, vaultId: 'vault', jobs: {} }
  Object.defineProperty(state, 'vaultPassword', { value: 'PRIVATE_TEST_VALUE', enumerable: false })
  return { fixture, state }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function ruleActivationDriver() {
  let selected = null
  const events = []
  return {
    events,
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
  const reads = []
  return {
    reads,
    async waitFor() {}, async fill() {}, async click() {},
    async findAll() { return [] },
    async select(css) { selected = css.includes('direct-host') ? 'direct' : 'via'; index = 0 },
    async attr(css, name) {
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
  let role = 'direct'
  let confirmed = false
  const observed = []
  const diagnosed = []
  const driver = {
    async waitFor(css) { if (css.includes('data-alert-status="resolved"')) { assert(css.includes(`data-transport="${role === 'via' ? 'proxy-jump' : 'direct'}"`)); observed.push(role) } },
    async select(css) { role = css.includes('direct-host') ? 'direct' : 'via' },
    async click(css) { if (css.includes('host-services-open')) { role = css.includes('direct-host') ? 'direct' : 'via'; confirmed = false; diagnosed.push(role) } },
    async attr(css, name) {
      if (name === 'data-open-count') return '1'
      if (name === 'data-host-health') return 'online'
      if (name === 'data-vault-id') return state.vaultId
      if (name === 'data-active-state') return 'failed'
      if (name === 'disabled') return null
      if (name === 'data-job-id') return `${css.includes('data-status="cancelled"') ? 'cancelled' : 'completed'}-${role}`
      throw new Error('unexpected read')
    },
    async text() { return confirmed ? 'status=completed' : `${fixture.hosts[role].serviceUnit}\nActive: failed (Result: exit-code)` },
    async until(fn) { const result = await fn(); assert(result); return result },
    async alertText() { return `Restart ${fixture.hosts[role].serviceUnit}` },
    async acceptAlert() { confirmed = true }, async dismissAlert() {},
  }
  const first = deferred()
  const release = deferred()
  const recovered = []
  const work = runOpsUiIncidents({ driver, fixture, resumeState: state, record: async () => {}, checkpoint: async () => ({}), onRecovered: async current => {
    assert(observed.includes(current))
    recovered.push(current)
    if (current === 'direct') { first.resolve(); await release.promise }
  } })
  await first.promise
  assert.deepEqual(recovered, ['direct'])
  assert.equal(diagnosed.includes('via'), false)
  release.resolve()
  assert.equal((await work).passed, true)
  assert.deepEqual(recovered, ['direct', 'via'])
})
