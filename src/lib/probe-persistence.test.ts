import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { ProbeSnapshot } from './probe-provider'
import {
  deletePersistedProbeSnapshots,
  listPersistedProbeSnapshots,
  toPersistedProbeSnapshotPayload,
  upsertPersistedProbeSnapshot,
} from './probe-persistence'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const snapshot: ProbeSnapshot = {
  schemaVersion: 1,
  host: {
    hostId: 'host-1',
    address: '10.0.0.1',
    port: 22,
    username: 'ops',
    jump: { address: 'bastion.example', port: 2200, username: 'jump' },
  },
  provider: {
    kind: 'ssh-agentless',
    id: 'ssh-agentless',
    capabilities: ['metrics'],
  },
  transport: 'proxy-jump',
  health: 'online',
  receivedAt: 1_100,
  metrics: {
    data: { sampledAt: 1_000 } as never,
    source: { kind: 'ssh-agentless', id: 'ssh-agentless', capabilities: ['metrics'] },
    freshness: { sampledAt: 1_000, receivedAt: 1_100, ttlMs: 60_000, expiresAt: 61_000, expired: false, expiryReason: null },
    confidence: 'observed',
  },
  inventory: null,
  errors: [],
}

describe('Probe persistence adapter', () => {
  it('preserves provider, transport and freshness metadata without secrets', () => {
    const payload = toPersistedProbeSnapshotPayload(snapshot, 'vault-1', 1_200)
    expect(payload).toMatchObject({
      vaultId: 'vault-1',
      providerKind: 'ssh-agentless',
      providerId: 'ssh-agentless',
      hostId: 'host-1',
      sampledAt: 1_000,
      receivedAt: 1_100,
      expiresAt: 61_000,
      updatedAt: 1_200,
    })
    expect(JSON.stringify(payload)).not.toContain('secret')
    expect(payload.snapshot.transport).toBe('proxy-jump')
    expect(payload.snapshot.host.jump).toMatchObject({ address: 'bastion.example', port: 2200 })
  })

  it('normalizes list and delete query values before invoking Rust commands', async () => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue([])
    await listPersistedProbeSnapshots({ vaultId: ' vault-1 ', providerKind: ' ssh-agentless ', providerId: ' ', hostId: ' host-1 ' })
    expect(invoke).toHaveBeenNthCalledWith(1, 'list_probe_snapshots', {
      query: { vaultId: 'vault-1', providerKind: 'ssh-agentless', providerId: null, hostId: 'host-1' },
    })

    await deletePersistedProbeSnapshots({ vaultId: ' vault-1 ', providerId: ' agent-1 ' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'delete_probe_snapshots', {
      query: { vaultId: 'vault-1', providerKind: null, providerId: 'agent-1', hostId: null },
    })
  })

  it('writes the canonical payload through the durable command', async () => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
    await upsertPersistedProbeSnapshot(snapshot, 'vault-1', 1_200)
    expect(invoke).toHaveBeenCalledWith('upsert_probe_snapshot', {
      payload: toPersistedProbeSnapshotPayload(snapshot, 'vault-1', 1_200),
    })
    expect(invoke).toHaveBeenCalledWith('append_provider_metric_history', { payload: { vaultId: 'vault-1', points: [expect.objectContaining({ providerKind: 'ssh-agentless', hostId: 'host-1', sampledAt: 1_000, expiresAt: 61_000 })] } })
  })

  it('rejects missing provider and host identity before writing', () => {
    expect(() => toPersistedProbeSnapshotPayload({
      ...snapshot,
      provider: { ...snapshot.provider, id: ' ' },
    }, 'vault-1')).toThrow('Probe provider id is required')
    expect(() => toPersistedProbeSnapshotPayload({
      ...snapshot,
      host: { ...snapshot.host, hostId: ' ' },
    }, 'vault-1')).toThrow('Probe host id is required')
  })
})
