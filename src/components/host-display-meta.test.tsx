import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HostMetadataLine } from './host-display-meta'

describe('host display metadata', () => {
  it('infers a country flag from the cached location label and renders the cached OS', () => {
    render(
      <HostMetadataLine
        network={{
          address: '203.0.113.8',
          addressType: 'ipv4',
          scope: 'public',
          versionLabel: 'IPv4',
          scopeLabel: 'Public IP',
          locationLabel: 'Region pending',
          publicIp: '203.0.113.8',
          canLookupLocation: true,
          resolvedLocationLabel: 'Hong Kong',
          locationStatus: 'ready',
        }}
        resource={{ os: 'Ubuntu 24.04 LTS' }}
      />,
    )

    expect(screen.getByText('Hong Kong')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument()
    expect(document.querySelector('img[src="https://flagcdn.com/24x18/hk.png"]')).toBeTruthy()
    expect(document.querySelector('[data-os-icon="ubuntu"]')).toBeTruthy()
  })

  it('renders an OS-specific local icon without a text fallback mark', () => {
    render(
      <HostMetadataLine
        resource={{ os: 'Debian GNU/Linux 12' }}
        showLocation={false}
      />,
    )

    expect(document.querySelector('[data-os-icon="debian"]')).toBeTruthy()
    expect(screen.queryByText('Db')).not.toBeInTheDocument()
    expect(screen.getByText('Debian GNU/Linux 12')).toBeInTheDocument()
  })
})
