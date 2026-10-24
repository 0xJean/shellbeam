import { useCallback, useEffect } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import type { HostProfile } from '@/lib/hosts'
import { flushLocalOpsHost, hydrateLocalOpsHost, isLocalOpsHydrated } from '@/lib/local-ops-persistence'
import { createHealthCheckScheduler } from '@/lib/health-check-scheduler'
import { collectLocalAlertObservations } from '@/lib/local-alert-collector'
import { evaluateLocalAlertRules } from '@/lib/local-alert-rules'
import { dispatchLocalAlertNotifications, loadLocalAlertRules, loadLocalAlertState, saveLocalAlertState, LOCAL_OPS_CHANGED_EVENT } from '@/lib/local-ops-store'

/** App-level read-only scheduling remains alive when Workspace panels unmount.
 * Locking/changing a vault cancels publication of old in-flight observations. */
export function LocalOpsRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, resolveAuthSecret, vaultStatusState } = useVault()
  const resolveSecret = useCallback(async (host: HostProfile) => (await resolveAuthSecret({ authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault' })) ?? '', [resolveAuthSecret])
  useEffect(() => {
    if (!activeVaultId || !vaultStatusState?.unlocked || !hosts.length) return
    let stopped = false
    let scanning = false
    let lastRuleScanAt = 0
    const health = createHealthCheckScheduler({ vaultId: activeVaultId, getHosts: () => hosts.filter((host) => isLocalOpsHydrated(activeVaultId, host.id)), resolveAuthSecret: resolveSecret, isUnlocked: () => !stopped })
    async function scanRules() {
      if (scanning || stopped || Date.now() - lastRuleScanAt < 30_000) return
      scanning = true
      lastRuleScanAt = Date.now()
      try {
        let cursor = 0
        async function worker() {
          while (!stopped && cursor < hosts.length) {
            const host = hosts[cursor++]
            try {
            await hydrateLocalOpsHost(activeVaultId, host.id, true)
            if (stopped) return
            const rules = loadLocalAlertRules(activeVaultId, host.id)
            if (rules.some((r) => r.enabled)) {
              const observations = await collectLocalAlertObservations({ vaultId: activeVaultId, host, rules, resolveAuthSecret: resolveSecret })
              if (stopped) return
              const currentRules = loadLocalAlertRules(activeVaultId, host.id).filter((rule) => rules.some((previous) => JSON.stringify(previous) === JSON.stringify(rule)))
              const state = evaluateLocalAlertRules(loadLocalAlertState(activeVaultId, host.id), currentRules, observations)
              saveLocalAlertState(activeVaultId, host.id, state)
              await flushLocalOpsHost(activeVaultId, host.id)
            }
            if (!stopped) await dispatchLocalAlertNotifications(activeVaultId, host.id, loadLocalAlertState(activeVaultId, host.id)).catch(() => undefined)
            } catch { /* A failed scope stays unknown; other hosts still refresh. */ }
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, hosts.length) }, () => worker()))
      } catch { /* The next bounded scan retries; no remote output is logged. */ } finally { scanning = false }
    }
    void Promise.allSettled(hosts.map((host) => hydrateLocalOpsHost(activeVaultId, host.id))).then(() => { if (!stopped) { health.start(); void scanRules() } })
    const timer = window.setInterval(() => { void scanRules() }, 5_000)
    const wake = () => { void health.tick(); void scanRules() }
    window.addEventListener(LOCAL_OPS_CHANGED_EVENT, wake)
    window.addEventListener('storage', wake)
    return () => { stopped = true; health.stop(); window.clearInterval(timer); window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, wake); window.removeEventListener('storage', wake) }
  }, [activeVaultId, hosts, resolveSecret, vaultStatusState?.unlocked])
  return null
}
