import { describe, expect, it } from 'vitest'
import { isRemoteOperationOutcomeUnknown, remoteOperationStatus } from './operation-verification'

describe('native remote outcome semantics', () => {
  it.each(['target_timeout', 'target_disconnected', 'output_limit', 'remote_state_unknown', 'post_state_unverified'])('preserves uncertain remote outcome %s', (errorCode) => {
    expect(remoteOperationStatus({ exitCode: -1, errorCode })).toBe('unknown')
  })
  it('does not infer uncertain execution from a known pre-exec timeout or an ordinary command failure', () => {
    expect(isRemoteOperationOutcomeUnknown({ exitCode: -1, errorCode: 'target_timeout_before_execution', errorType: 'network' })).toBe(false)
    expect(remoteOperationStatus({ exitCode: -1, errorCode: 'target_timeout_before_execution' })).toBe('failed')
    expect(remoteOperationStatus({ exitCode: 1, errorCode: 'remote_command_failed', errorType: 'command' })).toBe('failed')
    expect(remoteOperationStatus({ exitCode: 1, errorCode: 'jump_auth_failed', errorType: 'auth' })).toBe('failed')
  })
  it('honors an explicitly unknown exit state even when an exit code looks successful', () => {
    expect(remoteOperationStatus({ exitCode: 0, errorType: 'unknown' })).toBe('unknown')
    expect(remoteOperationStatus({ exitCode: 0 })).toBe('completed')
  })
})
