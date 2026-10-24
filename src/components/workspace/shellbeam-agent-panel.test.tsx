import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import { loadShellbeamAgentCatalogRelease } from '@/lib/shellbeam-agent-catalog'
import { runShellbeamAgentArtifactOperation } from '@/lib/shellbeam-agent-artifact'
import { ShellbeamAgentPanel } from './shellbeam-agent-panel'
import { checkShellbeamAgent, listShellbeamAgents, normalizeShellbeamAgentRecord } from '@/lib/shellbeam-agent'
import { getShellbeamAgentHistoryCursor, publishShellbeamAgentHistorySummary } from '@/lib/shellbeam-agent-history'
const mocks = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: mocks.t, locale: 'en' }) }))
vi.mock('@/lib/shellbeam-agent-catalog', () => ({ loadShellbeamAgentCatalogRelease: vi.fn() }))
vi.mock('@/lib/shellbeam-agent-artifact', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/shellbeam-agent-artifact')>(), runShellbeamAgentArtifactOperation: vi.fn(async () => null) }))
vi.mock('@/lib/shellbeam-agent', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/shellbeam-agent')>(), listShellbeamAgents: vi.fn(async () => []), upsertShellbeamAgent: vi.fn(), checkShellbeamAgent: vi.fn() }))
vi.mock('@/lib/shellbeam-agent-history', async (original) => ({ ...await original<typeof import('@/lib/shellbeam-agent-history')>(), getShellbeamAgentHistoryCursor: vi.fn(async () => ({ cursor: null, revision: 0, updatedAt: null, exhausted: false, reason: 'not-started' })) }))
const host = { id: 'edge', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'privateKey', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })
function openManagement() {
  fireEvent.click(screen.getByRole('button', { name: /^(Monitoring tools|Manage agent)$/ }))
}

describe('Agent production installation entry', () => {
  it('keeps optional agent controls and history unmounted until explicitly opened', async () => {
    render(<ShellbeamAgentPanel host={host} vaultId="optional" resolveAuthSecret={vi.fn()} />)
    await waitFor(() => expect(listShellbeamAgents).toHaveBeenCalledWith({ vaultId: 'optional', hostId: host.id }))
    expect(screen.getByRole('button', { name: 'Monitoring tools' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    expect(getShellbeamAgentHistoryCursor).not.toHaveBeenCalled()
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
    expect(loadShellbeamAgentCatalogRelease).not.toHaveBeenCalled()
    expect(runShellbeamAgentArtifactOperation).not.toHaveBeenCalled()
    openManagement()
    expect(screen.getByTestId('shellbeam-agent-panel')).toBeVisible()
    expect(screen.getByRole('button', { name: 'workspace.agentProbe.install' })).toBeDisabled()
  })

  it('keeps an existing unhealthy agent discoverable without expanding management', async () => {
    vi.mocked(listShellbeamAgents).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'attention', hostId: host.id, status: 'offline', health: 'offline', transport: 'direct' })])
    render(<ShellbeamAgentPanel host={host} vaultId="attention" resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Manage agent' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Agent needs attention')
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
  })

  it.each(['not-installed', 'retired', 'unsupported'] as const)('keeps %s agent records available without presenting them as a current failure', async (status) => {
    vi.mocked(listShellbeamAgents).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'inactive', hostId: host.id, status, transport: 'direct', lastHeartbeatAt: 1, lastError: 'historical diagnostic' })])
    render(<ShellbeamAgentPanel host={host} vaultId="inactive" resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Manage agent' })).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    expect(checkShellbeamAgent).not.toHaveBeenCalled()
  })

  it('does not restore expanded management on an A → B → A Vault switch', async () => {
    const view = render(<ShellbeamAgentPanel host={host} vaultId="scope-a" resolveAuthSecret={vi.fn()} />)
    openManagement()
    expect(screen.getByTestId('shellbeam-agent-panel')).toBeVisible()
    view.rerender(<ShellbeamAgentPanel host={host} vaultId="scope-b" resolveAuthSecret={vi.fn()} />)
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    view.rerender(<ShellbeamAgentPanel host={host} vaultId="scope-a" resolveAuthSecret={vi.fn()} />)
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Monitoring tools' })).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(listShellbeamAgents).toHaveBeenCalledTimes(3))
  })

  it('does not let history failure change the current healthy heartbeat', async () => {
    vi.mocked(listShellbeamAgents).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'panel-history', hostId: host.id, agentId: 'panel-node', status: 'installed', health: 'online', transport: 'direct', lastHeartbeatAt: Date.now() })])
    render(<ShellbeamAgentPanel host={host} vaultId="panel-history" resolveAuthSecret={vi.fn()} />)
    openManagement()
    await waitFor(() => expect(screen.getByText('workspace.agentProbe.online')).toBeInTheDocument())
    await waitFor(() => expect(getShellbeamAgentHistoryCursor).toHaveBeenCalledWith('panel-history', host.id, 'panel-node'))
    await act(async () => { publishShellbeamAgentHistorySummary({ vaultId: 'panel-history', hostId: host.id, nodeId: 'panel-node', providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', status: 'failed', reason: 'invalid-page', imported: 0, pages: 0, hasMore: null, cursor: null }) })
    await waitFor(() => expect(screen.getByText(/history.status.failed/)).toBeInTheDocument())
    expect(screen.getByText('workspace.agentProbe.online')).toBeInTheDocument()
  })
  it('hides old Vault lifecycle/release state and releases new-scope buttons while an old release request is pending', async () => {
    vi.mocked(listShellbeamAgents).mockResolvedValueOnce([normalizeShellbeamAgentRecord({ vaultId: 'panel-old', hostId: host.id, agentId: 'old-node', status: 'installed', version: '9.9.9', transport: 'direct' })]).mockResolvedValueOnce([])
    let finishRelease!: (value: Awaited<ReturnType<typeof loadShellbeamAgentCatalogRelease>>) => void
    const oldRelease = { manifest: { channel: 'stable', artifact: { version: 'old-release', sha256: 'a'.repeat(64) } } } as Awaited<ReturnType<typeof loadShellbeamAgentCatalogRelease>>
    vi.mocked(loadShellbeamAgentCatalogRelease).mockResolvedValueOnce(oldRelease).mockImplementationOnce(() => new Promise((resolve) => { finishRelease = resolve }))
    const view = render(<ShellbeamAgentPanel host={host} vaultId="panel-old" resolveAuthSecret={vi.fn()} />)
    openManagement()
    await waitFor(() => expect(screen.getByText('9.9.9')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'workspace.agentProbe.releaseLoad' }))
    await waitFor(() => expect(screen.getByText(/old-release/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'workspace.agentProbe.releaseLoad' }))
    await waitFor(() => expect(loadShellbeamAgentCatalogRelease).toHaveBeenCalledTimes(2))
    view.rerender(<ShellbeamAgentPanel host={host} vaultId="panel-new" resolveAuthSecret={vi.fn()} />)
    expect(screen.queryByText('9.9.9')).not.toBeInTheDocument()
    expect(screen.queryByText(/old-release/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('shellbeam-agent-panel')).not.toBeInTheDocument()
    openManagement()
    expect(screen.getByRole('button', { name: 'workspace.agentProbe.install' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'workspace.agentProbe.releaseLoad' })).toBeEnabled()
    await act(async () => { finishRelease(oldRelease) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'workspace.agentProbe.releaseLoad' })).toBeEnabled())
    expect(screen.queryByText(/old-release/)).not.toBeInTheDocument()
  })
  it('requires a verified release before first installation and routes through the signed artifact flow', async () => {
    const artifact = { artifactId: 'agent-linux', version: '0.1.0', platform: 'linux', architecture: 'x86_64', url: 'https://example.com/agent', sha256: 'a'.repeat(64), signature: 'signed' }
    const release = { manifest: { releaseId: 'release-1', channel: 'stable' as const, publishedAt: Date.now(), artifact }, artifact: { manifest: artifact, sha256: artifact.sha256, signature: new Uint8Array(64), url: new URL(artifact.url) }, releaseStage: 'stable' as const, releaseSignature: new Uint8Array(64) }
    vi.mocked(loadShellbeamAgentCatalogRelease).mockResolvedValueOnce(release)
    const resolveAuthSecret = vi.fn(async () => 'not displayed')
    render(<ShellbeamAgentPanel host={host} vaultId="vault-1" resolveAuthSecret={resolveAuthSecret} />)
    openManagement()
    const install = screen.getByRole('button', { name: 'workspace.agentProbe.install' })
    expect(install).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'workspace.agentProbe.releaseLoad' }))
    await waitFor(() => expect(install).toBeEnabled())
    expect(loadShellbeamAgentCatalogRelease).toHaveBeenCalledWith(expect.objectContaining({ host, vaultId: 'vault-1' }))
    fireEvent.click(install)
    await waitFor(() => expect(runShellbeamAgentArtifactOperation).toHaveBeenCalledWith(expect.objectContaining({ action: 'install', manifest: artifact, vaultId: 'vault-1', releaseSummary: expect.stringContaining('release=release-1') })))
    expect(screen.getByText('workspace.agentProbe.commandPreview')).toBeInTheDocument()
    expect(screen.getByText(/\.local\/bin\/shellbeam-agent.*install/)).not.toHaveTextContent('sudo')
    expect(screen.queryByText('not displayed')).not.toBeInTheDocument()
  })

  it.each(['host', 'jump', 'unmount'] as const)('passes a persistent execution guard that invalidates on %s change', async (change) => {
    const view = render(<ShellbeamAgentPanel host={host} vaultId="guard-vault" resolveAuthSecret={vi.fn()} artifactManifest={{ test: 'transport-boundary-only' }} artifactPolicy={{ allowedHosts: ['example.com'], trustedPublicKeyBase64: 'test-only' }} />)
    openManagement()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'workspace.agentProbe.install' })) })
    await waitFor(() => expect(runShellbeamAgentArtifactOperation).toHaveBeenCalledOnce())
    const guard = vi.mocked(runShellbeamAgentArtifactOperation).mock.calls[0][0].isCurrent
    expect(guard?.()).toBe(true)
    if (change === 'unmount') view.unmount()
    else await act(async () => { view.rerender(<ShellbeamAgentPanel host={{ ...host, ...(change === 'host' ? { address: '192.0.2.12' } : { jumpHostId: 'new-jump-profile' }), updatedAt: 2 }} vaultId="guard-vault" resolveAuthSecret={vi.fn()} artifactManifest={{ test: 'transport-boundary-only' }} artifactPolicy={{ allowedHosts: ['example.com'], trustedPublicKeyBase64: 'test-only' }} />) })
    expect(guard?.()).toBe(false)
  })
})
