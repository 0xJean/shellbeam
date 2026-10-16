import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByTestId('audit-empty')).toBeInTheDocument()
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
    expect(listOperationJobs).toHaveBeenCalledWith({ source: 'mcp', limit: 100 })
  })
})
