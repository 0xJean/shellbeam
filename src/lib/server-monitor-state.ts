import { useSyncExternalStore } from 'react'
import type { HostProfile } from '@/lib/hosts'
import {
  getServerMonitorHostKey,
  type ServerMonitorHistoryPoint,
  type ServerMonitorLatest,
  type ServerMonitorSnapshot,
  type ServerMonitorStatus,
} from './server-monitor'

export interface ServerMonitorHostState {
  latest?: ServerMonitorLatest
  history: ServerMonitorHistoryPoint[]
}

type Listener = () => void

let states: Record<string, ServerMonitorHostState> = {}
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function getServerMonitorStates() {
  return states
}

export function subscribeServerMonitorStates(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setServerMonitorStates(
  updater: (current: Record<string, ServerMonitorHostState>) => Record<string, ServerMonitorHostState>,
) {
  states = updater(states)
  emit()
}

export function mergeServerMonitorStates(next: Record<string, ServerMonitorHostState>) {
  setServerMonitorStates((current) => ({ ...current, ...next }))
}

export function clearServerMonitorStates() {
  states = {}
  emit()
}

export function pruneServerMonitorStates(hosts: HostProfile[]) {
  const validKeys = new Set(hosts.map(getServerMonitorHostKey))
  setServerMonitorStates((current) => {
    const next: Record<string, ServerMonitorHostState> = {}
    Object.entries(current).forEach(([key, state]) => {
      if (validKeys.has(key)) next[key] = state
    })
    return next
  })
}

export function getServerMonitorStateForHost(host: HostProfile | undefined) {
  return host ? states[getServerMonitorHostKey(host)] : undefined
}

export function createServerMonitorLatest(
  host: HostProfile,
  status: ServerMonitorStatus,
  now: number,
  previous?: ServerMonitorLatest,
  overrides: {
    snapshot?: ServerMonitorSnapshot | null
    lastSuccessAt?: number | null
    error?: string
  } = {},
): ServerMonitorLatest {
  return {
    hostKey: getServerMonitorHostKey(host),
    hostId: host.id,
    hostName: host.name,
    hostAddress: host.address,
    username: host.username,
    port: host.port || 22,
    status,
    snapshot: overrides.snapshot === undefined ? (previous?.snapshot ?? null) : overrides.snapshot,
    lastAttemptAt: now,
    lastSuccessAt: overrides.lastSuccessAt === undefined
      ? (previous?.lastSuccessAt ?? null)
      : overrides.lastSuccessAt,
    error: overrides.error,
    updatedAt: now,
  }
}

export function getServerMonitorFailureStatus(
  previous: ServerMonitorLatest | undefined,
  now: number,
  offlineAfterMs = 5 * 60 * 1000,
): ServerMonitorStatus {
  if (!previous?.lastSuccessAt) return 'offline'
  return now - previous.lastSuccessAt <= offlineAfterMs ? 'stale' : 'offline'
}

export function useServerMonitorStates() {
  return useSyncExternalStore(subscribeServerMonitorStates, getServerMonitorStates, getServerMonitorStates)
}

export function getServerMonitorStatusLabel(status: ServerMonitorStatus | undefined) {
  if (status === 'online') return 'online'
  if (status === 'stale') return 'stale'
  if (status === 'offline') return 'offline'
  if (status === 'paused') return 'paused'
  return 'checking'
}
