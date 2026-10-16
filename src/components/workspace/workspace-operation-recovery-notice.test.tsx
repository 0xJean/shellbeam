import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'

const { listOperationAudit } = vi.hoisted(() => ({ listOperationAudit: vi.fn() }))
vi.mock('@/lib/operation-job', () => ({ listOperationAudit }))

const host = {
  id: 'host-1', name: 'Production', address: '10.0.0.8', port: 22, username: 'root',
  group: 'Production', authType: 'password' as const, tags: [], jumpHost: 'bastion', jumpPort: 2200,
  createdAt: 0, updatedAt: 0,
}

describe('WorkspaceOperationRecoveryNotice', () => {
  it('restores unknown MCP jobs as a read-only recovery hint and shows ProxyJump', async () => {
    listOperationAudit.mockResolvedValueOnce([{
      auditId: 'audit-1', jobId: 'job-1', hostId: host.id, source: 'mcp', actor: 'mcp', action: 'service.restart', target: 'nginx.service',
      risk: 'high', provider: 'ssh-agentless', transport: 'proxy-jump', event: 'updated', status: 'unknown', confirmationStatus: 'confirmed', createdAt: 100,
    }])

    render(<WorkspaceOperationRecoveryNotice host={host} />)

    expect(await screen.findByTestId('workspace-operation-recovery')).toBeInTheDocument()
    expect(screen.getByText(/job=job-1/)).toBeInTheDocument()
    expect(screen.getByText('mcp')).toBeInTheDocument()
    expect(screen.getByText('ProxyJump')).toBeInTheDocument()
    await waitFor(() => expect(listOperationAudit).toHaveBeenCalledWith({ hostId: 'host-1', limit: 20 }))
  })

  it('does not render when the audit has no recoverable jobs', async () => {
    listOperationAudit.mockResolvedValueOnce([{ auditId: 'audit-2', jobId: 'job-2', status: 'completed' }])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    await waitFor(() => expect(listOperationAudit).toHaveBeenCalled())
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })
})
