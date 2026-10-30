import { useEffect, useState } from 'react'
import { primarySourcePoints } from '@/lib/metric-series'
import { listProviderMetricHistory, type ProviderMetricHistoryPoint } from '@/lib/provider-history'

/** Recent recorded samples for one host (one source), refreshed when history changes. Used for sparklines. */
export function useHostMetricHistory(vaultId: string | undefined, hostId: string | undefined, hours = 24) {
  const [loaded, setLoaded] = useState<{ key: string; points: ProviderMetricHistoryPoint[] }>({ key: '', points: [] })
  const key = `${vaultId ?? ''}:${hostId ?? ''}:${hours}`
  useEffect(() => {
    if (!vaultId || !hostId) return
    let live = true
    const load = () => {
      const to = Date.now()
      void listProviderMetricHistory({ vaultId, hostId, from: to - hours * 3_600_000, to, limit: 600 })
        .then((points) => { if (live) setLoaded({ key, points: Array.isArray(points) ? primarySourcePoints(points) : [] }) })
        .catch(() => { if (live) setLoaded({ key, points: [] }) })
    }
    load()
    const onChange = (event: Event) => { if ((event as CustomEvent<{ vaultId?: string }>).detail?.vaultId === vaultId) load() }
    window.addEventListener('provider-metric-history-changed', onChange)
    return () => { live = false; window.removeEventListener('provider-metric-history-changed', onChange) }
  }, [vaultId, hostId, hours, key])
  return loaded.key === key ? loaded.points : []
}
