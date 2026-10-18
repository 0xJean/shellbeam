import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { listKomariClients, type KomariClient } from '@/lib/komari'
import { mapKomariNodesToHosts } from '@/lib/komari-mapping'
import { editKomariMapping, getKomariMappingState, manualKomariMappings, type KomariMappingState } from '@/lib/komari-persistence'
import { komariMappingCopy } from '@/lib/locales/komari-mappings'
import { useT } from '@/lib/i18n'
import { Button } from './ui/button'

interface Entry {
  integration: KomariIntegration
  state: KomariMappingState
  nodes: KomariClient[]
  discovered: boolean
}

export interface KomariMappingsPanelProps {
  activeVaultId?: string
  hosts: HostProfile[]
  vaultUnlocked: boolean
  onLoadVaultSecret?: (key: string) => Promise<string | null>
}

/** Discovery is explicit and read-only. A saved binding uses native Vault,
 * host and revision checks; remote discovery never writes a mapping itself. */
export function KomariMappingsPanel({ activeVaultId, hosts, vaultUnlocked, onLoadVaultSecret }: KomariMappingsPanelProps) {
  const { locale } = useT()
  const copy = komariMappingCopy[locale]
  const [open, setOpen] = useState(false)
  const [loadedVault, setLoadedVault] = useState<string | null>(null)
  const loaded = loadedVault === activeVaultId
  const [scopedEntries, setScopedEntries] = useState<{ vaultId?: string; rows: Entry[] }>({ rows: [] })
  const entries = scopedEntries.vaultId === activeVaultId ? scopedEntries.rows : []
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [busyState, setBusyState] = useState<{ sequence: number; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scope = useRef({ vaultId: activeVaultId, unlocked: vaultUnlocked, sequence: 0 })
  if (scope.current.vaultId !== activeVaultId || scope.current.unlocked !== vaultUnlocked) {
    scope.current = { vaultId: activeVaultId, unlocked: vaultUnlocked, sequence: scope.current.sequence + 1 }
  }
  const busy = busyState?.sequence === scope.current.sequence ? busyState.key : null
  const scopedHosts = useMemo(() => hosts.filter((host) => !host.vaultId || host.vaultId === activeVaultId), [hosts, activeVaultId])

  const load = useCallback(async () => {
    if (!activeVaultId || !vaultUnlocked) return
    const sequence = ++scope.current.sequence
    const current = () => scope.current.sequence === sequence && scope.current.vaultId === activeVaultId && scope.current.unlocked
    setBusyState({ sequence, key: 'load' }); setError(null)
    try {
      const integrations = await listKomariIntegrations(activeVaultId)
      if (!current()) return
      let failed = false
      const next = await Promise.all(integrations.filter((integration) => integration.enabled && integration.vaultId === activeVaultId).map(async (integration): Promise<Entry> => {
        const state = await getKomariMappingState(activeVaultId, integration.id)
        if (!current()) return { integration, state, nodes: [], discovered: false }
        try {
          const token = await onLoadVaultSecret?.(integration.credentialRef)
          if (!current()) return { integration, state, nodes: [], discovered: false }
          if (!token) throw new Error('KOMARI_CREDENTIAL_UNAVAILABLE')
          const nodes = await listKomariClients({ endpoint: integration.endpoint, token })
          return { integration, state, nodes, discovered: true }
        } catch { failed = true; return { integration, state, nodes: [], discovered: false } }
      }))
      if (!current()) return
      setScopedEntries({ vaultId: activeVaultId, rows: next }); setSelections({}); setLoadedVault(activeVaultId)
      if (failed) setError(copy.loadFailed)
    } catch { if (current()) { setError(copy.loadFailed); setScopedEntries({ vaultId: activeVaultId, rows: [] }); setLoadedVault(activeVaultId) } }
    finally { if (current()) setBusyState(null) }
  }, [activeVaultId, vaultUnlocked, onLoadVaultSecret, copy.loadFailed])

  useEffect(() => {
    if (open && !loaded && vaultUnlocked) void load()
  }, [open, loaded, vaultUnlocked, load])
  useEffect(() => () => { scope.current.sequence++ }, [])

  async function save(entry: Entry, nodeId: string, hostId: string | null) {
    if (!activeVaultId || !vaultUnlocked || busy) return
    const sequence = ++scope.current.sequence
    const current = () => scope.current.sequence === sequence && scope.current.vaultId === activeVaultId && scope.current.unlocked
    setBusyState({ sequence, key: `${entry.integration.id}:${nodeId}` }); setError(null)
    try {
      const state = await editKomariMapping({ vaultId: activeVaultId, integrationId: entry.integration.id, nodeId, hostId, expectedRevision: entry.state.revision })
      if (!current()) return
      setScopedEntries((previous) => previous.vaultId !== activeVaultId ? previous : { ...previous, rows: previous.rows.map((row) => row.integration.id === entry.integration.id ? { ...row, state } : row) })
      setSelections({})
    } catch (caught) {
      if (current()) setError(String(caught).includes('KOMARI_MAPPING_CONFLICT') ? copy.conflict : copy.saveFailed)
    } finally { if (current()) setBusyState(null) }
  }

  if (!activeVaultId) return null
  return <details className="mb-3 rounded-lg border border-border/60 p-3" data-testid="komari-mappings-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs font-medium">{copy.title}</summary>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{copy.description}</p>
      {!vaultUnlocked && <p role="status" className="text-xs text-amber-600">{copy.locked}</p>}
      <Button size="sm" variant="outline" disabled={!vaultUnlocked || busy !== null} onClick={() => void load()}>{busy === 'load' ? copy.loading : copy.refresh}</Button>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {loaded && entries.length === 0 && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
      {vaultUnlocked && entries.map((entry) => {
        const mapping = mapKomariNodesToHosts({ hosts: scopedHosts, nodes: entry.nodes, explicit: manualKomariMappings(entry.state.mappings) })
        const nodeIds = [...new Set([...entry.nodes.map((node) => node.uuid), ...entry.state.mappings.filter((item) => item.source === 'manual').map((item) => item.nodeId)])]
        return <section key={entry.integration.id} className="space-y-2 rounded-md border p-3" aria-label={entry.integration.name}>
          <h3 className="text-sm font-medium">{entry.integration.name}</h3>
          {nodeIds.map((nodeId) => {
            const node = entry.nodes.find((item) => item.uuid === nodeId)
            const saved = entry.state.mappings.find((item) => item.nodeId === nodeId && item.source === 'manual')
            const resolved = mapping.mappings.find((item) => item.nodeId === nodeId)
            const key = `${entry.integration.id}:${nodeId}`
            const selection = selections[key] ?? saved?.hostId ?? resolved?.hostId ?? ''
            const ambiguous = mapping.conflicts.some((item) => item.nodeId === nodeId)
            return <div key={nodeId} className="space-y-2 rounded border border-border/60 p-3" data-testid={`komari-mapping-${nodeId}`}>
              <div className="text-xs font-medium">{node?.name || node?.hostname || nodeId} <span className="font-mono text-muted-foreground">{nodeId}</span></div>
              <div className="text-xs text-muted-foreground">{saved ? copy.manual : resolved ? copy.matched : copy.unmapped}{resolved ? ` · ${scopedHosts.find((host) => host.id === resolved.hostId)?.name ?? copy.hostMissing}` : ''}</div>
              {!node && <p className="text-xs text-amber-600">{entry.discovered ? copy.missing : copy.unavailable}</p>}
              {ambiguous && <p className="text-xs text-amber-600">{copy.ambiguous}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label={`${copy.host}: ${entry.integration.name} / ${nodeId}`} value={selection} disabled={!vaultUnlocked || busy !== null} onChange={(event) => setSelections((values) => ({ ...values, [key]: event.target.value }))} className="h-9 min-w-44 rounded border bg-background px-2 text-xs">
                  <option value="">{copy.choose}</option>
                  {saved && !scopedHosts.some((host) => host.id === saved.hostId) && <option value={saved.hostId} disabled>{copy.hostMissing}</option>}
                  {scopedHosts.map((host) => {
                    const occupied = entry.state.mappings.some((item) => item.source === 'manual' && item.hostId === host.id && item.nodeId !== nodeId)
                    return <option key={host.id} value={host.id} disabled={occupied}>{host.name} · {host.address}{occupied ? ` (${copy.occupied})` : ''}</option>
                  })}
                </select>
                <Button size="sm" disabled={!vaultUnlocked || busy !== null || !selection || !scopedHosts.some((host) => host.id === selection) || saved?.hostId === selection} onClick={() => void save(entry, nodeId, selection)}>{busy === key ? copy.saving : copy.apply}</Button>
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
