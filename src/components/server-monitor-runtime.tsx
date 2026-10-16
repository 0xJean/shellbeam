import { useCallback, useEffect, useRef } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import {
  loadPersistedServerMonitorStates,
  scanServerMonitorHosts,
  SERVER_MONITOR_INTERVAL_MS,
} from '@/lib/server-monitor-scan'
import { pruneServerMonitorStates } from '@/lib/server-monitor-state'

export function ServerMonitorRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, resolveAuthSecret } = useVault()
  const scanGenerationRef = useRef(0)
  const scanInFlightRef = useRef(false)
  const lastScanStartedAtRef = useRef(0)

  const resolveMonitorAuthSecret = useCallback(
    async (host: (typeof hosts)[number]) => (
      await resolveAuthSecret({
        authType: host.authType,
        explicitSecret: '',
        hostForRef: host,
        inputMode: 'vault',
      })
    ) ?? '',
    [resolveAuthSecret],
  )

  const scanNow = useCallback(async () => {
    if (scanInFlightRef.current || hosts.length === 0) return

    scanInFlightRef.current = true
    const generation = ++scanGenerationRef.current
    lastScanStartedAtRef.current = Date.now()

    try {
      await scanServerMonitorHosts({
        hosts,
        vaultId: activeVaultId ?? undefined,
        resolveAuthSecret: resolveMonitorAuthSecret,
        isCurrent: () => scanGenerationRef.current === generation,
      })
    } catch (error) {
      // A persistence or scheduler error must not take down the workspace.
      console.error('Server monitor scan failed', error)
    } finally {
      scanInFlightRef.current = false
    }
  }, [activeVaultId, hosts, resolveMonitorAuthSecret])

  useEffect(() => {
    let cancelled = false
    scanGenerationRef.current += 1
    pruneServerMonitorStates(hosts)

    const hydrateAndScan = async () => {
      try {
        await loadPersistedServerMonitorStates(hosts, () => !cancelled)
      } catch (error) {
        console.error('Load persisted server monitor state failed', error)
      }
      if (!cancelled) void scanNow()
    }

    void hydrateAndScan()

    const intervalId = window.setInterval(() => {
      void scanNow()
    }, SERVER_MONITOR_INTERVAL_MS)

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible'
        && Date.now() - lastScanStartedAtRef.current >= SERVER_MONITOR_INTERVAL_MS
      ) {
        void scanNow()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      scanGenerationRef.current += 1
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [hosts, scanNow])

  return null
}
