import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostGridCard } from './host-card'
import { HostKpiRow } from './hosts-overview'
import { summarizeFleetBilling } from '@/lib/host-billing'
import type { HostProfile } from '@/lib/hosts'

const makeHost = (overrides: Partial<HostProfile> = {}): HostProfile => ({
  id: 'h-bill',
  name: 'Tokyo VPS',
  address: '203.0.113.20',
  port: 22,
  username: 'root',
  group: 'Production',
  authType: 'privateKey',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('Host billing & expiry UI', () => {
  it('shows expiry badge on HostGridCard when billing expiresAt is configured', () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000)
    const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    const host = makeHost({
      billing: { provider: 'Bandwagon', price: 49.9, currency: 'USD', cycle: 'annual', expiresAt: iso },
    })

    render(
      <HostGridCard
        host={host}
        isSelected={false}
        status="online"
        onConnect={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    const badge = screen.getByTestId('host-billing-badge')
    expect(badge).toHaveAttribute('data-expiry-status', 'urgent')
  })

  it('shows interactive expiring pill and monthly cost summary on HostKpiRow', () => {
    const soon = new Date(Date.now() + 5 * 86_400_000)
    const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`
    const hosts = [
      makeHost({ id: 'h1', billing: { price: 120, currency: 'USD', cycle: 'annual', expiresAt: iso } }),
      makeHost({ id: 'h2', billing: { price: 10, currency: 'USD', cycle: 'monthly' } }),
    ]
    const onToggleExpiring = vi.fn()
    render(
      <HostKpiRow
        total={2}
        online={2}
        offline={0}
        stale={0}
        openAlerts={0}
        readings={hosts.map((host) => ({ host, cpu: 20, disk: 30 }))}
        billingSummary={summarizeFleetBilling(hosts)}
        expiringOnly={false}
        onToggleExpiring={onToggleExpiring}
      />,
    )

    const pill = screen.getByTestId('host-kpi-expiring')
    expect(pill).toBeInTheDocument()
    fireEvent.click(pill)
    expect(onToggleExpiring).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('host-kpis')).toHaveTextContent('$20')
  })
})
