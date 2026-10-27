import { useCallback, useEffect, useState } from 'react'
import { readCompatibleAgent, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import type { HostProfile } from '@/lib/hosts'
import { KOMARI_MAPPING_CHANGED_EVENT } from '@/lib/komari-persistence'
import { loadCurrentKomariSources, type CurrentKomariSource } from '@/lib/komari-source-eligibility'
import { probeInstallReadiness, type ProbeInstallReadiness } from '@/lib/probe-install'

export const PROBE_DEPLOYMENT_CHANGED_EVENT = 'shellbeam:probe-deployment-changed'
const SOURCES_TTL_MS = 30_000

// Every host card asks for the same vault's sources; share one read per vault.
const sourceCache = new Map<string, { at: number; value: Promise<CurrentKomariSource[]> }>()

function vaultSources(vaultId: string): Promise<CurrentKomariSource[]> {
  const hit = sourceCache.get(vaultId)
  if (hit && Date.now() - hit.at < SOURCES_TTL_MS) return hit.value
  const value = loadCurrentKomariSources([vaultId]).catch(() => [])
  sourceCache.set(vaultId, { at: Date.now(), value })
  return value
}

export function invalidateProbeInstallSources(vaultId?: string) {
  if (vaultId) sourceCache.delete(vaultId)
  else sourceCache.clear()
}

/** Reads (never changes) what the quick installer needs for one host. */
export function useProbeInstallReadiness(host: HostProfile, enabled = true) {
  const [state, setState] = useState<{ key: string; readiness: ProbeInstallReadiness; record: CompatibleAgentRecord | null } | null>(null)
  const [epoch, setEpoch] = useState(0)
  const key = `${host.vaultId ?? ''}:${host.id}:${host.monitoringMode ?? ''}:${host.updatedAt}`

  const reload = useCallback(() => {
    invalidateProbeInstallSources(host.vaultId)
    setEpoch((value) => value + 1)
  }, [host.vaultId])

  useEffect(() => {
    if (!enabled || !host.vaultId) return
    let live = true
    const vaultId = host.vaultId
    void Promise.all([vaultSources(vaultId), readCompatibleAgent(vaultId, host.id).catch(() => null)]).then(([sources, record]) => {
      if (live) setState({ key, readiness: probeInstallReadiness(host, sources, record), record })
    })
    return () => { live = false }
  }, [enabled, host, key, epoch])

  useEffect(() => {
    if (!enabled) return
    const onMapping = (event: Event) => { const detail = (event as CustomEvent<{ vaultId?: string }>).detail; if (!detail?.vaultId || detail.vaultId === host.vaultId) reload() }
    const onDeployment = (event: Event) => { const detail = (event as CustomEvent<{ vaultId: string; hostIds: string[] }>).detail; if (detail?.vaultId === host.vaultId && detail.hostIds.includes(host.id)) reload() }
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, onMapping)
    window.addEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, onDeployment)
    // Focus only re-reads; the shared TTL decides whether sources are fetched again.
    const onFocus = () => setEpoch((value) => value + 1)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, onMapping)
      window.removeEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, onDeployment)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, host.id, host.vaultId, reload])

  const current = state?.key === key ? state : null
  return { readiness: current?.readiness ?? null, record: current?.record ?? null, reload }
}
