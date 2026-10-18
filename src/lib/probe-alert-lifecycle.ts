import type { HostProfile } from './hosts'
import { evaluateLocalAlertRules, normalizeLocalAlertRule, type LocalAlertObservation, type LocalAlertRule } from './local-alert-rules'
import { hydrateLocalOpsHost, flushLocalOpsHost } from './local-ops-persistence'
import { dispatchLocalAlertNotifications, loadLocalAlertState, saveLocalAlertState } from './local-ops-store'
import { getProbeCollectionConfigRevision, probeCollectionDigest, type ProbeCollectionEvent, type ProbeCollectionSection } from './probe-collection-events'

export interface ProbeAlertLifecycleOptions {
  /** Return only an unlocked, current host in this event's Vault. */
  getCurrentHost: (event: ProbeCollectionEvent) => HostProfile | null
  /** Include the runtime generation boundary, including referenced jump-host
   * edits: a registry request only receives its target host's configuration. */
  isCurrent: (event: ProbeCollectionEvent) => boolean | Promise<boolean>
  /** A local translated label; never include a remote error or endpoint. */
  ruleName?: (section: ProbeCollectionSection) => string
}
export interface ProbeAlertLifecycleResult { status: 'applied' | 'ignored' }
const queues = new Map<string, Promise<void>>()

function validEvent(event: ProbeCollectionEvent) {
  return event && typeof event === 'object' && event.provider?.kind === 'ssh-agentless'
    && [event.eventId, event.vaultId, event.hostId, event.provider.id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 160 && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
    && /^[a-f0-9]{64}$/.test(event.configRevision)
    && [event.startedAt, event.completedAt].every(value => Number.isSafeInteger(value) && value >= 0)
    && event.startedAt <= event.completedAt && event.completedAt <= Date.now()
    && Number.isSafeInteger(event.startedSequence) && event.startedSequence > 0
    && ['direct', 'proxy-jump'].includes(event.transport)
    && Array.isArray(event.sections) && event.sections.length > 0 && event.sections.length <= 2
    && new Set(event.sections.map(row => row?.section)).size === event.sections.length
    && event.sections.every(row => row && ['metrics', 'inventory'].includes(row.section) && ['success', 'failure', 'unknown'].includes(row.outcome)
      && ['observed', 'collection-unavailable', 'scope-unavailable', 'unsupported', 'paused', 'observation-unavailable'].includes(row.reason)
      && (row.sampledAt === null || Number.isSafeInteger(row.sampledAt) && row.sampledAt >= 0 && row.sampledAt <= event.completedAt)
      && (row.outcome !== 'success' || row.reason === 'observed' && row.sampledAt !== null)
      && (row.outcome !== 'failure' || row.reason === 'collection-unavailable'))
}

export async function probeAlertRuleId(provider: ProbeCollectionEvent['provider'], section: ProbeCollectionSection) {
  const digest = await probeCollectionDigest(JSON.stringify([provider.kind, provider.id]))
  return `probe:${provider.kind}:${digest.slice(0, 32)}:${section}`
}

/** A read-only collection outcome creates a durable local lifecycle, never a
 * repair command. Unknown evidence preserves an open alert without resolving
 * it; recovery requires the original timestamp of a new successful sample. */
export function createProbeAlertLifecycleConsumer(options: ProbeAlertLifecycleOptions) {
  const seen = new Set<string>()
  const pending = new Set<Promise<ProbeAlertLifecycleResult>>()
  const failures = new Map<string, unknown>()
  const completed = new Map<string, number>()

  async function current(event: ProbeCollectionEvent) {
    if (!await options.isCurrent(event)) return false
    const host = options.getCurrentHost(event)
    if (!host || host.id !== event.hostId || host.vaultId && host.vaultId !== event.vaultId) return false
    const revision = await getProbeCollectionConfigRevision({ ...host, vaultId: event.vaultId })
    return revision === event.configRevision && await options.isCurrent(event)
  }

  function consume(event: ProbeCollectionEvent): Promise<ProbeAlertLifecycleResult> {
    if (!validEvent(event)) return Promise.resolve({ status: 'ignored' })
    const scope = JSON.stringify([event.vaultId, event.hostId])
    const work = (queues.get(scope) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<ProbeAlertLifecycleResult> => {
      if (seen.has(event.eventId) || !await current(event)) return { status: 'ignored' }
      await hydrateLocalOpsHost(event.vaultId, event.hostId, true)
      if (!await current(event)) return { status: 'ignored' }
      const rules: LocalAlertRule[] = []
      const observations: LocalAlertObservation[] = []
      const previous = loadLocalAlertState(event.vaultId, event.hostId)
      const accepted: string[] = []
      for (const row of event.sections) {
        const ruleId = await probeAlertRuleId(event.provider, row.section)
        const sectionKey = JSON.stringify([scope, event.configRevision, ruleId])
        const evaluation = previous.evaluations.find(value => value.ruleId === ruleId)
        // Unknown evidence does not update a sample timestamp in the shared
        // evaluator. Order it by the actual attempt completion separately so
        // a delayed old unknown/failure cannot regress a newer observation.
        if (event.completedAt < (completed.get(sectionKey) ?? 0)
          || row.outcome === 'unknown' && event.completedAt <= (evaluation?.sampledAt ?? 0)) continue
        accepted.push(sectionKey)
        rules.push(normalizeLocalAlertRule({ id: ruleId, hostId: event.hostId, metric: 'probe-provider', target: ruleId,
          name: options.ruleName?.(row.section) ?? `SSH probe unavailable · ${row.section}`, threshold: 1, recoveryThreshold: 0, durationMs: 0, recoveryDurationMs: 0,
          freshnessMs: 180_000, severity: 'warning', enabled: true }))
        observations.push({ ruleId, value: row.outcome === 'failure' ? 1 : row.outcome === 'success' ? 0 : null,
          sampledAt: row.outcome === 'success' ? row.sampledAt! : event.completedAt, source: event.provider.kind, transport: event.transport })
      }
      if (!rules.length) return { status: 'ignored' }
      if (!await current(event)) return { status: 'ignored' }
      const state = evaluateLocalAlertRules(previous, rules, observations, Date.now())
      saveLocalAlertState(event.vaultId, event.hostId, state)
      await flushLocalOpsHost(event.vaultId, event.hostId)
      for (const key of accepted) completed.set(key, event.completedAt)
      while (completed.size > 512) completed.delete(completed.keys().next().value!)
      // A scope change while the durable transaction was pending must not
      // deliver the old host's notification into the new active context.
      if (!await current(event)) return { status: 'ignored' }
      await dispatchLocalAlertNotifications(event.vaultId, event.hostId, state)
      seen.add(event.eventId)
      if (seen.size > 256) seen.delete(seen.values().next().value!)
      return { status: 'applied' }
    })
    const settled = work.then(result => { if (result.status === 'applied') failures.delete(scope) }, error => { failures.set(scope, error) })
    queues.set(scope, settled)
    pending.add(work)
    void settled.then(() => { pending.delete(work); if (queues.get(scope) === settled) queues.delete(scope) })
    return work
  }

  return {
    consume,
    async flush() {
      await Promise.all([...pending].map(work => work.then(() => undefined, () => undefined)))
      if (failures.size) throw failures.values().next().value
    },
  }
}
