import type { CommandRunResult } from './sessions'

type RemoteOperationOutcome = Pick<CommandRunResult, 'exitCode' | 'errorCode' | 'errorType'>
const UNKNOWN_OUTCOME_CODES = new Set(['target_timeout', 'target_disconnected', 'output_limit', 'remote_state_unknown', 'post_state_unverified'])

/** Native execution failures are returned values, not necessarily exceptions.
 * A pre-exec deadline explicitly proves no command was sent; a deadline after
 * exec, signal/unknown exit, or truncated output cannot prove the remote state. */
export function isRemoteOperationOutcomeUnknown(result: RemoteOperationOutcome) {
  if (result.errorCode === 'target_timeout_before_execution') return false
  return UNKNOWN_OUTCOME_CODES.has(result.errorCode ?? '') || result.errorType === 'unknown'
}

export function remoteOperationStatus(result: RemoteOperationOutcome): 'completed' | 'failed' | 'unknown' {
  if (result.errorCode === 'target_timeout_before_execution') return 'failed'
  return isRemoteOperationOutcomeUnknown(result) ? 'unknown' : result.exitCode === 0 ? 'completed' : 'failed'
}

export interface OperationVerification {
  status: 'verified' | 'unknown' | 'not-run'
  summary: string
}

export interface VerifiedOperationResult extends CommandRunResult {
  verification: OperationVerification
}

/** Keep the original command result visible, while the same canonical job
 * remains unknown if its desired post-state cannot be observed. */
export function verifiedOperationAudit(result: VerifiedOperationResult) {
  const { verification } = result
  return {
    ...result,
    ...(verification.status === 'unknown' ? {
      exitCode: -1,
      errorCode: result.errorCode && result.errorCode !== 'target_timeout_before_execution' ? result.errorCode : 'remote_state_unknown',
      errorType: 'unknown' as const,
      errorSummary: verification.summary,
    } : {}),
    resultSummary: `exit=${result.exitCode}; verification=${verification.status}; ${verification.summary}`,
  }
}
