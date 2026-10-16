import type { HostProfile } from '@/lib/hosts'
import { runSshCommand } from '@/lib/sessions'

export function resolveWorkspaceHost(
  hosts: HostProfile[],
  options: { selectedHostId?: string | null; hostAddress?: string | null },
) {
  const { selectedHostId = null, hostAddress = null } = options

  if (selectedHostId) {
    return hosts.find((entry) => entry.id === selectedHostId) ?? null
  }

  if (hostAddress) {
    return hosts.find((entry) => entry.address === hostAddress) ?? null
  }

  return null
}

export async function runWorkspaceRemoteCommand(options: {
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  command: string
}) {
  const { host, resolveAuthSecret, command } = options
  const secret = await resolveAuthSecret(host)

  return runSshCommand({
    hostId: host.id,
    host: host.address,
    port: host.port || 22,
    username: host.username || 'root',
    authType: host.authType,
    password: host.authType === 'password' ? secret : undefined,
    privateKey: host.authType === 'privateKey' ? secret : undefined,
    jumpHost: host.jumpHost,
    jumpPort: host.jumpPort,
    jumpUser: host.jumpUser,
    command,
  })
}
