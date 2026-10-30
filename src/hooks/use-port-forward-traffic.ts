import { useCallback, useEffect, useState } from 'react'
import { portForwardTunnelStats, type PortForwardTunnelStats } from '@/lib/port-forward'

export const TRAFFIC_REFRESH_MS = 3_000

export interface PortForwardTraffic {
  /** Running tunnels only, keyed by rule id. */
  byRule: Record<string, PortForwardTunnelStats>
  /** Time of the last snapshot; use it for durations instead of reading the clock during render. */
  now: number
}

const EMPTY: PortForwardTraffic = { byRule: {}, now: 0 }

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * Polls tunnel traffic while the caller is mounted, `enabled` and the window is visible.
 * Returns the latest snapshot plus `reload` to refresh right after a start/stop.
 */
export function usePortForwardTraffic(enabled = true, refreshMs = TRAFFIC_REFRESH_MS) {
  const [traffic, setTraffic] = useState<PortForwardTraffic>(EMPTY)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = async () => {
      if (isHidden()) return
      const stats = await portForwardTunnelStats().catch(() => [] as PortForwardTunnelStats[])
      if (!live) return
      const byRule: Record<string, PortForwardTunnelStats> = {}
      for (const entry of stats) if (entry.running) byRule[entry.ruleId] = entry
      setTraffic({ byRule, now: Date.now() })
    }
    void load()
    const timer = window.setInterval(() => void load(), refreshMs)
    const onVisible = () => { if (!isHidden()) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refreshMs, nonce])

  return { ...(enabled ? traffic : EMPTY), reload }
}
