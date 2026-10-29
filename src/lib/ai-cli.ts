import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { AICliBackend, AICliProfile, AIStreamCallbacks } from './ai'
import type { AIHistoryItem } from './ai-conversation'
import { t } from './i18n'

export interface AICliStatus { version: string; executable: string }
type CliEvent = { type: 'token'; text: string } | { type: 'model'; name: string } | { type: 'done' } | { type: 'error'; code: string }
const ERROR_CODES = new Set(['desktop_only', 'not_found', 'unsupported', 'invalid_request', 'busy', 'timeout', 'failed', 'invalid_output', 'tool_use', 'cancelled'])
export function cliErrorMessage(error: unknown): string {
  const code = typeof error === 'string' && ERROR_CODES.has(error) ? error : 'failed'
  return t(`ai.cli.error.${code}`)
}
export async function checkAICli(backend: AICliBackend, executable: string): Promise<AICliStatus> {
  if (!isTauri()) throw 'desktop_only'
  return invoke('ai_cli_status', { backend, executable })
}

/** Per-invocation channel; no global events, credentials, or terminal output in logs. */
export async function streamCliCommand(
  backend: AICliBackend, profile: AICliProfile | undefined, prompt: string, context: string,
  callbacks: AIStreamCallbacks, signal?: AbortSignal, history: AIHistoryItem[] = [], host = '',
): Promise<void> {
  if (signal?.aborted) return
  if (!isTauri()) { callbacks.onError(cliErrorMessage('desktop_only')); return }
  const requestId = crypto.randomUUID()
  let started = false
  let settled = false
  let finish!: () => void
  const completion = new Promise<void>((resolve) => { finish = resolve })
  const cancelNative = () => { void invoke('ai_cli_cancel', { requestId }).catch(() => {}) }
  const abort = () => {
    if (settled) return
    settled = true
    if (started) cancelNative()
    finish()
  }
  const channel = new Channel<CliEvent>()
  channel.onmessage = (event) => {
    if (settled || signal?.aborted) return
    if (event.type === 'token') callbacks.onToken(event.text)
    else if (event.type === 'model') callbacks.onModel?.(event.name)
    else {
      settled = true
      if (event.type === 'done') callbacks.onDone()
      else callbacks.onError(cliErrorMessage(event.code))
      finish()
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await invoke('ai_cli_start', {
      request: { requestId, backend, executable: profile?.executable ?? '', model: profile?.model ?? '', prompt, context, history, host },
      channel,
    })
    started = true
    // Abort can happen before the native registration acknowledgement arrives.
    if (signal?.aborted) { cancelNative(); abort() }
    await completion
  } catch (error) {
    if (!settled && !signal?.aborted) callbacks.onError(cliErrorMessage(error))
  } finally {
    settled = true
    signal?.removeEventListener('abort', abort)
    channel.onmessage = () => {}
  }
}
