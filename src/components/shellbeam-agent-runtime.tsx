import { useCallback, useEffect, useRef, useState } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { listShellbeamAgents, type ShellbeamAgentRecord } from '@/lib/shellbeam-agent'
import { createShellbeamAgentScheduler } from '@/lib/shellbeam-agent-scheduler'

/**
 * Keeps installed ShellBeam Probes fresh while the desktop app is open. The
 * runtime only runs the read-only heartbeat check; all mutations still go
 * through the explicit OperationJob flow in the Workspace panel.
 */
export function ShellbeamAgentRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, resolveAuthSecret, vaultStatusState } = useVault()
  const [persistedRecords, setPersistedRecords] = useState<ShellbeamAgentRecord[]>([])
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    let cancelled = false
    void listShellbeamAgents({ vaultId: activeVaultId })
      .then((records) => {
        if (cancelled || generation !== generationRef.current) return
        setPersistedRecords(records)
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Load ShellBeam Probe scheduler records failed', error)
          setPersistedRecords([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeVaultId])

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

  useEffect(() => {
    if (!vaultStatusState?.unlocked) return
    const eligibleRecords = persistedRecords.filter((record) => !['not-installed', 'retired', 'unsupported', 'uninstalling'].includes(record.status))
    const eligibleHostIds = new Set(eligibleRecords.map((record) => record.hostId))
    const eligibleHosts = hosts.filter((host) => eligibleHostIds.has(host.id))
    if (eligibleHosts.length === 0) return
    const scheduler = createShellbeamAgentScheduler({
      hosts: eligibleHosts,
      vaultId: activeVaultId,
      resolveAuthSecret: resolveMonitorAuthSecret,
      previousRecords: persistedRecords,
      onError: (error, host) => console.error(`ShellBeam Probe background check failed for ${host.name}`, error),
    })
    scheduler.start()
    return () => scheduler.stop()
  }, [activeVaultId, hosts, persistedRecords, resolveMonitorAuthSecret, vaultStatusState?.unlocked])

  return null
}
