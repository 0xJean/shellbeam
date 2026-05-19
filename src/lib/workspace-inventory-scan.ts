import type { HostProfile } from './hosts'
import { fetchWorkspaceInventory, getWorkspaceInventoryHostKey, saveWorkspaceInventoryCacheEntry } from './workspace-inventory'
import { getWorkspaceInventoryStates, mergeWorkspaceInventoryStates, type WorkspaceInventoryHostState } from './workspace-inventory-state'

interface WorkspaceInventoryScanOptions {
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  concurrency?: number
  isCurrent?: () => boolean
  currentStates?: Record<string, WorkspaceInventoryHostState>
}

export async function scanWorkspaceInventoryHosts({
  hosts,
  resolveAuthSecret,
  concurrency = 3,
  isCurrent = () => true,
  currentStates = getWorkspaceInventoryStates(),
}: WorkspaceInventoryScanOptions) {
  if (hosts.length === 0 || !isCurrent()) return

  const pending = hosts.slice()
  const scanningStates = hosts.reduce<Record<string, WorkspaceInventoryHostState>>((next, host) => {
    const key = getWorkspaceInventoryHostKey(host)
    const current = currentStates[key]
    next[key] = {
      status: 'scanning',
      inventory: current?.inventory,
      updatedAt: current?.updatedAt,
    }
    return next
  }, {})

  mergeWorkspaceInventoryStates(scanningStates)

  async function worker() {
    while (pending.length > 0 && isCurrent()) {
      const host = pending.shift()
      if (!host) return

      const key = getWorkspaceInventoryHostKey(host)
      try {
        const inventory = await fetchWorkspaceInventory({ host, resolveAuthSecret })
        if (!isCurrent()) return
        saveWorkspaceInventoryCacheEntry(host, inventory)
        const nextState: WorkspaceInventoryHostState = {
          status: 'ready',
          inventory,
          updatedAt: Date.now(),
        }
        mergeWorkspaceInventoryStates({ [key]: nextState })
      } catch (error) {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : String(error)
        const previousState = getWorkspaceInventoryStates()[key]
        const nextState: WorkspaceInventoryHostState = {
          status: 'error',
          inventory: previousState?.inventory,
          updatedAt: previousState?.updatedAt,
          error: message,
        }
        mergeWorkspaceInventoryStates({ [key]: nextState })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, hosts.length)) }, () => worker()))
}
