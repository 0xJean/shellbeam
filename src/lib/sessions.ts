import type { AuthType } from '@/lib/ssh'
import { invoke } from '@tauri-apps/api/core'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

export type CommandRunStatus = 'success' | 'failed'

export type CommandErrorType =
  | 'network'
  | 'auth'
  | 'command'
  | 'validation'
  | 'internal'
  | 'unknown'

export interface CommandRunRequest {
  hostId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  command: string
}

export interface CommandRunResult {
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
    return await invoke<CommandRunResult>('run_ssh_command', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}
