import type { HostProfile } from './hosts'
import type { VerifiedHostKey } from './sessions'

export interface JumpHostIdentity {
  hostId?: string
  /** An unresolved reference stays partial rather than reusing copied fields. */
  address?: string
  port?: number
  username?: string
}
export interface HostIdentity {
  hostId: string
  address: string
  port: number
  username: string
  jump?: JumpHostIdentity
  verifiedHostKeys?: VerifiedHostKey[]
}

/** Prefer the referenced profile. Native SSH results supply the resolved route
 * after verification; non-SSH providers can pass current profiles explicitly. */
export function getHostIdentity(host: HostProfile, profiles: readonly HostProfile[] = []): HostIdentity {
  const referenced = host.jumpHostId ? profiles.find((profile) => profile.id === host.jumpHostId) : undefined
  const jump = host.jumpHostId
    ? { hostId: host.jumpHostId, ...(referenced ? { address: referenced.address, port: referenced.port || 22, username: referenced.username || 'root' } : {}) }
    : host.jumpHost?.trim() ? { address: host.jumpHost.trim(), port: host.jumpPort || 22, username: host.jumpUser?.trim() || host.username || 'root' } : undefined
  return { hostId: host.id || `${host.username}@${host.address}:${host.port || 22}`, address: host.address, port: host.port || 22, username: host.username || 'root', ...(jump ? { jump } : {}) }
}
