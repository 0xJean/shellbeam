import { hostConnections, type HostProfile } from './hosts'

/** Search the current referenced route. Copied fields only describe legacy
 * routes and must not resurrect an edited or deleted referenced jump host. */
export function matchesHostSearch(host: HostProfile, query: string, hosts: readonly HostProfile[]) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const jumpProfile = host.jumpHostId
    ? hosts.find((candidate) => candidate.id === host.jumpHostId && candidate.vaultId === host.vaultId)
    : undefined
  const jumpValues = host.jumpHostId
    ? [jumpProfile?.name, jumpProfile?.address, jumpProfile?.username, jumpProfile?.port]
    : [host.jumpHost, host.jumpUser, host.jumpPort]
  return [host.name, host.address, host.username, host.group, ...(host.tags ?? []), ...jumpValues, ...hostConnections(host).flatMap(c => [c.label, c.address, c.username])]
    .some((value) => value !== undefined && String(value).toLowerCase().includes(normalized))
}
