import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationJob } from '@/lib/operation-job'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'

const { listOperationJobs } = vi.hoisted(() => ({ listOperationJobs: vi.fn() }))
vi.mock('@/lib/operation-job', () => ({ listOperationJobs }))

const host = {
  id: 'host-1', vaultId: 'production', name: 'Production', address: '10.0.0.8', port: 22, username: 'root',
  group: 'Production', authType: 'password' as const, tags: [], jumpHost: 'bastion', jumpPort: 2200,
  createdAt: 0, updatedAt: 0,
}

function job(overrides: Partial<OperationJob> = {}): OperationJob {
  return {
    auditId: 'audit-1', jobId: 'job-1', vaultId: host.vaultId, hostId: host.id,
    source: 'mcp', actor: 'mcp', action: 'service.restart', target: 'nginx.service',
    risk: 'high', provider: 'ssh-agentless', transport: 'proxy-jump', status: 'unknown',
    confirmationRequired: false, confirmationStatus: 'not_required', queuedAt: 100, updatedAt: 100,
    ...overrides,
  }
}

function deferredJobs() {
  let resolve!: (entries: OperationJob[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<OperationJob[]>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('WorkspaceOperationRecoveryNotice', () => {
  beforeEach(() => {
    listOperationJobs.mockReset()
    listOperationJobs.mockResolvedValue([])
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
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
    expect(screen.getByText('Operations with unknown outcomes')).toBeInTheDocument()
    expect(screen.getByText(/verify the remote state before retrying/)).toBeInTheDocument()
    expect(listOperationJobs).toHaveBeenCalledExactlyOnceWith({ vaultId: 'production', hostId: 'host-1', status: 'unknown', limit: 5 })
  })

  it('does not render when the audit has no recoverable jobs', async () => {
    listOperationJobs.mockResolvedValueOnce([{ auditId: 'audit-2', jobId: 'job-2', status: 'completed' }])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('uses the explicit active Vault and rejects foreign rows with identical host ids', async () => {
    listOperationJobs.mockResolvedValueOnce([
      { auditId: 'foreign', jobId: 'foreign-job', vaultId: 'production', hostId: host.id, status: 'unknown' },
      { auditId: 'other-host', jobId: 'other-host-job', vaultId: 'team', hostId: 'other-host', status: 'unknown' },
      { auditId: 'current', jobId: 'current-job', vaultId: 'team', hostId: host.id, status: 'unknown' },
    ])
    render(<WorkspaceOperationRecoveryNotice host={{ ...host, vaultId: 'team' }} vaultId="team" />)
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
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    listOperationJobs.mockResolvedValueOnce([{ auditId: 'team', jobId: 'team-job', vaultId: 'team', hostId: host.id, status: 'unknown' }])
    rerender(<WorkspaceOperationRecoveryNotice host={{ ...host, vaultId: 'team' }} vaultId="team" />)
    expect(await screen.findByText('job=team-job')).toBeInTheDocument()
    await act(async () => {
      resolveOld([job({ auditId: 'old', jobId: 'production-job' })])
    })
    expect(screen.getByText('job=team-job')).toBeInTheDocument()
    expect(screen.queryByText('job=production-job')).not.toBeInTheDocument()
    rerender(<WorkspaceOperationRecoveryNotice host={host} vaultId="" />)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('renders no warning while the first canonical journal read is pending', async () => {
    const read = deferredJobs()
    listOperationJobs.mockReturnValueOnce(read.promise)
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
    await act(async () => { read.resolve([]) })
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('does not turn current queued or running reads and writes into recovery incidents', async () => {
    listOperationJobs.mockResolvedValueOnce([
      job({ jobId: 'queued-read', action: 'service.list', risk: 'read-only', status: 'queued' }),
      job({ jobId: 'running-read', action: 'service.list', risk: 'read-only', status: 'running' }),
      job({ jobId: 'running-write', status: 'running' }),
      job({ jobId: 'completed', status: 'completed' }),
      job({ jobId: 'cancelled', status: 'cancelled' }),
    ])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it.each([
    { name: 'explicit empty Vault', host, vaultId: '' },
    { name: 'empty host id', host: { ...host, id: '' }, vaultId: undefined },
    { name: 'conflicting Vault', host, vaultId: 'team' },
  ])('does not query or start refresh listeners for $name', async ({ host: scopedHost, vaultId }) => {
    render(<WorkspaceOperationRecoveryNotice host={scopedHost} vaultId={vaultId} />)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(listOperationJobs).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('silently polls canonical status, retains unknown rows during reads, and removes reconciled jobs', async () => {
    const refresh = deferredJobs()
    listOperationJobs.mockResolvedValueOnce([job()]).mockReturnValueOnce(refresh.promise)
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    expect(await screen.findByText('job=job-1')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(listOperationJobs).toHaveBeenCalledTimes(2)
    expect(screen.getByText('job=job-1')).toBeInTheDocument()
    expect(screen.getByTitle('Refresh operation audit')).not.toBeDisabled()

    // Focus, visibility and timer events share a slow in-flight local read.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(listOperationJobs).toHaveBeenCalledTimes(2)
    await act(async () => { refresh.resolve([job({ status: 'completed' })]) })
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })

  it('pauses background polling and refreshes on visible return and focus', async () => {
    listOperationJobs.mockResolvedValue([job()])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    expect(await screen.findByText('job=job-1')).toBeInTheDocument()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listOperationJobs).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(listOperationJobs).toHaveBeenCalledTimes(3)
  })

  it('keeps unknown evidence on a failed journal refresh and supports manual local refresh', async () => {
    const refresh = deferredJobs()
    listOperationJobs.mockResolvedValueOnce([job()]).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce([])
    render(<WorkspaceOperationRecoveryNotice host={host} />)
    expect(await screen.findByText('job=job-1')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Refresh operation audit'))
    expect(screen.getByTitle('Refresh operation audit')).toBeDisabled()
    expect(screen.getByText('job=job-1')).toBeInTheDocument()
    await act(async () => { refresh.reject(new Error('journal unavailable')) })
    expect(screen.getByText('job=job-1')).toBeInTheDocument()
    expect(screen.getByTitle('Refresh operation audit')).not.toBeDisabled()
    fireEvent.click(screen.getByTitle('Refresh operation audit'))
    await waitFor(() => expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument())
    expect(listOperationJobs).toHaveBeenCalledTimes(3)
  })

  it('hides existing evidence immediately on a Vault conflict and ignores a pending old refresh', async () => {
    const oldRead = deferredJobs()
    listOperationJobs.mockResolvedValueOnce([job()]).mockReturnValueOnce(oldRead.promise)
    const { rerender } = render(<WorkspaceOperationRecoveryNotice host={host} />)
    expect(await screen.findByText('job=job-1')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    rerender(<WorkspaceOperationRecoveryNotice host={host} vaultId="team" />)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { oldRead.resolve([job()]) })
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
    expect(listOperationJobs).toHaveBeenCalledTimes(2)
  })

  it('removes its timer and listeners on unmount and ignores an in-flight read', async () => {
    const read = deferredJobs()
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    listOperationJobs.mockReturnValueOnce(read.promise)
    const { unmount } = render(<WorkspaceOperationRecoveryNotice host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(30_000)
      read.resolve([job()])
    })
    expect(listOperationJobs).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('workspace-operation-recovery')).not.toBeInTheDocument()
  })
})
