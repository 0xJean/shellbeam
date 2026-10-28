import { parseHostKeyError } from '@/components/host-key-confirm-dialog'

/** Remote connect stages shown by the connection placeholder, in display order. */
export type RemoteConnectStage = 'resolve_host' | 'open_tcp' | 'verify_host' | 'secure_session' | 'authenticate' | 'prepare_workspace'

export interface ConnectFailure {
  /** The step that failed. */
  stage: RemoteConnectStage
  /** Steps the backend certainly finished before the failure. */
  completed: RemoteConnectStage[]
  /** Key into `connectionStatesCopy[locale].failNote`. */
  reason: string
  viaJump: boolean
  hostKeyMismatch: boolean
}

// The order the SSH backend actually runs these steps in (handshake precedes host key checks).
const BACKEND_ORDER: RemoteConnectStage[] = ['resolve_host', 'open_tcp', 'secure_session', 'verify_host', 'authenticate', 'prepare_workspace']

const OPERATION_STAGE: Record<string, RemoteConnectStage> = {
  unreachable: 'open_tcp',
  timeout: 'open_tcp',
  tunnel_failed: 'open_tcp',
  session_failed: 'secure_session',
  handshake_failed: 'secure_session',
  host_key_failed: 'verify_host',
  auth_failed: 'authenticate',
}

function failure(stage: RemoteConnectStage, reason: string, viaJump: boolean, hostKeyMismatch = false): ConnectFailure {
  // An unreachable host may have failed name resolution, so nothing before it is known to be done.
  const completed = reason === 'unreachable' ? [] : BACKEND_ORDER.slice(0, BACKEND_ORDER.indexOf(stage))
  return { stage, completed, reason, viaJump, hostKeyMismatch }
}

function routeStage(message: string): string | undefined {
  const start = message.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed = JSON.parse(message.slice(start)) as { routeStage?: unknown }
    return typeof parsed.routeStage === 'string' ? parsed.routeStage : undefined
  } catch {
    return undefined
  }
}

/**
 * Derives which connect step failed from the error the SSH backend returned
 * (`SSH <target|jump> <operation>`, host key payloads, channel errors).
 * Returns null when the error does not identify a step.
 */
export function parseConnectFailure(message: string | undefined): ConnectFailure | null {
  if (!message) return null
  const hostKey = parseHostKeyError(message)
  if (hostKey) {
    const mismatch = hostKey.code === 'host_key_mismatch'
    return failure('verify_host', mismatch ? 'host_key_mismatch' : 'host_key_failed', routeStage(message) === 'jump', mismatch)
  }
  if (message.includes('host key not accepted')) return failure('verify_host', 'host_key_rejected', false)
  const ssh = message.match(/\bSSH (target|jump) (unreachable|timeout|tunnel_failed|session_failed|handshake_failed|host_key_failed|auth_failed)\b/)
    ?? message.match(/\b(target|jump)_(unreachable|timeout|tunnel_failed|session_failed|handshake_failed|host_key_failed|auth_failed)\b/)
  if (ssh) return failure(OPERATION_STAGE[ssh[2]], ssh[2], ssh[1] === 'jump' || ssh[2] === 'tunnel_failed')
  if (/\binteractive (open channel|request PTY|start shell) failed\b/.test(message)) return failure('prepare_workspace', 'workspace_failed', false)
  return null
}
