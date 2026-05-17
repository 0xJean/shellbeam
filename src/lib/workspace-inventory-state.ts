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
    next[key] = existing?.status === 'error'
      ? { ...existing, inventory: existing.inventory ?? entry.inventory, updatedAt: existing.updatedAt ?? entry.updatedAt }
      : { status: 'ready', inventory: entry.inventory, updatedAt: entry.updatedAt }
    return next
  }, {})
}

export function useWorkspaceInventoryStates() {
  return useSyncExternalStore(subscribeWorkspaceInventoryStates, getWorkspaceInventoryStates, getWorkspaceInventoryStates)
}
