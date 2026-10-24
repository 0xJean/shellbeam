import type { HostProfile } from './hosts'
import {
  checkShellbeamAgent,
  normalizeShellbeamAgentRecord,
  type ShellbeamAgentCommandResult,
  type ShellbeamAgentRecord,
  upsertShellbeamAgent,
} from './shellbeam-agent'
import { operationTransport } from './operation-job'
import { upsertPersistedProbeSnapshot } from './probe-persistence'
import { parseShellbeamAgentObservation } from './shellbeam-agent'
import type { ProbeSnapshot } from './probe-provider'
import { COLLECTION_LIMITS } from './collection-limits'
import { syncShellbeamAgentHistory, SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS, type ShellbeamAgentHistorySyncSummary } from './shellbeam-agent-history'

/**
 * Agent lifecycle polling is deliberately a read-only scheduler. Installing,
 * upgrading, removing, or rolling back an agent remains an explicit
 * OperationJob. This scheduler only performs the one-shot probe and persists
 * its redacted lifecycle summary.
 */
export const SHELLBEAM_AGENT_SCHEDULE_INTERVAL_MS = COLLECTION_LIMITS.cadence.monitorIntervalMs
export const SHELLBEAM_AGENT_SCHEDULE_CONCURRENCY = COLLECTION_LIMITS.scheduler.concurrency
export const SHELLBEAM_AGENT_CHECK_TIMEOUT_MS = SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS

export interface ShellbeamAgentScheduleOptions {
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  vaultId?: string
  intervalMs?: number
  concurrency?: number
  timeoutMs?: number
  now?: () => number
  /** Optional lifecycle gate. Use this to avoid polling hosts without a
   * persisted probe installation; scheduled checks never install anything. */
  shouldCheck?: (host: HostProfile) => boolean
  /** Latest durable record, used to preserve version/capabilities on a
   * transient timeout or transport failure. */
  previousRecords?: ShellbeamAgentRecord[]
  check?: (host: HostProfile, resolveAuthSecret: (host: HostProfile) => Promise<string>, now: number) => Promise<ShellbeamAgentCommandResult>
  persist?: (record: ShellbeamAgentRecord) => Promise<unknown>
  onRecord?: (record: ShellbeamAgentRecord) => void
  persistSnapshot?: (snapshot: ProbeSnapshot, vaultId: string) => Promise<unknown>
  onError?: (error: unknown, host: HostProfile) => void
  importHistory?: boolean
  syncHistory?: typeof syncShellbeamAgentHistory
  onHistory?: (summary: ShellbeamAgentHistorySyncSummary) => void
}

export interface ShellbeamAgentScheduleResult {
  checkedHosts: HostProfile[]
  skippedHosts: HostProfile[]
  records: ShellbeamAgentRecord[]
  history: ShellbeamAgentHistorySyncSummary[]
}

export interface ShellbeamAgentScheduler {
  start(): void
  stop(): void
  isRunning(): boolean
  scanNow(options?: { force?: boolean }): Promise<ShellbeamAgentScheduleResult>
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function redactedError(error: unknown) {
  const message = errorMessage(error)
    .replace(/(password|passwd|private[_-]?key|secret|token|credential|authorization|bearer)(\s*[=:]\s*|\s+)[^\s,;]+/gi, '$1=<redacted>')
    .split('').map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('')
    .trim()
    .slice(0, 240) || 'ShellBeam Probe scheduler failed'
  const safe = new Error(message)
  if (error instanceof Error && error.name) safe.name = error.name
  return safe
}

function hostKey(vaultId: string, host: HostProfile) {
  return `${vaultId}:${host.id}`
}

function timeoutError(timeoutMs: number) {
  const error = new Error(`ShellBeam Probe check timed out after ${timeoutMs}ms`)
  error.name = 'ShellbeamAgentCheckTimeoutError'
  return error
}

/** Race a remote check against a bounded timeout. The remote promise is left
 * to clean itself up in the transport layer; the scheduler records unknown
 * and can continue checking other hosts without waiting for it. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function unknownRecord(host: HostProfile, vaultId: string, now: number, error: unknown, previous?: ShellbeamAgentRecord) {
  const record = normalizeShellbeamAgentRecord({
    ...previous,
    vaultId,
    hostId: host.id,
    status: 'unknown',
    health: 'unknown',
    transport: operationTransport(host),
    lastCheckedAt: now,
    updatedAt: now,
    lastErrorCode: error instanceof Error && error.name === 'ShellbeamAgentCheckTimeoutError'
      ? 'agent_check_timeout'
      : 'agent_check_failed',
    // normalizeShellbeamAgentRecord redacts sensitive words and bounds the
    // summary before it is persisted.
    lastError: redactedError(error).message,
  }, now)
  // A stale heartbeat is useful metadata, but an unsuccessful check must not
  // derive online health from that old timestamp.
  record.health = 'unknown'
  return record
}

export function createShellbeamAgentScheduler(options: ShellbeamAgentScheduleOptions): ShellbeamAgentScheduler {
  const vaultId = options.vaultId?.trim() || 'local'
  const intervalMs = Math.max(1_000, options.intervalMs ?? SHELLBEAM_AGENT_SCHEDULE_INTERVAL_MS)
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? SHELLBEAM_AGENT_SCHEDULE_CONCURRENCY)))
  const timeoutMs = Math.max(0, options.timeoutMs ?? SHELLBEAM_AGENT_CHECK_TIMEOUT_MS)
  const now = options.now ?? (() => Date.now())
  const check = options.check ?? ((host: HostProfile, resolve: (host: HostProfile) => Promise<string>, checkedAt: number) => checkShellbeamAgent(host, resolve, checkedAt, vaultId))
  const persist = options.persist ?? ((record: ShellbeamAgentRecord) => upsertShellbeamAgent(record, { notifyChange: false }))
  const previousRecordsByHost = new Map((options.previousRecords ?? []).filter((record) => record.vaultId === vaultId).map((record) => [record.hostId, record]))
  const lastAttemptAt = new Map<string, number>()
  const inFlight = new Set<string>()
  let timer: number | undefined
  let running = false
  let generation = 0
  let scanPromise: Promise<ShellbeamAgentScheduleResult> | undefined

  const scanNow = async ({ force = false }: { force?: boolean } = {}): Promise<ShellbeamAgentScheduleResult> => {
    if (scanPromise) return scanPromise
    const scanGeneration = generation
    const startedAt = now()
    const pending = options.hosts.filter((host) => {
      if (host.vaultId && host.vaultId !== vaultId) return false
      if (options.shouldCheck && !options.shouldCheck(host)) return false
      const key = hostKey(vaultId, host)
      const previousAttempt = lastAttemptAt.get(key) ?? 0
      // A manual refresh may bypass the interval TTL, while a scheduled tick
      // never launches the same host more than once in the interval window.
      return !inFlight.has(key) && (force || previousAttempt === 0 || startedAt - previousAttempt >= intervalMs)
    })
    const skippedHosts = options.hosts.filter((host) => !pending.includes(host))
    const checkedHosts: HostProfile[] = []
    const records: ShellbeamAgentRecord[] = []
    const history: ShellbeamAgentHistorySyncSummary[] = []

    const run = async () => {
      const queue = pending.slice()
      async function worker() {
        while (queue.length > 0 && generation === scanGeneration) {
          const host = queue.shift()
          if (!host) return
          const key = hostKey(vaultId, host)
          if (inFlight.has(key)) continue
          inFlight.add(key)
          lastAttemptAt.set(key, now())
          const checkedAt = now()
          let record: ShellbeamAgentRecord
          let observation: ProbeSnapshot | undefined
          try {
            const result = await withTimeout(check(host, options.resolveAuthSecret, checkedAt), timeoutMs)
            if (result.record.hostId !== host.id || result.record.vaultId !== 'local' && result.record.vaultId !== vaultId
              || result.snapshot && result.snapshot.host.hostId !== host.id) throw new Error('agent_check_scope_mismatch')
            const receivedAt = now()
            observation = result.snapshot ?? parseShellbeamAgentObservation(result.stdout, result.record, host, receivedAt)
            record = normalizeShellbeamAgentRecord({
              ...result.record,
              vaultId,
              hostId: host.id,
              lastCheckedAt: receivedAt,
              updatedAt: receivedAt,
              transport: operationTransport(host),
            }, receivedAt)
          } catch (error) {
            record = unknownRecord(host, vaultId, checkedAt, error, previousRecordsByHost.get(host.id))
            if (generation === scanGeneration) options.onError?.(redactedError(error), host)
          }

          // stop() invalidates the scan generation. Do not write results or
          // invoke callbacks after the app has shut down or changed vault.
          if (generation !== scanGeneration) {
            inFlight.delete(key)
            continue
          }

          // Persist lifecycle metadata only. The command output and auth
          // material stay in the transport result and never enter SQLite.
          try {
            await withTimeout(Promise.resolve(persist(record)), timeoutMs)
            if (generation !== scanGeneration) { inFlight.delete(key); continue }
            if (observation?.metrics || observation?.inventory) await withTimeout(Promise.resolve((options.persistSnapshot ?? upsertPersistedProbeSnapshot)(observation, vaultId)), timeoutMs)
            if (generation !== scanGeneration) { inFlight.delete(key); continue }
            if (options.importHistory !== false && record.status === 'installed' && observation?.metrics) {
              let historyActive = true
              let acknowledged: ShellbeamAgentHistorySyncSummary = { vaultId, hostId: host.id, providerKind: 'shellbeam-agent', providerId: 'shellbeam-agent', nodeId: record.agentId, status: 'failed', reason: 'timeout', imported: 0, pages: 0, hasMore: null, cursor: null }
              let summary: ShellbeamAgentHistorySyncSummary
              try {
                summary = await withTimeout((options.syncHistory ?? syncShellbeamAgentHistory)({ host, record, vaultId, resolveAuthSecret: options.resolveAuthSecret, now, isCurrent: () => historyActive && generation === scanGeneration,
                  onProgress: (progress) => { if (historyActive && generation === scanGeneration) acknowledged = { ...progress } },
                }), SHELLBEAM_AGENT_HISTORY_TIMEOUT_MS)
              } catch {
                // The independent history deadline may win while a later page
                // is pending. Never erase pages already acknowledged by SQLite.
                summary = { ...acknowledged, status: 'failed', reason: 'timeout' }
              } finally { historyActive = false }
              if (generation !== scanGeneration) { inFlight.delete(key); continue }
              history.push(summary)
              options.onHistory?.(summary)
            }
          } catch (error) {
            if (generation === scanGeneration) options.onError?.(redactedError(error), host)
          }
          if (generation !== scanGeneration) { inFlight.delete(key); continue }
          records.push(record)
          checkedHosts.push(host)
          options.onRecord?.(record)
          inFlight.delete(key)
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker()))
      return { checkedHosts, skippedHosts, records, history }
    }

    scanPromise = run().finally(() => {
      scanPromise = undefined
    })
    return scanPromise
  }

  const tick = () => {
    if (!running || typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void scanNow().catch((error) => {
      // A scheduler tick must never tear down the workspace event loop.
      options.onError?.(redactedError(error), options.hosts[0] ?? ({ id: '', name: '', address: '', port: 22, username: '', group: 'Custom', authType: 'password', tags: [], createdAt: 0, updatedAt: 0 } as HostProfile))
    })
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') tick()
  }

  return {
    start() {
      if (running) return
      running = true
      generation += 1
      if (typeof window !== 'undefined') {
        timer = window.setInterval(tick, intervalMs)
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      tick()
    },
    stop() {
      running = false
      generation += 1
      if (timer !== undefined && typeof window !== 'undefined') window.clearInterval(timer)
      timer = undefined
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    },
    isRunning: () => running,
    scanNow,
  }
}
