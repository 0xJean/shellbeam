import { useSyncExternalStore } from 'react'
import type { HostProfile } from './hosts'
import type { WorkspaceInventory } from './workspace-inventory'
import { getWorkspaceInventoryHostKey } from './workspace-inventory'

export interface WorkspaceInventoryHostState {
  status: 'idle' | 'scanning' | 'ready' | 'error'
  inventory?: WorkspaceInventory
  updatedAt?: number
  error?: string
}

export type WorkspaceInventoryDisplayStatus = 'online' | 'offline' | 'checking'

type Listener = () => void

let states: Record<string, WorkspaceInventoryHostState> = {}
const listeners = new Set<Listener>()

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

export function createReadyWorkspaceInventoryStates(cache: Record<string, { inventory: WorkspaceInventory; updatedAt: number }>, current = states) {
  return Object.entries(cache).reduce<Record<string, WorkspaceInventoryHostState>>((next, [key, entry]) => {
    const existing = current[key]
    if (existing?.status === 'error') {
      next[key] = { ...existing, inventory: existing.inventory ?? entry.inventory, updatedAt: existing.updatedAt ?? entry.updatedAt }
      return next
    }
    if (existing?.status === 'scanning') {
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
