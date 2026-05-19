import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceServerList } from './workspace-server-list'

const hosts = [
  {
    id: 'host-1',
    name: 'Production API',
    address: '10.0.0.15',
    port: 22,
    username: 'root',
    group: 'Production',
    authType: 'password' as const,
    tags: ['api'],
    createdAt: 0,
    updatedAt: 0,
  },
]

describe('workspace server list', () => {
  it('renders resource metrics inside server asset rows', () => {
    render(
      <WorkspaceServerList
        hosts={hosts}
        selectedKey="host-1"
        getHostKey={(host) => host.id}
        onSelect={vi.fn()}
        getResourceMetrics={() => ({
          cpuPercent: 18,
          memoryPercent: 64,
          diskPercent: 71,
          cpuDetail: '3 days',
          memoryDetail: '1280M/2000M',
          diskDetail: '36G/50G',
        })}
      />,
    )

    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('MEM')).toBeInTheDocument()
    expect(screen.getByText('DISK')).toBeInTheDocument()
    expect(screen.getByText('18%')).toBeInTheDocument()
    expect(screen.getByText('64%')).toBeInTheDocument()
    expect(screen.getByText('71%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'MEM 64% · 1280M/2000M' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'DISK 71% · 36G/50G' })).toBeInTheDocument()
  })

  it('supports double-click open actions', () => {
    const onRowDoubleClick = vi.fn()

    render(
      <WorkspaceServerList
        hosts={hosts}
        selectedKey="host-1"
        getHostKey={(host) => host.id}
        onSelect={vi.fn()}
        onRowDoubleClick={onRowDoubleClick}
        renderRegionLine={() => <div>Asia Pacific</div>}
      />,
    )

    screen.getByRole('button', { name: /Production API/i }).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(onRowDoubleClick).toHaveBeenCalledWith(hosts[0])
    expect(screen.getByText('Asia Pacific')).toBeInTheDocument()
  })
})
