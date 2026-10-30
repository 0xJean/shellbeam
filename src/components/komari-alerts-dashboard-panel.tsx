import { monitoringAlertTitle } from '@/lib/monitoring-presentation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listKomariIntegrations } from '@/lib/komari-config'
import type { HostProfile } from '@/lib/hosts'
import { isCurrentKomariAlert, loadCurrentKomariSource, type CurrentKomariSource } from '@/lib/komari-source-eligibility'
import { groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import type { HostIncident } from './host-alerts-center'
import { useT } from '@/lib/i18n'
import { monitoringAlertsCopy } from '@/lib/locales/monitoring-alerts'
import { loadNotificationPolicy } from '@/lib/notification-policy'
import type { NotificationDispatchState } from '@/lib/notification-dispatch'
import {
  dispatchAndPersistKomariAlertNotifications,
  emitKomariAlertNotification,
  type KomariAlertNotificationSummary,
} from '@/lib/komari-alert-notifications'
import {
  loadKomariPersistence,
  confirmedKomariSyncAt,
  readKomariAlertState,
  KOMARI_MAPPING_CHANGED_EVENT,
} from '@/lib/komari-persistence'
import {
  persistKomariAlertAction,
  runKomariAlertAction,
  type KomariAlertAction,
} from '@/lib/komari-alert-actions'
import {
  summarizeKomariAlertState,
  type KomariAlertRecord,
  type KomariAlertState,
} from '@/lib/komari-alerts'
import type { KomariAlertSummary } from '@/lib/komari'
import KomariAlertPanel from './komari-alert-panel'
import NotificationDeliverySummary, { type NotificationDispatchSummary } from './notification-delivery-summary'

interface AlertEntry {
  integrationId: string
  source: CurrentKomariSource
  state: KomariAlertState
  notificationState?: NotificationDispatchState
  notificationSummary?: KomariAlertNotificationSummary
}
const EMPTY_HOSTS: HostProfile[] = []

function unassignedAlert(alert: KomariAlertRecord, source: CurrentKomariSource) {
  // A former host-owned incident stays in that host's audit. Losing a mapping
  // must never turn it into a newly discovered source-level incident.
  return !alert.hostId && (!alert.nodeId || !!source.state && !source.error
    && !source.state.mappings.some(mapping => mapping.nodeId === alert.nodeId))
}

function currentUnassignedAlert(alert: KomariAlertRecord, source: CurrentKomariSource) {
  if (alert.kind === 'load' || alert.kind === 'offline') return false
  if (!source.integration.enabled || source.error || !unassignedAlert(alert, source)) return false
  const syncedAt = confirmedKomariSyncAt(source.integration, source.state?.syncState)
  // Aggregate rows have no endpoint in their fingerprint. Only a committed
  // remote sync for this configuration proves their current origin; a local
  // acknowledgement or cache write cannot manufacture that provenance.
  return syncedAt !== null && alert.integrationId === source.integration.id
    && alert.lastSeenAt >= source.integration.updatedAt && alert.lastSeenAt <= Date.now()
}

function notificationProjection(entry: AlertEntry, hosts: HostProfile[]): KomariAlertState {
  const snapshots = entry.source.state?.snapshots.map(row => row.snapshot) ?? []
  const alerts = entry.state.alerts.filter(alert => entry.source.integration.enabled && !entry.source.error
    && ((!!alert.hostId || !!alert.nodeId) && hosts.some(host => isCurrentKomariAlert(alert, host, [entry.source], snapshots)) || currentUnassignedAlert(alert, entry.source)))
  const ids = new Set(alerts.map(alert => alert.alertId))
  return { ...entry.state, alerts, audit: entry.state.audit.filter(audit => ids.has(audit.alertId)) }
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => value !== null && value !== undefined)
  if (numbers.length !== values.length) return null
  return numbers.reduce((sum, value) => sum + value, 0)
}

function mergeAlertEntries(entries: AlertEntry[]): KomariAlertState | null {
  if (entries.length === 0) return null
  const alerts = entries.flatMap((entry) => entry.state.alerts)
  const audit = entries.flatMap((entry) => entry.state.audit).sort((left, right) => left.at - right.at).slice(-1000)
  const summaries = entries.map((entry) => entry.state.summary)
  const base: KomariAlertSummary = {
    load: sumNullable(summaries.map((summary) => summary.load)),
    offline: sumNullable(summaries.map((summary) => summary.offline)),
    total: sumNullable(summaries.map((summary) => summary.total)),
    active: sumNullable(summaries.map((summary) => summary.active)),
    updatedAt: Math.max(...summaries.map((summary) => summary.updatedAt ?? 0)),
  }
  const summary = summarizeKomariAlertState(alerts, Math.max(...summaries.map((item) => item.localUpdatedAt)), base)
  return { schemaVersion: 1, alerts, audit, summary }
}

function mergeNotificationSummaries(entries: AlertEntry[]): NotificationDispatchSummary | null {
  const summaries = entries.map((entry) => entry.notificationSummary).filter((summary): summary is KomariAlertNotificationSummary => summary !== undefined)
  if (summaries.length === 0) return null
  return {
    considered: summaries.reduce((sum, summary) => sum + summary.considered, 0),
    delivered: summaries.reduce((sum, summary) => sum + summary.delivered, 0),
    skipped: summaries.reduce((sum, summary) => sum + summary.skipped + summary.omitted, 0),
    failed: summaries.reduce((sum, summary) => sum + summary.failed, 0),
    lastDeliveredAt: summaries.reduce<number | null>((latest, summary) => summary.lastDeliveredAt === null ? latest : Math.max(latest ?? 0, summary.lastDeliveredAt), null),
  }
}

function mergeNotificationStates(entries: AlertEntry[]): NotificationDispatchState | null {
  const states = entries.map((entry) => entry.notificationState).filter((state): state is NotificationDispatchState => state !== undefined)
  if (states.length === 0) return null
  return {
    deliveries: states.flatMap((state) => state.deliveries).sort((left, right) => left.deliveredAt - right.deliveredAt).slice(-1_000),
    attempts: states.flatMap((state) => state.attempts ?? []).sort((left, right) => left.attemptedAt - right.attemptedAt).slice(-1_000),
  }
}

export interface KomariAlertsDashboardPanelProps {
  /** Retain delivery reconciliation when the host page owns the unified UI. */
  headless?: boolean
  onAdditionalIncidents?: (incidents: HostIncident[]) => void
  activeVaultId?: string
  vaultUnlocked?: boolean
  /** Host profiles let host-scoped acknowledgement/close actions use the
   * same confirmed OperationJob bridge as the inline host card. Aggregate
   * alerts without a host continue through the local journal only. */
  hosts?: HostProfile[]
  onOpenHost?: (hostId: string) => void
  onOpenOperation?: (operationJobId: string) => void
}

/** Loads persisted lifecycle rows, routes newly observed transitions through
 * the local notification policy, and delegates acknowledgement/close to the
 * same durable helper used by other alert surfaces. It never fetches Komari
 * credentials or mutates Komari's remote alert state. */
export function KomariAlertsDashboardPanel(props: KomariAlertsDashboardPanelProps) {
  return props.activeVaultId && props.vaultUnlocked ? <VaultAlertsDashboard key={props.activeVaultId} {...props} /> : null
}

function VaultAlertsDashboard({ activeVaultId, hosts = EMPTY_HOSTS, onOpenHost, onOpenOperation, headless, onAdditionalIncidents }: KomariAlertsDashboardPanelProps) {
  const { t, locale } = useT()
  const additionalCallback = useRef(onAdditionalIncidents)
  additionalCallback.current = onAdditionalIncidents
  const scopedHosts = useMemo(() => hosts.filter(host => !host.vaultId || host.vaultId === activeVaultId).map(host => ({ ...host, vaultId: host.vaultId ?? activeVaultId })), [activeVaultId, hosts])
  const [entries, setEntries] = useState<AlertEntry[]>([])
  const latestEntries = useRef(entries)
  latestEntries.current = entries
  const latestHosts = useRef(scopedHosts)
  latestHosts.current = scopedHosts
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = useRef({ generation: 0, loadSequence: 0, mounted: false }).current
  useEffect(() => {
    scope.mounted = true
    scope.generation++
    return () => { scope.mounted = false; scope.generation++; scope.loadSequence++; additionalCallback.current?.([]) }
  }, [scope])

  const reload = useCallback(async () => {
    if (!activeVaultId) {
      setEntries([])
      return
    }
    const epoch = scope.generation
    const request = ++scope.loadSequence
    const current = () => scope.mounted && scope.generation === epoch && scope.loadSequence === request
    if (!current()) return
    setLoading(true)
    setError(null)
    try {
      const integrations = await listKomariIntegrations(activeVaultId)
      if (!current()) return
      const loaded = await Promise.all(integrations.filter((integration) => integration.vaultId === activeVaultId).map(async (integration): Promise<AlertEntry | null> => {
        const source = await loadCurrentKomariSource(integration)
        if (!current()) return null
        const persisted = source.state ?? await loadKomariPersistence(integration.id)
        if (!current()) return null
        const state = readKomariAlertState(persisted.syncState)
        return state ? { integrationId: integration.id, source, state } : null
      }))
      if (!current()) return
      const nextEntries = loaded.filter((entry): entry is AlertEntry => entry !== null)
      const notificationPolicy = loadNotificationPolicy()
      const notifiedEntries = await Promise.all(nextEntries.map(async (entry) => {
        const projected = notificationProjection(entry, scopedHosts)
        if (!projected.alerts.length || !current()) return entry
        try {
          const result = await dispatchAndPersistKomariAlertNotifications(entry.integrationId, projected, {
            isCurrent: current,
            policy: notificationPolicy,
            // Discover recent unseen MCP/session transitions, and retry known
            // failures without replaying old history or successful channels.
            audit: [],
            retryPending: true,
            includeRecent: true,
            // The in-app alert panel is the local sink. Delivery state stores
            // metadata only, while the panel remains the payload surface.
            onLocal: emitKomariAlertNotification,
          })
          return { ...entry, notificationState: result.state, notificationSummary: result.summary }
        } catch {
          // Notification delivery must never hide a healthy persisted alert
          // lifecycle when an optional sink is unavailable.
          return entry
        }
      }))
      if (current()) setEntries(notifiedEntries)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) setLoading(false)
    }
  }, [activeVaultId, scope, scopedHosts])

  useEffect(() => { void reload() }, [reload])

  // Alert lifecycle rows are persisted in the local Komari sync journal, so
  // another window/session may acknowledge, close or resolve an alert while
  // this dashboard is mounted. Re-read that journal when the app returns to
  // the foreground and during a long open session; this keeps the summary and
  // notification delivery ledger aligned without polling the Komari API.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('shellbeam:host-ops-refresh', refreshWhenVisible)
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 15_000)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('shellbeam:host-ops-refresh', refreshWhenVisible)
      window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [reload])

  const state = useMemo(() => mergeAlertEntries(entries), [entries])
  const notificationSummary = useMemo(() => mergeNotificationSummaries(entries), [entries])
  const notificationState = useMemo(() => mergeNotificationStates(entries), [entries])
  const handleAction = useCallback(async (action: KomariAlertAction, alert: KomariAlertRecord) => {
    const epoch = scope.generation
    const initialHost = alert.hostId ? latestHosts.current.find(host => host.id === alert.hostId && host.vaultId === activeVaultId) : undefined
    const hostVersion = initialHost ? JSON.stringify(initialHost) : null
    const current = () => scope.mounted && scope.generation === epoch && (!alert.hostId
      || latestHosts.current.some(host => host.id === alert.hostId && host.vaultId === activeVaultId && JSON.stringify(host) === hostVersion))
    if (!current()) return
    // An older reload must not overwrite a just-confirmed local action.
    scope.loadSequence++
    setLoading(false)
    const entry = latestEntries.current.find((candidate) => candidate.integrationId === alert.integrationId && candidate.state.alerts.some((item) => item.alertId === alert.alertId))
    if (!entry) throw new Error('Komari alert integration was not found')
    const persisted = await loadKomariPersistence(entry.integrationId)
    if (!current()) return
    const latest = readKomariAlertState(persisted.syncState) ?? entry.state
    const host = alert.hostId ? latestHosts.current.find((candidate) => candidate.id === alert.hostId && candidate.vaultId === activeVaultId) : undefined
    if (alert.hostId && !host) return
    const result = host
      ? (await runKomariAlertAction(action, {
          integrationId: entry.integrationId,
          state: latest,
          alertId: alert.alertId,
          host,
          vaultId: activeVaultId,
          isCurrent: current,
          lastSyncedAt: persisted.lastSyncedAt ?? undefined,
          ttlMs: persisted.syncState?.ttlMs,
          confirmMessage: t(
            action === 'acknowledge' ? 'hosts.alert.confirmAcknowledge' : 'hosts.alert.confirmClose',
            { host: host.name, alert: monitoringAlertTitle(alert, locale) },
          ),
        }))
      : await persistKomariAlertAction(action, {
          integrationId: entry.integrationId,
          state: latest,
          alertId: alert.alertId,
        })
    if (!result || !current()) return
    scope.loadSequence++
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('shellbeam:host-ops-refresh'))
    }
    // Re-read current configuration and eligibility before delivery. The
    // action helper above receives the complete journal; this refresh writes
    // only delivery metadata and never persists a filtered lifecycle state.
    await reload()
  }, [activeVaultId, t, locale, scope, reload])

  useEffect(() => {
    if (!headless || !additionalCallback.current) return
    const incidents: HostIncident[] = entries.flatMap(entry => {
      const snapshots = entry.source.state?.snapshots.map(row => row.snapshot) ?? []
      return groupKomariAlertIncidents(entry.state.alerts).flatMap(({ alert, memberAlertIds }): HostIncident[] => {
        if (alert.integrationId !== entry.integrationId) return []
        const host = alert.hostId ? scopedHosts.find(host => host.id === alert.hostId) : undefined
        const hasCurrentHost = (!!alert.hostId || !!alert.nodeId)
          && scopedHosts.some(host => isCurrentKomariAlert(alert, host, [entry.source], snapshots))
        // Current host incidents are already supplied by the host summary.
        if (hasCurrentHost) return []
        const currentUnassigned = currentUnassignedAlert(alert, entry.source)
        return [{
          key: host ? `komari:${host.id}:${entry.integrationId}:${alert.alertId}` : `komari:additional:${entry.integrationId}:${alert.alertId}`, hostId: host?.id ?? '',
          hostName: host?.name ?? entry.source.integration.name,
          title: alert.title, monitoringKind: alert.kind, source: 'komari', status: alert.status, updatedAt: alert.lastSeenAt, busy: loading,
          historyOnly: !currentUnassigned,
          evidenceUnavailable: alert.evidenceStatus === 'unverified-rule-count',
          audit: entry.state.audit.filter(row => memberAlertIds.includes(row.alertId)),
          // Deleted/foreign host identities remain read-only history; they
          // must not be reclassified as unassigned actionable incidents.
          act: !alert.hostId || host ? (action: 'acknowledge' | 'close') => handleAction(action, alert) : undefined,
        }]
      })
    })
    additionalCallback.current(incidents)
  }, [entries, headless, handleAction, loading, scopedHosts])

  if (headless || (!error && !state?.alerts.length)) return null
  return (
    <details className="mb-4 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--workspace-text-strong)]">{monitoringAlertsCopy[locale].alerts} · {state?.summary.open ?? 0} {monitoringAlertsCopy[locale].open}</summary>
      {notificationSummary && <NotificationDeliverySummary summary={notificationSummary} state={notificationState} compact className="mb-3" />}
      <KomariAlertPanel
        state={state}
        loading={loading}
        error={error}
        onAcknowledge={(alert) => handleAction('acknowledge', alert)}
        onClose={(alert) => handleAction('close', alert)}
        onOpenHost={onOpenHost}
        onOpenOperation={onOpenOperation}
        compact
        className="mb-4"
      />
    </details>
  )
}

export default KomariAlertsDashboardPanel
