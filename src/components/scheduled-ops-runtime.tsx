import { useEffect, useRef } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { createScheduledOpsScheduler } from '@/lib/scheduled-ops-runtime'
import { SCHEDULED_TASK_CHANGED_EVENT } from '@/lib/scheduled-tasks'

/** Independent of Workspace navigation. Schedules pause on app exit, restart,
 * vault lock/switch, or an unknown execution result and require explicit resume. */
export function ScheduledOpsRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, resolveAuthSecret, vaultStatusState } = useVault()
  const hostsRef = useRef(hosts)
  const resolveRef = useRef(resolveAuthSecret)
  useEffect(() => { hostsRef.current = hosts }, [hosts])
  useEffect(() => { resolveRef.current = resolveAuthSecret }, [resolveAuthSecret])
  useEffect(() => {
    if (!activeVaultId || !vaultStatusState?.unlocked) return
    let stopped = false
    const scheduler = createScheduledOpsScheduler({ vaultId: activeVaultId, getHosts: () => hostsRef.current, resolveAuthSecret: async (host) => (await resolveRef.current({ authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault' })) ?? '', isCurrent: () => !stopped })
    scheduler.start()
    const wake = () => { void scheduler.tick() }
    window.addEventListener(SCHEDULED_TASK_CHANGED_EVENT, wake)
    window.addEventListener('storage', wake)
    return () => { stopped = true; scheduler.stop(); window.removeEventListener(SCHEDULED_TASK_CHANGED_EVENT, wake); window.removeEventListener('storage', wake) }
  }, [activeVaultId, vaultStatusState?.unlocked])
  return null
}
