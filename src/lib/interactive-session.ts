import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { toInvokeErrorMessage } from '@/lib/invoke-error'

import type { AuthType } from '@/lib/ssh'

const INTERACTIVE_OUTPUT_EVENT = 'shellbeam://interactive-output'
const INTERACTIVE_STATUS_EVENT = 'shellbeam://interactive-status'
const INTERACTIVE_PROGRESS_EVENT = 'shellbeam://interactive-progress'

export interface InteractiveSessionCreateRequest {
  hostId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  cols?: number
  rows?: number
  keepAliveIntervalSecs?: number
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
  acceptHostKey?: boolean
}

export interface InteractiveSessionInfo {
  sessionId: string
  hostId?: string
  host: string
  username: string
  createdAt: number
  lastActiveAt: number
  status: string
}

export interface InteractiveOutputChunk {
  seq: number
  stream: 'stdout' | 'stderr' | string
  data: string
  timestamp: number
}

export interface InteractivePollResponse {
  sessionId: string
  status: string
  nextSeq: number
  chunks: InteractiveOutputChunk[]
}

export interface InteractiveOutputEventPayload {
  sessionId: string
  chunks: InteractiveOutputChunk[]
}

export interface InteractiveStatusEventPayload {
  sessionId: string
  status: string
}

export interface InteractiveProgressEventPayload {
  sessionId: string
  stage: string
}

export async function createInteractiveSession(payload: InteractiveSessionCreateRequest) {
  try {
    return await invoke<InteractiveSessionInfo>('create_interactive_session', { payload })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function sendInteractiveInput(sessionId: string, input: string) {
  try {
    return await invoke<void>('send_interactive_input', { payload: { sessionId, input } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function pollInteractiveOutput(sessionId: string, afterSeq = 0) {
  try {
    return await invoke<InteractivePollResponse>('poll_interactive_output', {
      payload: { sessionId, afterSeq },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function listInteractiveSessions() {
  try {
    return await invoke<InteractiveSessionInfo[]>('list_interactive_sessions')
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function closeInteractiveSession(sessionId: string) {
  try {
    return await invoke<void>('close_interactive_session', { payload: { sessionId } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function resizeInteractiveTerminal(sessionId: string, cols: number, rows: number) {
  try {
    return await invoke<void>('resize_interactive_terminal', { payload: { sessionId, cols, rows } })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function createLocalTerminal(cols?: number, rows?: number) {
  try {
    return await invoke<InteractiveSessionInfo>('create_local_terminal', {
      payload: { cols: cols ?? 80, rows: rows ?? 24 },
    })
  } catch (error) {
    throw new Error(toInvokeErrorMessage(error))
  }
}

export async function listenToInteractiveOutputEvents(
  handler: (payload: InteractiveOutputEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveOutputEventPayload>(INTERACTIVE_OUTPUT_EVENT, (event) => {
    handler(event.payload)
  })
}

export async function listenToInteractiveStatusEvents(
  handler: (payload: InteractiveStatusEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveStatusEventPayload>(INTERACTIVE_STATUS_EVENT, (event) => {
    handler(event.payload)
  })
}

export async function listenToInteractiveProgressEvents(
  handler: (payload: InteractiveProgressEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveProgressEventPayload>(INTERACTIVE_PROGRESS_EVENT, (event) => {
    handler(event.payload)
  })
}
