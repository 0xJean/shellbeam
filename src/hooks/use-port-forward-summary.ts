import { useEffect, useState } from 'react'
import { listPortForwardRules, portForwardTunnelStatus, type PortForwardRule } from '@/lib/port-forward'

const REFRESH_MS = 15_000

/** Rules and which of them are running, refreshed while the app is open (sidebar count, mobile Tools). */
export function usePortForwardSummary(vaultId?: string | null, enabled = true) {
  const [summary, setSummary] = useState<{ rules: PortForwardRule[]; running: Set<string> }>({ rules: [], running: new Set() })
  useEffect(() => {
    if (!enabled) return
    let live = true
    const load = async () => {
      const rules = await listPortForwardRules(vaultId).catch(() => [] as PortForwardRule[])
      const states = await Promise.all((rules ?? []).map(async (rule) => [rule.id, await portForwardTunnelStatus(rule.id).catch(() => false)] as const))
      if (live) setSummary({ rules: rules ?? [], running: new Set(states.filter(([, on]) => on).map(([id]) => id)) })
    }
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    window.addEventListener('focus', load)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', load) }
  }, [vaultId, enabled])
  return summary
}
