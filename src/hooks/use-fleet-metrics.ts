import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KOMARI_INTEGRATIONS_CHANGED_EVENT,
  PROBE_DEPLOYMENT_CHANGED_EVENT,
} from '@/hooks/use-probe-install-readiness'
import { CERTIFICATE_CACHE_EVENT, loadCachedCertificates, type CachedCertificate } from '@/lib/certificate-cache'
import { readCompatibleAgent, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { buildHostOpsViews, loadHostOpsViews, type HostOpsView } from '@/lib/host-ops-view'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { groupKomariAlertIncidents } from '@/lib/komari-alert-incidents'
import type { KomariAlertState } from '@/lib/komari-alerts'
import type { KomariIntegration } from '@/lib/komari-config'
import { KOMARI_MAPPING_CHANGED_EVENT, readKomariAlertState } from '@/lib/komari-persistence'
import { loadCurrentKomariSources } from '@/lib/komari-source-eligibility'
import { LOCAL_OPS_CHANGED_EVENT, loadLocalAlertState } from '@/lib/local-ops-store'
import { primarySourcePoints } from '@/lib/metric-series'
import { listProviderMetricHistory, type ProviderMetricHistoryPoint } from '@/lib/provider-history'
import { listShellbeamAgents, type ShellbeamAgentRecord } from '@/lib/shellbeam-agent'

export interface FleetHost {
  host: HostProfile
  view?: HostOpsView
  status: string
  history: ProviderMetricHistoryPoint[]
  openAlerts: number
  probeRecord?: CompatibleAgentRecord | null
}

export interface FleetAlert {
  key: string
  hostId: string | null
  hostName: string
  source: 'monitoring' | 'local'
  severity: string
  title: string
  status: string
  openedAt: number
  acknowledgedAt: number | null
  resolvedAt: number | null
}

export interface FleetMetrics {
  hosts: FleetHost[]
  alerts: FleetAlert[]
  agents: ShellbeamAgentRecord[]
  servers: KomariIntegration[]
  probes: Record<string, CompatibleAgentRecord | null>
  certificates: CachedCertificate[]
  from: number
  to: number
  refreshedAt: number | null
  loading: boolean
  error: boolean
}

const OPEN = new Set(['active', 'acknowledged'])
const HISTORY_LIMIT = 1500
/** History is re-read this often while the dashboard is visible. */
const REFRESH_MS = 60_000

/** Everything the dashboard draws, read from local stores (no SSH round trips). */
export function useFleetMetrics({ hosts, vaultId, unlocked, rangeHours }: { hosts: HostProfile[]; vaultId?: string | null; unlocked: boolean; rangeHours: number }) {
  const [state, setState] = useState<Omit<FleetMetrics, 'loading'> & { key: string }>({
    key: '',
    hosts: [],
    alerts: [],
    agents: [],
    servers: [],
    probes: {},
    certificates: [],
    from: 0,
    to: 0,
    refreshedAt: null,
    error: false,
  })
  const [revision, setRevision] = useState(0)
  const run = useRef(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const requestKey = `${vaultId ?? ''}:${unlocked}:${rangeHours}:${revision}:${hosts.length}`

  useEffect(() => {
    const id = ++run.current
    const scoped = hosts.filter((host) => !host.vaultId || !vaultId || host.vaultId === vaultId)
    const to = Date.now()
    const from = to - rangeHours * 3_600_000
    void (async () => {
      let komariStates: KomariAlertState[] = []
      let servers: KomariIntegration[] = []
      let views: Record<string, HostOpsView> = {}
      let error = false
      try {
        if (vaultId && unlocked) {
          const sources = await loadCurrentKomariSources([vaultId]).catch(() => [])
          servers = Array.isArray(sources) ? sources.map((source) => source.integration) : []
          komariStates = (Array.isArray(sources) ? sources : []).flatMap((source) => {
            const alertState = source.error ? null : readKomariAlertState(source.state?.syncState)
            return alertState ? [alertState] : []
          })
        }
        views = await loadHostOpsViews(scoped, { vaultId: vaultId ?? undefined, komariAlertStates: komariStates })
      } catch {
        error = true
        views = buildHostOpsViews({ hosts: scoped })
      }
      const [histories, agents, probeRecords] = await Promise.all([
        vaultId
          ? Promise.all(scoped.map((host) => Promise.resolve(listProviderMetricHistory({ vaultId, hostId: host.id, from, to, limit: HISTORY_LIMIT })).then((r) => (Array.isArray(r) ? r : []), () => [] as ProviderMetricHistoryPoint[])))
          : Promise.resolve(scoped.map(() => [] as ProviderMetricHistoryPoint[])),
        vaultId
          ? Promise.resolve(listShellbeamAgents({ vaultId })).then((r) => (Array.isArray(r) ? r : []), () => [] as ShellbeamAgentRecord[])
          : Promise.resolve([] as ShellbeamAgentRecord[]),
        vaultId && unlocked
          ? Promise.all(scoped.map((host) => Promise.resolve(readCompatibleAgent(vaultId, host.id)).then((r) => (r && typeof r === 'object' && 'hostId' in r ? r : null), () => null)))
          : Promise.resolve(scoped.map(() => null as CompatibleAgentRecord | null)),
      ])
      if (id !== run.current) return
      const probes: Record<string, CompatibleAgentRecord | null> = {}
      scoped.forEach((host, idx) => {
        probes[host.id] = probeRecords[idx] ?? null
      })
      const names = new Map(scoped.map((host) => [host.id, host.name]))
      const alerts: FleetAlert[] = []
      for (const host of scoped) {
        for (const alert of loadLocalAlertState(vaultId ?? undefined, host.id).alerts) {
          if (alert.hostId !== host.id) continue
          alerts.push({ key: `local:${host.id}:${alert.ruleId}:${alert.openedAt}`, hostId: host.id, hostName: host.name, source: 'local', severity: alert.severity, title: alert.name, status: alert.status, openedAt: alert.openedAt, acknowledgedAt: null, resolvedAt: alert.resolvedAt })
        }
      }
      for (const { alert } of groupKomariAlertIncidents(komariStates.flatMap((state) => state.alerts))) {
        if (alert.hostId && !names.has(alert.hostId)) continue
        alerts.push({ key: `monitoring:${alert.alertId}`, hostId: alert.hostId, hostName: alert.hostId ? names.get(alert.hostId) ?? '' : '', source: 'monitoring', severity: alert.severity, title: alert.title, status: alert.status, openedAt: alert.firstSeenAt, acknowledgedAt: alert.acknowledgedAt, resolvedAt: alert.resolvedAt ?? alert.closedAt })
      }
      setState({
        key: requestKey,
        hosts: scoped.map((host, index) => ({
          host,
          view: views[host.id],
          status: views[host.id]?.health.state ?? (hasSshConnection(host) ? 'unknown' : 'unsupported'),
          history: primarySourcePoints(histories[index]),
          openAlerts: alerts.filter((alert) => alert.hostId === host.id && OPEN.has(alert.status)).length,
          probeRecord: probes[host.id],
        })),
        alerts,
        agents,
        servers,
        probes,
        certificates: loadCachedCertificates(vaultId),
        from,
        to,
        refreshedAt: Date.now(),
        error,
      })
    })()
  }, [hosts, vaultId, unlocked, rangeHours, revision, requestKey])

  useEffect(() => {
    const onChange = () => refresh()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, REFRESH_MS)
    window.addEventListener('provider-metric-history-changed', onChange)
    window.addEventListener(LOCAL_OPS_CHANGED_EVENT, onChange)
    window.addEventListener(CERTIFICATE_CACHE_EVENT, onChange)
    window.addEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, onChange)
    window.addEventListener(KOMARI_INTEGRATIONS_CHANGED_EVENT, onChange)
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, onChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('provider-metric-history-changed', onChange)
      window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, onChange)
      window.removeEventListener(CERTIFICATE_CACHE_EVENT, onChange)
      window.removeEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, onChange)
      window.removeEventListener(KOMARI_INTEGRATIONS_CHANGED_EVENT, onChange)
      window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, onChange)
    }
  }, [refresh])

  const { key, ...rest } = state
  return { ...rest, loading: key !== requestKey, refresh }
}

export const isOpenAlert = (alert: FleetAlert) => OPEN.has(alert.status)
