import { useSyncExternalStore } from 'react'
import type { HostProfile } from './hosts'
import type { WorkspaceInventory } from './workspace-inventory'
import { getWorkspaceInventoryHostKey } from './workspace-inventory'

export interface WorkspaceInventoryHostState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
  scanId?: number
}

export type WorkspaceInventoryDisplayStatus = 'online' | 'offline' | 'checking'

export interface WorkspaceInventoryScanRollback {
  restore: Record<string, WorkspaceInventoryHostState>
  clear: string[]
}

type Listener = () => void

let states: Record<string, WorkspaceInventoryHostState> = {}
const listeners = new Set<Listener>()
let nextScanId = 0

function emit() {
  listeners.forEach((listener) => listener())
}

export function getWorkspaceInventoryStates() {
  return states
}

export function subscribeWorkspaceInventoryStates(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setWorkspaceInventoryStates(updater: (current: Record<string, WorkspaceInventoryHostState>) => Record<string, WorkspaceInventoryHostState>) {
  states = updater(states)
  emit()
}

export function mergeWorkspaceInventoryStates(nextStates: Record<string, WorkspaceInventoryHostState>) {
  setWorkspaceInventoryStates((current) => ({ ...current, ...nextStates }))
}

export function clearWorkspaceInventoryStates() {
  states = {}
  emit()
}

export function selectWorkspaceInventoryStatesForHosts(hosts: HostProfile[], source = states) {
  return hosts.reduce<Record<string, WorkspaceInventoryHostState>>((next, host) => {
    const key = getWorkspaceInventoryHostKey(host)
    if (source[key]) next[key] = source[key]
    return next
  }, {})
}

export function createWorkspaceInventoryScanId() {
  nextScanId += 1
  return nextScanId
}

export function createWorkspaceInventoryScanningStates(
  hosts: HostProfile[],
  scanId: number,
  current = states,
) {
  return hosts.reduce<Record<string, WorkspaceInventoryHostState>>((next, host) => {
    const key = getWorkspaceInventoryHostKey(host)
    const existing = current[key]
    next[key] = {
      status: 'scanning',
      scanId,
      inventory: existing?.inventory,
      updatedAt: existing?.updatedAt,
    }
    return next
  }, {})
}

export function createWorkspaceInventoryScanRollback(
  scanId: number,
  previousStates: Record<string, WorkspaceInventoryHostState | undefined>,
  current = states,
) {
  return Object.entries(previousStates).reduce<WorkspaceInventoryScanRollback>((next, [key, previousState]) => {
    const active = current[key]
    if (active?.status !== 'scanning' || active.scanId !== scanId) return next
    if (previousState && (previousState.status !== 'scanning' || previousState.scanId)) {
      next.restore[key] = previousState
    } else if (active.inventory || previousState?.inventory) {
      next.restore[key] = {
        status: 'ready',
        inventory: active.inventory ?? previousState?.inventory,
        updatedAt: active.updatedAt ?? previousState?.updatedAt,
      }
    } else {
      next.clear.push(key)
    }
    return next
  }, { restore: {}, clear: [] })
}

export function restoreWorkspaceInventoryStatesFromScan(
  scanId: number,
  previousStates: Record<string, WorkspaceInventoryHostState | undefined>,
) {
  const { restore, clear } = createWorkspaceInventoryScanRollback(scanId, previousStates)
  if (Object.keys(restore).length === 0 && clear.length === 0) return

  setWorkspaceInventoryStates((current) => {
    const next = { ...current }
    Object.entries(restore).forEach(([key, state]) => {
      next[key] = state
    })
    clear.forEach((key) => {
      delete next[key]
    })
    return next
  })
}

export function createReadyWorkspaceInventoryStates(cache: Record<string, { inventory: WorkspaceInventory; updatedAt: number }>, current = states) {
  return Object.entries(cache).reduce<Record<string, WorkspaceInventoryHostState>>((next, [key, entry]) => {
    const existing = current[key]
    if (existing?.status === 'error') {
      next[key] = { ...existing, inventory: existing.inventory ?? entry.inventory, updatedAt: existing.updatedAt ?? entry.updatedAt }
      return next
    }
    if (existing?.status === 'scanning' && existing.scanId) {
      next[key] = { ...existing, inventory: existing.inventory ?? entry.inventory, updatedAt: existing.updatedAt ?? entry.updatedAt }
      return next
    }
    if (existing?.status === 'ready' && (existing.updatedAt ?? 0) >= entry.updatedAt) {
      next[key] = existing
      return next
    }
    next[key] = { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
    return next
  }, {})
}

export function useWorkspaceInventoryStates() {
  return useSyncExternalStore(subscribeWorkspaceInventoryStates, getWorkspaceInventoryStates, getWorkspaceInventoryStates)
}

export function getWorkspaceInventoryDisplayStatus(state?: WorkspaceInventoryHostState): WorkspaceInventoryDisplayStatus | undefined {
  if (!state) return undefined
  if (state.status === 'scanning') return 'checking'
  if (state.status === 'error') return 'offline'
  if (state.status === 'ready' || (state.status === 'idle' && state.inventory)) return 'online'
  return undefined
}
