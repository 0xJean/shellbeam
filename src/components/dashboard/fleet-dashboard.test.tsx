import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { I18nProvider } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { buildHostOpsViews, loadHostOpsViews } from '@/lib/host-ops-view'
import { FleetDashboard } from './fleet-dashboard'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/hooks/use-host-network-metadata', () => ({ useHostNetworkMetadata: () => ({}) }))
vi.mock('@/lib/host-ops-view', async (original) => ({ ...await original<typeof import('@/lib/host-ops-view')>(), loadHostOpsViews: vi.fn() }))

const now = Date.now()
const hosts = ['web', 'db'].map((name, index) => ({ id: `h${index}`, vaultId: 'v', name, address: `10.0.0.${index}`, port: 22, username: 'ops', authType: 'password', group: '', tags: [], createdAt: 1, updatedAt: 1 })) as HostProfile[]
const sample = (hostId: string, sampledAt: number, cpuPercent: number, diskPercent: number) => ({ providerKind: 'ssh-agentless', providerId: 'p', hostId, nodeId: '', sampledAt, receivedAt: sampledAt, expiresAt: sampledAt + 60_000, confidence: 'high',
  metrics: { cpuPercent, memoryPercent: 40, diskPercent, load1: 1, load5: 1, load15: 1, networkRxBytesPerSec: 1024, networkTxBytesPerSec: 512, latencyMs: hostId === 'h0' ? 20 : 90, memoryUsedBytes: null, memoryTotalBytes: null, diskUsedBytes: null, diskTotalBytes: null, os: 'Ubuntu 22.04' } })

beforeEach(() => {
  localStorage.setItem('shellbeam.locale', 'en')
  vi.mocked(loadHostOpsViews).mockImplementation(async (profiles) => buildHostOpsViews({ hosts: profiles }))
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'list_provider_metric_history') return []
    const hostId = (args as { query: { hostId: string } }).query.hostId
    return hostId === 'h0' ? [sample('h0', now - 3_600_000, 30, 51), sample('h0', now - 60_000, 50, 52)] : [sample('h1', now - 60_000, 90, 93)]
  })
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('fleet dashboard', () => {
  it('summarises recorded history without inventing values', async () => {
    render(<I18nProvider><FleetDashboard hosts={hosts} vaultId="v" unlocked /></I18nProvider>)
    const kpis = await screen.findByTestId('fleet-kpis')
    await waitFor(() => expect(within(kpis).getByText('Peak 90% · db')).toBeInTheDocument())
    expect(within(kpis).getByText('70')).toBeInTheDocument()
    const disk = screen.getByTestId('fleet-disk-top')
    expect(within(disk).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['db93%', 'web52%'])
  })

  it('switches tabs and orders SSH latency from fastest', async () => {
    render(<I18nProvider><FleetDashboard hosts={hosts} vaultId="v" unlocked /></I18nProvider>)
    await screen.findByTestId('fleet-cluster-cpu')
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts & network' }))
    const latency = await screen.findByTestId('fleet-latency')
    await waitFor(() => expect(within(latency).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['web20', 'db90']))
    fireEvent.click(screen.getByRole('tab', { name: 'Assets & compliance' }))
    expect(screen.getByTestId('fleet-certs')).toHaveTextContent('Run a Sites & SSL scan')
    expect(screen.getByTestId('fleet-os')).not.toHaveTextContent('No samples')
  })
})
