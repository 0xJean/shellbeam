import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHostMetricHistory } from '@/hooks/use-host-metric-history'
import { CERTIFICATE_CACHE_EVENT, loadCachedCertificates, type CachedCertificate } from '@/lib/certificate-cache'
import type { HostProfile } from '@/lib/hosts'
import type { ProviderMetricHistoryPoint } from '@/lib/provider-history'
import { loadScheduledTasks, SCHEDULED_TASK_CHANGED_EVENT, type ScheduledTask } from '@/lib/scheduled-tasks'
import type { ServerMonitorSnapshot } from '@/lib/server-monitor'
import { getWorkspaceInventoryHostKey, type WorkspaceInventory } from '@/lib/workspace-inventory'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { useWorkspaceProviderState, type WorkspaceProviderState } from '@/lib/workspace-provider-state'

export interface MobileHomeData {
  host: HostProfile | null
  provider: WorkspaceProviderState
  metrics: ServerMonitorSnapshot | null
  history: ProviderMetricHistoryPoint[]
  inventory: WorkspaceInventory | null
  certificates: CachedCertificate[]
  tasks: ScheduledTask[]
  failedServices: number
  exitedContainers: number
  now: number
  refresh: () => Promise<void>
}

export const isExitedContainer = (status: string) => /^(exited|dead|created)/i.test(status.trim())
export const isRunningContainer = (status: string) => /^up\b/i.test(status.trim())

/** Everything the v3 home screen shows, read from data the app already keeps locally. */
export function useMobileHomeData({ host, hosts, vaultId }: { host: HostProfile | null; hosts: HostProfile[]; vaultId?: string }): MobileHomeData {
  const provider = useWorkspaceProviderState({ host, hosts, vaultId })
  const scope = host?.vaultId ?? vaultId
  const history = useHostMetricHistory(scope, host?.id)
  const inventoryStates = useWorkspaceInventoryStates()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const bump = () => setRevision((value) => value + 1)
    const events = [CERTIFICATE_CACHE_EVENT, SCHEDULED_TASK_CHANGED_EVENT, 'storage']
    events.forEach((name) => window.addEventListener(name, bump))
    return () => events.forEach((name) => window.removeEventListener(name, bump))
  }, [])

  const hostId = host?.id
  const hostVault = host?.vaultId
  const certificates = useMemo(() => {
    void revision
    return hostId ? loadCachedCertificates(hostVault ?? vaultId).filter((row) => row.hostId === hostId) : []
  }, [hostId, hostVault, vaultId, revision])
  const tasks = useMemo(() => {
    void revision
    return hostId ? loadScheduledTasks(vaultId, hostId) : []
  }, [hostId, vaultId, revision])

  const inventory = provider.view?.inventory ?? (host ? inventoryStates[getWorkspaceInventoryHostKey(host)]?.inventory : undefined) ?? null
  const providerRefresh = provider.refresh
  const refresh = useCallback(async () => {
    window.dispatchEvent(new CustomEvent('shellbeam:host-ops-refresh', { detail: { vaultId: scope } }))
    setRevision((value) => value + 1)
    await providerRefresh()
  }, [providerRefresh, scope])

  return {
    host,
    provider,
    metrics: provider.view?.metrics ?? null,
    history,
    inventory,
    certificates,
    tasks,
    failedServices: inventory?.services.filter((service) => service.active === 'failed').length ?? 0,
    exitedContainers: inventory?.containers.filter((container) => isExitedContainer(container.status)).length ?? 0,
    now: provider.now,
    refresh,
  }
}
