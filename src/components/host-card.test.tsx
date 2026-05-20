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
})
