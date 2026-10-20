import type { HostProfile } from './hosts'
import type { HostOperationalSummary } from '@/components/host-card'
import { groupKomariAlertIncidents } from './komari-alert-incidents'
import type { KomariAlertAuditEntry } from './komari-alerts'

export interface HostIncident {
  key: string
  hostId: string
  hostName: string
  title: string
  source: string
  status: string
  updatedAt: number
  busy: boolean
  /** Retained lifecycle from a source that no longer supplies current health. */
  historyOnly?: boolean
  audit?: KomariAlertAuditEntry[]
  act?: (action: 'acknowledge' | 'close') => void | Promise<void>
}

/** Presentation adapter only: original records and confirmed action handlers
 * remain authoritative. Different sources are never deduplicated by title. */
export function buildHostIncidents(hosts: HostProfile[], summaries: Map<string, HostOperationalSummary | undefined>, vaultId?: string): HostIncident[] {
  if (!vaultId) return []
  return hosts.flatMap(host => {
    const summary = summaries.get(host.id)
    if ((host.vaultId && host.vaultId !== vaultId) || summary?.vaultId !== vaultId) return []
    const local: HostIncident[] = (summary.localAlerts ?? []).filter(alert => alert.hostId === host.id).map(alert => ({
      key: `local:${host.id}:${alert.ruleId}`, hostId: host.id, hostName: host.name, title: alert.name,
      source: alert.source || 'local', status: alert.status, updatedAt: alert.updatedAt,
      busy: !!summary.localAlertBusy,
      act: summary.onLocalAlertAction ? action => summary.onLocalAlertAction!(alert, action) : undefined,
    }))
    const komari: HostIncident[] = groupKomariAlertIncidents(summary.komariAlerts ?? [])
      .filter(({ alert }) => !alert.hostId || alert.hostId === host.id).map(({ alert, memberAlertIds }) => ({
        key: `komari:${host.id}:${alert.integrationId}:${alert.alertId}`, hostId: host.id, hostName: host.name,
        title: alert.title, source: 'komari', status: alert.status, updatedAt: alert.lastSeenAt,
        busy: !!summary.komariAlertBusy,
        audit: summary.komariAlertAudits?.filter(entry => memberAlertIds.includes(entry.alertId)),
        act: summary.onKomariAlertAction ? action => summary.onKomariAlertAction!(action, alert) : undefined,
      }))
    return [...local, ...komari]
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
}
