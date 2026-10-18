import type { HostProfile } from './hosts'

export type ObservationHost = Pick<HostProfile, 'id' | 'address' | 'port' | 'username' | 'vaultId'>
/** Versioned keys separate identical host IDs in different Vaults. Legacy
 * unscoped entries remain inaccessible to a scoped host and are never claimed. */
export function getHostObservationKey(host: ObservationHost) {
  const hostId = host.id || `${host.username}@${host.address}:${host.port || 22}`
  return host.vaultId ? `vault:${JSON.stringify([host.vaultId, hostId])}` : hostId
}
export function observationVaultIds(hosts: readonly Pick<HostProfile, 'vaultId'>[]) {
  return [...new Set(hosts.flatMap((host) => host.vaultId ? [host.vaultId] : []))]
}

/** Never relabel an old Vault's host object as a host in the active Vault. */
export function scopeObservationHosts(hosts: readonly HostProfile[], vaultId?: string): HostProfile[] {
  if (!vaultId) return [...hosts]
  if (hosts.some((host) => host.vaultId && host.vaultId !== vaultId)) throw new Error('HOST_VAULT_SCOPE_MISMATCH')
  return hosts.map((host) => host.vaultId ? host : { ...host, vaultId })
}
