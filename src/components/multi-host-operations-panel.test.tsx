import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MultiHostOperationsPanel, type MultiHostOperationResult } from './multi-host-operations-panel'
import type { HostProfile } from '@/lib/hosts'

const hosts: HostProfile[] = [
  { id: 'h1', name: 'edge-1', address: '10.0.0.1', port: 22, username: 'root', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 },
  { id: 'h2', name: 'edge-2', address: '10.0.0.2', port: 22, username: 'root', group: 'Production', authType: 'password', tags: [], jumpHost: 'bastion', jumpPort: 22, jumpUser: 'jump', createdAt: 0, updatedAt: 0 },
  { id: 'h3', name: 'edge-3', address: '10.0.0.3', port: 22, username: 'root', group: 'Production', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 },
]

const result: MultiHostOperationResult = {
  operation: 'docker.restart',
  status: 'completed',
  results: [
    { hostId: 'h1', status: 'completed', jobId: 'job-1', auditId: 'audit-1', resultSummary: 'exit=0' },
    { hostId: 'h2', status: 'completed', jobId: 'job-2', auditId: 'audit-2', resultSummary: 'exit=0' },
  ],
}

describe('MultiHostOperationsPanel', () => {
  it('limits selection and submits a confirmed operation with host IDs', async () => {
    const onRunOperation = vi.fn().mockResolvedValue(result)
    render(<MultiHostOperationsPanel hosts={hosts} maxHosts={2} onRunOperation={onRunOperation} />)

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    fireEvent.click(checkboxes[2])
    expect(checkboxes[2]).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'docker.restart' } })
    fireEvent.change(screen.getByLabelText('Service or container'), { target: { value: 'api' } })
    fireEvent.click(screen.getByRole('button', { name: /Run operation/i }))

    await waitFor(() => expect(onRunOperation).toHaveBeenCalledWith({
      operation: 'docker.restart',
      hostIds: ['h1', 'h2'],
      target: 'api',
      confirmationRequired: true,
    }))
    expect(await screen.findByTestId('multi-host-operation-result')).toBeInTheDocument()
    expect(screen.getByText('job=job-1')).toBeInTheDocument()
  })

  it('requires a safe target before prompting or dispatching', async () => {
    const onRunOperation = vi.fn().mockResolvedValue(result)
    render(<MultiHostOperationsPanel hosts={hosts} initialSelectedHostIds={['h1']} onRunOperation={onRunOperation} />)
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'service.restart' } })
    fireEvent.change(screen.getByLabelText('Service or container'), { target: { value: 'nginx; rm -rf /' } })
    fireEvent.click(screen.getByRole('button', { name: /Run operation/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('safe service or container name')
    expect(onRunOperation).not.toHaveBeenCalled()
  })

  it('renders ProxyJump host context and shows a cancelled core result', async () => {
    const onRunOperation = vi.fn().mockResolvedValue({ ...result, status: 'cancelled', results: [{ hostId: 'h2', status: 'cancelled' }] })
    render(<MultiHostOperationsPanel hosts={hosts} initialSelectedHostIds={['h2']} onRunOperation={onRunOperation} />)
    expect(screen.getAllByText(/ProxyJump/).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'service.restart' } })
    fireEvent.change(screen.getByLabelText('Service or container'), { target: { value: 'sshd.service' } })
    fireEvent.click(screen.getByRole('button', { name: /Run operation/i }))
    await waitFor(() => expect(onRunOperation).toHaveBeenCalled())
    expect(await screen.findByTestId('multi-host-operation-result')).toBeInTheDocument()
  })
})
