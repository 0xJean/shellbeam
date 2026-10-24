import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import type { OperationAuditEntry, OperationJob } from '@/lib/operation-job'
import OperationsAuditCenter from './operations-audit-center'

const { listOperationJobs, listOperationAudit } = vi.hoisted(() => ({
  listOperationJobs: vi.fn(),
  listOperationAudit: vi.fn(),
}))
vi.mock('@/lib/operation-job', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operation-job')>('@/lib/operation-job')
  return { ...actual, listOperationJobs, listOperationAudit }
})

const baseJob: OperationJob = {
  jobId: 'job-1',
  auditId: 'audit-1',
  hostId: 'host-1',
  hostName: 'Production',
  hostAddress: '10.0.0.10',
  source: 'workspace',
  actor: 'local-user',
  action: 'service.restart',
  target: 'nginx.service',
  risk: 'high',
  provider: 'ssh-agentless',
  transport: 'proxy-jump',
  status: 'unknown',
  confirmationRequired: true,
  confirmationStatus: 'confirmed',
  queuedAt: 1_000,
  updatedAt: 2_000,
  requestId: 'batch-42',
  errorSummary: 'connection lost',
}

const audit: OperationAuditEntry = {
  auditId: 'audit-1',
  jobId: 'job-1',
  hostId: 'host-1',
  hostName: 'Production',
  hostAddress: '10.0.0.10',
  source: 'workspace',
  actor: 'local-user',
  action: 'service.restart',
  target: 'nginx.service',
  risk: 'high',
  provider: 'ssh-agentless',
  transport: 'proxy-jump',
  event: 'updated',
  status: 'unknown',
  confirmationStatus: 'confirmed',
  createdAt: 2_000,
  errorSummary: 'connection lost',
}

function renderCenter(props?: React.ComponentProps<typeof OperationsAuditCenter>) {
  return render(<I18nProvider><OperationsAuditCenter {...props} /></I18nProvider>)
}

describe('OperationsAuditCenter', () => {
  beforeEach(() => {
    listOperationJobs.mockReset()
    listOperationAudit.mockReset()
    listOperationJobs.mockResolvedValue([])
    listOperationAudit.mockResolvedValue([])
  })

  it('groups batch jobs by requestId and exposes unknown/cancelled retry states', async () => {
    const cancelled = { ...baseJob, jobId: 'job-2', auditId: 'audit-2', hostId: 'host-2', hostName: 'Staging', status: 'cancelled' as const, requestId: 'batch-42', errorSummary: undefined }
    listOperationJobs.mockResolvedValue([baseJob, cancelled])
    const onRetry = vi.fn().mockResolvedValue(undefined)

    renderCenter({ onRetry })

    await waitFor(() => expect(screen.getByTestId('operations-request-group')).toBeInTheDocument())
    expect(screen.getByTestId('operation-request-id')).toHaveTextContent('request=batch-42')
    expect(screen.getAllByTestId('operation-status-unknown')).toHaveLength(2)
    expect(screen.getAllByTestId('operation-status-cancelled')).toHaveLength(1)
    expect(screen.getAllByTestId('operation-retry')).toHaveLength(2)

    fireEvent.click(screen.getAllByTestId('operation-retry')[0]!)
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ jobId: expect.stringMatching(/^job-/) })))
  })

  it('switches to audit history and filters by status', async () => {
    listOperationJobs.mockResolvedValue([baseJob])
    listOperationAudit.mockResolvedValue([audit])

    renderCenter()
    await waitFor(() => expect(screen.getByTestId('operations-request-group')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('audit-tab'))
    expect(screen.getByTestId('operation-audit-row')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('operations-filter'), { target: { value: 'completed' } })
    await waitFor(() => expect(screen.getByTestId('audit-empty')).toBeInTheDocument())
    expect(listOperationAudit).toHaveBeenLastCalledWith({ status: 'completed', limit: 101 })
  })

  it('shows a local-store error without throwing', async () => {
    listOperationJobs.mockRejectedValue(new Error('journal unavailable'))
    renderCenter()
    await waitFor(() => expect(screen.getByTestId('operations-error')).toHaveTextContent('journal unavailable'))
  })

  it('restores MCP unknown jobs from the durable journal with reconciliation guidance', async () => {
    const mcpJob = { ...baseJob, source: 'mcp' as const, provider: 'mcp-remote', status: 'unknown' as const, auditId: 'mcp-audit', jobId: 'mcp-job' }
    listOperationJobs.mockResolvedValue([mcpJob])
    listOperationAudit.mockResolvedValue([{ ...audit, source: 'mcp' as const, jobId: 'mcp-job', auditId: 'mcp-audit' }])

    renderCenter({ source: 'mcp' })

    await waitFor(() => expect(screen.getByTestId('operations-mcp-recovery')).toBeInTheDocument())
    expect(screen.getByTestId('operations-restored')).toBeInTheDocument()
    expect(screen.getByText('Remote outcome is unknown; reconcile the host before retrying.')).toBeInTheDocument()
    expect(listOperationJobs).toHaveBeenCalledWith({ source: 'mcp', limit: 101 })
  })

  it('queries older jobs by the last visible time/id and returns to newer pages or the latest on refresh', async () => {
    const rows = ['z', 'y', 'x', 'w'].map(id => ({ ...baseJob, jobId: id, auditId: `audit-${id}`, updatedAt: 2_000, requestId: undefined }))
    listOperationJobs.mockImplementation(async query => query.before ? rows.slice(2) : rows.slice(0, 3))
    renderCenter({ hostId: 'host-1', limit: 2 })
    await waitFor(() => expect(screen.getByTestId('operations-older')).toBeEnabled())
    expect(screen.getAllByTestId('operations-request-group')).toHaveLength(2)
    expect(screen.queryByText('job=x')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('operations-older'))
    await waitFor(() => expect(screen.getByText('job=x')).toBeInTheDocument())
    expect(listOperationJobs).toHaveBeenLastCalledWith({ hostId: 'host-1', limit: 3, before: { timestamp: 2_000, id: 'y' } })
    expect(screen.getByTestId('operations-page')).toHaveTextContent('Page 2')
    expect(screen.getByTestId('operations-older')).toBeDisabled()
    fireEvent.click(screen.getByTestId('operations-newer'))
    await waitFor(() => expect(screen.getByText('job=z')).toBeInTheDocument())
    expect(screen.getByTestId('operations-newer')).toBeDisabled()
    fireEvent.click(screen.getByTestId('operations-older'))
    await waitFor(() => expect(screen.getByText('job=x')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('operations-refresh'))
    await waitFor(() => expect(screen.getByText('job=z')).toBeInTheDocument())
    expect(screen.getByTestId('operations-page')).toHaveTextContent('Page 1')
  })

  it('retrieves older scoped audit entries with native source/status filters and independent cursors', async () => {
    const rows = ['z', 'y', 'x'].map(id => ({ ...audit, auditId: id, vaultId: 'vault-a', createdAt: 3_000 }))
    listOperationAudit.mockImplementation(async query => query.before ? rows.slice(2) : rows)
    renderCenter({ hostId: 'host-1', vaultId: 'vault-a', limit: 2 })
    await waitFor(() => expect(screen.getByTestId('operations-restored')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('audit-tab'))
    fireEvent.click(screen.getByTestId('operations-older'))
    await waitFor(() => expect(screen.getAllByTestId('operation-audit-row')).toHaveLength(1))
    expect(listOperationAudit).toHaveBeenLastCalledWith({ hostId: 'host-1', vaultId: 'vault-a', limit: 3, before: { timestamp: 3_000, id: 'y' } })
    expect(listOperationJobs).toHaveBeenLastCalledWith({ hostId: 'host-1', vaultId: 'vault-a', limit: 3 })
    fireEvent.change(screen.getByTestId('operations-source-filter'), { target: { value: 'workspace' } })
    fireEvent.change(screen.getByTestId('operations-filter'), { target: { value: 'unknown' } })
    await waitFor(() => expect(listOperationAudit).toHaveBeenLastCalledWith({ hostId: 'host-1', vaultId: 'vault-a', source: 'workspace', status: 'unknown', limit: 3 }))
    expect(screen.getByTestId('operations-page')).toHaveTextContent('Page 1')
    await waitFor(() => expect(screen.getAllByTestId('operation-audit-row')).toHaveLength(2))
  })

  it('rejects late filter responses and clears previous Vault rows immediately on scope changes', async () => {
    let finishOld: (rows: OperationJob[]) => void = () => {}
    listOperationJobs.mockImplementation(query => {
      if (query.vaultId === 'vault-a' && !query.status) return new Promise(resolve => { finishOld = resolve })
      return Promise.resolve([{ ...baseJob, vaultId: query.vaultId, jobId: `${query.vaultId}-new`, status: 'cancelled', requestId: undefined }])
    })
    const { rerender } = renderCenter({ vaultId: 'vault-a' })
    fireEvent.change(screen.getByTestId('operations-filter'), { target: { value: 'cancelled' } })
    await waitFor(() => expect(screen.getByText('job=vault-a-new')).toBeInTheDocument())
    await act(async () => { finishOld([{ ...baseJob, vaultId: 'vault-a', jobId: 'late-old', requestId: undefined }]) })
    expect(screen.queryByText('job=late-old')).not.toBeInTheDocument()
    rerender(<I18nProvider><OperationsAuditCenter vaultId="vault-b" /></I18nProvider>)
    expect(screen.queryByText('job=vault-a-new')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('job=vault-b-new')).toBeInTheDocument())
    expect(listOperationJobs).toHaveBeenLastCalledWith({ vaultId: 'vault-b', limit: 101 })
  })

  it('retains the current historical page after a failed fetch and allows moving back', async () => {
    const rows = ['z', 'y', 'x'].map(id => ({ ...baseJob, jobId: id, requestId: undefined }))
    listOperationJobs.mockImplementation(async query => {
      if (query.before) throw new Error('read failed')
      return rows
    })
    renderCenter({ limit: 2 })
    await waitFor(() => expect(screen.getByTestId('operations-older')).toBeEnabled())
    fireEvent.click(screen.getByTestId('operations-older'))
    await waitFor(() => expect(screen.getByTestId('operations-error')).toHaveTextContent('read failed'))
    expect(screen.queryByText('job=z')).not.toBeInTheDocument()
    expect(screen.getByTestId('operations-newer')).toBeEnabled()
    fireEvent.click(screen.getByTestId('operations-newer'))
    await waitFor(() => expect(screen.getByText('job=z')).toBeInTheDocument())
    expect(screen.queryByTestId('operations-error')).not.toBeInTheDocument()
  })

  it('does not automatically refresh historical pages when the app becomes visible', async () => {
    const rows = ['z', 'y', 'x'].map(id => ({ ...baseJob, jobId: id, requestId: undefined }))
    listOperationJobs.mockImplementation(async query => query.before ? rows.slice(2) : rows)
    renderCenter({ limit: 2 })
    await waitFor(() => expect(screen.getByTestId('operations-older')).toBeEnabled())
    fireEvent.click(screen.getByTestId('operations-older'))
    await waitFor(() => expect(screen.getByText('job=x')).toBeInTheDocument())
    const calls = listOperationJobs.mock.calls.length
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listOperationJobs).toHaveBeenCalledTimes(calls)
    expect(screen.getByText('job=x')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('operations-refresh'))
    await waitFor(() => expect(screen.getByText('job=z')).toBeInTheDocument())
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listOperationJobs.mock.calls.length).toBeGreaterThan(calls + 1)
  })

  it('keeps every request bounded and refetches when the already-selected reconciliation filter is clicked', async () => {
    const rows = Array.from({ length: 110 }, (_, index) => ({ ...baseJob, source: 'mcp' as const, jobId: `job-${index}`, requestId: undefined }))
    listOperationJobs.mockResolvedValue(rows)
    renderCenter({ source: 'mcp', limit: 2_000 })
    await waitFor(() => expect(screen.getAllByTestId('operations-request-group')).toHaveLength(100))
    expect(listOperationJobs).toHaveBeenLastCalledWith({ source: 'mcp', limit: 101 })
    fireEvent.click(screen.getByTestId('operations-mcp-recovery').querySelector('button')!)
    await waitFor(() => expect(listOperationJobs).toHaveBeenLastCalledWith({ source: 'mcp', status: 'unknown', limit: 101 }))
    await waitFor(() => expect(screen.getAllByTestId('operations-request-group')).toHaveLength(100))
    const count = listOperationJobs.mock.calls.length
    fireEvent.click(screen.getByTestId('operations-mcp-recovery').querySelector('button')!)
    await waitFor(() => expect(listOperationJobs).toHaveBeenCalledTimes(count + 1))
    await waitFor(() => expect(screen.getAllByTestId('operations-request-group')).toHaveLength(100))
  })
})
