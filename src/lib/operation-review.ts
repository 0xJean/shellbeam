import type { HostProfile } from './hosts'
import { getHostIdentity } from './host-identity'
import { t as translate } from './i18n'

function oneLine(value: string) {
  return [...value].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').trim()
}
function endpoint(username: string, address: string, port: number) {
  return `${oneLine(username)}@${address.includes(':') ? `[${oneLine(address)}]` : oneLine(address)}:${port}`
}

/** A shared confirmation summary with no workflow-specific warnings. Reference
 * routes stay unresolved until Vault resolves them; copied legacy fields must
 * not pretend to describe the referenced jump host. */
export function hostOperationReview(host: HostProfile, command: string, t: typeof translate = translate) {
  const identity = getHostIdentity(host)
  const jump = identity.jump
  const route = !jump ? t('workspace.operation.route.direct')
    : jump.address ? `ProxyJump ${endpoint(jump.username ?? 'root', jump.address, jump.port ?? 22)}`
      : t('workspace.operation.route.reference', { id: jump.hostId ?? 'unknown' })
  return t('workspace.operation.hostReview', { host: `${oneLine(host.name)} · ${endpoint(identity.username, identity.address, identity.port)}`, route, command })
}
