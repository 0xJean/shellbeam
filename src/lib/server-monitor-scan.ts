import { COLLECTION_LIMITS, collectionConcurrency } from './collection-limits'
import { observationVaultIds, scopeObservationHosts } from './host-observation-scope'
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
import { getProbeProviderRegistry } from './probe-scheduler'
import { isUnsupportedProbeError } from './unified-probe'

export const SERVER_MONITOR_INTERVAL_MS = COLLECTION_LIMITS.cadence.monitorIntervalMs
export const SERVER_MONITOR_HISTORY_MS = COLLECTION_LIMITS.history.monitorRetentionMs
export const SERVER_MONITOR_CONCURRENCY = COLLECTION_LIMITS.scheduler.concurrency

const probeRegistry = getProbeProviderRegistry()

interface ScanOptions {
  hosts: HostProfile[]
  vaultId?: string
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
  const latest = await listServerMonitorLatest(observationVaultIds(hosts))
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
  vaultId,
  resolveAuthSecret,
  concurrency = SERVER_MONITOR_CONCURRENCY,
  isCurrent = () => true,
}: ScanOptions): Promise<ServerMonitorScanResult> {
  if (hosts.length === 0 || !isCurrent()) {
    return { scannedHosts: [], skippedHosts: hosts }
  }

  hosts = scopeObservationHosts(hosts, vaultId)
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
        const scheduled = await probeRegistry.probe({
          host,
          vaultId,
          resolveAuthSecret,
          sections: ['metrics'],
          providerId: 'ssh-agentless',
          // Monitor cadence is the source of truth for its 60-second history;
          // the registry still coalesces overlapping scans for this host.
          force: true,
        })
        const probe = scheduled.snapshot
        if (probe.health === 'unsupported') {
          if (!isCurrent()) return
          const latest = createServerMonitorLatest(host, 'unsupported', attemptAt, previous?.latest, {
            snapshot: null, error: probe.errors[0]?.message ?? 'unsupported_os', probeTelemetry: probe.telemetry ?? null,
          })
          await saveServerMonitorResult({ latest }).catch(() => undefined)
          mergeServerMonitorStates({ [key]: { latest, history: historyForState(previous) } })
          scannedHosts.push(host)
          continue
        }
        if (!probe.metrics || (scheduled.recovered && !vaultId)) {
          throw new Error(probe.errors[0]?.message || 'server monitor returned no usable Linux metrics')
        }
        const snapshot = probe.metrics.data
        if (!isCurrent()) return

        // A durable fallback is useful for continuity, but it is not a new
        // successful sample. Keep its sampledAt/lastSuccessAt and surface the
        // provider error so the host card can show stale data explicitly.
        const recovered = Boolean(scheduled.recovered)
          || String(probe.health) === 'stale'
          || probe.metrics.freshness.expired
        const status = recovered ? 'stale' : 'online'
        const lastSuccessAt = Math.max(
          snapshot.sampledAt,
          previous?.latest?.lastSuccessAt ?? 0,
        ) || snapshot.sampledAt
        const latest = createServerMonitorLatest(host, status, attemptAt, previous?.latest, {
          snapshot,
          lastSuccessAt,
          probeTelemetry: probe.telemetry ?? null,
          ...(recovered && probe.errors[0]?.message ? { error: probe.errors[0].message } : {}),
        })
        const historyPoint: ServerMonitorHistoryPoint = {
          hostKey: key,
          sampledAt: snapshot.sampledAt,
          snapshot,
        }
        try {
          // Stale fallback data must not create a fresh history point. The
          // latest row remains durable, while the previous history remains the
          // source of truth until a real sample succeeds.
          await saveServerMonitorResult(buildLatestPayload(latest, recovered ? undefined : historyPoint))
        } catch (persistError) {
          latest.error = `Saved in memory; local history failed: ${errorMessage(persistError)}`
        }
        mergeServerMonitorStates({
          [key]: {
            latest,
            history: recovered
              ? historyForState(previous)
              : mergeHistory(historyForState(previous), historyPoint),
          },
        })
        scannedHosts.push(host)
      } catch (error) {
        if (!isCurrent()) return

        const status = isUnsupportedProbeError(error) ? 'unsupported' : isServerMonitorVaultUnavailableError(error)
          ? 'paused'
          : getServerMonitorFailureStatus(previous?.latest, Date.now())
        const latest = createServerMonitorLatest(host, status, attemptAt, previous?.latest, {
          error: errorMessage(error),
          ...(status === 'unsupported' ? { snapshot: null } : {}),
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
      { length: Math.max(1, Math.min(collectionConcurrency(concurrency), hosts.length)) },
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
