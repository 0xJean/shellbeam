import { collectionCommandTimeoutMs } from './collection-limits'
import type { AuthType } from '@/lib/ssh'
import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'
import type { HostIdentity } from './host-identity'

export type CommandRunStatus = 'success' | 'failed'

export type CommandErrorType =
  | 'network'
  | 'auth'
  | 'command'
  | 'validation'
  | 'internal'
  | 'unknown'

export interface CommandRunRequest {
  vaultId?: string
  hostId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  command: string
  /** May shorten the native command deadline; cannot raise its 90s ceiling. */
  timeoutMs?: number
}

export interface VerifiedHostKey {
  stage: 'jump' | 'target'
  host: string
  port: number
  fingerprintSha256: string
  keyType: string
}

export interface CommandRunResult {
  hostIdentity?: HostIdentity
  verifiedHostKeys?: VerifiedHostKey[]
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  errorType?: CommandErrorType
  errorCode?: string
  errorSource?: string
  retryable?: boolean
}

export interface ConnectionTestResult {
  connected: boolean
  durationMs: number
  errorType?: CommandErrorType
  message?: string
  errorCode?: string
  errorSource?: string
  retryable?: boolean
}

export interface CommandRunView {
  status: CommandRunStatus
  output: string
  result: CommandRunResult
}

export function mapErrorType(error: unknown): CommandErrorType {
  const message = String(error).toLowerCase()
  if (message.includes('auth')) return 'auth'
  if (message.includes('tcp connect') || message.includes('handshake') || message.includes('timeout')) return 'network'
  if (message.includes('execute command')) return 'command'
  if (message.includes('required')) return 'validation'
  if (message.includes('internal')) return 'internal'
  return 'unknown'
}

export function buildCommandOutput(result: CommandRunResult): string {
  const sections: string[] = []
  if (result.stdout) sections.push(result.stdout)
  if (result.stderr) sections.push(`[stderr]\n${result.stderr}`)
  if (result.errorCode || result.errorSource || result.retryable !== undefined) {
    sections.push(
      `[error meta] code=${result.errorCode ?? '-'} source=${result.errorSource ?? '-'} retryable=${result.retryable ?? false}`,
    )
  }
  sections.push(`[exit code: ${result.exitCode}]`)
  return sections.join('\n\n')
}

export async function testSshConnection(payload: CommandRunRequest) {
  try {
    return await invoke<ConnectionTestResult>('test_ssh_connection', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function runSshCommand(payload: CommandRunRequest) {
  try {
    return await invoke<CommandRunResult>('run_ssh_command', { payload: payload.timeoutMs === undefined ? payload : { ...payload, timeoutMs: collectionCommandTimeoutMs(payload.timeoutMs) } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
