import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from './hosts'

const runSshCommand = vi.fn()

vi.mock('./sessions', () => ({
  runSshCommand: (payload: unknown) => runSshCommand(payload),
}))

import { runWorkspaceRemoteCommand } from './workspace-remote'

const host: HostProfile = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 2222,
  username: 'deploy',
  group: 'Production',
  authType: 'privateKey',
  tags: [],
  jumpHost: 'bastion.example.com',
  jumpPort: 2200,
  jumpUser: 'bastion',
  createdAt: 0,
  updatedAt: 0,
}

describe('workspace remote transport', () => {
  beforeEach(() => {
    runSshCommand.mockReset()
    runSshCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, durationMs: 10 })
  })

  it('passes host ProxyJump settings to the SSH command transport', async () => {
    await runWorkspaceRemoteCommand({
      host,
      resolveAuthSecret: async () => 'PRIVATE KEY',
      command: 'uname -a',
    })

    expect(runSshCommand).toHaveBeenCalledWith({
      hostId: 'host-1',
      host: '10.0.0.15',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      password: undefined,
      privateKey: 'PRIVATE KEY',
      jumpHost: 'bastion.example.com',
      jumpPort: 2200,
      jumpUser: 'bastion',
      command: 'uname -a',
    })
  })
  it('resolves saved-host credentials only inside the selected native vault', async () => {
    const resolve = vi.fn(async () => 'must-not-cross-the-bridge')
    await runWorkspaceRemoteCommand({ host, vaultId: 'team', resolveAuthSecret: resolve, command: 'uname -a' })
    expect(resolve).not.toHaveBeenCalled()
    expect(runSshCommand).toHaveBeenCalledWith(expect.objectContaining({ hostId: host.id, vaultId: 'team', command: 'uname -a' }))
    expect(JSON.stringify(runSshCommand.mock.calls)).not.toContain('must-not-cross-the-bridge')
  })

})
