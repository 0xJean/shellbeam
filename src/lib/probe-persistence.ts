import { invoke } from '@tauri-apps/api/core'
import type { ProbeSnapshot } from './probe-provider'

/** Durable row for a canonical ProbeProvider snapshot. Secrets are never part
 * of the envelope; transport and provider metadata are safe to retain. */
export interface PersistedProbeSnapshotRecord {
  vaultId: string
  providerKind: string
  providerId: string
  hostId: string
  snapshot: ProbeSnapshot
  sampledAt: number
  receivedAt: number
  expiresAt: number
  updatedAt: number
}

export interface PersistedProbeSnapshotPayload {
  vaultId: string
  providerKind: string
  providerId: string
  hostId: string
  snapshot: ProbeSnapshot
  sampledAt: number
  receivedAt: number
  expiresAt: number
  updatedAt?: number
}

export interface ProbeSnapshotQuery {
  vaultId?: string
  providerKind?: string
  providerId?: string
  hostId?: string
}

function text(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Probe ${field} is required`)
  return normalized
}

function normalizedQuery(query: ProbeSnapshotQuery) {
  return {
    vaultId: text(query.vaultId ?? '', 'vault id'),
    providerKind: query.providerKind?.trim() || null,
    providerId: query.providerId?.trim() || null,
    hostId: query.hostId?.trim() || null,
  }
}

export function toPersistedProbeSnapshotPayload(
  snapshot: ProbeSnapshot,
  vaultId: string,
  updatedAt = Date.now(),
): PersistedProbeSnapshotPayload {
  const observation = snapshot.metrics ?? snapshot.inventory
  return {
    vaultId: text(vaultId, 'vault id'),
    providerKind: text(snapshot.provider.kind, 'provider kind'),
    providerId: text(snapshot.provider.id, 'provider id'),
    hostId: text(snapshot.host.hostId, 'host id'),
    snapshot,
    sampledAt: observation?.freshness.sampledAt ?? snapshot.receivedAt,
    receivedAt: snapshot.receivedAt,
    expiresAt: observation?.freshness.expiresAt ?? snapshot.receivedAt,
    updatedAt,
  }
}

export async function listPersistedProbeSnapshots(
  query: ProbeSnapshotQuery,
): Promise<PersistedProbeSnapshotRecord[]> {
  return invoke<PersistedProbeSnapshotRecord[]>('list_probe_snapshots', { query: normalizedQuery(query) })
}

export async function upsertPersistedProbeSnapshot(
  snapshot: ProbeSnapshot,
  vaultId: string,
  updatedAt = Date.now(),
): Promise<void> {
  return invoke<void>('upsert_probe_snapshot', {
    payload: toPersistedProbeSnapshotPayload(snapshot, vaultId, updatedAt),
  })
}

export async function deletePersistedProbeSnapshots(
  query: ProbeSnapshotQuery,
): Promise<void> {
  return invoke<void>('delete_probe_snapshots', { query: normalizedQuery(query) })
}
