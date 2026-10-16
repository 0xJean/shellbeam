import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  loadKomariPersistence,
  persistKomariSync,
  toKomariMappingPayload,
  toKomariSnapshotPayload,
} from './komari-persistence'
import type { ProbeSnapshot } from './probe-provider'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const snapshot: ProbeSnapshot = {
  schemaVersion: 1,
  host: { hostId: 'host-1', address: '10.0.0.1', port: 22, username: 'ops' },
  provider: {
    kind: 'komari',
    id: 'integration-1',
    nodeId: 'node-1',
    capabilities: ['metrics'],
  },
  transport: 'direct',
  health: 'online',
  receivedAt: 1_100,
  metrics: {
    data: { sampledAt: 1_000, cpuPercent: 33 } as never,
    source: {
      kind: 'komari',
      id: 'integration-1',
      nodeId: 'node-1',
      capabilities: ['metrics'],
    },
    freshness: { sampledAt: 1_000, receivedAt: 1_100, ttlMs: 120_000, expiresAt: 121_000, expired: false },
    confidence: 'observed',
  },
  inventory: null,
  errors: [],
}

describe('Komari persistence adapter', () => {
  it('converts ProbeSnapshot to a durable row while retaining freshness', () => {
    expect(toKomariSnapshotPayload(snapshot, 1_200)).toEqual({
      integrationId: 'integration-1',
      nodeId: 'node-1',
      hostId: 'host-1',
      snapshot,
      sampledAt: 1_000,
      receivedAt: 1_100,
      expiresAt: 121_000,
      updatedAt: 1_200,
    })
  })

  it('normalizes mapping payloads for the Rust command', () => {
    expect(toKomariMappingPayload('integration-1', {
      hostId: 'host-1',
      nodeId: 'node-1',
      source: 'address',
      confidence: 'matched',
      updatedAt: 1_200,
    })).toEqual({
      integrationId: 'integration-1',
      hostId: 'host-1',
      nodeId: 'node-1',
      source: 'address',
      confidence: 'matched',
      updatedAt: 1_200,
    })
  })

  it('persists snapshots and mappings atomically through one invoke', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await persistKomariSync({
      integrationId: 'integration-1',
      snapshots: [snapshot],
      mappings: [{ hostId: 'host-1', nodeId: 'node-1', source: 'address', confidence: 'matched', updatedAt: 1_200 }],
      updatedAt: 1_200,
    })
    expect(invoke).toHaveBeenCalledWith('persist_komari_sync', {
      payload: expect.objectContaining({ integrationId: 'integration-1' }),
    })
    const call = vi.mocked(invoke).mock.calls.at(-1)?.[1] as { payload: { snapshots: unknown[]; mappings: unknown[] } }
    expect(call.payload.snapshots).toHaveLength(1)
    expect(call.payload.mappings).toHaveLength(1)
  })

  it('derives a sync TTL timestamp from the newest persisted row', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([{ ...toKomariSnapshotPayload(snapshot, 1_200) }])
      .mockResolvedValueOnce([{ integrationId: 'integration-1', hostId: 'host-1', nodeId: 'node-1', source: 'address', confidence: 'matched', updatedAt: 1_300 }])
    await expect(loadKomariPersistence('integration-1')).resolves.toMatchObject({ lastSyncedAt: 1_300 })
  })
})
