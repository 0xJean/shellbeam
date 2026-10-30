import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { metricHistoryPaths, listProviderMetricHistory, type ProviderMetricHistoryPoint } from '@/lib/provider-history'
import { ProviderHistoryDisclosure, ProviderHistoryPanel } from './provider-history-panel'
vi.mock('@/lib/provider-history', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/provider-history')>(), listProviderMetricHistory: vi.fn() }))
const point = (at: number, cpu: number | null, providerId = 'komari-main') => ({ providerKind: 'komari', providerId, hostId: 'edge', nodeId: 'node-1', sampledAt: at, receivedAt: at + 10, expiresAt: at + 120000, confidence: 'partial', metrics: { cpuPercent: cpu, memoryPercent: null, diskPercent: 20, sampledAt: at } } as ProviderMetricHistoryPoint)
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('Provider metric history range view', () => {
  it('loads history only on request and hides pending previous-scope data after A → B → A', async () => {
    localStorage.setItem('shellbeam.locale', 'en')
    let resolvePrevious!: (points: ProviderMetricHistoryPoint[]) => void
    vi.mocked(listProviderMetricHistory).mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve })).mockResolvedValue([])
    const view = render(<ProviderHistoryDisclosure vaultId="vault-a" hostId="edge" />)
    expect(listProviderMetricHistory).not.toHaveBeenCalled()
    expect(screen.queryByTestId('provider-history-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Metric history' }))
    expect(listProviderMetricHistory).toHaveBeenCalledOnce()
    view.rerender(<ProviderHistoryDisclosure vaultId="vault-b" hostId="edge" />)
    expect(screen.queryByTestId('provider-history-panel')).not.toBeInTheDocument()
    view.rerender(<ProviderHistoryDisclosure vaultId="vault-a" hostId="edge" />)
    await act(async () => { resolvePrevious([point(Date.now(), 73)]) })
    expect(screen.queryByTestId('provider-history-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Metric history' })).toHaveAttribute('aria-expanded', 'false')
    expect(listProviderMetricHistory).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Metric history' }))
    await waitFor(() => expect(listProviderMetricHistory).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('CPU: 73.0%')).not.toBeInTheDocument()
  })
  it('queries the active vault and host, changes range and exposes provenance/unknown values', async () => {
    localStorage.setItem('shellbeam.locale', 'en')
    const now = Date.now(); vi.mocked(listProviderMetricHistory).mockResolvedValue([point(now - 1000, 25), point(now, 30)])
    render(<ProviderHistoryPanel vaultId="vault-a" hostId="edge" />)
    expect(await screen.findByRole('img', { name: /CPU, memory and disk/ })).toBeInTheDocument()
    expect(listProviderMetricHistory).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'vault-a', hostId: 'edge', limit: 2000 }))
    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveValue('komari:komari-main:node-1')
    expect(screen.getByRole('combobox', { name: 'Source' })).toHaveTextContent('Monitoring service · komari-main:node-1')
    expect(screen.getByText('Memory: unknown')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '7d' }))
    await waitFor(() => expect(listProviderMetricHistory).toHaveBeenCalledTimes(2))
    const query = vi.mocked(listProviderMetricHistory).mock.calls.at(-1)?.[0]
    expect((query?.to ?? 0) - (query?.from ?? 0)).toBe(7 * 24 * 3600000)
  })
  it('breaks graph paths at missing values and never plots missing data as zero', () => {
    const paths = metricHistoryPaths([point(1, 10), point(2, null), point(3, 20)], 'cpuPercent', 1, 3)
    expect(paths).toHaveLength(2)
    expect(paths[0]).toBe('M20.00,128.00')
    expect(paths[1]).toBe('M780.00,116.00')
  })
  it('preserves null gaps omitted by native downsampling even when endpoint TTLs overlap', () => {
    const next = { ...point(3, 20), gapBefore: ['cpuPercent' as const] }
    expect(metricHistoryPaths([point(1, 10), next], 'cpuPercent', 1, 3)).toHaveLength(2)
    expect(metricHistoryPaths([point(1, 10), next], 'diskPercent', 1, 3)).toHaveLength(1)
  })
  it('breaks lines after a sampling TTL expires instead of implying continued collection', () => {
    const paths = metricHistoryPaths([point(1, 10), point(300000, 20)], 'cpuPercent', 1, 300000)
    expect(paths).toHaveLength(2)
    expect(paths.every((path) => !path.includes(' L'))).toBe(true)
  })

})
