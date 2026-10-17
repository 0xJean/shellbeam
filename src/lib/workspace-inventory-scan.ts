import type { HostProfile } from './hosts'
import {
  getWorkspaceInventoryHostKey,
  loadWorkspaceInventoryPersistedCache,
  saveWorkspaceInventoryHostStateSnapshot,
  saveWorkspaceInventoryCacheEntry,
} from './workspace-inventory'
import {
  createWorkspaceInventoryScanId,
  createWorkspaceInventoryScanningStates,
  createReadyWorkspaceInventoryStates,
  getWorkspaceInventoryStates,
  mergeWorkspaceInventoryStates,
  restoreWorkspaceInventoryStatesFromScan,
  type WorkspaceInventoryHostState,
} from './workspace-inventory-state'
import { getProbeProviderRegistry } from './probe-scheduler'

export const WORKSPACE_INVENTORY_REFRESH_INTERVAL_MS = 5 * 60 * 1000

const probeRegistry = getProbeProviderRegistry()

interface WorkspaceInventoryScanOptions {
  hosts: HostProfile[]
  vaultId?: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  concurrency?: number
  isCurrent?: () => boolean
  currentStates?: Record<string, WorkspaceInventoryHostState>
  refreshIntervalMs?: number
  now?: number
}

export interface WorkspaceInventoryScanResult {
  scannedHosts: HostProfile[]
  skippedHosts: HostProfile[]
}

function getStateRefreshTime(state: WorkspaceInventoryHostState | undefined) {
  return state?.updatedAt ?? state?.inventory?.scannedAt ?? 0
}

function shouldRefreshWorkspaceInventoryHost(
  host: HostProfile,
  states: Record<string, WorkspaceInventoryHostState>,
  refreshIntervalMs: number,
  now: number,
) {
  const state = states[getWorkspaceInventoryHostKey(host)]
  if (!state) return true
  if (state.status === 'scanning') return false
  const refreshedAt = getStateRefreshTime(state)
  if (refreshedAt <= 0) return true
  if ((host.updatedAt || host.createdAt || 0) > refreshedAt) return true
  return now - refreshedAt >= refreshIntervalMs
}

export async function scanWorkspaceInventoryHosts({
  hosts,
  vaultId,
  resolveAuthSecret,
  concurrency = 3,
  isCurrent = () => true,
  currentStates = getWorkspaceInventoryStates(),
  refreshIntervalMs = WORKSPACE_INVENTORY_REFRESH_INTERVAL_MS,
  now = Date.now(),
}: WorkspaceInventoryScanOptions): Promise<WorkspaceInventoryScanResult> {
  if (hosts.length === 0 || !isCurrent()) return { scannedHosts: [], skippedHosts: [] }

  const cache = await loadWorkspaceInventoryPersistedCache(hosts)
  if (!isCurrent()) return { scannedHosts: [], skippedHosts: hosts }

  const statesBeforeCacheMerge = { ...currentStates, ...getWorkspaceInventoryStates() }
  mergeWorkspaceInventoryStates(createReadyWorkspaceInventoryStates(cache, statesBeforeCacheMerge))

  const latestStates = { ...statesBeforeCacheMerge, ...getWorkspaceInventoryStates() }
  const targetHosts = refreshIntervalMs <= 0
    ? hosts
    : hosts.filter((host) => shouldRefreshWorkspaceInventoryHost(host, latestStates, refreshIntervalMs, now))
  const skippedHosts = hosts.filter((host) => !targetHosts.includes(host))

  if (targetHosts.length === 0) return { scannedHosts: [], skippedHosts }

  const pending = targetHosts.slice()
  const scanId = createWorkspaceInventoryScanId()
  const previousStates = targetHosts.reduce<Record<string, WorkspaceInventoryHostState | undefined>>((next, host) => {
    const key = getWorkspaceInventoryHostKey(host)
    next[key] = latestStates[key]
    return next
  }, {})
  const scanningStates = createWorkspaceInventoryScanningStates(targetHosts, scanId, latestStates)

  mergeWorkspaceInventoryStates(scanningStates)

  async function worker() {
    while (pending.length > 0 && isCurrent()) {
      const host = pending.shift()
      if (!host) return

      const key = getWorkspaceInventoryHostKey(host)
      try {
        const scheduled = await probeRegistry.probe({
          host,
          vaultId,
          resolveAuthSecret,
          sections: ['inventory'],
          providerId: 'ssh-agentless',
          // Workspace owns its persisted refresh interval. The shared
          // registry still coalesces overlapping scans, but a scan that has
          // been scheduled by Workspace must collect a new inventory.
          force: true,
        })
        const probe = scheduled.snapshot
        if (!probe.inventory || (scheduled.recovered && !vaultId)) {
          throw new Error(probe.errors[0]?.message || 'workspace inventory returned no usable data')
        }
        const inventory = probe.inventory.data
        if (!isCurrent()) return
        const recovered = Boolean(scheduled.recovered)
          || String(probe.health) === 'stale'
          || probe.inventory.freshness.expired
        if (recovered) {
          // Do not write a stale fallback through saveWorkspaceInventoryCacheEntry:
          // that helper stamps Date.now(), which would make expired inventory
          // appear fresh after a failed probe. Keep the previous cache when it
          // exists; otherwise retain the provider's original sampled time.
          const previousState = getWorkspaceInventoryStates()[key] ?? previousStates[key]
          const updatedAt = previousState?.updatedAt ?? probe.inventory.freshness.sampledAt
          const error = probe.errors[0]?.message || 'Probe returned stale inventory'
          void saveWorkspaceInventoryHostStateSnapshot(host, 'ready', updatedAt, error)
          const nextState: WorkspaceInventoryHostState = {
            status: 'ready',
            inventory: previousState?.inventory ?? inventory,
            updatedAt,
            error,
          }
          mergeWorkspaceInventoryStates({ [key]: nextState })
          continue
        }
        const cacheEntry = await saveWorkspaceInventoryCacheEntry(host, inventory)
        if (!isCurrent()) return
        void saveWorkspaceInventoryHostStateSnapshot(host, 'ready', cacheEntry.updatedAt)
        const nextState: WorkspaceInventoryHostState = {
          status: 'ready',
          inventory: cacheEntry.inventory,
          updatedAt: cacheEntry.updatedAt,
        }
        mergeWorkspaceInventoryStates({ [key]: nextState })
      } catch (error) {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : String(error)
        const previousState = getWorkspaceInventoryStates()[key]
        const updatedAt = Date.now()
        void saveWorkspaceInventoryHostStateSnapshot(host, 'error', updatedAt, message)
        const nextState: WorkspaceInventoryHostState = {
          status: 'error',
          inventory: previousState?.inventory,
          updatedAt,
          error: message,
        }
        mergeWorkspaceInventoryStates({ [key]: nextState })
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targetHosts.length)) }, () => worker()))
  } finally {
    if (!isCurrent()) {
      restoreWorkspaceInventoryStatesFromScan(scanId, previousStates)
    }
  }

  return { scannedHosts: targetHosts, skippedHosts }
}
