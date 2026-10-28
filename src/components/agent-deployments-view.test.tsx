import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '@/lib/hosts'
import type { McpDeploymentRecord } from '@/lib/mcp'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'
import { OPEN_SFTP_REQUEST_EVENT, OPEN_TERMINAL_REQUEST_EVENT } from '@/lib/navigation-request'
import { AgentDeploymentsView } from './agent-deployments-view'

const host = (id: string, name: string) => ({ id, vaultId: 'v1', name, address: `10.0.0.${id.length}`, port: 22, username: 'root', group: 'p', authType: 'privateKey', tags: [], createdAt: 1, updatedAt: 1 }) as HostProfile
const hosts = [host('h1', 'prod-web-01'), host('h2', 'gpu-runner')]
const record = (patch: Partial<McpDeploymentRecord>): McpDeploymentRecord => ({
  deploymentId: 'd', clientId: 'c', agentName: 'Claude Code', vaultId: 'v1', hostId: 'h1', name: 'api', deploymentPath: '/opt/app', projectKind: 'docker compose',
  status: 'deployed', source: { repository: 'github.com/jean/api', ref: 'main', commit: '9f3c2a1b0000' }, dependencies: [{ name: 'node', version: '22' }],
  components: [{ name: 'web', type: 'static', path: '/opt/app/web/dist', status: 'served' }], runtime: { language: 'Node.js', version: '22', ports: '3000' },
  notes: 'rollback: git checkout 1b7e0d4', createdAt: 1, updatedAt: 2, lastVerifiedAt: Date.now() - 60_000, ...patch,
})
const deployments = [
  record({ deploymentId: 'a' }),
  record({ deploymentId: 'b', name: 'llm-runner', hostId: 'h2', deploymentPath: '/srv/llm', status: 'failed', lastVerifiedAt: null }),
]
const inventory = { projects: [{ name: 'app', kind: 'compose', path: '/opt/app/' }], containers: [], pm2: [], services: [], tools: [], resource: {} } as unknown as WorkspaceInventory

describe('AgentDeploymentsView', () => {
  beforeEach(() => { localStorage.setItem('shellbeam.locale', 'en') })

  it('groups records by host and leads the detail with the deploy directory', () => {
    render(<AgentDeploymentsView deployments={deployments} hosts={hosts} inventoryFor={() => undefined} />)
    expect(screen.getAllByTestId('agent-deployment-row')).toHaveLength(2)
    const detail = screen.getByTestId('agent-deployment-detail')
    expect(within(detail).getByTestId('agent-deployment-path')).toHaveTextContent('root@prod-web-01:/opt/app')
    expect(detail).toHaveTextContent('github.com/jean/api')
    expect(detail).toHaveTextContent('/opt/app/web/dist')
    expect(detail).toHaveTextContent('rollback: git checkout 1b7e0d4')
    expect(screen.getByTestId('agent-deployment-crosscheck')).toHaveAttribute('data-state', 'unscanned')
  })

  it('cross-checks the directory against the asset scan', () => {
    const { rerender } = render(<AgentDeploymentsView deployments={deployments} hosts={hosts} inventoryFor={() => ({ inventory, updatedAt: 5 })} />)
    expect(screen.getByTestId('agent-deployment-crosscheck')).toHaveAttribute('data-state', 'found')
    rerender(<AgentDeploymentsView deployments={[record({ deploymentPath: '/opt/other' })]} hosts={hosts} inventoryFor={() => ({ inventory, updatedAt: 5 })} />)
    expect(screen.getByTestId('agent-deployment-crosscheck')).toHaveAttribute('data-state', 'missing')
  })

  it('filters by status and switches the detail', () => {
    render(<AgentDeploymentsView deployments={deployments} hosts={hosts} inventoryFor={() => undefined} />)
    fireEvent.click(screen.getByTestId('agent-filter-failed'))
    expect(screen.getAllByTestId('agent-deployment-row')).toHaveLength(1)
    expect(screen.getByTestId('agent-deployment-path')).toHaveTextContent('/srv/llm')
  })

  it('asks the app to open a terminal or SFTP at the deploy directory', () => {
    const terminal = vi.fn(); const sftp = vi.fn()
    window.addEventListener(OPEN_TERMINAL_REQUEST_EVENT, terminal)
    window.addEventListener(OPEN_SFTP_REQUEST_EVENT, sftp)
    render(<AgentDeploymentsView deployments={deployments} hosts={hosts} inventoryFor={() => undefined} />)
    fireEvent.click(screen.getByTestId('agent-deployment-terminal'))
    fireEvent.click(screen.getByTestId('agent-deployment-sftp'))
    expect((terminal.mock.calls[0][0] as CustomEvent).detail).toEqual({ vaultId: 'v1', hostId: 'h1', path: '/opt/app' })
    expect((sftp.mock.calls[0][0] as CustomEvent).detail).toEqual({ vaultId: 'v1', hostId: 'h1', path: '/opt/app' })
    window.removeEventListener(OPEN_TERMINAL_REQUEST_EVENT, terminal)
    window.removeEventListener(OPEN_SFTP_REQUEST_EVENT, sftp)
  })

  it('disables directory actions for hosts without SSH', () => {
    render(<AgentDeploymentsView deployments={deployments} hosts={[{ ...hosts[0], connections: [] }, hosts[1]]} inventoryFor={() => undefined} />)
    expect(screen.getByTestId('agent-deployment-terminal')).toBeDisabled()
    expect(screen.getByTestId('agent-deployment-sftp')).toBeDisabled()
  })

  it('takes turns between list and detail below the md breakpoint', () => {
    render(<AgentDeploymentsView deployments={deployments} hosts={hosts} inventoryFor={() => undefined} />)
    const list = screen.getAllByTestId('agent-deployment-row')[0].closest('.sb-card')!
    expect(screen.getByTestId('agent-deployment-detail')).toHaveClass('max-md:hidden')
    expect(list).not.toHaveClass('max-md:hidden')
    fireEvent.click(screen.getAllByTestId('agent-deployment-row')[1])
    expect(screen.getByTestId('agent-deployment-detail')).not.toHaveClass('max-md:hidden')
    expect(screen.getByTestId('agent-deployment-path')).toHaveTextContent('/srv/llm')
    expect(list).toHaveClass('max-md:hidden')
    fireEvent.click(screen.getByTestId('agent-deployment-back'))
    expect(list).not.toHaveClass('max-md:hidden')
    expect(screen.getByTestId('agent-deployment-detail')).toHaveClass('max-md:hidden')
  })
})
