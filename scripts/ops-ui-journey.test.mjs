import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyOpsUiConnectionFailure, initializeOpsUiVault, OPS_UI_SELECTORS } from './ops-ui-journey.mjs'

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
