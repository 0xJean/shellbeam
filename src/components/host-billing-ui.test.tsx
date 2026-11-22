import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostGridCard } from './host-card'
import { HostDirectoryEditor } from './host-directory-editor'
import { HostKpiRow } from './hosts-overview'
import { summarizeFleetBilling } from '@/lib/host-billing'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'

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

  it('supports adding, updating, and clearing billing on saved hosts via HostDirectoryEditor', async () => {
    const saved = makeHost({
      privateKeyRef: 'k1',
      billing: { provider: 'Vultr', price: 12, currency: 'USD', cycle: 'monthly', expiresAt: '2026-12-01' },
    })
    const onSubmit = vi.fn<(draft: HostProfileDraft) => Promise<void>>(async () => {})

    const { rerender } = render(
      <HostDirectoryEditor
        host={saved}
        vaultUnlocked
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    // Existing billing starts expanded and can be updated.
    const expiresInput = screen.getByTestId('host-billing-expires') as HTMLInputElement
    expect(expiresInput.value).toBe('2026-12-01')
    fireEvent.change(expiresInput, { target: { value: '2027-12-01' } })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].billing?.expiresAt).toBe('2027-12-01')

    // Clearing all billing fields removes billing cleanly.
    rerender(
      <HostDirectoryEditor
        key="clear"
        host={saved}
        vaultUnlocked
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByTestId('host-billing-provider'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('host-billing-price'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('host-billing-expires'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit.mock.calls[1][0].billing).toBeUndefined()
  })

  it('rejects negative billing price or quota instead of silently clearing saved values', async () => {
    const saved = makeHost({
      privateKeyRef: 'k1',
      billing: { provider: 'Vultr', price: 12, currency: 'USD', cycle: 'monthly', monthlyTrafficGb: 1000 },
    })
    const onSubmit = vi.fn<(draft: HostProfileDraft) => Promise<void>>(async () => {})

    render(
      <HostDirectoryEditor
        host={saved}
        vaultUnlocked
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('host-billing-traffic'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: /save|保存/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
