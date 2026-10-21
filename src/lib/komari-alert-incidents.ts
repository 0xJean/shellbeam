import type { KomariAlertRecord, KomariAlertStatus } from './komari-alerts'

export interface KomariAlertIncident {
  /** A display projection of an existing record; never a replacement ID. */
  alert: KomariAlertRecord
  members: KomariAlertRecord[]
  memberAlertIds: string[]
}

/** Legacy load/offline rows came from rule counts, not dated event evidence.
 * Keep their IDs, lifecycle and audits, but never treat them as current faults. */
export function isUnverifiedKomariRuleAlert(alert: Pick<KomariAlertRecord, 'kind'>): boolean {
  return alert.kind === 'load' || alert.kind === 'offline'
}

export function komariAlertLastObservation(alert: KomariAlertRecord): 'abnormal' | 'recovered' | 'unknown' {
  if (isUnverifiedKomariRuleAlert(alert)) return 'unknown'
  if (alert.resolvedAt !== null || alert.count === 0) return 'recovered'
  return (alert.count ?? 0) > 0 ? 'abnormal' : 'unknown'
}

function scopeKey(alert: KomariAlertRecord): string {
  return JSON.stringify([alert.integrationId, alert.nodeId ?? null, alert.hostId ?? null])
}

function isLegacyMissingReportRetry(alert: KomariAlertRecord): boolean {
  return alert.kind === 'probe-error:provider'
    && /^Komari Probe provider error: Probe recovery failed after \d+ retr(?:y|ies): Komari returned no dated metric observations$/.test(alert.title)
}

/** Only migrate the exact legacy fan-out of one missing-observation result.
 * Same scope and opening timestamp are required. Inventory failures and other
 * provider failures remain independent, even when observed in the same sync.
 * Existing IDs, statuses and audit facts are never rewritten. */
export function normalizeKomariAlertIncidents(alerts: readonly KomariAlertRecord[]): KomariAlertRecord[] {
  const records = alerts.map((alert) => {
    const record = { ...alert }
    if (isUnverifiedKomariRuleAlert(record)) record.evidenceStatus = 'unverified-rule-count'
    if (typeof record.incidentKey !== 'string' || !record.incidentKey.trim() || record.incidentKey.length > 200) delete record.incidentKey
    // A historical retry symptom may later become an independent provider
    // fault. Detach open faults on reads as well as reconciliation, without
    // altering IDs. Terminal members retain their original incident history.
    if (record.incidentKey?.startsWith('komari-missing-observations:')
      && record.kind === 'probe-error:provider'
      && (record.status === 'active' || record.status === 'acknowledged')
      && !isLegacyMissingReportRetry(record)) delete record.incidentKey
    return record
  })
  for (const metrics of records) {
    if (metrics.kind !== 'probe-error:metrics' || metrics.incidentKey) continue
    const missing = metrics.title.includes('Komari returned no dated metric observations')
      || metrics.probeTelemetry?.lastErrorCode === 'empty'
    if (!missing) continue
    const key = `komari-missing-observations:${metrics.alertId}`
    metrics.incidentKey = key
    for (const other of records) {
      if (other.incidentKey || scopeKey(other) !== scopeKey(metrics) || other.firstSeenAt !== metrics.firstSeenAt) continue
      const unknown = other.kind === 'probe-unknown' && other.title === 'Komari Probe health is unknown'
      const retry = isLegacyMissingReportRetry(other)
      if (unknown || retry) other.incidentKey = key
    }
  }
  return records
}

const statusOrder: KomariAlertStatus[] = ['active', 'acknowledged', 'resolved', 'closed']
const severityOrder = ['critical', 'warning', 'info']

/** Scope remains part of the grouping key even for persisted incidentKey data:
 * an imported/corrupt key must not join two nodes, hosts or integrations. */
export function groupKomariAlertIncidents(input: readonly KomariAlertRecord[]): KomariAlertIncident[] {
  const groups = new Map<string, KomariAlertRecord[]>()
  for (const alert of normalizeKomariAlertIncidents(input)) {
    const key = JSON.stringify([scopeKey(alert), alert.incidentKey || alert.alertId])
    groups.set(key, [...(groups.get(key) ?? []), alert])
  }
  return [...groups.values()].map((members) => {
    members.sort((left, right) => Number(right.kind === 'probe-error:metrics') - Number(left.kind === 'probe-error:metrics')
      || left.firstSeenAt - right.firstSeenAt || left.alertId.localeCompare(right.alertId))
    const primary = members[0]
    const status = statusOrder.find((value) => members.some((member) => member.status === value)) ?? primary.status
    // Only the exact old retry marker inflated severity. A later real outage
    // on the primary, or any independent critical diagnostic, remains critical.
    const severity = severityOrder.find((value) => members.some((member) => (member.incidentKey?.startsWith('komari-missing-observations:')
      && isLegacyMissingReportRetry(member) ? 'warning' : member.severity) === value)) as KomariAlertRecord['severity']
    return {
      alert: {
        ...primary,
        status,
        severity,
        count: members.length > 1 ? 1 : primary.count,
        firstSeenAt: Math.min(...members.map((member) => member.firstSeenAt)),
        lastSeenAt: Math.max(...members.map((member) => member.lastSeenAt)),
      },
      members,
      memberAlertIds: members.map((member) => member.alertId),
    }
  })
}

export function komariAlertIncidentMembers(alerts: readonly KomariAlertRecord[], alertId: string): KomariAlertRecord[] {
  return groupKomariAlertIncidents(alerts).find((incident) => incident.memberAlertIds.includes(alertId))?.members ?? []
}
