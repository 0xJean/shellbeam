import type { HostProfile } from '@/lib/hosts'
import {
  getServerMonitorHostKey,
  listServerMonitorHistory,
  listServerMonitorLatest,
  saveServerMonitorResult,
  type ServerMonitorHistoryPoint,
  type ServerMonitorLatest,
} from './server-monitor'
import {
  createServerMonitorLatest,
  getServerMonitorFailureStatus,
  getServerMonitorStates,
  mergeServerMonitorStates,
  pruneServerMonitorStates,
  type ServerMonitorHostState,
} from './server-monitor-state'
import { createAgentlessSshProbeProvider } from './probe-provider'

export const SERVER_MONITOR_INTERVAL_MS = 60 * 1000
export const SERVER_MONITOR_HISTORY_MS = 24 * 60 * 60 * 1000
export const SERVER_MONITOR_CONCURRENCY = 3

const serverMonitorProbeProvider = createAgentlessSshProbeProvider()

interface ScanOptions {
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  concurrency?: number
  isCurrent?: () => boolean
}

export interface ServerMonitorScanResult {
  scannedHosts: HostProfile[]
  skippedHosts: HostProfile[]
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isServerMonitorVaultUnavailableError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return message.includes('vault')
    && (
      message.includes('locked')
      || message.includes('锁定')
      || message.includes('未初始化')
      || message.includes('尚未初始化')
    )
}

function historyForState(state: ServerMonitorHostState | undefined) {
  return state?.history ?? []
}

function mergeHistory(history: ServerMonitorHistoryPoint[], point: ServerMonitorHistoryPoint) {
  const next = [...history.filter((entry) => entry.sampledAt !== point.sampledAt), point]
  return next
    .sort((a, b) => a.sampledAt - b.sampledAt)
    .filter((entry) => entry.sampledAt >= Date.now() - SERVER_MONITOR_HISTORY_MS)
}

function buildLatestPayload(latest: ServerMonitorLatest, history?: ServerMonitorHistoryPoint) {
  return history ? { latest, history } : { latest }
}

export async function loadPersistedServerMonitorStates(
  hosts: HostProfile[],
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent()) return
  pruneServerMonitorStates(hosts)
  const latest = await listServerMonitorLatest()
  if (!isCurrent()) return
  const hostKeys = new Set(hosts.map(getServerMonitorHostKey))
  const latestByKey = latest.filter((entry) => hostKeys.has(entry.hostKey))
  const historyEntries = await Promise.all(
    latestByKey.map(async (entry) => {
      const history = await listServerMonitorHistory({
        hostKey: entry.hostKey,
        from: Date.now() - SERVER_MONITOR_HISTORY_MS,
        to: Date.now(),
      })
      return [entry.hostKey, history] as const
    }),
  )
  if (!isCurrent()) return
  const historyByKey = new Map(historyEntries)
  mergeServerMonitorStates(
    latestByKey.reduce<Record<string, ServerMonitorHostState>>((next, entry) => {
      next[entry.hostKey] = {
        latest: entry,
        history: historyByKey.get(entry.hostKey) ?? [],
      }
      return next
    }, {}),
  )
}

export async function scanServerMonitorHosts({
  hosts,
  resolveAuthSecret,
  concurrency = SERVER_MONITOR_CONCURRENCY,
  isCurrent = () => true,
}: ScanOptions): Promise<ServerMonitorScanResult> {
  if (hosts.length === 0 || !isCurrent()) {
    return { scannedHosts: [], skippedHosts: hosts }
  }

  pruneServerMonitorStates(hosts)
  const pending = hosts.slice()
  const scannedHosts: HostProfile[] = []
  const skippedHosts: HostProfile[] = []
  const checkingAt = Date.now()
  const statesBeforeScan = getServerMonitorStates()

  mergeServerMonitorStates(
    hosts.reduce<Record<string, ServerMonitorHostState>>((next, host) => {
      const key = getServerMonitorHostKey(host)
      const previous = statesBeforeScan[key]
      next[key] = {
        latest: createServerMonitorLatest(host, 'checking', checkingAt, previous?.latest),
        history: historyForState(previous),
      }
      return next
    }, {}),
  )

  async function worker() {
    while (pending.length > 0 && isCurrent()) {
      const host = pending.shift()
      if (!host) return

      const key = getServerMonitorHostKey(host)
      const previous = getServerMonitorStates()[key]
      const attemptAt = Date.now()

      try {
        const probe = await serverMonitorProbeProvider.probe({
          host,
          resolveAuthSecret,
          sections: ['metrics'],
        })
        if (!probe.metrics) {
          throw new Error(probe.errors[0]?.message || 'server monitor returned no usable Linux metrics')
        }
        const snapshot = probe.metrics.data
        if (!isCurrent()) return

        const latest = createServerMonitorLatest(host, 'online', attemptAt, previous?.latest, {
          snapshot,
          lastSuccessAt: snapshot.sampledAt,
        })
        const historyPoint: ServerMonitorHistoryPoint = {
          hostKey: key,
          sampledAt: snapshot.sampledAt,
          snapshot,
        }
        try {
          await saveServerMonitorResult(buildLatestPayload(latest, historyPoint))
        } catch (persistError) {
          latest.error = `Saved in memory; local history failed: ${errorMessage(persistError)}`
        }
        mergeServerMonitorStates({
          [key]: {
            latest,
            history: mergeHistory(historyForState(previous), historyPoint),
          },
        })
        scannedHosts.push(host)
      } catch (error) {
        if (!isCurrent()) return

        const status = isServerMonitorVaultUnavailableError(error)
          ? 'paused'
          : getServerMonitorFailureStatus(previous?.latest, Date.now())
        const latest = createServerMonitorLatest(host, status, attemptAt, previous?.latest, {
          error: errorMessage(error),
        })
        try {
          await saveServerMonitorResult({ latest })
        } catch {
          // Keep the in-memory failure state even if the local database is unavailable.
        }
        mergeServerMonitorStates({
          [key]: {
            latest,
            history: historyForState(previous),
          },
        })
        scannedHosts.push(host)
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, hosts.length)) },
      () => worker(),
    ),
  )

  if (isCurrent()) {
    const scannedKeys = new Set(scannedHosts.map(getServerMonitorHostKey))
    hosts.forEach((host) => {
      if (!scannedKeys.has(getServerMonitorHostKey(host))) skippedHosts.push(host)
    })
  }

  return { scannedHosts, skippedHosts }
}
