import { invoke } from '@tauri-apps/api/core'
import type { KomariAlertSummary } from './komari'
import type { ProbeSnapshot } from './probe-provider'
import type { KomariHostMapping } from './komari-mapping'

/** A durable ProbeSnapshot row returned by the local Komari cache. */
export interface KomariSnapshotRecord {
  integrationId: string
  nodeId: string
  hostId: string
  snapshot: ProbeSnapshot
  sampledAt: number
  receivedAt: number
  expiresAt: number
  updatedAt: number
}

export interface KomariSnapshotPayload {
  integrationId: string
  nodeId: string
  hostId: string
  snapshot: ProbeSnapshot
  sampledAt: number
  receivedAt: number
  expiresAt: number
  updatedAt?: number
}

export interface KomariMappingRecord extends KomariHostMapping {
  integrationId: string
}

export interface KomariMappingPayload {
  integrationId: string
  hostId: string
  nodeId: string
  source: KomariHostMapping['source']
  confidence: KomariHostMapping['confidence']
  updatedAt?: number
}

export interface KomariPersistedState {
  snapshots: KomariSnapshotRecord[]
  mappings: KomariMappingRecord[]
  syncState: KomariSyncState | null
  /** The newest local write, suitable for the sync TTL check. */
  lastSyncedAt: number | null
}

export interface KomariSyncState {
  integrationId: string
  lastSyncedAt: number
  ttlMs: number
  alertSummary: Record<string, unknown> | null
  updatedAt: number
}

export interface KomariSyncStatePayload {
  integrationId: string
  lastSyncedAt: number
  ttlMs: number
  alertSummary?: KomariAlertSummary | null
  updatedAt?: number
}

function required(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Komari ${field} is required`)
  return normalized
}

function integrationIdFromSnapshot(snapshot: ProbeSnapshot) {
  const integrationId = snapshot.provider.id.trim()
  const nodeId = snapshot.provider.nodeId?.trim()
  if (!integrationId) throw new Error('Komari integration id is required')
  if (!nodeId) throw new Error('Komari snapshot node id is required')
  return { integrationId, nodeId }
}

/** Convert a provider result to the durable row used by the Rust cache. */
export function toKomariSnapshotPayload(
  snapshot: ProbeSnapshot,
  updatedAt = Date.now(),
): KomariSnapshotPayload {
  const { integrationId, nodeId } = integrationIdFromSnapshot(snapshot)
  const observation = snapshot.metrics ?? snapshot.inventory
  const sampledAt = observation?.freshness.sampledAt ?? snapshot.receivedAt
  const expiresAt = observation?.freshness.expiresAt ?? snapshot.receivedAt
  return {
    integrationId,
    nodeId,
    hostId: required(snapshot.host.hostId, 'host id'),
    snapshot,
    sampledAt,
    receivedAt: snapshot.receivedAt,
    expiresAt,
    updatedAt,
  }
}

export function toKomariMappingPayload(
  integrationId: string,
  mapping: KomariHostMapping,
): KomariMappingPayload {
  return {
    integrationId: required(integrationId, 'integration id'),
    hostId: required(mapping.hostId, 'host id'),
    nodeId: required(mapping.nodeId, 'node id'),
    source: mapping.source,
    confidence: mapping.confidence,
    updatedAt: mapping.updatedAt,
  }
}

export async function listKomariSnapshots(integrationId?: string): Promise<KomariSnapshotRecord[]> {
  return invoke<KomariSnapshotRecord[]>('list_komari_snapshots', {
    integrationId: integrationId?.trim() || null,
  })
}

export async function upsertKomariSnapshot(payload: KomariSnapshotPayload): Promise<void> {
  return invoke<void>('upsert_komari_snapshot', { payload })
}

export async function listKomariMappings(integrationId?: string): Promise<KomariMappingRecord[]> {
  return invoke<KomariMappingRecord[]>('list_komari_mappings', {
    integrationId: integrationId?.trim() || null,
  })
}

export async function loadKomariPersistence(integrationId: string): Promise<KomariPersistedState> {
  const [snapshots, mappings, syncState] = await Promise.all([
    listKomariSnapshots(integrationId),
    listKomariMappings(integrationId),
    getKomariSyncState(integrationId),
  ])
  const updatedAt = snapshots.map((snapshot) => snapshot.updatedAt)
  updatedAt.push(...mappings.map((mapping) => mapping.updatedAt))
  return {
    snapshots,
    mappings,
    syncState,
    lastSyncedAt: syncState?.lastSyncedAt ?? (updatedAt.length > 0 ? Math.max(...updatedAt) : null),
  }
}

export async function getKomariSyncState(integrationId: string): Promise<KomariSyncState | null> {
  return invoke<KomariSyncState | null>('get_komari_sync_state', {
    integrationId: required(integrationId, 'integration id'),
  })
}

export async function upsertKomariSyncState(payload: KomariSyncStatePayload): Promise<void> {
  return invoke<void>('upsert_komari_sync_state', { payload })
}

export async function upsertKomariMapping(payload: KomariMappingPayload): Promise<void> {
  return invoke<void>('upsert_komari_mapping', { payload })
}

export async function replaceKomariMappings(
  integrationId: string,
  mappings: KomariHostMapping[],
): Promise<void> {
  const normalizedIntegrationId = required(integrationId, 'integration id')
  return invoke<void>('replace_komari_mappings', {
    payload: {
      integrationId: normalizedIntegrationId,
      mappings: mappings.map((mapping) => toKomariMappingPayload(normalizedIntegrationId, mapping)),
    },
  })
}

/** Persist one complete sync in a single SQLite transaction. */
export async function persistKomariSync(options: {
  integrationId: string
  snapshots: ProbeSnapshot[]
  mappings: KomariHostMapping[]
  updatedAt?: number
  ttlMs?: number
  alertSummary?: KomariAlertSummary | null
}): Promise<void> {
  const integrationId = required(options.integrationId, 'integration id')
  const updatedAt = options.updatedAt ?? Date.now()
  return invoke<void>('persist_komari_sync', {
    payload: {
      integrationId,
      lastSyncedAt: updatedAt,
      ttlMs: options.ttlMs ?? 60_000,
      alertSummary: options.alertSummary ?? null,
      snapshots: options.snapshots.map((snapshot) => {
        const payload = toKomariSnapshotPayload(snapshot, updatedAt)
        if (payload.integrationId !== integrationId) {
          throw new Error('Komari snapshot integration does not match the sync')
        }
        return payload
      }),
      mappings: options.mappings.map((mapping) => toKomariMappingPayload(integrationId, mapping)),
    },
  })
}

export async function clearKomariPersistence(integrationId?: string): Promise<void> {
  return invoke<void>('clear_komari_persistence', {
    integrationId: integrationId?.trim() || null,
  })
}
