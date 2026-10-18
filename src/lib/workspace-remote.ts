import { runConfirmedOperation } from './operation-job'
import type { HostProfile } from '@/lib/hosts'
import { runSshCommand, type CommandRunResult } from '@/lib/sessions'

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
  vaultId?: string
  audit?: { action: string; target: string }
}): Promise<CommandRunResult> {
  const { host, resolveAuthSecret, command } = options
  if (options.vaultId && host.vaultId && options.vaultId !== host.vaultId) {
    throw new Error('WORKSPACE_VAULT_SCOPE_MISMATCH')
  }
  const vaultId = options.vaultId ?? host.vaultId
  if (options.audit && host.id && vaultId) {
    const execution = await runConfirmedOperation({
      host, vaultId, action: options.audit.action, target: options.audit.target,
      risk: 'read-only', confirmMessage: '',
      execute: () => runWorkspaceRemoteCommand({ ...options, audit: undefined }),
      getResult: (value) => value,
    })
    if (!execution) throw new Error('Read operation could not be journaled')
    return execution.value
  }
  if (host.id && vaultId) {
    return runSshCommand({ vaultId, hostId: host.id, host: '', port: 22, username: '', authType: host.authType, command })
  }
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
