import { useCallback, useEffect, useState } from 'react'
import { readCompatibleAgent, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import type { HostProfile } from '@/lib/hosts'
import { KOMARI_MAPPING_CHANGED_EVENT } from '@/lib/komari-persistence'
import { loadCurrentKomariSources, type CurrentKomariSource } from '@/lib/komari-source-eligibility'
import { probeInstallReadiness, type ProbeInstallReadiness } from '@/lib/probe-install'

export const PROBE_DEPLOYMENT_CHANGED_EVENT = 'shellbeam:probe-deployment-changed'
const CACHE_TTL_MS = 30_000

// Host cards and the host page banner ask for the same data; share one read
// per vault (sources) and per host (probe record) within the TTL.
const sourceCache = new Map<string, { at: number; value: Promise<CurrentKomariSource[]> }>()
const recordCache = new Map<string, { at: number; value: Promise<CompatibleAgentRecord | null> }>()

function cached<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>, fallback: T): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  // Promise.resolve guards against loaders that return a non-promise (e.g. a mocked invoke).
  const value = Promise.resolve().then(load).then((result) => result ?? fallback, () => fallback)
  cache.set(key, { at: Date.now(), value })
  return value
}

export function invalidateProbeInstallSources(vaultId?: string) {
  if (!vaultId) { sourceCache.clear(); recordCache.clear(); return }
  sourceCache.delete(vaultId)
  for (const key of recordCache.keys()) if (key.startsWith(`${vaultId}:`)) recordCache.delete(key)
}

/** Reads (never changes) what the quick installer needs for one host. */
export async function loadProbeInstallReadiness(host: HostProfile): Promise<{ readiness: ProbeInstallReadiness; record: CompatibleAgentRecord | null }> {
  const vaultId = host.vaultId
  if (!vaultId) return { readiness: probeInstallReadiness(host, [], null), record: null }
  const [sources, record] = await Promise.all([
    cached(sourceCache, vaultId, () => loadCurrentKomariSources([vaultId]), [] as CurrentKomariSource[]),
    cached(recordCache, `${vaultId}:${host.id}`, () => readCompatibleAgent(vaultId, host.id), null),
  ])
  return { readiness: probeInstallReadiness(host, sources, record), record }
}

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
    void loadProbeInstallReadiness(host).then(({ readiness, record }) => { if (live) setState({ key, readiness, record }) })
    return () => { live = false }
  }, [enabled, host, key, epoch])

  useEffect(() => {
    if (!enabled) return
    const onMapping = (event: Event) => { const detail = (event as CustomEvent<{ vaultId?: string }>).detail; if (!detail?.vaultId || detail.vaultId === host.vaultId) reload() }
    const onDeployment = (event: Event) => { const detail = (event as CustomEvent<{ vaultId: string; hostIds: string[] }>).detail; if (detail?.vaultId === host.vaultId && detail.hostIds.includes(host.id)) reload() }
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, onMapping)
    window.addEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, onDeployment)
    // Focus only re-reads; the shared TTL decides whether data is fetched again.
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
