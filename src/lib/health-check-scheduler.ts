import { flushLocalOpsHost, hydrateLocalOpsHost } from './local-ops-persistence'
import type { HostProfile } from './hosts'
import { loadHealthChecks, loadHealthCheckHistory, latestHealthCheckResults, persistHealthCheckResult, runHealthCheck, type HealthCheckDefinition, type HealthCheckResult } from './health-checks'
import { evaluateLocalAlertRules, type LocalAlertRule } from './local-alert-rules'
import { dispatchLocalAlertNotifications, loadLocalAlertState, saveLocalAlertState } from './local-ops-store'

const inFlight = new Map<string, Promise<HealthCheckResult>>()
const waiters: Array<() => void> = []
let active = 0
const MAX_CONCURRENCY = 4
async function acquire() {
  if (active >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiters.push(resolve))
  else active += 1
}
function release() { const next = waiters.shift(); if (next) next(); else active -= 1 }
export function healthCheckAlertRule(check: HealthCheckDefinition): LocalAlertRule {
  return { id: `check:${check.id}`, hostId: check.hostId, name: check.name, metric: 'health-check', target: check.id, threshold: 1, recoveryThreshold: 0, durationMs: check.alertAfterMs ?? 0, recoveryDurationMs: check.recoveryAfterMs ?? 0, freshnessMs: Math.max(5_000, check.intervalMs * 2), severity: 'warning', enabled: check.enabled }
}
/** Manual and automatic checks share this gate; a panel cannot overlap an
 * already-running background check or exceed the global four-connection cap. */
export function runAndPersistHealthCheck(options: {
  vaultId?: string
  host: HostProfile
  check: HealthCheckDefinition
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  now?: number
  run?: () => Promise<HealthCheckResult>
  isCurrent?: () => boolean
  notify?: boolean
}): Promise<HealthCheckResult> {
  const key = JSON.stringify([options.vaultId || 'default', options.host.id, options.check.id])
  const pending = inFlight.get(key)
  if (pending) return pending
  const work = (async () => {
    await acquire()
    try {
      if (options.isCurrent && !options.isCurrent()) return { checkId: options.check.id, hostId: options.host.id, status: 'unknown' as const, checkedAt: options.now ?? Date.now(), nextCheckAt: (options.now ?? Date.now()) + options.check.intervalMs, durationMs: null, latencyMs: null, provider: 'ssh-agentless' as const, transport: options.host.jumpHost ? 'proxy-jump' as const : 'direct' as const }
      await hydrateLocalOpsHost(options.vaultId, options.host.id)
      const result = await (options.run ? options.run() : runHealthCheck(options))
      if (options.isCurrent && !options.isCurrent()) return result
      const normalized = persistHealthCheckResult(options.vaultId, result)
      const state = evaluateLocalAlertRules(loadLocalAlertState(options.vaultId, options.host.id), [healthCheckAlertRule(options.check)], [{ ruleId: `check:${options.check.id}`, value: normalized.status === 'unknown' ? null : normalized.status === 'failing' ? 1 : 0, sampledAt: normalized.checkedAt, source: normalized.provider, transport: normalized.transport }], normalized.checkedAt)
      saveLocalAlertState(options.vaultId, options.host.id, state)
      await flushLocalOpsHost(options.vaultId, options.host.id)
      if (options.notify !== false) await dispatchLocalAlertNotifications(options.vaultId, options.host.id, state).catch(() => undefined)
      return normalized
    } finally { release() }
  })()
  inFlight.set(key, work)
  void work.finally(() => { if (inFlight.get(key) === work) inFlight.delete(key) }).catch(() => undefined)
  return work
}
export interface HealthCheckSchedulerOptions {
  vaultId?: string
  getHosts: () => HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  getChecks?: (host: HostProfile) => HealthCheckDefinition[]
  getLatest?: (host: HostProfile) => Record<string, HealthCheckResult>
  now?: () => number
  run?: (host: HostProfile, check: HealthCheckDefinition) => Promise<HealthCheckResult>
  isUnlocked?: () => boolean
  onError?: (error: unknown) => void
  pollMs?: number
}
/** App-owned lifecycle. No dependency on whether Workspace or its check panel
 * is mounted. Hydration honors persisted nextCheckAt after a restart. */
export function createHealthCheckScheduler(options: HealthCheckSchedulerOptions) {
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  async function tick() {
    if (stopped || options.isUnlocked?.() === false) return
    if (ticking) return ticking
    const work = (async () => {
      const now = options.now?.() ?? Date.now()
      const due = options.getHosts().flatMap((host) => {
        const latest = options.getLatest?.(host) ?? latestHealthCheckResults(loadHealthCheckHistory(options.vaultId, host.id))
        return (options.getChecks?.(host) ?? loadHealthChecks(options.vaultId, host)).filter((check) => check.enabled && check.hostId === host.id && (!latest[check.id] || latest[check.id].checkedAt > now || Math.min(latest[check.id].nextCheckAt, latest[check.id].checkedAt + check.intervalMs) <= now)).map((check) => ({ host, check, previousAt: latest[check.id]?.checkedAt ?? 0 }))
      }).sort((a, b) => a.previousAt - b.previousAt).slice(0, 64)
      await Promise.all(due.map(({ host, check }) => runAndPersistHealthCheck({ vaultId: options.vaultId, host, check, resolveAuthSecret: options.resolveAuthSecret, now, run: options.run ? () => options.run!(host, check) : undefined, isCurrent: () => !stopped && options.isUnlocked?.() !== false && (options.getChecks?.(host) ?? loadHealthChecks(options.vaultId, host)).some((current) => current.id === check.id && current.enabled && JSON.stringify(current) === JSON.stringify(check)) }).catch((error) => options.onError?.(error))))
    })()
    ticking = work
    try { await work } finally { if (ticking === work) ticking = undefined }
  }
  return {
    tick,
    start() { if (timer) return; stopped = false; void tick(); timer = setInterval(() => { void tick() }, Math.max(1_000, options.pollMs ?? 5_000)) },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined },
  }
}
