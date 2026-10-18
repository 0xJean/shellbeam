import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationJob } from '@/lib/operation-job'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'

const { listOperationJobs } = vi.hoisted(() => ({ listOperationJobs: vi.fn() }))
vi.mock('@/lib/operation-job', () => ({ listOperationJobs }))

const host = {
  id: 'host-1', vaultId: 'production', name: 'Production', address: '10.0.0.8', port: 22, username: 'root',
  group: 'Production', authType: 'password' as const, tags: [], jumpHost: 'bastion', jumpPort: 2200,
  createdAt: 0, updatedAt: 0,
}

describe('WorkspaceOperationRecoveryNotice', () => {
  beforeEach(() => { listOperationJobs.mockReset(); listOperationJobs.mockResolvedValue([]) })
  it('restores unknown MCP jobs as a read-only recovery hint and shows ProxyJump', async () => {
    listOperationJobs.mockResolvedValueOnce([{
      auditId: 'audit-1', jobId: 'job-1', vaultId: 'production', hostId: host.id, source: 'mcp', actor: 'mcp', action: 'service.restart', target: 'nginx.service',
      risk: 'high', provider: 'ssh-agentless', transport: 'proxy-jump', event: 'updated', status: 'unknown', confirmationStatus: 'confirmed', createdAt: 100,
    }])

    render(<WorkspaceOperationRecoveryNotice host={host} />)

    expect(await screen.findByTestId('workspace-operation-recovery')).toBeInTheDocument()
    expect(screen.getByText(/job=job-1/)).toBeInTheDocument()
    expect(screen.getByText('mcp')).toBeInTheDocument()
    expect(screen.getByText('ProxyJump')).toBeInTheDocument()
    await waitFor(() => expect(listOperationJobs).toHaveBeenCalledWith({ vaultId: 'production', hostId: 'host-1', status: 'unknown', limit: 5 }))
  })

  it('does not render when the audit has no recoverable jobs', async () => {
    listOperationJobs.mockResolvedValueOnce([{ auditId: 'audit-2', jobId: 'job-2', status: 'completed' }])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    await waitFor(() => expect(listOperationJobs).toHaveBeenCalledTimes(3))
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('uses the explicit active Vault and rejects foreign rows with identical host ids', async () => {
    listOperationJobs.mockResolvedValueOnce([
      { auditId: 'foreign', jobId: 'foreign-job', vaultId: 'production', hostId: host.id, status: 'unknown' },
      { auditId: 'other-host', jobId: 'other-host-job', vaultId: 'team', hostId: 'other-host', status: 'unknown' },
      { auditId: 'current', jobId: 'current-job', vaultId: 'team', hostId: host.id, status: 'queued' },
    ])
    render(<WorkspaceOperationRecoveryNotice host={host} vaultId="team" />)
    expect(await screen.findByText('job=current-job')).toBeInTheDocument()
    expect(screen.queryByText(/foreign-job|other-host-job/)).not.toBeInTheDocument()
    expect(listOperationJobs).toHaveBeenCalledWith({ vaultId: 'team', hostId: host.id, status: 'unknown', limit: 5 })
  })

  it('does not query an unscoped journal for a host without a Vault', async () => {
    render(<WorkspaceOperationRecoveryNotice host={{ ...host, vaultId: undefined }} />)
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('hides old Vault results immediately and ignores their late completion after switching', async () => {
    let resolveOld!: (entries: OperationJob[]) => void
    listOperationJobs.mockImplementationOnce(() => new Promise<OperationJob[]>((resolve) => { resolveOld = resolve }))
    const { rerender } = render(<WorkspaceOperationRecoveryNotice host={host} />)
    await waitFor(() => expect(listOperationJobs).toHaveBeenCalledTimes(3))
    listOperationJobs.mockResolvedValueOnce([{ auditId: 'team', jobId: 'team-job', vaultId: 'team', hostId: host.id, status: 'unknown' }])
    rerender(<WorkspaceOperationRecoveryNotice host={host} vaultId="team" />)
    expect(await screen.findByText('job=team-job')).toBeInTheDocument()
    await act(async () => {
      resolveOld([{ auditId: 'old', jobId: 'production-job', vaultId: 'production', hostId: host.id, status: 'running' } as OperationJob])
    })
    expect(screen.getByText('job=team-job')).toBeInTheDocument()
    expect(screen.queryByText('job=production-job')).not.toBeInTheDocument()
    rerender(<WorkspaceOperationRecoveryNotice host={host} vaultId="" />)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })
})
