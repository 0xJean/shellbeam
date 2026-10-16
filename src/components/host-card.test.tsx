import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostListItem } from './host-card'

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '203.0.113.8',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'password' as const,
  tags: ['web', 'critical'],
  createdAt: 0,
  updatedAt: 0,
}

describe('host list item', () => {
  it('renders cached region and system icons in list mode', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        network={{
          address: host.address,
          addressType: 'ipv4',
          scope: 'public',
          versionLabel: 'IPv4',
          scopeLabel: 'Public IP',
          locationLabel: 'Region pending',
          publicIp: host.address,
          canLookupLocation: true,
          resolvedLocationLabel: 'Hong Kong',
          locationStatus: 'ready',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('Hong Kong')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument()
    expect(document.querySelector('img[src="https://flagcdn.com/24x18/hk.png"]')).toBeTruthy()
    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="cpu"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="memory"]')).toBeTruthy()
    expect(document.querySelector('[data-resource-metric-icon="disk"]')).toBeTruthy()
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('critical')).toBeInTheDocument()
  })

  it('keeps the host avatar OS-specific with a local icon asset', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="online"
        resource={{
          hostname: 'api',
          os: 'Ubuntu 24.04 LTS',
          kernel: '',
          uptime: '',
          cpuPercent: null,
          memoryPercent: null,
          memoryText: '',
          diskPercent: null,
          diskText: '',
          network: '',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
    expect(screen.queryByText('Ub')).not.toBeInTheDocument()
  })

  it('shows the configured jump host in list metadata', () => {
    render(
      <HostListItem
        index={1}
        host={{ ...host, jumpHost: 'bastion.example.com', jumpPort: 2200, jumpUser: 'jump' }}
        isSelected={false}
        status="online"
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(document.querySelector('[data-host-jump-pill]')).toBeTruthy()
    expect(screen.getByText(/bastion\.example\.com:2200/)).toBeInTheDocument()
  })

  it('shows service, process and operation summaries for the ops view', () => {
    render(
      <HostListItem
        index={1}
        host={host}
        isSelected={false}
        status="stale"
        operations={{
          serviceTotal: 4,
          serviceActive: 3,
          serviceFailed: 1,
          processTotal: 2,
          processRunning: 2,
          auditCount: 3,
          latestAudit: {
            action: 'service.restart',
            target: 'nginx.service',
            status: 'completed',
            createdAt: 1000,
            transport: 'direct',
            provider: 'ssh-agentless',
          },
          provider: 'ssh-agentless',
          sampledAt: 1000,
          transport: 'direct',
        }}
        onSelect={vi.fn()}
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByTestId('host-ops-summary')).toBeInTheDocument()
    expect(screen.getByText('3/4')).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByText(/service\.restart/)).toBeInTheDocument()
  })
})
