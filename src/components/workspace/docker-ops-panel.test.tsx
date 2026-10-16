import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DockerOpsPanel } from './docker-ops-panel'

vi.mock('@/lib/workspace-remote', () => ({ runWorkspaceRemoteCommand: vi.fn().mockResolvedValue({ stdout: '__SB_DOCKER=abc123|api|acme/api|Up 1 minute|', stderr: '', exitCode: 0, durationMs: 1 }) }))
vi.mock('@/lib/operation-job', () => ({ operationTransport: () => 'direct', runConfirmedOperation: vi.fn() }))

describe('DockerOpsPanel', () => {
  it('renders the container operations surface', async () => {
    render(<DockerOpsPanel host={{ id: 'h1', name: 'Host', address: '127.0.0.1', port: 22, username: 'root', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 }} resolveAuthSecret={vi.fn()} />)
    expect(await screen.findByTestId('docker-ops-panel')).toBeInTheDocument()
    expect(await screen.findByText('api')).toBeInTheDocument()
  })
})
