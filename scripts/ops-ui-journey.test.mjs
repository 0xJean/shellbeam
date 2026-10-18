import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyOpsUiConnectionFailure } from './ops-ui-journey.mjs'

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
