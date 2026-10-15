import type { HostProfile } from './hosts'
import {
  getServerMonitorHostKey,
  listServerMonitorLatest,
  type ServerMonitorLatest,
  type ServerMonitorSnapshot,
  type ServerMonitorStatus,
} from './server-monitor'
import {
  loadWorkspaceInventoryHostStateSnapshots,
  loadWorkspaceInventoryPersistedCache,
  type WorkspaceInventory,
  type WorkspaceInventoryCache,
  type WorkspaceInventoryHostStateSnapshot,
  type WorkspaceInventoryResource,
} from './workspace-inventory'
import { listOperationAudit, type OperationAuditEntry } from './operation-job'
import { operationTransport } from './operation-job'

export type OperationTransport = ReturnType<typeof operationTransport>

/**
 * The state shown by the host-list operations view.  Values stay nullable when
 * no probe has produced them; a missing inventory must not look like a healthy
 * host with zero services or processes.
 */
export type HostOpsHealthState = ServerMonitorStatus | 'checking' | 'unknown' | 'jump-unavailable'
export type HostOpsProvider = 'ssh-agentless' | 'komari' | 'shellbeam-agent' | 'unknown'

export interface HostOpsRoute {
  transport: OperationTransport
  jumpHost?: string
  jumpPort?: number
  jumpUser?: string
}

export interface HostOpsServiceSummary {
  available: boolean
  total: number | null
  active: number | null
  failed: number | null
  inactive: number | null
  enabled: number | null
  updatedAt: number | null
}

export interface HostOpsProcessSummary {
  available: boolean
  /** Number of process entries available from the inventory probe (PM2 today). */
  total: number | null
  pm2: number | null
  updatedAt: number | null
}

export interface HostOpsFreshness {
  sampledAt: number | null
  updatedAt: number | null
  ageMs: number | null
  stale: boolean
}

export interface HostOpsOperationSummary {
  total: number
  active: number
  failed: number
  unknown: number
  latestStatus: OperationAuditEntry['status'] | null
  latestAt: number | null
}

export interface HostOpsHealth {
  state: HostOpsHealthState
  provider: HostOpsProvider
  transport: OperationTransport
  freshness: HostOpsFreshness
  error?: string
  lastSuccessAt?: number | null
}

export interface HostOpsView {
  host: HostProfile
  hostKey: string
  route: HostOpsRoute
  health: HostOpsHealth
  resource: WorkspaceInventoryResource | null
  metrics: ServerMonitorSnapshot | null
  inventory: WorkspaceInventory | null
  serviceSummary: HostOpsServiceSummary
  processSummary: HostOpsProcessSummary
  operationSummary: HostOpsOperationSummary
  audits: OperationAuditEntry[]
  latestAudit: OperationAuditEntry | null
}

export interface BuildHostOpsViewsInput {
  hosts: HostProfile[]
  monitorLatest?: ServerMonitorLatest[]
  inventoryCache?: WorkspaceInventoryCache
  inventoryStates?: Record<string, WorkspaceInventoryHostStateSnapshot>
  audits?: OperationAuditEntry[]
  now?: number
  staleAfterMs?: number
}

function isActive(value: string) {
  return value === 'active' || value === 'running'
}

function isFailed(value: string) {
  return value === 'failed' || value === 'failure'
}

function isInactive(value: string) {
  return value === 'inactive' || value === 'dead' || value === 'exited'
}

function isEnabled(value: string) {
  return value === 'enabled' || value === 'static' || value === 'indirect'
}

function serviceSummary(inventory: WorkspaceInventory | null, updatedAt: number | null): HostOpsServiceSummary {
  if (!inventory) {
    return { available: false, total: null, active: null, failed: null, inactive: null, enabled: null, updatedAt }
  }
  const services = inventory.services ?? []
  return {
    available: true,
    total: services.length,
    active: services.filter((service) => isActive(service.active)).length,
    failed: services.filter((service) => isFailed(service.active)).length,
    inactive: services.filter((service) => isInactive(service.active)).length,
    enabled: services.filter((service) => isEnabled(service.enabled)).length,
    updatedAt,
  }
}

function processSummary(inventory: WorkspaceInventory | null, updatedAt: number | null): HostOpsProcessSummary {
  if (!inventory) return { available: false, total: null, pm2: null, updatedAt }
  const pm2 = Array.isArray(inventory.pm2) ? inventory.pm2.length : 0
  return { available: true, total: pm2, pm2, updatedAt }
}

function freshness(
  monitor: ServerMonitorLatest | undefined,
  inventory: WorkspaceInventory | null,
  inventoryUpdatedAt: number | null,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  now: number,
  staleAfterMs: number,
): HostOpsFreshness {
  const sampledCandidates = [
    monitor?.snapshot?.sampledAt,
    inventory?.scannedAt,
    monitor?.lastSuccessAt ?? undefined,
    state?.updatedAt,
  ].filter((value): value is number => typeof value === 'number' && value > 0)
  const sampledAt = sampledCandidates.length > 0 ? Math.max(...sampledCandidates) : null
  const updatedAt = Math.max(
    monitor?.updatedAt ?? 0,
    inventoryUpdatedAt ?? 0,
    state?.updatedAt ?? 0,
  ) || null
  const ageMs = sampledAt === null ? null : Math.max(0, now - sampledAt)
  return {
    sampledAt,
    updatedAt,
    ageMs,
    stale: ageMs !== null && ageMs > staleAfterMs,
  }
}

function healthState(
  monitor: ServerMonitorLatest | undefined,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  freshnessValue: HostOpsFreshness,
): HostOpsHealthState {
  const errorText = `${monitor?.error ?? ''} ${state?.error ?? ''}`.toLowerCase()
  const jumpUnavailable = /proxy[ -]?jump|jump host|jump tunnel|bastion/.test(errorText)
  if (monitor?.status) {
    if (monitor.status === 'checking') return 'checking'
    if (monitor.status === 'offline' && jumpUnavailable) return 'jump-unavailable'
    if (monitor.status === 'online' && freshnessValue.stale) return 'stale'
    return monitor.status
  }
  if (state?.status === 'error') return jumpUnavailable ? 'jump-unavailable' : 'offline'
  if (state?.status === 'ready') return freshnessValue.stale ? 'stale' : 'online'
  return 'unknown'
}

function providerFor(
  monitor: ServerMonitorLatest | undefined,
  inventory: WorkspaceInventory | null,
  state: WorkspaceInventoryHostStateSnapshot | undefined,
  audits: OperationAuditEntry[],
): HostOpsProvider {
  // Persisted monitor/inventory records currently come from the built-in
  // ProbeProvider. Keep this mapping in one place so Komari can be added
  // without changing the host-list data contract.
  if (monitor || inventory || state) return 'ssh-agentless'
  const auditedProvider = audits.find((audit) => audit.provider)?.provider
  if (auditedProvider === 'ssh-agentless' || auditedProvider === 'komari' || auditedProvider === 'shellbeam-agent') {
    return auditedProvider
  }
  return 'unknown'
}

function operationSummary(audits: OperationAuditEntry[]): HostOpsOperationSummary {
  return {
    total: audits.length,
    active: audits.filter((audit) => audit.status === 'queued' || audit.status === 'running').length,
    failed: audits.filter((audit) => audit.status === 'failed').length,
    unknown: audits.filter((audit) => audit.status === 'unknown').length,
    latestStatus: audits[0]?.status ?? null,
    latestAt: audits[0]?.createdAt ?? null,
  }
}

/** Build deterministic per-host operations data from persisted probe records. */
export function buildHostOpsViews({
  hosts,
  monitorLatest = [],
  inventoryCache = {},
  inventoryStates = {},
  audits = [],
  now = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
}: BuildHostOpsViewsInput): Record<string, HostOpsView> {
  const monitorByKey = new Map(monitorLatest.map((entry) => [entry.hostKey, entry]))

  return hosts.reduce<Record<string, HostOpsView>>((result, host) => {
    const hostKey = getServerMonitorHostKey(host)
    const monitor = monitorByKey.get(hostKey)
    const inventoryEntry = inventoryCache[hostKey]
    const inventory = inventoryEntry?.inventory ?? null
    const inventoryUpdatedAt = inventoryEntry?.updatedAt ?? null
    const state = inventoryStates[hostKey]
    const route: HostOpsRoute = {
      transport: operationTransport(host),
      ...(host.jumpHost?.trim() ? { jumpHost: host.jumpHost.trim() } : {}),
      ...(host.jumpPort ? { jumpPort: host.jumpPort } : {}),
      ...(host.jumpUser?.trim() ? { jumpUser: host.jumpUser.trim() } : {}),
    }
    const allHostAudits = audits
      .filter((audit) => audit.hostId === host.id || (!audit.hostId && audit.hostAddress === host.address))
      .sort((a, b) => b.createdAt - a.createdAt)
    const hostAudits = allHostAudits.slice(0, 10)
    const freshnessValue = freshness(monitor, inventory, inventoryUpdatedAt, state, now, staleAfterMs)
    const monitorError = monitor?.error?.trim()
    const stateError = state?.error?.trim()
    const view: HostOpsView = {
      host,
      hostKey,
      route,
      health: {
        state: healthState(monitor, state, freshnessValue),
        provider: providerFor(monitor, inventory, state, allHostAudits),
        transport: route.transport,
        freshness: freshnessValue,
        error: monitorError || stateError || undefined,
        lastSuccessAt: monitor?.lastSuccessAt ?? null,
      },
      resource: inventory?.resource ?? null,
      metrics: monitor?.snapshot ?? null,
      inventory,
      serviceSummary: serviceSummary(inventory, inventoryUpdatedAt),
      processSummary: processSummary(inventory, inventoryUpdatedAt),
      operationSummary: operationSummary(hostAudits),
      audits: hostAudits,
      latestAudit: hostAudits[0] ?? null,
    }
    result[host.id] = view
    return result
  }, {})
}

/** Load all persisted sources used by the host operations view in parallel. */
export async function loadHostOpsViews(
  hosts: HostProfile[],
  options: { auditLimit?: number; staleAfterMs?: number; now?: number } = {},
) {
  if (hosts.length === 0) return {}
  const [monitorLatest, inventoryCache, inventoryStates, audits] = await Promise.all([
    listServerMonitorLatest(),
    loadWorkspaceInventoryPersistedCache(hosts),
    loadWorkspaceInventoryHostStateSnapshots(hosts),
    listOperationAudit(options.auditLimit ?? 200),
  ])
  return buildHostOpsViews({
    hosts,
    monitorLatest,
    inventoryCache,
    inventoryStates,
    audits,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
  })
}
