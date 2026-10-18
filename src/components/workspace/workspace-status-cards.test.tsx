import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerMonitorHostKey } from '@/lib/server-monitor'
import { clearServerMonitorStates, mergeServerMonitorStates } from '@/lib/server-monitor-state'
import { WorkspaceStatusCards } from './workspace-status-cards'
import { WorkspaceMobileShell } from './workspace-mobile-shell'
import { listPersistedProbeSnapshots, toPersistedProbeSnapshotPayload, type PersistedProbeSnapshotRecord } from '@/lib/probe-persistence'
import { createProbeObservation, type ProbeSnapshot } from '@/lib/probe-provider'
import { invoke } from '@tauri-apps/api/core'

vi.mock('./shellbeam-agent-panel', () => ({ ShellbeamAgentPanel: () => null }))
vi.mock('@/lib/probe-persistence', async (original) => ({ ...await original<typeof import('@/lib/probe-persistence')>(), listPersistedProbeSnapshots: vi.fn(async () => []) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const host = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.15',
  port: 22,
  username: 'root',
  group: 'Default',
  authType: 'password' as const,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
}

const snapshot = {
  hostname: 'prod-api',
  os: 'Ubuntu 24.04 LTS',
  kernel: 'Linux 6.8',
  uptimeSeconds: 86400,
  cpuPercent: 23,
  load1: 0.5,
  load5: 0.4,
  load15: 0.3,
  memoryUsedBytes: 640,
  memoryTotalBytes: 1000,
  memoryPercent: 61,
  diskUsedBytes: 740,
  diskTotalBytes: 1000,
  diskPercent: 74,
  networkRxBytesPerSec: 18.4 * 1024 * 1024,
  networkTxBytesPerSec: 4 * 1024 * 1024,
  latencyMs: 14,
  sampledAt: Date.now(),
}

describe('workspace status cards', () => {
  beforeEach(() => {
    clearServerMonitorStates()
    localStorage.removeItem('shellbeam.locale')
    vi.mocked(listPersistedProbeSnapshots).mockReset().mockResolvedValue([])
    vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
      if (command === 'list_komari_integrations') return [{ id: 'komari-a', vaultId: 'active', name: 'Komari', endpoint: 'https://komari.test', credentialRef: 'komari-a.api-key', enabled: true, createdAt: 1, updatedAt: 1 }]
      if (command === 'list_komari_mappings') return [{ integrationId: 'komari-a', hostId: host.id, nodeId: 'node-a', source: 'manual', confidence: 'explicit', updatedAt: Date.now() }]
      if (command === 'get_komari_sync_state') return { integrationId: 'komari-a', lastSyncedAt: Date.now() - 2000, ttlMs: 60_000, updatedAt: Date.now(), alertSummary: null }
      return []
    })
  })
  afterEach(() => vi.useRealTimers())

  it('ages a persisted online sample to stale without another SSH request', () => {
    vi.useFakeTimers()
    const sampledAt = Date.now()
    const key = getServerMonitorHostKey(host)
    mergeServerMonitorStates({ [key]: { history: [], latest: {
      hostKey: key, hostId: host.id, hostName: host.name, hostAddress: host.address,
      username: host.username, port: host.port, status: 'online', snapshot: { ...snapshot, sampledAt },
      lastAttemptAt: sampledAt, lastSuccessAt: sampledAt, updatedAt: sampledAt,
    } } })
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'online')
    act(() => vi.advanceTimersByTime(150_000))
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'stale')
    expect(screen.getAllByText('Data stale')).not.toHaveLength(0)
    expect(screen.getByText('23%')).toBeInTheDocument()
  })

  it('shows live telemetry values from the shared monitor state', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'online',
          snapshot,
          lastAttemptAt: snapshot.sampledAt,
          lastSuccessAt: snapshot.sampledAt,
          probeTelemetry: {
            status: 'recovered',
            startedAt: snapshot.sampledAt - 180,
            completedAt: snapshot.sampledAt,
            durationMs: 180,
            attempts: 1,
            maxRetries: 2,
            retryDelayMs: 150,
            recovered: true,
            exhausted: false,
            sections: ['metrics'],
          },
          updatedAt: snapshot.sampledAt,
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getByText('23%')).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
    expect(screen.getByText('74%')).toBeInTheDocument()
    expect(screen.getByText(/↓ 18 MB\/s/)).toBeInTheDocument()
    expect(screen.getAllByText('Online').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'online')
    expect(screen.getAllByTestId('workspace-probe-telemetry')).toHaveLength(4)
    expect(screen.getAllByTestId('workspace-probe-telemetry')[0]).toHaveTextContent('Recovered from cache')
    expect(screen.getAllByTestId('workspace-probe-telemetry')[0]).toHaveTextContent('1 retries')
  })

  it.each(['cards', 'mobile Overview'] as const)('shows current Komari metrics while retaining failed SSH separately in %s', async (presentation) => {
    const scoped = { ...host, vaultId: 'active' }
    const sampledAt = Date.now() - 5000
    const source = { kind: 'komari' as const, id: 'komari-a', nodeId: 'node-a', capabilities: ['metrics' as const] }
    const probe: ProbeSnapshot = {
      schemaVersion: 1, host: { hostId: host.id, address: host.address, port: host.port, username: host.username },
      provider: { ...source, capabilities: [...source.capabilities] }, health: 'online', transport: 'direct', receivedAt: sampledAt + 1000,
      metrics: createProbeObservation({ data: { ...snapshot, cpuPercent: 57, diskPercent: null, sampledAt }, source: { ...source, capabilities: [...source.capabilities] }, sampledAt, receivedAt: sampledAt + 1000, ttlMs: 60_000, confidence: 'partial' }),
      inventory: null, errors: [],
    }
    vi.mocked(listPersistedProbeSnapshots).mockResolvedValue([toPersistedProbeSnapshotPayload(probe, 'active') as PersistedProbeSnapshotRecord])
    const key = getServerMonitorHostKey(scoped)
    mergeServerMonitorStates({ [key]: { history: [], latest: {
      hostKey: key, hostId: host.id, hostName: host.name, hostAddress: host.address, port: host.port, username: host.username,
      status: 'offline', snapshot: null, updatedAt: sampledAt, lastAttemptAt: sampledAt, lastSuccessAt: null,
      probeTelemetry: { status: 'failed', startedAt: sampledAt, completedAt: sampledAt, durationMs: 200, attempts: 2, maxRetries: 2, retryDelayMs: 150, exhausted: true, recovered: false, sections: ['metrics'] },
    } } })
    await act(async () => { render(presentation === 'cards'
      ? <WorkspaceStatusCards activeVaultId="active" hostAddress={host.address} selectedHostId={host.id} hosts={[scoped]} />
      : <WorkspaceMobileShell activeVaultId="active" sessionId="session-a" hostName={host.name} hostAddress={host.address} hostId={host.id} hosts={[scoped]} activeApp="overview" onSelectApp={() => {}} />) })
    const cards = screen.getAllByTestId('workspace-status-card')
    expect(within(cards[0]).getByText('57%')).toBeInTheDocument()
    expect(cards[0]).toHaveAttribute('data-provider', 'komari')
    expect(cards[0]).toHaveAttribute('data-status', 'online')
    expect(within(cards[2]).getByText('Unavailable')).toBeInTheDocument()
    expect(within(cards[2]).getByTestId('workspace-status-meter').firstElementChild).toHaveStyle({ width: '0%' })
    expect(screen.queryByTestId('workspace-probe-telemetry')).not.toBeInTheDocument()
    const selected = screen.getAllByTestId('workspace-provider-source').find((row) => row.dataset.selected === 'true')!
    expect(selected).toHaveAttribute('data-provider', 'komari')
    expect(within(selected).getByText('Partial')).toBeInTheDocument()
    expect(within(selected).getByLabelText('Provider capabilities')).not.toHaveTextContent('Services')
    expect(screen.getAllByTestId('workspace-provider-source').find((row) => row.dataset.provider === 'ssh-agentless')).toHaveAttribute('data-health', 'offline')
  })

  it('falls back gracefully when no host is selected', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={null} hosts={[host]} />)

    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'idle')
  })

  it('uses only the active Vault observation when host IDs collide', async () => {
    const vaultHost = { ...host, vaultId: 'active' }
    const otherHost = { ...host, vaultId: 'other', address: '10.0.0.99' }
    for (const [candidate, cpu] of [[host, 99], [otherHost, 88], [vaultHost, 37]] as const) {
      const key = getServerMonitorHostKey(candidate)
      mergeServerMonitorStates({ [key]: { history: [], latest: {
        hostKey: key, hostId: candidate.id, hostName: candidate.name, hostAddress: candidate.address,
        username: candidate.username, port: candidate.port, status: 'online', snapshot: { ...snapshot, cpuPercent: cpu },
        lastAttemptAt: snapshot.sampledAt, lastSuccessAt: snapshot.sampledAt, updatedAt: snapshot.sampledAt,
      } } })
    }
    const view = await act(async () => render(<WorkspaceStatusCards activeVaultId="active" hostAddress={host.address} selectedHostId={host.id} hosts={[otherHost, host]} />))
    expect(screen.getByText('37%')).toBeInTheDocument()
    expect(screen.queryByText('99%')).not.toBeInTheDocument()
    expect(screen.queryByText('88%')).not.toBeInTheDocument()
    await act(async () => view.rerender(<WorkspaceStatusCards activeVaultId="missing" hostAddress={host.address} selectedHostId={host.id} hosts={[otherHost, host]} />))
    expect(screen.queryByText('37%')).not.toBeInTheDocument()
    expect(screen.queryByText('99%')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'idle')
  })

  it('matches the current host address when host id is unavailable', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'stale',
          snapshot: { ...snapshot, cpuPercent: 31 },
          lastAttemptAt: snapshot.sampledAt,
          lastSuccessAt: snapshot.sampledAt,
          updatedAt: snapshot.sampledAt,
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={null} hosts={[host]} />)

    expect(screen.getByText('31%')).toBeInTheDocument()
    expect(screen.getAllByText('Data stale').length).toBeGreaterThan(0)
  })

  it('shows offline status without launching another SSH request', () => {
    mergeServerMonitorStates({
      [getServerMonitorHostKey(host)]: {
        latest: {
          hostKey: getServerMonitorHostKey(host),
          hostId: host.id,
          hostName: host.name,
          hostAddress: host.address,
          username: host.username,
          port: host.port,
          status: 'offline',
          snapshot: null,
          lastAttemptAt: Date.now(),
          lastSuccessAt: null,
          error: 'TCP connect failed: timed out',
          updatedAt: Date.now(),
        },
        history: [],
      },
    })

    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getAllByText('Offline').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveAttribute('data-status', 'offline')
  })

  it('uses a container-adaptive grid so four cards reflow inside narrow widgets', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getByTestId('workspace-status-grid')).toHaveClass('grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]')
    expect(screen.getAllByTestId('workspace-status-card')).toHaveLength(4)
  })

  it('uses the darker workspace monitor card styling from the visual language spec', () => {
    render(<WorkspaceStatusCards hostAddress={host.address} selectedHostId={host.id} hosts={[host]} />)

    expect(screen.getAllByTestId('workspace-status-card')[0]).toHaveClass('bg-[var(--workspace-surface-900)]')
    expect(screen.getAllByTestId('workspace-status-meter')[0]).toHaveClass('bg-[var(--workspace-surface-950)]')
  })
})
