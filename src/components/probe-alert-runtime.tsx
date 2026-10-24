import { useEffect } from 'react'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import { currentProbeCollectionSequence, subscribeProbeCollections, subscribeProbeCollectionDiagnostics, type ProbeCollectionEvent } from '@/lib/probe-collection-events'
import { createProbeAlertLifecycleConsumer } from '@/lib/probe-alert-lifecycle'
import { useT } from '@/lib/i18n'
import { clearProbeAlertRuntimeDiagnostic, setProbeAlertRuntimeDiagnostic } from '@/lib/probe-alert-runtime-state'

/** Subscribe before background collection starts. Only actual attempts from
 * the active, unlocked host configuration may advance its durable alert. */
export function ProbeAlertRuntime() {
  const { hosts } = useHosts()
  const { activeVaultId, vaultStatusState } = useVault()
  const { t } = useT()
  useEffect(() => {
    if (!activeVaultId || !vaultStatusState?.unlocked || !hosts.length) return
    let stopped = false
    const generationStartedAt = Date.now()
    const generationSequence = currentProbeCollectionSequence()
    const diagnosticEpochs = new Map<string, number>()
    const currentHost = (event: Pick<ProbeCollectionEvent, 'vaultId' | 'hostId' | 'startedAt' | 'startedSequence'>) => {
      if (stopped || event.vaultId !== activeVaultId || !Number.isSafeInteger(event.startedAt) || event.startedAt < generationStartedAt || event.startedAt > Date.now()
        || !Number.isSafeInteger(event.startedSequence) || event.startedSequence <= generationSequence) return null
      const matches = hosts.filter(host => host.id === event.hostId && (!host.vaultId || host.vaultId === activeVaultId))
      return matches.length === 1 ? matches[0] : null
    }
    const consumer = createProbeAlertLifecycleConsumer({
      getCurrentHost: currentHost,
      isCurrent: event => currentHost(event) !== null,
      ruleName: section => t('localOps.probeUnavailable', { section: t(`localOps.probeSection.${section}`) }),
    })
    const reportError = (event?: ProbeCollectionEvent) => {
      // Provider/native errors may contain private details. Persistence keeps
      // its own scoped diagnostic; never copy the exception into a UI log.
      if (!stopped) {
        if (event && currentHost(event)) {
          diagnosticEpochs.set(event.hostId, (diagnosticEpochs.get(event.hostId) ?? 0) + 1)
          setProbeAlertRuntimeDiagnostic(event.vaultId, event.hostId, 'persistence-unavailable')
        }
        console.warn('Probe alert lifecycle persistence unavailable')
      }
    }
    const unsubscribe = subscribeProbeCollections(event => {
      if (currentHost(event)) {
        const diagnosticEpoch = diagnosticEpochs.get(event.hostId) ?? 0
        void consumer.consume(event).then(result => {
          if (result.status === 'applied' && currentHost(event) && (diagnosticEpochs.get(event.hostId) ?? 0) === diagnosticEpoch) clearProbeAlertRuntimeDiagnostic(event.vaultId, event.hostId)
        }).catch(() => reportError(event))
      }
    })
    const unsubscribeDiagnostics = subscribeProbeCollectionDiagnostics(diagnostic => {
      if (currentHost(diagnostic)) {
        diagnosticEpochs.set(diagnostic.hostId, (diagnosticEpochs.get(diagnostic.hostId) ?? 0) + 1)
        setProbeAlertRuntimeDiagnostic(diagnostic.vaultId, diagnostic.hostId, diagnostic.code)
      }
    })
    return () => {
      stopped = true
      unsubscribe()
      unsubscribeDiagnostics()
      void consumer.flush().catch(() => reportError())
    }
  }, [activeVaultId, hosts, vaultStatusState?.unlocked, t])
  return null
}
