import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import { loadShellbeamAgentCatalogRelease } from '@/lib/shellbeam-agent-catalog'
import { runShellbeamAgentArtifactOperation } from '@/lib/shellbeam-agent-artifact'
import { ShellbeamAgentPanel } from './shellbeam-agent-panel'
const mocks = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('@/lib/i18n', () => ({ useT: () => ({ t: mocks.t }) }))
vi.mock('@/lib/shellbeam-agent-catalog', () => ({ loadShellbeamAgentCatalogRelease: vi.fn() }))
vi.mock('@/lib/shellbeam-agent-artifact', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/shellbeam-agent-artifact')>(), runShellbeamAgentArtifactOperation: vi.fn(async () => null) }))
vi.mock('@/lib/shellbeam-agent', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/shellbeam-agent')>(), listShellbeamAgents: vi.fn(async () => []), upsertShellbeamAgent: vi.fn(), checkShellbeamAgent: vi.fn() }))
const host = { id: 'edge', name: 'edge', address: '10.0.0.1', port: 22, username: 'ops', authType: 'privateKey', tags: [], group: 'Production', createdAt: 1, updatedAt: 1 } as HostProfile
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })
describe('Agent production installation entry', () => {
  it('requires a verified release before first installation and routes through the signed artifact flow', async () => {
    const artifact = { artifactId: 'agent-linux', version: '0.1.0', platform: 'linux', architecture: 'x86_64', url: 'https://example.com/agent', sha256: 'a'.repeat(64), signature: 'signed' }
    const release = { manifest: { releaseId: 'release-1', channel: 'stable' as const, publishedAt: Date.now(), artifact }, artifact: { manifest: artifact, sha256: artifact.sha256, signature: new Uint8Array(64), url: new URL(artifact.url) }, releaseStage: 'stable' as const, releaseSignature: new Uint8Array(64) }
    vi.mocked(loadShellbeamAgentCatalogRelease).mockResolvedValueOnce(release)
    const resolveAuthSecret = vi.fn(async () => 'not displayed')
    render(<ShellbeamAgentPanel host={host} vaultId="vault-1" resolveAuthSecret={resolveAuthSecret} />)
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
})
