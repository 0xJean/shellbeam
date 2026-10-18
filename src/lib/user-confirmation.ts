import type { HostProfile } from './hosts'

export interface UserConfirmationRequest {
  message: string
  /** Exact text required for destructive file operations. */
  token?: string
  /** The initiating Vault, which may differ from a deletion target. */
  vaultId?: string
  host?: HostProfile
  hosts?: readonly HostProfile[]
  risk?: 'read-only' | 'low' | 'high'
  isCurrent?: () => boolean
}

export type ConfirmationInterruption = 'scope-changed' | 'unavailable' | 'busy'
export interface UserConfirmationDecision {
  accepted: boolean
  reason: 'accepted' | 'rejected' | ConfirmationInterruption
  /** Remains valid after the dialog closes, until the actual operation sends. */
  isCurrent?: () => boolean
}
type Presenter = (request: UserConfirmationRequest) => Promise<boolean | ConfirmationInterruption | UserConfirmationDecision>
let presenter: Presenter | undefined

/** The application owns one visible confirmation surface. Embedded consumers
 * without that surface can still use the platform's native dialog below. */
export function registerUserConfirmationPresenter(next: Presenter) {
  if (presenter) throw new Error('CONFIRMATION_PRESENTER_ALREADY_REGISTERED')
  presenter = next
  return () => { if (presenter === next) presenter = undefined }
}

/** Tauri's dialog plugin replaces window.confirm with an async function.
 * Never treat its Promise, a truthy object, or a rejected call as consent. */
export async function requestUserDecision(request: UserConfirmationRequest): Promise<UserConfirmationDecision> {
  try {
    if (request.isCurrent?.() === false) return { accepted: false, reason: 'scope-changed' }
    if (!request.message.trim()) return { accepted: false, reason: 'unavailable' }
    let answer: unknown
    if (presenter) {
      answer = await presenter(request)
      if (answer === 'scope-changed' || answer === 'unavailable' || answer === 'busy') return { accepted: false, reason: answer }
      if (answer && typeof answer === 'object' && 'accepted' in answer && 'reason' in answer) {
        const decision = answer as UserConfirmationDecision
        if ((decision.accepted === true && decision.reason === 'accepted') || (decision.accepted === false && ['rejected', 'scope-changed', 'unavailable', 'busy'].includes(decision.reason))) return decision
        return { accepted: false, reason: 'unavailable' }
      }
    } else if (typeof window === 'undefined') return { accepted: false, reason: 'unavailable' }
    else if (request.token !== undefined) answer = (await window.prompt(request.message)) === request.token
    else answer = await window.confirm(request.message)
    // Return the actual decision. The caller must separately check its scope
    // before execution so accepted-but-invalidated consent is audited honestly.
    return { accepted: answer === true, reason: answer === true ? 'accepted' : answer === false ? 'rejected' : 'unavailable' }
  } catch {
    return { accepted: false, reason: 'unavailable' }
  }
}

export async function confirmUserAction(request: UserConfirmationRequest): Promise<boolean> {
  const decision = await requestUserDecision(request)
  try { return decision.accepted && decision.isCurrent?.() !== false } catch { return false }
}
