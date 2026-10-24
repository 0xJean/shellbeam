import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { COLLECTION_LIMITS } from './collection-limits'
import { buildHostOpsViews, type HostOpsHealthState, type HostOpsProvider, type HostOpsView } from './host-ops-view'
import type { HostProfile } from './hosts'
import { getHostIdentity } from './host-identity'
import { listKomariIntegrations } from './komari-config'
import { isCurrentKomariSnapshot, loadCurrentKomariSource, type CurrentKomariSource } from './komari-source-eligibility'
import { parseKomariAlertState } from './komari-alerts'
import { isKomariWaitingForFirstReport } from './komari-first-report'
import { KOMARI_MAPPING_CHANGED_EVENT, confirmedKomariSyncAt, type KomariPersistedState } from './komari-persistence'
import { listPersistedProbeSnapshots, type PersistedProbeSnapshotRecord } from './probe-persistence'
import { refreshProbeSnapshotFreshness } from './probe-scheduler'
import type { ProbeCapability, ProbeConfidence, ProbeProviderKind, ProbeProviderTelemetry, ProbeSnapshot } from './probe-provider'
import { getServerMonitorHostKey, listServerMonitorLatest, type ServerMonitorLatest } from './server-monitor'
import { useServerMonitorStates } from './server-monitor-state'
import { listShellbeamAgents, type ShellbeamAgentRecord } from './shellbeam-agent'
import { loadWorkspaceInventoryHostStateSnapshots, loadWorkspaceInventoryPersistedCache, type WorkspaceInventoryCache, type WorkspaceInventoryHostStateSnapshot } from './workspace-inventory'
import { useWorkspaceInventoryStates, type WorkspaceInventoryHostState } from './workspace-inventory-state'

export interface WorkspaceProviderSource {
  kind: ProbeProviderKind
  id: string
  nodeId?: string
  health: HostOpsHealthState
  waitingForFirstReport?: boolean
  confidence: ProbeConfidence | null
  sampledAt: number | null
  receivedAt: number | null
  lastSyncedAt: number | null
  ttlMs: number | null
  expiresAt: number | null
  capabilities: ProbeCapability[]
  fallbackProvider?: HostOpsProvider
  fallbackReason?: string
  syncError: boolean
}

export interface WorkspaceProviderState {
  view: HostOpsView | null
  source: WorkspaceProviderSource | null
  sources: WorkspaceProviderSource[]
  loading: boolean
  error: boolean
  telemetry: ProbeProviderTelemetry | null
  refresh: () => Promise<void>
  now: number
}

export interface WorkspaceProviderStateOptions {
  host: HostProfile | null
  hosts?: HostProfile[]
  vaultId?: string
}

export type WorkspaceKomariState = CurrentKomariSource

export interface WorkspaceProviderData {
  rows: PersistedProbeSnapshotRecord[]
  komari: WorkspaceKomariState[]
  monitors: ServerMonitorLatest[]
  inventoryCache: WorkspaceInventoryCache
  inventoryStates: Record<string, WorkspaceInventoryHostStateSnapshot>
  agents: ShellbeamAgentRecord[]
}

const emptyData = (): WorkspaceProviderData => ({ rows: [], komari: [], monitors: [], inventoryCache: {}, inventoryStates: {}, agents: [] })
export const WORKSPACE_PROVIDER_POLL_MS = 15_000
const validTime = (value: number | undefined | null, now: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now ? value : null

function scopedHost({ host, vaultId }: WorkspaceProviderStateOptions): HostProfile | null {
  if (!host) return null
  const scope = vaultId?.trim()
  if (scope && host.vaultId && host.vaultId !== scope) return null
  return scope && !host.vaultId ? { ...host, vaultId: scope } : host
}

function rowSnapshot(row: PersistedProbeSnapshotRecord | KomariPersistedState['snapshots'][number]): ProbeSnapshot {
  const snapshot = row.snapshot
  // The durable deadline can be stricter than a legacy envelope. Inventory has
  // its own deadline when the row's primary observation is a metric sample.
  return { ...snapshot,
    metrics: snapshot.metrics ? { ...snapshot.metrics, freshness: { ...snapshot.metrics.freshness, expiresAt: Math.min(snapshot.metrics.freshness.expiresAt, row.expiresAt) } } : null,
    inventory: snapshot.inventory ? { ...snapshot.inventory, freshness: { ...snapshot.inventory.freshness, expiresAt: snapshot.metrics ? snapshot.inventory.freshness.expiresAt : Math.min(snapshot.inventory.freshness.expiresAt, row.expiresAt) } } : null,
  }
}

function sameEndpoint(snapshot: ProbeSnapshot, host: HostProfile, profiles: HostProfile[]) {
  // A manual Komari binding intentionally survives an SSH route/address change.
  if (snapshot.provider.kind === 'komari') return true
  const expected = getHostIdentity(host, profiles)
  if (snapshot.host.address !== expected.address || snapshot.host.port !== expected.port || snapshot.host.username !== expected.username) return false
  if (snapshot.transport !== (expected.jump ? 'proxy-jump' : 'direct')) return false
  const actual = snapshot.host.jump
  if (!expected.jump) return !actual
  // An unresolved referenced profile is not proof of a usable current route.
  if (!expected.jump.address || !actual) return false
  return (!expected.jump.hostId || actual.hostId === expected.jump.hostId)
    && actual.address === expected.jump.address && actual.port === expected.jump.port && actual.username === expected.jump.username
}

function snapshotId(snapshot: ProbeSnapshot) {
  return `${snapshot.provider.kind}:${snapshot.provider.id}:${snapshot.provider.nodeId ?? ''}`
}

/** Pure projection shared by the hook tests. Selection itself belongs to the
 * host operations model, so Overview and host cards cannot drift in priority. */
export function buildWorkspaceProviderState(options: WorkspaceProviderStateOptions & {
  data?: WorkspaceProviderData
  runtimeMonitor?: ServerMonitorLatest
  runtimeInventory?: WorkspaceInventoryHostState
  now?: number
}): Pick<WorkspaceProviderState, 'view' | 'source' | 'sources' | 'telemetry' | 'now'> {
  const host = scopedHost(options)
  const now = options.now ?? Date.now()
  if (!host) return { view: null, source: null, sources: [], telemetry: null, now }
  const vaultId = options.vaultId?.trim() || host.vaultId
  const data = options.data ?? emptyData()
  const profiles = (options.hosts ?? [host]).filter((candidate) => !vaultId || !candidate.vaultId || candidate.vaultId === vaultId).map((candidate) => vaultId && !candidate.vaultId ? { ...candidate, vaultId } : candidate)
  const jump = host.jumpHostId ? profiles.find((candidate) => candidate.id === host.jumpHostId) : undefined
  // Overview projects one target. Keep its referenced route available without
  // rebuilding every other host on each freshness tick.
  const hosts = jump && jump.id !== host.id ? [host, jump] : [host]
  const key = getServerMonitorHostKey(host)
  const komari = data.komari.filter((entry) => entry.integration.vaultId === vaultId && entry.integration.enabled)
  const integrationById = new Map(komari.map((entry) => [entry.integration.id, entry]))
  const allowed = (snapshot: ProbeSnapshot) => {
    if (snapshot.host.hostId !== host.id || !sameEndpoint(snapshot, host, hosts)) return false
    if (snapshot.provider.kind !== 'komari') return true
    return isCurrentKomariSnapshot(snapshot, host, komari)
  }
  const canonical = data.rows.filter((row) => row.vaultId === vaultId && row.hostId === host.id && row.snapshot.host.hostId === row.hostId && row.snapshot.provider.id === row.providerId && row.snapshot.provider.kind === row.providerKind).map(rowSnapshot).filter(allowed)
  const dedicated = komari.flatMap((entry) => (entry.state?.snapshots ?? []).filter((row) => row.integrationId === entry.integration.id && row.hostId === host.id && row.snapshot.host.hostId === row.hostId && row.snapshot.provider.kind === 'komari' && row.snapshot.provider.id === row.integrationId && row.snapshot.provider.nodeId === row.nodeId).map(rowSnapshot)).filter(allowed)
  const snapshots = [...dedicated, ...canonical].reduce<ProbeSnapshot[]>((rows, candidate) => {
    const index = rows.findIndex((row) => snapshotId(row) === snapshotId(candidate))
    if (index < 0) rows.push(candidate)
    else if (candidate.receivedAt >= rows[index].receivedAt) rows[index] = candidate
    return rows
  }, [])
  const routeResolved = !host.jumpHostId || Boolean(getHostIdentity(host, hosts).jump?.address)
  const monitorMatches = (value: ServerMonitorLatest | undefined): value is ServerMonitorLatest => Boolean(routeResolved && value && value.hostKey === key && value.hostId === host.id && value.hostAddress === host.address && value.username === host.username && value.port === (host.port || 22))
  const persistedMonitor = data.monitors.filter(monitorMatches).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const runtimeMonitor = monitorMatches(options.runtimeMonitor) ? options.runtimeMonitor : undefined
  const monitor = runtimeMonitor && (!persistedMonitor || runtimeMonitor.updatedAt >= persistedMonitor.updatedAt) ? runtimeMonitor : persistedMonitor
  const runtimeInventory = options.runtimeInventory
  const persistedInventoryState = data.inventoryStates[key]
  const runtimeIsLatest = runtimeInventory && (runtimeInventory.updatedAt ?? 0) >= (persistedInventoryState?.updatedAt ?? 0)
  const inventoryCache = { ...data.inventoryCache }
  const inventoryStates = { ...data.inventoryStates }
  if (runtimeIsLatest) {
    if (runtimeInventory.inventory) inventoryCache[key] = { inventory: runtimeInventory.inventory, updatedAt: runtimeInventory.updatedAt ?? runtimeInventory.inventory.scannedAt }
    if (runtimeInventory.status === 'ready' || runtimeInventory.status === 'error' || runtimeInventory.status === 'unsupported') {
      inventoryStates[key] = { hostKey: key, hostId: host.id, hostName: host.name, hostAddress: host.address, username: host.username, port: host.port, hostGroup: host.group, tags: host.tags, authType: host.authType, status: runtimeInventory.status, updatedAt: runtimeInventory.updatedAt ?? 0, error: runtimeInventory.error }
    }
  }
  const common = { hosts, monitorLatest: monitor ? [monitor] : [], inventoryCache, inventoryStates, shellbeamAgents: data.agents.filter((agent) => agent.vaultId === vaultId && agent.hostId === host.id), komariSources: komari, now, staleAfterMs: COLLECTION_LIMITS.cadence.metricsTtlMs }
  const view = buildHostOpsViews({ ...common, probeSnapshots: canonical, komariSnapshots: dedicated })[host.id]
  const sources: WorkspaceProviderSource[] = snapshots.map((snapshot) => {
    const refreshed = refreshProbeSnapshotFreshness(snapshot, now)
    const observation = refreshed.metrics ?? refreshed.inventory
    const providerView = buildHostOpsViews({ hosts: [host], probeSnapshots: [snapshot], now, staleAfterMs: COLLECTION_LIMITS.cadence.metricsTtlMs })[host.id]
    const integration = integrationById.get(snapshot.provider.id)
    const sampledAt = validTime(observation?.freshness.sampledAt, now)
    // A legacy snapshot without an endpoint cannot establish first-report
    // identity. Do not borrow another server's baseline.
    const waitingForFirstReport = Boolean(snapshot.provider.endpoint && isKomariWaitingForFirstReport(refreshed, parseKomariAlertState(integration?.state?.syncState?.alertSummary)?.probeBaselines))
    return { kind: snapshot.provider.kind, id: snapshot.provider.id, ...(snapshot.provider.nodeId ? { nodeId: snapshot.provider.nodeId } : {}), health: waitingForFirstReport ? 'unknown' : providerView.health.state,
      ...(snapshot.provider.kind === 'komari' ? { waitingForFirstReport } : {}),
      confidence: observation?.confidence ?? null, sampledAt,
      receivedAt: validTime(observation?.freshness.receivedAt ?? snapshot.receivedAt, now),
      lastSyncedAt: snapshot.provider.kind === 'komari' && integration ? confirmedKomariSyncAt(integration.integration, integration.state?.syncState, now) : null,
      ttlMs: observation?.freshness.ttlMs ?? null, expiresAt: sampledAt === null ? null : observation?.freshness.expiresAt ?? null,
      capabilities: [...snapshot.provider.capabilities], syncError: snapshot.provider.kind === 'komari' && Boolean(integration?.error),
    }
  })
  if (monitor) {
    const sshView = buildHostOpsViews({ ...common, probeSnapshots: canonical.filter((row) => row.provider.kind === 'ssh-agentless') })[host.id]
    const existing = sources.findIndex((source) => source.kind === 'ssh-agentless')
    // The live monitor can precede its canonical write, including a new failed
    // attempt with an old metric sample. Preserve that actual collection state.
    const matchingMetricSnapshot = snapshots.find((snapshot) => snapshot.provider.kind === 'ssh-agentless' && snapshot.metrics?.freshness.sampledAt === monitor.snapshot?.sampledAt)
    if (existing < 0 || !matchingMetricSnapshot || monitor.updatedAt >= (sources[existing].receivedAt ?? 0)) {
      const source: WorkspaceProviderSource = { kind: 'ssh-agentless', id: existing < 0 ? 'ssh-agentless' : sources[existing].id,
        health: sshView.health.state, confidence: matchingMetricSnapshot?.metrics?.confidence ?? null,
        sampledAt: sshView.health.freshness.sampledAt, receivedAt: validTime(matchingMetricSnapshot?.metrics?.freshness.receivedAt, now), lastSyncedAt: null,
        ttlMs: sshView.health.freshness.ttlMs ?? null, expiresAt: sshView.health.freshness.expiresAt ?? null,
        capabilities: matchingMetricSnapshot ? [...matchingMetricSnapshot.provider.capabilities] : monitor.snapshot ? ['metrics'] : [], syncError: false }
      if (existing < 0) sources.push(source)
      else sources[existing] = source
    }
  }
  // A mapped node with no usable observation is still a real source. Keep its
  // last successful sync visible while explaining a current SSH fallback.
  for (const entry of komari) {
    if (entry.error) continue
    for (const mapping of entry.state?.mappings.filter((row) => row.hostId === host.id && row.integrationId === entry.integration.id) ?? []) {
      if (sources.some((source) => source.kind === 'komari' && source.id === entry.integration.id && source.nodeId === mapping.nodeId)) continue
      const retained = [
        ...data.rows.filter(row => row.vaultId === vaultId && row.hostId === host.id).map(row => row.snapshot),
        ...(entry.state?.snapshots.map(row => row.snapshot) ?? []),
      ].filter(snapshot => snapshot.provider.kind === 'komari' && snapshot.provider.id === entry.integration.id
        && snapshot.host.hostId === host.id && snapshot.provider.nodeId === mapping.nodeId)
      // A metadata rename preserves an unsampled authoritative mapping. An
      // old endpoint observation cannot instead manufacture a current fallback.
      if (retained.some(snapshot => snapshot.provider.endpoint && !isCurrentKomariSnapshot(snapshot, host, [entry]))) continue
      sources.push({ kind: 'komari', id: entry.integration.id, nodeId: mapping.nodeId, health: 'unknown', confidence: null, sampledAt: null, receivedAt: null, lastSyncedAt: confirmedKomariSyncAt(entry.integration, entry.state?.syncState, now), ttlMs: null, expiresAt: null, capabilities: [], syncError: entry.error })
    }
  }
  const selectedId = view.health.probe?.providerId
  const selectedNode = view.health.probe?.nodeId
  const source = sources.find((candidate) => candidate.kind === view.health.provider && (!selectedId || candidate.id === selectedId) && (!selectedNode || candidate.nodeId === selectedNode)) ?? sources.find((candidate) => candidate.kind === view.health.provider) ?? null
  if (source) {
    source.health = source.waitingForFirstReport ? 'unknown' : view.health.state
    if (source.waitingForFirstReport) view.health.state = 'unknown'
    source.fallbackProvider = view.health.fallbackProvider
    source.fallbackReason = view.health.fallbackReason
    if (source.kind === 'ssh-agentless' && !source.fallbackProvider && sources.some((row) => row.kind === 'komari')) {
      source.fallbackProvider = 'komari'
      source.fallbackReason = 'Komari metrics were unavailable or stale; SSH data selected.'
      view.health.fallbackProvider = source.fallbackProvider
      view.health.fallbackReason = source.fallbackReason
    }
  }
  const selectedTelemetry = view.health.probe?.telemetry ?? (source?.kind === 'ssh-agentless' ? monitor?.probeTelemetry ?? null : null)
  const telemetry = view.metrics && !selectedTelemetry?.sections.includes('metrics') ? null : selectedTelemetry
  return { view, source, sources, telemetry, now }
}

async function loadData(host: HostProfile, vaultId: string): Promise<{ data: WorkspaceProviderData; error: boolean }> {
  const results = await Promise.allSettled([
    listPersistedProbeSnapshots({ vaultId, hostId: host.id }), listKomariIntegrations(vaultId),
    listServerMonitorLatest([vaultId]), loadWorkspaceInventoryPersistedCache([host]),
    loadWorkspaceInventoryHostStateSnapshots([host]), listShellbeamAgents({ vaultId }),
  ] as const)
  const [rows, integrations, monitors, inventoryCache, inventoryStates, agents] = results
  const configured = integrations.status === 'fulfilled' ? (integrations.value ?? []).filter((entry) => entry.vaultId === vaultId && entry.enabled) : []
  const komari = await Promise.all(configured.map(loadCurrentKomariSource))
  return { data: { rows: rows.status === 'fulfilled' ? rows.value ?? [] : [], komari,
    monitors: monitors.status === 'fulfilled' ? monitors.value ?? [] : [], inventoryCache: inventoryCache.status === 'fulfilled' ? inventoryCache.value ?? {} : {},
    inventoryStates: inventoryStates.status === 'fulfilled' ? inventoryStates.value ?? {} : {}, agents: agents.status === 'fulfilled' ? agents.value ?? [] : [] },
    error: results.some((result) => result.status === 'rejected') || komari.some((entry) => entry.error) }
}

/** Read-only local projection. No credentials or remote commands are needed to
 * show metrics collected by another provider or restored in another session. */
export function useWorkspaceProviderState(options: WorkspaceProviderStateOptions): WorkspaceProviderState {
  const host = scopedHost(options)
  const vaultId = options.vaultId?.trim() || host?.vaultId || ''
  const hostKey = host ? getServerMonitorHostKey(host) : ''
  const routeIdentity = host ? getHostIdentity(host, (options.hosts ?? []).filter((candidate) => !candidate.vaultId || candidate.vaultId === vaultId)).jump : undefined
  const scope = host ? JSON.stringify([vaultId, hostKey, host.address, host.port, host.username, routeIdentity]) : ''
  const currentScope = useRef(scope)
  const generation = useRef(0)
  const monitorStates = useServerMonitorStates()
  const inventoryStates = useWorkspaceInventoryStates()
  const [now, setNow] = useState(Date.now)
  const [loaded, setLoaded] = useState<{ scope: string; data: WorkspaceProviderData; error: boolean; loading: boolean }>({ scope: '', data: emptyData(), error: false, loading: false })
  const hostRef = useRef(host)
  useLayoutEffect(() => { currentScope.current = scope; hostRef.current = host }, [scope, host])
  const refresh = useCallback(async () => {
    if (currentScope.current !== scope || !hostRef.current || !vaultId) return
    const sequence = ++generation.current
    const requestedHost = hostRef.current
    setLoaded((previous) => ({ scope, data: previous.scope === scope ? previous.data : emptyData(), error: false, loading: true }))
    const result = await loadData(requestedHost, vaultId)
    if (currentScope.current !== scope || sequence !== generation.current) return
    setNow(Date.now())
    setLoaded({ scope, ...result, loading: false })
  }, [scope, vaultId])
  useEffect(() => {
    let active = true
    generation.current += 1
    queueMicrotask(() => { if (active) void refresh() })
    return () => { active = false; generation.current += 1 }
  }, [refresh])
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    if (!vaultId || !scope) return () => window.clearInterval(clock)
    const update = (event?: Event) => {
      const eventVault = (event as CustomEvent<{ vaultId?: string }> | undefined)?.detail?.vaultId
      if (!eventVault || eventVault === vaultId) void refresh()
    }
    const mappingChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ vaultId?: string; integrationId?: string }>).detail
      if (detail?.vaultId !== vaultId || currentScope.current !== scope) return
      ++generation.current
      // Publish the invalidation before the read finishes. A rebind must not
      // keep the previous host's healthy metrics visible during a slow sync.
      setLoaded((previous) => previous.scope !== scope ? previous : { ...previous, data: { ...previous.data,
        rows: previous.data.rows.filter((row) => row.providerKind !== 'komari' || row.providerId !== detail.integrationId),
        komari: previous.data.komari.filter((entry) => entry.integration.id !== detail.integrationId),
      } })
      void refresh()
    }
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh() }
    const poll = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, WORKSPACE_PROVIDER_POLL_MS)
    const events = ['provider-metric-history-changed', 'shellbeam-agent-state-changed', 'shellbeam-agent-history-changed', 'shellbeam:host-ops-refresh', 'focus']
    events.forEach((name) => window.addEventListener(name, update))
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, mappingChanged)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(clock); window.clearInterval(poll)
      events.forEach((name) => window.removeEventListener(name, update))
      window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, mappingChanged)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh, scope, vaultId])
  const data = loaded.scope === scope ? loaded.data : undefined
  const state = buildWorkspaceProviderState({ ...options, data, runtimeMonitor: monitorStates[hostKey]?.latest, runtimeInventory: inventoryStates[hostKey], now })
  return { ...state, refresh, loading: Boolean(vaultId && host && (loaded.scope !== scope || loaded.loading)), error: loaded.scope === scope && loaded.error }
}
