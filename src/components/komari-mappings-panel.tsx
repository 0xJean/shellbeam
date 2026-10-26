import { NativeSelect } from '@/components/ui/select'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { KomariApiError, listKomariClients, type KomariClient } from '@/lib/komari'
import { mapKomariNodesToHosts } from '@/lib/komari-mapping'
import { importMonitoringHost, editKomariMapping, getKomariMappingState, manualKomariMappings, type KomariMappingState } from '@/lib/komari-persistence'
import { komariMappingCopy } from '@/lib/locales/komari-mappings'
import { useT } from '@/lib/i18n'
import { monitoringModeCopy } from '@/lib/locales/monitoring-mode'
import { requestUserDecision } from '@/lib/user-confirmation'
import { Button } from './ui/button'

interface Entry {
  integration: KomariIntegration
  state: KomariMappingState
  nodes: KomariClient[]
  discovered: boolean
  discoveryError: 'credentialMissing' | 'credentialReadFailed' | 'permissionDenied' | 'endpointUnavailable' | 'requestTimedOut' | 'requestFailed' | null
}

export interface KomariMappingsPanelProps {
  activeVaultId?: string
  hosts: HostProfile[]
  vaultUnlocked: boolean
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  integrationId?: string
  initiallyOpen?: boolean
  discoveredNodes?: KomariClient[]
  onHostImported?: (host: HostProfile) => void
  onStateChange?: (state: { busy: boolean; unmapped: number; unsaved: boolean; failed: boolean }) => void
}

/** Discovery is explicit and read-only. A saved binding uses native Vault,
 * host and revision checks; remote discovery never writes a mapping itself. */
export function KomariMappingsPanel({ activeVaultId, hosts, vaultUnlocked, onLoadVaultSecret, integrationId, initiallyOpen = false, discoveredNodes, onStateChange, onHostImported }: KomariMappingsPanelProps) {
  const { locale } = useT()
  const copy = komariMappingCopy[locale]
  const [open, setOpen] = useState(initiallyOpen)
  const [loadedVault, setLoadedVault] = useState<string | null>(null)
  const loaded = loadedVault === activeVaultId
  const [scopedEntries, setScopedEntries] = useState<{ vaultId?: string; rows: Entry[] }>({ rows: [] })
  const entries = scopedEntries.vaultId === activeVaultId ? scopedEntries.rows : []
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [busyState, setBusyState] = useState<{ sequence: number; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scope = useRef({ vaultId: activeVaultId, integrationId, unlocked: vaultUnlocked, sequence: 0 })
  if (scope.current.vaultId !== activeVaultId || scope.current.integrationId !== integrationId || scope.current.unlocked !== vaultUnlocked) {
    scope.current = { vaultId: activeVaultId, integrationId, unlocked: vaultUnlocked, sequence: scope.current.sequence + 1 }
  }
  const busy = busyState?.sequence === scope.current.sequence ? busyState.key : null
  const scopedHosts = useMemo(() => hosts.filter((host) => !host.vaultId || host.vaultId === activeVaultId), [hosts, activeVaultId])

  const unmapped = entries.reduce((count, entry) => {
    const mapping = mapKomariNodesToHosts({ hosts: scopedHosts, nodes: entry.nodes, explicit: manualKomariMappings(entry.state.mappings) })
    return count + entry.nodes.filter((node) => !mapping.mappings.some((item) => item.nodeId === node.uuid)).length
  }, 0)
  const unsaved = entries.some((entry) => {
    const mapping = mapKomariNodesToHosts({ hosts: scopedHosts, nodes: entry.nodes, explicit: manualKomariMappings(entry.state.mappings) })
    return Object.entries(selections).some(([key, hostId]) => {
      const prefix = `${entry.integration.id}:`
      if (!key.startsWith(prefix)) return false
      const nodeId = key.slice(prefix.length)
      const saved = entry.state.mappings.find((item) => item.nodeId === nodeId)
      const resolved = mapping.mappings.find((item) => item.nodeId === nodeId)
      return hostId !== (saved?.hostId ?? resolved?.hostId ?? '')
    })
  })
  useEffect(() => { onStateChange?.({ busy: busy !== null || !loaded, unmapped, unsaved, failed: error !== null }) }, [busy, loaded, unmapped, unsaved, error, onStateChange])

  const load = useCallback(async (reuseDiscovery = false) => {
    if (!activeVaultId || !vaultUnlocked) return
    const sequence = ++scope.current.sequence
    const current = () => scope.current.sequence === sequence && scope.current.vaultId === activeVaultId && scope.current.unlocked
    setBusyState({ sequence, key: 'load' }); setError(null)
    try {
      const integrations = await listKomariIntegrations(activeVaultId)
      if (!current()) return
      let failed = false
      const next = await Promise.all(integrations.filter((integration) => (integrationId ? integration.id === integrationId : integration.enabled) && integration.vaultId === activeVaultId).map(async (integration): Promise<Entry> => {
        const state = await getKomariMappingState(activeVaultId, integration.id)
        const unavailable: Entry = { integration, state, nodes: [], discovered: false, discoveryError: null }
        if (!current()) return unavailable
        if (reuseDiscovery && discoveredNodes && integration.id === integrationId) return { integration, state, nodes: discoveredNodes, discovered: true, discoveryError: null }
        if (!onLoadVaultSecret) {
          failed = true
          return { ...unavailable, discoveryError: 'credentialReadFailed' }
        }
        let token: string | null | undefined
        try {
          token = await onLoadVaultSecret(integration.credentialRef)
        } catch {
          failed = true
          return { ...unavailable, discoveryError: 'credentialReadFailed' }
        }
        if (!current()) return unavailable
        if (!token?.trim()) {
          failed = true
          return { ...unavailable, discoveryError: 'credentialMissing' }
        }
        try {
          const nodes = await listKomariClients({ endpoint: integration.endpoint, token })
          return { integration, state, nodes, discovered: true, discoveryError: null }
        } catch (cause) {
          failed = true
          // Only fixed, local copy reaches the UI. Upstream error messages can
          // contain credentials, addresses or response bodies.
          const code = cause instanceof KomariApiError ? cause.code : null
          const discoveryError = code === 'permission' ? 'permissionDenied'
            : code === 'timeout' ? 'requestTimedOut'
              : code === 'unavailable' ? 'endpointUnavailable' : 'requestFailed'
          return { ...unavailable, discoveryError }
        }
      }))
      if (!current()) return
      setScopedEntries({ vaultId: activeVaultId, rows: next }); setSelections({}); setLoadedVault(activeVaultId)
      if (failed) setError(copy.loadFailed)
    } catch { if (current()) { setError(copy.loadFailed); setScopedEntries({ vaultId: activeVaultId, rows: [] }); setLoadedVault(activeVaultId) } }
    finally { if (current()) setBusyState(null) }
  }, [activeVaultId, vaultUnlocked, onLoadVaultSecret, copy.loadFailed, integrationId, discoveredNodes])

  useEffect(() => {
    if (open && !loaded && vaultUnlocked) void load(true)
  }, [open, loaded, vaultUnlocked, load])
  useEffect(() => () => { scope.current.sequence++ }, [])

  async function save(entry: Entry, nodeId: string, hostId: string | null) {
    if (!activeVaultId || !vaultUnlocked || busy) return
    const sequence = ++scope.current.sequence
    const current = () => scope.current.sequence === sequence && scope.current.vaultId === activeVaultId && scope.current.unlocked
    setBusyState({ sequence, key: `${entry.integration.id}:${nodeId}` }); setError(null)
    try {
      if (hostId && scopedHosts.find(host => host.id === hostId)?.monitoringMode === 'ssh') { setError(monitoringModeCopy[locale].chooseFirst); return }
      const state = await editKomariMapping({ vaultId: activeVaultId, integrationId: entry.integration.id, nodeId, hostId, expectedRevision: entry.state.revision })
      if (!current()) return
      setScopedEntries((previous) => previous.vaultId !== activeVaultId ? previous : { ...previous, rows: previous.rows.map((row) => row.integration.id === entry.integration.id ? { ...row, state } : row) })
      setSelections({})
    } catch (caught) {
      if (current()) setError(String(caught).includes('KOMARI_MAPPING_CONFLICT') ? copy.conflict : copy.saveFailed)
    } finally { if (current()) setBusyState(null) }
  }

  async function importNode(entry: Entry, node: KomariClient) {
    if (!activeVaultId || !vaultUnlocked || busy) return
    const sequence = ++scope.current.sequence
    const current = () => scope.current.sequence === sequence && scope.current.vaultId === activeVaultId && scope.current.unlocked
    setBusyState({ sequence, key: `${entry.integration.id}:${node.uuid}` }); setError(null)
    try {
      const answer = await requestUserDecision({ vaultId: activeVaultId, risk: 'low', message: monitoringModeCopy[locale].importConfirm, isCurrent: current })
      if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
      const imported = await importMonitoringHost({ vaultId: activeVaultId, integrationId: entry.integration.id, nodeId: node.uuid,
        expectedRevision: entry.state.revision, expectedIntegrationVersion: entry.integration.updatedAt,
        name: node.name || node.hostname || node.uuid, group: typeof node.raw.group === 'string' ? node.raw.group : 'Custom',
        tags: typeof node.raw.tags === 'string' ? node.raw.tags.split(';').filter(Boolean) : [] })
      if (!current()) return
      const state = await getKomariMappingState(activeVaultId, entry.integration.id)
      if (!current()) return
      onHostImported?.(imported)
      setScopedEntries(previous => previous.vaultId !== activeVaultId ? previous : { ...previous, rows: previous.rows.map(row => row.integration.id === entry.integration.id ? { ...row, state } : row) })
      setSelections({})
    } catch { if (current()) setError(copy.importFailed) }
    finally { if (current()) setBusyState(null) }
  }

  if (!activeVaultId) return null
  return <details className="mb-3 rounded-lg border border-border/60 p-3" data-testid="komari-mappings-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs font-medium">{copy.title}</summary>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{copy.description}</p>
      <p className="text-xs text-muted-foreground">{monitoringModeCopy[locale].chooseFirst}</p>
      {!vaultUnlocked && <p role="status" className="text-xs text-amber-600">{copy.locked}</p>}
      <Button size="sm" variant="outline" disabled={!vaultUnlocked || busy !== null} onClick={() => void load()}>{busy === 'load' ? copy.loading : copy.refresh}</Button>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {loaded && entries.length === 0 && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
      {vaultUnlocked && entries.map((entry) => {
        const mapping = mapKomariNodesToHosts({ hosts: scopedHosts, nodes: entry.nodes, explicit: manualKomariMappings(entry.state.mappings) })
        const nodeIds = [...new Set([...entry.nodes.map((node) => node.uuid), ...entry.state.mappings.map((item) => item.nodeId)])]
        return <section key={entry.integration.id} className="space-y-2 rounded-md border p-3" aria-label={entry.integration.name}>
          <h3 className="text-sm font-medium">{entry.integration.name}</h3>
          {entry.discoveryError && <p role="alert" className="text-xs text-red-500">{copy[entry.discoveryError]}</p>}
          {entry.discovered && entry.nodes.length === 0 && <p role="status" className="text-xs text-muted-foreground">{copy.noNodes}</p>}
          {nodeIds.map((nodeId) => {
            const node = entry.nodes.find((item) => item.uuid === nodeId)
            const saved = entry.state.mappings.find((item) => item.nodeId === nodeId)
            const resolved = mapping.mappings.find((item) => item.nodeId === nodeId)
            const key = `${entry.integration.id}:${nodeId}`
            const suggested = mapping.suggestions?.find(item => item.nodeId === nodeId)
            const selection = selections[key] ?? saved?.hostId ?? resolved?.hostId ?? suggested?.hostId ?? ''
            const ambiguous = mapping.conflicts.some((item) => item.nodeId === nodeId)
            return <div key={nodeId} className="space-y-2 rounded border border-border/60 p-3" data-testid={`komari-mapping-${nodeId}`}>
              <div className="text-xs font-medium">{node?.name || node?.hostname || nodeId} <span className="font-mono text-muted-foreground">{nodeId}</span></div>
              <div className="text-xs text-muted-foreground">{saved?.source === 'manual' ? copy.manual : saved || suggested ? copy.matched : copy.unmapped}{resolved ? ` · ${scopedHosts.find((host) => host.id === resolved.hostId)?.name ?? copy.hostMissing}` : ''}</div>
              {!node && <p className="text-xs text-amber-600">{entry.discovered ? copy.missing : copy.unavailable}</p>}
              {ambiguous && <p className="text-xs text-amber-600">{copy.ambiguous}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect aria-label={`${copy.host}: ${entry.integration.name} / ${nodeId}`} value={selection} disabled={!vaultUnlocked || busy !== null} onChange={(event) => setSelections((values) => ({ ...values, [key]: event.target.value }))} className="h-9 min-w-44 rounded border bg-background px-2 text-xs">
                  <option value="">{copy.choose}</option>
                  {saved && !scopedHosts.some((host) => host.id === saved.hostId) && <option value={saved.hostId} disabled>{copy.hostMissing}</option>}
                  {scopedHosts.map((host) => {
                    const occupied = entry.state.mappings.some((item) => item.source === 'manual' && item.hostId === host.id && item.nodeId !== nodeId)
                    return <option key={host.id} value={host.id} disabled={occupied || host.monitoringMode === 'ssh'}>{host.name} · {host.address}{occupied ? ` (${copy.occupied})` : host.monitoringMode === 'ssh' ? ` (${monitoringModeCopy[locale].ssh})` : ''}</option>
                  })}
                </NativeSelect>
                <Button size="sm" disabled={!vaultUnlocked || busy !== null || !selection || !scopedHosts.some((host) => host.id === selection && host.monitoringMode !== 'ssh') || (saved?.source === 'manual' && saved.hostId === selection)} onClick={() => void save(entry, nodeId, selection)}>{busy === key ? copy.saving : copy.apply}</Button>
                {node && !entry.state.mappings.some(item => item.nodeId === nodeId) && <Button size="sm" variant="outline" disabled={!vaultUnlocked || busy !== null} onClick={() => void importNode(entry, node)}>{copy.importHost}</Button>}
                {saved && <Button size="sm" variant="outline" disabled={!vaultUnlocked || busy !== null} onClick={() => void save(entry, nodeId, null)}>{copy.reset}</Button>}
              </div>
            </div>
          })}
          {scopedHosts.length === 0 && <p className="text-xs text-muted-foreground">{copy.noHosts}</p>}
        </section>
      })}
    </div>}
  </details>
}
