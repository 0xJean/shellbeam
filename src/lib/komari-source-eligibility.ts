import { isUnverifiedKomariRuleAlert } from './komari-alert-incidents'
import { normalizeKomariEndpoint } from './komari'
import { parseKomariAlertState, type KomariAlertRecord } from './komari-alerts'
import { listKomariIntegrations, type KomariIntegration } from './komari-config'
import { confirmedKomariSyncAt, getKomariMappingState, loadKomariPersistence, type KomariPersistedState } from './komari-persistence'
import type { HostProfile } from './hosts'
import type { ProbeSnapshot } from './probe-provider'

export interface CurrentKomariSource {
  integration: KomariIntegration
  state: KomariPersistedState | null
  /** Zero proves that no authoritative mapping edit has ever been recorded.
   * Missing/unreadable revisions must not revive a legacy association. */
  mappingRevision?: number
  error: boolean
}

export async function loadCurrentKomariSource(integration: KomariIntegration): Promise<CurrentKomariSource> {
  try {
    const [state, mapping] = await Promise.all([
      loadKomariPersistence(integration.id),
      getKomariMappingState(integration.vaultId, integration.id),
    ])
    if (!Number.isSafeInteger(mapping.revision) || mapping.revision < 0 || !Array.isArray(mapping.mappings)) throw new Error('KOMARI_MAPPING_READ_FAILED')
    return { integration, state: { ...state, mappings: mapping.mappings }, mappingRevision: mapping.revision, error: false }
  } catch {
    return { integration, state: null, error: true }
  }
}

export async function loadCurrentKomariSources(vaultIds: readonly string[]): Promise<CurrentKomariSource[]> {
  return (await Promise.all([...new Set(vaultIds)].map(async (vaultId) => {
    const integrations = await listKomariIntegrations(vaultId).catch(() => [])
    return Promise.all(integrations.filter((integration) => integration.vaultId === vaultId && integration.enabled).map(loadCurrentKomariSource))
  }))).flat()
}

function sourceFor(host: HostProfile, integrationId: string, sources: readonly CurrentKomariSource[]) {
  return sources.find((entry) => entry.integration.id === integrationId && entry.integration.enabled
    && Boolean(host.vaultId) && entry.integration.vaultId === host.vaultId && entry.state && !entry.error)
}

function mapped(entry: CurrentKomariSource, hostId: string, nodeId: string) {
  return entry.state!.mappings.some((mapping) => mapping.integrationId === entry.integration.id
    && mapping.hostId === hostId && mapping.nodeId === nodeId)
}

/** Current presentation only. This never rewrites snapshots or audit history. */
export function isCurrentKomariSnapshot(snapshot: ProbeSnapshot, host: HostProfile, sources: readonly CurrentKomariSource[]): boolean {
  if (snapshot.provider.kind !== 'komari' || snapshot.host.hostId !== host.id) return false
  const entry = sourceFor(host, snapshot.provider.id, sources)
  const nodeId = snapshot.provider.nodeId?.trim()
  if (!entry || !nodeId) return false
  const legacy = entry.mappingRevision === 0 && entry.state!.mappings.length === 0
  if (!mapped(entry, host.id, nodeId) && !legacy) return false
  if (snapshot.provider.endpoint) {
    try { return normalizeKomariEndpoint(snapshot.provider.endpoint) === normalizeKomariEndpoint(entry.integration.endpoint) }
    catch { return false }
  }
  // Old canonical rows omitted the endpoint. Only an untouched legacy
  // association whose observation follows the config can still establish it.
  return legacy && snapshot.receivedAt >= entry.integration.updatedAt
}

export function isCurrentKomariAlert(alert: KomariAlertRecord, host: HostProfile, sources: readonly CurrentKomariSource[], snapshots: readonly ProbeSnapshot[]): boolean {
  if (isUnverifiedKomariRuleAlert(alert)) return false
  const entry = sourceFor(host, alert.integrationId, sources)
  if (!entry || (alert.hostId && alert.hostId !== host.id)) return false
  if (alert.kind === 'server-load') {
    const evidence = alert.loadEvidence
    if (!evidence || evidence.hostCreatedAt !== host.createdAt || !alert.nodeId || !mapped(entry, host.id, alert.nodeId)) return false
    try { return evidence.endpoint === normalizeKomariEndpoint(entry.integration.endpoint) } catch { return false }
  }
  const baselines = parseKomariAlertState(entry.state?.syncState?.alertSummary)?.probeBaselines ?? []
  const matchingBaselines = baselines.filter(baseline => baseline.integrationId === alert.integrationId
    && baseline.hostId === host.id && (!alert.nodeId || baseline.nodeId === alert.nodeId)
    && baseline.endpoint && mapped(entry, host.id, baseline.nodeId))
  const storedSnapshots = (entry.state?.snapshots ?? []).filter(row => row.integrationId === alert.integrationId
    && row.hostId === host.id && row.snapshot.host.hostId === row.hostId && row.snapshot.provider.id === row.integrationId
    && row.snapshot.provider.kind === 'komari' && row.snapshot.provider.nodeId === row.nodeId).map(row => row.snapshot)
  const matchingSnapshots = [...snapshots, ...storedSnapshots]
    .filter(snapshot => snapshot.provider.kind === 'komari' && snapshot.provider.id === alert.integrationId
      && snapshot.host.hostId === host.id && (!alert.nodeId || snapshot.provider.nodeId === alert.nodeId))
  let endpoint: string
  try { endpoint = normalizeKomariEndpoint(entry.integration.endpoint) } catch { return false }
  const evidence = [
    ...matchingBaselines.map(baseline => ({ endpoint: baseline.endpoint, at: baseline.lastHealthySampledAt })),
    ...matchingSnapshots.map(snapshot => ({ endpoint: snapshot.provider.endpoint, at: snapshot.receivedAt })),
  ].flatMap(value => {
    // A later sample belongs to the current source, but cannot establish
    // where an older lifecycle record originated.
    if (!value.endpoint || !Number.isFinite(value.at) || value.at <= 0 || value.at > alert.lastSeenAt) return []
    try { return [{ endpoint: normalizeKomariEndpoint(value.endpoint), at: value.at }] } catch { return [] }
  })
  // Evidence already belonging to this endpoint before the metadata edit
  // preserves a rename. Samples arriving after an endpoint edit still need
  // the committed-sync check below when an older server is in the journal.
  const priorCurrentEvidenceAt = Math.max(0, ...evidence.filter(value => value.endpoint === endpoint
    && value.at < entry.integration.updatedAt).map(value => value.at))
  const foreignEvidenceAt = Math.max(0, ...evidence.filter(value => value.endpoint !== endpoint).map(value => value.at))
  if (foreignEvidenceAt > 0 && foreignEvidenceAt >= priorCurrentEvidenceAt) {
    // Retained A provenance cannot be overridden by B's newer canonical
    // sample alone. A committed sync for B plus a newly observed lifecycle
    // can establish B even when its first collection failed before a healthy
    // baseline existed. Cache reconciliation may advance lastSeenAt after
    // that sync, so it has no upper bound at the commit timestamp.
    const syncedAt = confirmedKomariSyncAt(entry.integration, entry.state?.syncState)
    if (syncedAt === null || !Number.isFinite(alert.lastSeenAt) || alert.lastSeenAt < entry.integration.updatedAt) return false
  }
  // Config updatedAt also changes on rename/credential edits. It cannot
  // invalidate an older incident or prove that it belongs to a new endpoint.
  if (matchingSnapshots.some(snapshot => isCurrentKomariSnapshot(snapshot, host, sources))) return true
  // A retained baseline may prove provenance after a latest-cache reset, but
  // never overrides a removed/reassigned mapping or a changed server address.
  return matchingBaselines.some((baseline) => {
    try { return normalizeKomariEndpoint(baseline.endpoint!) === endpoint }
    catch { return false }
  })
}
