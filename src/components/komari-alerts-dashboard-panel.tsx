import { useCallback, useEffect, useMemo, useState } from 'react'
import { listKomariIntegrations } from '@/lib/komari-config'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { loadNotificationPolicy } from '@/lib/notification-policy'
import type { NotificationDispatchState } from '@/lib/notification-dispatch'
import {
  dispatchAndPersistKomariAlertNotifications,
  emitKomariAlertNotification,
  type KomariAlertNotificationSummary,
} from '@/lib/komari-alert-notifications'
import {
  loadKomariPersistence,
  readKomariAlertState,
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
  state: KomariAlertState
  notificationState?: NotificationDispatchState
  notificationSummary?: KomariAlertNotificationSummary
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
  return { deliveries: states.flatMap((state) => state.deliveries).sort((left, right) => left.deliveredAt - right.deliveredAt).slice(-1_000) }
}

export interface KomariAlertsDashboardPanelProps {
  activeVaultId?: string
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
export function KomariAlertsDashboardPanel({ activeVaultId, hosts = [], onOpenHost, onOpenOperation }: KomariAlertsDashboardPanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<AlertEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!activeVaultId) {
      setEntries([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const integrations = await listKomariIntegrations(activeVaultId)
      const loaded = await Promise.all(integrations.filter((integration) => integration.enabled).map(async (integration) => {
        const persisted = await loadKomariPersistence(integration.id)
        const state = readKomariAlertState(persisted.syncState)
        return state ? { integrationId: integration.id, state } : null
      }))
      const nextEntries = loaded.filter((entry): entry is AlertEntry => entry !== null)
      const notificationPolicy = loadNotificationPolicy()
      const notifiedEntries = await Promise.all(nextEntries.map(async (entry) => {
        try {
          const result = await dispatchAndPersistKomariAlertNotifications(entry.integrationId, entry.state, {
            policy: notificationPolicy,
            // The persisted lifecycle includes audit history. Only rows from
            // the most recent sync/action are eligible here; older rows remain
            // visible in the audit panel but must not replay notifications.
            audit: entry.state.audit.filter((audit) => audit.at >= entry.state.summary.localUpdatedAt),
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
      setEntries(notifiedEntries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [activeVaultId])

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
    const timer = window.setInterval(refreshWhenVisible, 15_000)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [reload])

  const state = useMemo(() => mergeAlertEntries(entries), [entries])
  const notificationSummary = useMemo(() => mergeNotificationSummaries(entries), [entries])
  const notificationState = useMemo(() => mergeNotificationStates(entries), [entries])
  const handleAction = useCallback(async (action: KomariAlertAction, alert: KomariAlertRecord) => {
    const entry = entries.find((candidate) => candidate.state.alerts.some((item) => item.alertId === alert.alertId))
    if (!entry) throw new Error('Komari alert integration was not found')
    const persisted = await loadKomariPersistence(entry.integrationId)
    const host = alert.hostId ? hosts.find((candidate) => candidate.id === alert.hostId) : undefined
    const result = host
      ? (await runKomariAlertAction(action, {
          integrationId: entry.integrationId,
          state: entry.state,
          alertId: alert.alertId,
          host,
          vaultId: activeVaultId,
          lastSyncedAt: persisted.lastSyncedAt ?? undefined,
          ttlMs: persisted.syncState?.ttlMs,
          confirmMessage: t(
            action === 'acknowledge' ? 'hosts.alert.confirmAcknowledge' : 'hosts.alert.confirmClose',
            { host: host.name, alert: alert.title },
          ),
        }))
      : await persistKomariAlertAction(action, {
          integrationId: entry.integrationId,
          state: entry.state,
          alertId: alert.alertId,
        })
    if (!result) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('shellbeam:host-ops-refresh'))
    }
    try {
      const notificationResult = await dispatchAndPersistKomariAlertNotifications(entry.integrationId, result.state, {
        policy: loadNotificationPolicy(),
        audit: result.state.audit.slice(-1),
        state: entry.notificationState,
        onLocal: emitKomariAlertNotification,
      })
      setEntries((current) => current.map((candidate) => candidate.integrationId === entry.integrationId
        ? { ...candidate, state: result.state, notificationState: notificationResult.state, notificationSummary: notificationResult.summary }
        : candidate))
    } catch {
      setEntries((current) => current.map((candidate) => candidate.integrationId === entry.integrationId ? { ...candidate, state: result.state } : candidate))
    }
  }, [activeVaultId, entries, hosts, t])

  if (!activeVaultId && !state && !loading) return null
  return (
    <>
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
    </>
  )
}

export default KomariAlertsDashboardPanel
