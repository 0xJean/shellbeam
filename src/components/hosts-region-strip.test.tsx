import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostsRegionStrip } from './hosts-region-strip'

describe('HostsRegionStrip', () => {
  it('hides itself when fewer than 2 regions exist', () => {
    const { container } = render(
      <HostsRegionStrip
        buckets={[{ key: 'US', label: 'United States', countryCode: 'US', online: 2, total: 2, offline: 0 }]}
        selected={null}
        onSelect={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders ratio badges for degraded regions and toggles selection', () => {
    const onSelect = vi.fn()
    render(
      <HostsRegionStrip
        buckets={[
          { key: 'US', label: 'United States', countryCode: 'US', online: 3, total: 4, offline: 1 },
          { key: 'JP', label: 'Japan', countryCode: 'JP', online: 2, total: 2, offline: 0 },
        ]}
        selected={null}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByTestId('region-pill-ratio-US')).toHaveTextContent('3/4')
    expect(screen.getByTestId('region-pill-ratio-JP')).toHaveTextContent('2')

    fireEvent.click(screen.getByTestId('region-pill-US'))
    expect(onSelect).toHaveBeenCalledWith('US')
  })
})
