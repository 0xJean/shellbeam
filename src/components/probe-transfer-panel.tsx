import { useEffect, useRef, useState } from 'react'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cancelCompatibleAgent, operateProbeTransfer, prepareProbeTransfer, probeTransferDestinations, readProbeTransfer, recoverProbeTransfer, type ProbeTransfer, type ProbeTransferDestination, type CompatibleAgentPreview } from '@/lib/compatible-agent'
import { Button } from './ui/button'
import { Input } from './ui/input'

import { probeTransferCopy } from '@/lib/locales/probe-transfer'

export function ProbeTransferPanel({ vaultId, hostId, canMove, onChanged, onPending }: { vaultId: string; hostId: string; canMove: boolean; onChanged: () => void; onPending: (value: boolean) => void }) {
  const { locale } = useT(); const c = probeTransferCopy[locale]
  const { activeVaultId, captureVaultScope } = useVault()
  const [row, setRow] = useState<ProbeTransfer | null>(null); const [options, setOptions] = useState<ProbeTransferDestination[] | null>(null)
  const [selection, setSelection] = useState(''); const [endpoint, setEndpoint] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const readEpoch = useRef(0); const alive = useRef(true); const running = useRef(false); const plans = useRef(new Set<string>())
  const pending = !!row && !['completed', 'restored'].includes(row.status)
  useEffect(() => { onPending(pending) }, [pending, onPending])
  useEffect(() => { alive.current = true; const ids = plans.current; return () => { alive.current = false; for (const id of ids) void cancelCompatibleAgent(id).catch(() => {}); ids.clear() } }, [])
  useEffect(() => {
    const valid = captureVaultScope(); let current = true
    const reload = () => { const epoch = ++readEpoch.current; void readProbeTransfer(vaultId, hostId).then(r => { if (current && epoch === readEpoch.current && valid()) setRow(r) }).catch(() => {}) }
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ vaultId: string; hostIds: string[] }>).detail; if (detail?.vaultId === vaultId && detail.hostIds.includes(hostId)) reload() }
    reload(); window.addEventListener('shellbeam:probe-deployment-changed', changed)
    return () => { current = false; window.removeEventListener('shellbeam:probe-deployment-changed', changed) }
  }, [vaultId, hostId, captureVaultScope])
  const work = async (fn: (current: () => boolean) => Promise<void>) => {
    if (running.current || activeVaultId !== vaultId) return
    running.current = true; readEpoch.current++; setBusy(true); setError(''); const valid = captureVaultScope(); const current = () => alive.current && valid()
    try { await fn(current) } catch (e) { if (current()) setError(`${c.failure} ${String(e).match(/(?:KOMARI_AGENT|MONITORING)_[A-Z_]+/)?.[0] ?? ''}`) }
    finally { running.current = false; if (current()) setBusy(false) }
  }
  const act = (action: 'move' | 'inspect' | 'restore' | 'finish') => work(async current => {
    let id: string | undefined
    try {
      const target = options?.[Number(selection)]
      if (action === 'move' && (!target || selection === '')) return
      const p = action === 'move' ? await prepareProbeTransfer({ vaultId, sourceHostId: hostId, targetHostId: target!.hostId, targetConnectionId: target!.connectionId, targetIntegrationId: target!.integrationId, ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}) }) : await recoverProbeTransfer(vaultId, row!.id, action)
      id = p.planId; plans.current.add(id); if (!current()) return
      const describe = (e: CompatibleAgentPreview) => `${e.hostName} · ${e.account} · ${e.transport} · ${e.serviceScope}\n${e.endpoint}\n${e.nodeId}\n${e.dataDirectory}\n${e.currentVersion ?? '—'} → ${e.targetVersion ?? '—'}`
      if (action !== 'inspect') {
        const decision = await requestUserDecision({ vaultId, risk: 'high', message: `${c[action]}\n${c.source}: ${describe(p.source)}\n${c.destination}: ${describe(p.target)}\n${c.confirm}`, isCurrent: current })
        if (!decision.accepted || decision.isCurrent?.() === false || !current()) return
      }
      const next = await operateProbeTransfer(id, action !== 'inspect'); if (!current()) return
      setRow(next); onPending(!['completed', 'restored'].includes(next.status)); onChanged()
      window.dispatchEvent(new CustomEvent('shellbeam:probe-deployment-changed', { detail: { vaultId, hostIds: [hostId, next.target?.record?.hostId].filter(Boolean) } }))
    } finally { if (id) { plans.current.delete(id); await cancelCompatibleAgent(id).catch(() => {}) } }
  })
  if (!canMove && !row) return null
  return <details data-testid="probe-transfer-panel" className="min-w-0 border-t pt-2"><summary className="cursor-pointer">{c.title}</summary>
    <div className="min-w-0 space-y-2 py-2">
      <p className="text-muted-foreground">{c.hint}</p>
      {row && <div role="status" className="break-words">{row.status === 'completed' ? c.completed : row.status === 'restored' ? c.restored : c.pending}<div className="mt-1 break-all">{c.audit}: {row.jobId}</div></div>}
      {pending ? <div className="flex flex-wrap gap-2">{(['inspect', 'finish', 'restore'] as const).map(action => <Button key={action} size="sm" variant="outline" disabled={busy} onClick={() => void act(action)}>{c[action]}</Button>)}</div> : canMove && <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void work(async current => { const values = await probeTransferDestinations(vaultId); if (current()) { setOptions(values); setSelection(''); setEndpoint('') } })}>{c.load}</Button>
        {options && (options.length ? <><label className="block">{c.target}<select aria-label={c.target} className="mt-1 block w-full min-w-0 rounded border border-border bg-background p-2" disabled={busy} value={selection} onChange={e => { setSelection(e.target.value); setEndpoint('') }}><option value="">—</option>{options.map((o, i) => <option value={i} key={`${o.hostId}:${o.connectionId}:${o.integrationId}`}>{o.hostName} · {o.connectionName} · {o.account}@{o.address} · {o.serviceName}</option>)}</select></label>
          <label className="block">{c.endpoint}<Input aria-label={c.endpoint} disabled={busy} value={endpoint} placeholder={selection !== '' ? options[Number(selection)]?.endpoint : ''} onChange={e => setEndpoint(e.target.value)} /></label>
          <Button size="sm" variant="outline" disabled={busy || selection === ''} onClick={() => void act('move')}>{c.move}</Button></> : <p>{c.empty}</p>)}
      </>}
      <p className="text-muted-foreground">{c.preserved}</p>{busy && <p role="status">{c.working}</p>}{(error || row?.errorCode) && <p role="alert" className="break-words text-destructive">{error || `${c.failure} ${row?.errorCode}`}</p>}
    </div>
  </details>
}
