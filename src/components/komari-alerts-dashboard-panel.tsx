import { useCallback, useEffect, useMemo, useState } from 'react'
import { listKomariIntegrations } from '@/lib/komari-config'
import {
  loadKomariPersistence,
  readKomariAlertState,
} from '@/lib/komari-persistence'
import {
  persistKomariAlertAction,
  type KomariAlertAction,
} from '@/lib/komari-alert-actions'
import {
  summarizeKomariAlertState,
  type KomariAlertRecord,
  type KomariAlertState,
} from '@/lib/komari-alerts'
import type { KomariAlertSummary } from '@/lib/komari'
import KomariAlertPanel from './komari-alert-panel'

interface AlertEntry {
  integrationId: string
  state: KomariAlertState
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

export interface KomariAlertsDashboardPanelProps {
  activeVaultId?: string
  onOpenHost?: (hostId: string) => void
  onOpenOperation?: (operationJobId: string) => void
}

/** Loads persisted lifecycle rows and delegates acknowledgement/close to the
 * same durable helper used by other alert surfaces. It intentionally does not
 * fetch Komari credentials or mutate remote notifications. */
export function KomariAlertsDashboardPanel({ activeVaultId, onOpenHost, onOpenOperation }: KomariAlertsDashboardPanelProps) {
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
      setEntries(loaded.filter((entry): entry is AlertEntry => entry !== null))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [activeVaultId])

  useEffect(() => { void reload() }, [reload])

  const state = useMemo(() => mergeAlertEntries(entries), [entries])
  const handleAction = useCallback(async (action: KomariAlertAction, alert: KomariAlertRecord) => {
    const entry = entries.find((candidate) => candidate.state.alerts.some((item) => item.alertId === alert.alertId))
    if (!entry) throw new Error('Komari alert integration was not found')
    const result = await persistKomariAlertAction(action, {
      integrationId: entry.integrationId,
      state: entry.state,
      alertId: alert.alertId,
    })
    setEntries((current) => current.map((candidate) => candidate.integrationId === entry.integrationId ? { ...candidate, state: result.state } : candidate))
  }, [entries])

  if (!activeVaultId && !state && !loading) return null
  return (
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
  )
}

export default KomariAlertsDashboardPanel
