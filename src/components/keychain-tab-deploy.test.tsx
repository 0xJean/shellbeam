import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'

const mocks = vi.hoisted(() => ({
  vaultGetSecret: vi.fn(),
  listHosts: vi.fn(),
  runConfirmedOperation: vi.fn(),
  runWorkspaceRemoteCommand: vi.fn(),
}))
vi.mock('@/lib/vault', () => ({ vaultGetSecret: mocks.vaultGetSecret, vaultSetSecret: vi.fn() }))
vi.mock('@/lib/hosts', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/hosts')>()), listHosts: mocks.listHosts }))
vi.mock('@/lib/operation-job', () => ({ runConfirmedOperation: mocks.runConfirmedOperation }))
vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: mocks.runWorkspaceRemoteCommand }))

import { KeychainTab } from './keychain-tab'

const publicLine = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGakgi4tyu+8n90xMy1obL1HlJ6AD0VDPDILB4PLW7EW jean's key"
const host: HostProfile = { id: 'h1', vaultId: 'vault-a', name: 'prod-web-01', address: '10.0.0.1', port: 22, username: 'deploy', group: 'Production', authType: 'privateKey', privateKeyRef: 'ssh.work.privateKey', tags: [], createdAt: 1, updatedAt: 1 }
function props() {
  return { vaultKeys: ['ssh.work.privateKey', 'ssh.work.publicKey'], vaultUnlocked: true, vaultBusy: false, activeVaultId: 'vault-a', onRefresh: vi.fn(async () => {}), onDeleteSecret: vi.fn(async () => {}), onOutput: vi.fn(), onError: vi.fn() }
}

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.clearAllMocks()
  mocks.listHosts.mockResolvedValue([host])
  mocks.runConfirmedOperation.mockImplementation(async (options: { execute: (context: { isCurrent: () => boolean }) => Promise<unknown> }) => ({ value: await options.execute({ isCurrent: () => true }), job: {} }))
  mocks.runWorkspaceRemoteCommand.mockResolvedValue({ stdout: 'shellbeam:authorized-key-added\n', stderr: '', exitCode: 0, durationMs: 5 })
})

describe('keychain public key details and deploy', () => {
  it('shows the paired public key, its fingerprint and the hosts using the key', async () => {
    mocks.vaultGetSecret.mockResolvedValue(`${publicLine}\n`)
    render(<KeychainTab {...props()} />)
    expect(await screen.findByText(publicLine)).toBeInTheDocument()
    expect(mocks.vaultGetSecret).toHaveBeenCalledWith('ssh.work.publicKey', 'vault-a')
    expect(mocks.vaultGetSecret).not.toHaveBeenCalledWith('ssh.work.privateKey', expect.anything())
    expect(await screen.findByText('SHA256:33Ck/m3aTl9chTNTUpTStjBG7O+wFsrwPnZIPsLTAPg')).toBeInTheDocument()
    expect(await screen.findByText('prod-web-01')).toBeInTheDocument()
  })

  it('never displays a public-key entry that does not hold a public key', async () => {
    mocks.vaultGetSecret.mockResolvedValue('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----')
    render(<KeychainTab {...props()} />)
    expect(await screen.findByText('This entry is not a valid OpenSSH public key.')).toBeInTheDocument()
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Deploy to host/ })).toBeNull()
  })

  it('deploys through the confirmed operation flow with an idempotent authorized_keys command', async () => {
    mocks.vaultGetSecret.mockResolvedValue(publicLine)
    const input = props()
    render(<KeychainTab {...input} />)
    fireEvent.click(await screen.findByRole('button', { name: /Deploy to host/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(input.onOutput).toHaveBeenCalledWith('Public key ssh.work.publicKey added to ~/.ssh/authorized_keys on prod-web-01.'))
    expect(mocks.runConfirmedOperation).toHaveBeenCalledWith(expect.objectContaining({ host, vaultId: 'vault-a', risk: 'high', action: 'ssh.authorized_keys.add' }))
    const { command } = mocks.runWorkspaceRemoteCommand.mock.calls[0][0] as { command: string }
    expect(command).toContain('.ssh/authorized_keys')
    expect(command).toContain(publicLine.replace("'", `'\\''`))
  })
})
