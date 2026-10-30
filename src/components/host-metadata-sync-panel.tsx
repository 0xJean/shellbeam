import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { listHosts } from '@/lib/hosts'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { getKomariMappingState } from '@/lib/komari-persistence'
import { vaultGetSecret } from '@/lib/vault'
import { HOST_METADATA_CHANGED, listHostMetadata, metadataAction, metadataSession, notifyHostMetadataChanged, readRemoteHostMetadata, type HostMetadata, type HostMetadataBinding } from '@/lib/host-metadata-sync'
import { Button } from './ui/button'
import { hostMetadataSyncCopy } from '@/lib/locales/host-metadata-sync'

type Candidate = { integration: KomariIntegration; nodeId: string; revision: number }
function ConflictChoices({ row, zh, busy, apply }: { row: HostMetadataBinding; zh: boolean; busy: boolean; apply: (choices: Partial<Record<keyof HostMetadata, 'local' | 'remote'>>) => void }) {
  const [choices, setChoices] = useState<Partial<Record<keyof HostMetadata, 'local' | 'remote'>>>({})
  const copy = hostMetadataSyncCopy[zh ? 'zh-CN' : 'en']
  const value = (data: HostMetadata, key: keyof HostMetadata) => Array.isArray(data[key]) ? data[key].join(', ') : data[key]
  return <div className="space-y-2">
    {row.conflicts.map(field => <fieldset key={field} className="rounded border p-2 text-xs">
      <legend>{copy[field]}</legend>
      {(['local', 'remote'] as const).map(side => <label key={side} className="flex items-start gap-2 break-all py-1">
        <input type="radio" name={`${row.id}-${field}`} checked={choices[field] === side} disabled={busy} onChange={() => setChoices(previous => ({ ...previous, [field]: side }))} />
        <span>{copy[side]}: {value(side === 'local' ? row.desired : row.remote, field) || '—'}</span>
      </label>)}
    </fieldset>)}
    <Button size="sm" disabled={busy || row.conflicts.some(field => !choices[field])} onClick={() => apply(choices)}>{copy.resolve}</Button>
  </div>
}
export function HostMetadataSyncPanel(props: { host: HostProfile; unlocked: boolean }) {
  return <ScopedHostMetadataSyncPanel key={`${props.host.vaultId}:${props.host.id}:${props.unlocked}`} {...props} />
}
function ScopedHostMetadataSyncPanel({ host, unlocked }: { host: HostProfile; unlocked: boolean }) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const { locale } = useT()
  const copy = hostMetadataSyncCopy[locale]
  const [rows, setRows] = useState<HostMetadataBinding[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scope = useRef({ hostId: host.id, vaultId: host.vaultId, unlocked })
  if (scope.current.hostId !== host.id || scope.current.vaultId !== host.vaultId || scope.current.unlocked !== unlocked) scope.current = { hostId: host.id, vaultId: host.vaultId, unlocked }
  useEffect(() => {
    const captured = scope.current
    let alive = true
    const vaultId = host.vaultId
    const refresh = async () => {
      if (!vaultId || !unlocked || !('__TAURI_INTERNALS__' in window)) return
      try {
        const [bindings, integrations] = await Promise.all([listHostMetadata(vaultId), listKomariIntegrations(vaultId)])
        const found = await Promise.all(integrations.filter(integration => integration.enabled && integration.vaultId === vaultId).map(async integration => {
          const state = await getKomariMappingState(vaultId, integration.id)
          return state.mappings.filter(mapping => mapping.hostId === host.id).map(mapping => ({ integration, nodeId: mapping.nodeId, revision: state.revision }))
        }))
        if (alive && scope.current === captured) { setRows(bindings.filter(row => row.hostId === host.id)); setCandidates(found.flat()) }
      } catch { if (alive && scope.current === captured) setError(copy.error) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener(HOST_METADATA_CHANGED, refresh)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener(HOST_METADATA_CHANGED, refresh) }
  }, [host.id, host.vaultId, unlocked, copy.error])
  if (!unlocked || !host.vaultId || (!rows.length && !candidates.length && !error)) return null
  async function run(operation: (valid: () => boolean, session: number) => Promise<unknown>) {
    if (busy) return
    const captured = scope.current
    const valid = () => mounted.current && scope.current === captured && captured.unlocked
    setBusy(true); setError('')
    try { const session = await metadataSession(host.vaultId!); if (!valid()) return; await operation(valid, session); if (valid()) notifyHostMetadataChanged(host.vaultId!) }
    catch (reason) { if (valid()) setError(String(reason).includes('STALE') ? copy.stale : copy.error) }
    finally { if (valid()) setBusy(false) }
  }
  async function enable(candidate: Candidate, valid: () => boolean, session: number) {
    const vaultId = host.vaultId!
    const token = await vaultGetSecret(candidate.integration.credentialRef, vaultId)
    if (!valid() || !token) throw new Error('METADATA_SCOPE_CHANGED')
    const remote = await readRemoteHostMetadata({ endpoint: candidate.integration.endpoint, token }, candidate.nodeId)
    if (!valid()) return
    const current = (await listHosts(vaultId)).find(row => row.id === host.id)
    if (!valid() || !current || current.updatedAt !== host.updatedAt) throw new Error('METADATA_STALE_EDIT')
    await invoke('enable_host_metadata_sync', { input: { vaultId, hostId: host.id, integrationId: candidate.integration.id, nodeId: candidate.nodeId, expectedMappingRevision: candidate.revision, expectedIntegrationVersion: candidate.integration.updatedAt, expectedEndpoint: candidate.integration.endpoint, expectedHostUpdatedAt: host.updatedAt, session, remote } })
  }
  return <section data-testid="host-metadata-sync" className="mx-auto w-full max-w-xl space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">{copy.title}</h3>
    <p className="text-xs text-muted-foreground">{copy.fields}</p>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    {candidates.filter(candidate => !rows.some(row => row.integrationId === candidate.integration.id && row.status !== 'disabled')).map(candidate => <div key={candidate.integration.id} className="flex items-center justify-between gap-2 text-sm">
      <span>{candidate.integration.name}</span><Button size="sm" disabled={busy} onClick={() => void run((valid, session) => enable(candidate, valid, session))}>{copy.enable}</Button>
    </div>)}
    {rows.map(row => <div key={row.id} className="space-y-2 border-t pt-3 text-xs">
      <p>{candidates.find(value => value.integration.id === row.integrationId)?.integration.name ?? copy.title} · <strong>{copy[row.status === 'retry' ? 'retryState' : row.status]}</strong></p>
      {row.errorCode && row.errorCode !== 'stopped-by-user' && <p className="text-amber-500">{row.errorCode === 'identity-changed' || row.errorCode === 'scope-changed' ? copy.identity : copy.error} <span className="font-mono">({row.errorCode})</span></p>}
      {row.status === 'conflict' && <ConflictChoices key={`${row.id}:${JSON.stringify([row.desired, row.remote, row.conflicts])}`} row={row} zh={locale === 'zh-CN'} busy={busy} apply={choices => void run(async (valid, session) => { if (valid()) await metadataAction(row, 'resolve', session, { choices }) })} />}
      <div className="flex flex-wrap gap-2">
        {['retry', 'failed'].includes(row.status) && row.errorCode !== 'identity-changed' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async (valid, session) => { if (valid()) await metadataAction(row, 'retry', session) })}>{copy.retry}</Button>}
        {(row.status !== 'disabled' || row.errorCode === 'scope-changed') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async (valid, session) => { if (valid()) await metadataAction(row, 'disable', session) })}>{row.status === 'disabled' ? copy.dismiss : copy.disable}</Button>}
      </div>
      <details><summary className="cursor-pointer text-muted-foreground">{copy.syncDetails}</summary><p className="mt-2">{copy.warning}</p><p className="break-all font-mono">{row.jobId}</p></details>
    </div>)}
  </section>
}

/** Pending work remains reachable after the edit dialog closes. No backend
 * means no extra dashboard module or onboarding prompt. */
type NoticeProps = { vaultId?: string; unlocked: boolean; hosts: HostProfile[]; onEdit: (host: HostProfile) => void }
export function HostMetadataSyncNotice(props: NoticeProps) {
  return <ScopedMetadataSyncNotice key={`${props.vaultId}:${props.unlocked}`} {...props} />
}
function ScopedMetadataSyncNotice({ vaultId, unlocked, hosts, onEdit }: NoticeProps) {
  const { locale } = useT()
  const copy = hostMetadataSyncCopy[locale]
  const [state, setState] = useState<HostMetadataBinding[]>([])
  useEffect(() => {
    if (!vaultId || !unlocked || !('__TAURI_INTERNALS__' in window)) return
    let alive = true
    const refresh = async () => {
      try { const rows = await listHostMetadata(vaultId); if (alive) setState(rows) } catch { /* locked/switching: existing intent stays durable */ }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener(HOST_METADATA_CHANGED, refresh)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener(HOST_METADATA_CHANGED, refresh) }
  }, [vaultId, unlocked])
  const rows = unlocked ? state.filter(row => row.status !== 'synced' && (row.status !== 'disabled' || row.errorCode === 'scope-changed') && hosts.some(host => host.id === row.hostId)) : []
  if (!rows.length) return null
  return <div data-testid="host-metadata-pending" className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
    <span>{copy.title}</span>
    {rows.map(row => <button key={row.id} className="rounded border px-2 py-1 hover:bg-muted" onClick={() => { const host = hosts.find(host => host.id === row.hostId); if (host) onEdit(host) }}>
      {hosts.find(host => host.id === row.hostId)?.name} · {copy[row.status === 'retry' ? 'retryState' : row.status]}
    </button>)}
  </div>
}
