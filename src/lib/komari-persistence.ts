import { notifyHostMetadataChanged } from './host-metadata-sync'
import type { HostProfile } from './hosts'
import { invoke } from '@tauri-apps/api/core'
import type { KomariAlertSummary } from './komari'
import {
  parseKomariAlertState,
  toKomariAlertStatePayload,
  type KomariAlertState,
} from './komari-alerts'
import type { ProbeSnapshot } from './probe-provider'
import type { KomariHostMapping } from './komari-mapping'
import type { KomariIntegration } from './komari-config'
import { getProbeProviderRegistry } from './probe-scheduler'

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

export interface KomariMappingState {
  mappings: KomariMappingRecord[]
  revision: number
}
export const KOMARI_MAPPING_CHANGED_EVENT = 'shellbeam:komari-mapping-changed'

export function manualKomariMappings(mappings: readonly KomariHostMapping[]): Record<string, string> {
  return Object.fromEntries(mappings.filter((mapping) => mapping.source === 'manual').map((mapping) => [mapping.hostId, mapping.nodeId]))
}

export async function getKomariMappingState(vaultId: string, integrationId: string): Promise<KomariMappingState> {
  return invoke<KomariMappingState>('get_komari_mapping_state', { vaultId: required(vaultId, 'vault id'), integrationId: required(integrationId, 'integration id') })
}

export async function editKomariMapping(options: { vaultId: string; integrationId: string; nodeId: string; hostId: string | null; expectedRevision: number }): Promise<KomariMappingState> {
  const saved = await invoke<KomariMappingState>('edit_komari_mapping', { payload: options })
  getProbeProviderRegistry().invalidateProvider(options.vaultId, options.integrationId)
  window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { vaultId: options.vaultId, integrationId: options.integrationId } }))
  window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))
  return saved
}

export async function importMonitoringHost(options: { vaultId: string; integrationId: string; nodeId: string; expectedRevision: number; expectedIntegrationVersion: number; name: string; group: string; tags: string[] }): Promise<HostProfile> {
  const host = await invoke<HostProfile>('import_monitoring_host', { payload: options })
  notifyHostMetadataChanged(options.vaultId)
  getProbeProviderRegistry().invalidateProvider(options.vaultId, options.integrationId)
  window.dispatchEvent(new CustomEvent(KOMARI_MAPPING_CHANGED_EVENT, { detail: { vaultId: options.vaultId, integrationId: options.integrationId } }))
  window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))
  return { ...host, vaultId: options.vaultId }
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
  /** Legacy TTL scheduling metadata; older local alert writes could set it. */
  lastSyncedAt: number
  /** Native provenance: only a committed remote sync may establish this. */
  lastSuccessfulSyncAt?: number | null
  ttlMs: number
  alertSummary: Record<string, unknown> | null
  updatedAt: number
}

/** Cache/mapping writes and legacy sync rows cannot prove a remote sync. */
export function confirmedKomariSyncAt(integration: KomariIntegration, state: KomariSyncState | null | undefined, now = Date.now()): number | null {
  const stamp = state?.lastSuccessfulSyncAt
  return state?.integrationId === integration.id && typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 && stamp <= now && stamp >= (integration.updatedAt ?? 0) ? stamp : null
}

export interface KomariSyncStatePayload {
  integrationId: string
  lastSyncedAt: number
  ttlMs: number
  alertSummary?: KomariAlertSummary | Record<string, unknown> | null
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

/** Read the lifecycle state embedded in the sync state's alert summary. Older
 * caches only contain aggregate counts and intentionally return null. */
export function readKomariAlertState(syncState: KomariSyncState | null | undefined): KomariAlertState | null {
  return parseKomariAlertState(syncState?.alertSummary)
}

/** Persist the local alert lifecycle alongside the existing Komari sync state.
 * This keeps acknowledgement/recovery durable without adding a second
 * database or retaining remote notification payloads. */
export async function persistKomariAlertState(options: {
  integrationId: string
  state: Omit<KomariAlertState, 'schemaVersion'> | KomariAlertState
  /** Legacy scheduling hint only; this is never successful-sync provenance. */
  lastSyncedAt?: number
  ttlMs?: number
  updatedAt?: number
}): Promise<void> {
  const integrationId = required(options.integrationId, 'integration id')
  const current = await getKomariSyncState(integrationId)
  const now = options.updatedAt ?? Date.now()
  return upsertKomariSyncState({
    integrationId,
    // Preserve the existing TTL scheduling behavior. Native storage keeps the
    // independent lastSuccessfulSyncAt untouched by this local-only write.
    lastSyncedAt: options.lastSyncedAt ?? current?.lastSyncedAt ?? now,
    ttlMs: options.ttlMs ?? current?.ttlMs ?? 60_000,
    alertSummary: toKomariAlertStatePayload({ schemaVersion: 1, ...options.state }),
    updatedAt: now,
  })
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
  vaultId?: string
  expectedMappingRevision?: number
  snapshots: ProbeSnapshot[]
  mappings: KomariHostMapping[]
  updatedAt?: number
  ttlMs?: number
  alertSummary?: KomariAlertSummary | null
  alertState?: KomariAlertState | null
}): Promise<void> {
  const integrationId = required(options.integrationId, 'integration id')
  const updatedAt = options.updatedAt ?? Date.now()
  return invoke<void>('persist_komari_sync', {
    payload: {
      integrationId,
      ...(options.vaultId ? { vaultId: options.vaultId } : {}),
      ...(options.expectedMappingRevision === undefined ? {} : { expectedMappingRevision: options.expectedMappingRevision }),
      lastSyncedAt: updatedAt,
      ttlMs: options.ttlMs ?? 60_000,
      alertSummary: options.alertState
        ? toKomariAlertStatePayload(options.alertState)
        : options.alertSummary ?? null,
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
