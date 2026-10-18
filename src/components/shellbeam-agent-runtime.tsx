import { useCallback, useEffect, useRef, useState } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { listShellbeamAgents, SHELLBEAM_AGENT_STATE_CHANGED_EVENT, type ShellbeamAgentRecord } from '@/lib/shellbeam-agent'
import { createShellbeamAgentScheduler } from '@/lib/shellbeam-agent-scheduler'

/**
 * Keeps installed ShellBeam Probes fresh while the desktop app is open. The
 * runtime only runs the read-only heartbeat check; all mutations still go
 * through the explicit OperationJob flow in the Workspace panel.
 */
export function ShellbeamAgentRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, resolveAuthSecret, vaultStatusState } = useVault()
  const [hydrated, setHydrated] = useState<{ vaultId: string; records: ShellbeamAgentRecord[] } | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    let cancelled = false
    let loadSequence = 0
    const reload = () => { const sequence = ++loadSequence; void listShellbeamAgents({ vaultId: activeVaultId })
      .then((records) => {
        if (cancelled || generation !== generationRef.current || sequence !== loadSequence) return
        setHydrated({ vaultId: activeVaultId, records: records.filter((record) => record.vaultId === activeVaultId) })
      })
      .catch((error) => {
        if (!cancelled && generation === generationRef.current && sequence === loadSequence) {
          console.error('Load ShellBeam Probe scheduler records failed', error)
          setHydrated({ vaultId: activeVaultId, records: [] })
        }
      }) }
    reload()
    window.addEventListener(SHELLBEAM_AGENT_STATE_CHANGED_EVENT, reload)
    return () => {
      cancelled = true
      window.removeEventListener(SHELLBEAM_AGENT_STATE_CHANGED_EVENT, reload)
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
    if (!vaultStatusState?.unlocked || hydrated?.vaultId !== activeVaultId) return
    const eligibleRecords = hydrated.records.filter((record) => record.vaultId === activeVaultId && !['not-installed', 'retired', 'unsupported', 'uninstalling'].includes(record.status))
    const eligibleHostIds = new Set(eligibleRecords.map((record) => record.hostId))
    const eligibleHosts = hosts.filter((host) => host.vaultId === activeVaultId && eligibleHostIds.has(host.id))
    if (eligibleHosts.length === 0) return
    const scheduler = createShellbeamAgentScheduler({
      hosts: eligibleHosts,
      vaultId: activeVaultId,
      resolveAuthSecret: resolveMonitorAuthSecret,
      previousRecords: eligibleRecords,
      onError: (error, host) => console.error(`ShellBeam Probe background check failed for ${host.name}`, error),
    })
    scheduler.start()
    return () => scheduler.stop()
  }, [activeVaultId, hosts, hydrated, resolveMonitorAuthSecret, vaultStatusState?.unlocked])

  return null
}
