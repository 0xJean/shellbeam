import { useEffect, useRef, useState } from 'react'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cancelCompatibleAgent, compatibleAgentPolicy, operateCompatibleAgent, prepareCompatibleAgent, readCompatibleAgent, type CompatibleAgentAction, type CompatibleAgentPolicy, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { Button } from './ui/button'
import { Input } from './ui/input'

/** No server requests on mount. Hosts without a source or prior managed probe
 * keep their ordinary connection experience, including after a source removal. */
export function CompatibleAgentTools({ host, integrationId, bindingKey }: { host: HostProfile; integrationId?: string; bindingKey?: string }) {
  const { locale } = useT(); const c = compatibleAgentCopy[locale]
  const [record, setRecord] = useState<CompatibleAgentRecord | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    if (host.vaultId) void readCompatibleAgent(host.vaultId, host.id).then(r => { if (live) setRecord(r) }).catch(() => {})
    return () => { live = false }
  }, [host.id, host.vaultId])
  const saved = record?.hostId === host.id && record.vaultId === host.vaultId ? record : null
  const source = saved?.integrationId ?? integrationId
  if (!source) return null
  return <details data-testid="compatible-agent-tools" className="mt-3 min-w-0 border-t border-border/50 pt-2" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-xs font-medium">{c.title}</summary>
    {open && (hasSshConnection(host) ? <CompatibleAgentPanel key={JSON.stringify([host, source, bindingKey])} host={host} integrationId={source} /> : <p className="mt-2 text-xs">{c.ssh}</p>)}
  </details>
}

export function CompatibleAgentPanel({ host, integrationId }: { host: HostProfile; integrationId: string }) {
  const { locale } = useT(); const c = compatibleAgentCopy[locale]
  const { activeVaultId, captureVaultScope } = useVault(); const vaultId = host.vaultId ?? activeVaultId
  const [record, setRecord] = useState<CompatibleAgentRecord | null>(null)
  const [endpoint, setEndpoint] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('')
  const [error, setError] = useState(''); const [code, setCode] = useState(''); const [policy, setPolicy] = useState<CompatibleAgentPolicy | null>(null)
  const readEpoch = useRef(0); const live = useRef(true); const running = useRef(false); const plans = useRef(new Set<string>())
  useEffect(() => { live.current = true; const ids = plans.current; return () => { live.current = false; for (const id of ids) void cancelCompatibleAgent(id).catch(() => {}); ids.clear() } }, [])
  useEffect(() => { const epoch = ++readEpoch.current; const valid = captureVaultScope(); let current = true; void readCompatibleAgent(vaultId, host.id).then(r => { if (current && epoch === readEpoch.current && valid()) { setRecord(r); if (r) setEndpoint(r.endpoint) } }).catch(() => {}); return () => { current = false } }, [vaultId, host.id, captureVaultScope])
  const explain = (cause: unknown) => {
    const raw = String(cause).match(/(?:KOMARI_AGENT|MONITORING)_[A-Z_]+/)?.[0] ?? 'KOMARI_AGENT_OPERATION_FAILED'; setCode(raw)
    return /NO_UPGRADE/.test(raw) ? c.noUpgrade : /READBACK/.test(raw) ? c.readback : /ALREADY_REPORTING/.test(raw) ? c.nodeOnline : /EXTERNAL|UNMANAGED/.test(raw) ? c.external : /CHANGED|SCOPE/.test(raw) ? c.changed : /CATALOG_EXPIRED|CATALOG_ROLLBACK/.test(raw) ? c.catalogStale : /RELEASE|CATALOG|SIGNATURE|ARTIFACT|POLICY|ARCHITECTURE/.test(raw) ? c.releaseError : /REPORT/.test(raw) ? c.report : /SSH/.test(raw) ? c.connection : c.generic
  }
  const work = async (fn: (current: () => boolean) => Promise<void>) => {
    if (running.current || vaultId !== activeVaultId) return
    running.current = true; readEpoch.current++; setBusy(true); setError(''); setNotice(''); setCode('')
    const valid = captureVaultScope(); const current = () => live.current && valid()
    try { await fn(current) } catch (cause) { if (current()) setError(explain(cause)) }
    finally { running.current = false; if (current()) setBusy(false) }
  }
  const act = (action: CompatibleAgentAction) => work(async current => {
    let id: string | undefined
    try {
      const p = await prepareCompatibleAgent({ vaultId, hostId: host.id, integrationId, action, ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}) })
      id = p.planId; plans.current.add(id)
      if (!current()) return
      if (action !== 'inspect') {
        const answer = await requestUserDecision({ vaultId, risk: 'high', message: `${c[action]} · ${p.hostName}\n${p.nodeId}\n${p.endpoint}\n${p.transport} · ${c.account}: ${p.account} · ${p.serviceScope === 'system' ? c.systemService : c.userService}\nKomari Agent · ${p.currentVersion ?? '—'} → ${p.targetVersion ?? '—'} · ${c.artifact}: ${p.artifactBytes ? (p.artifactBytes / 1048576).toFixed(1) + ' MiB' : '—'}\n${p.dataDirectory}\n${c.cadence}\n${c.confirm}\n${c.preserved}`, isCurrent: current })
        if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
      }
      const next = await operateCompatibleAgent(id, action !== 'inspect')
      if (!current()) return
      setRecord(next); setEndpoint(next.endpoint)
      if (next.errorCode) setError(explain(next.errorCode))
    } finally { if (id) { plans.current.delete(id); await cancelCompatibleAgent(id).catch(() => {}) } }
  })
  const status = record ? c[record.status as keyof typeof c] ?? c.unknown : c.notManaged
  const unsettled = !!record && ['prepared', 'dispatched', 'unknown'].includes(record.status)
  const installed = !!record?.current && !['retired', 'absent'].includes(record.observation.status)
  return <div data-testid="compatible-agent-panel" className="min-w-0 space-y-3 py-3 text-xs" onClick={e => e.stopPropagation()}>
    <p>{c.description}</p><p className="text-muted-foreground">{c.officialHint}</p><p className="text-muted-foreground">{c.requirements}</p>
    <div role="status" className="break-words">{busy ? c.working : status}</div>
    {record && <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt>{c.version}</dt><dd>{record.current?.manifest.version ?? '—'}</dd><dt>{c.previous}</dt><dd>{record.previous?.manifest.version ?? '—'}</dd>
      <dt>{c.observed}</dt><dd>{record.observedAt ? new Date(record.observedAt).toLocaleString(locale) : c.idle}</dd>
      <dt>{c.job}</dt><dd className="break-all font-mono" title={record.jobId}>{record.jobId}</dd>
    </dl>}
    <label className="block">{c.endpoint}<Input aria-label={c.endpoint} value={endpoint} disabled={busy || !!record?.current} onChange={e => setEndpoint(e.target.value)} className="mt-1 min-w-0" /><span className="mt-1 block text-muted-foreground">{c.endpointHint}</span></label>
    <div className="flex flex-wrap gap-2">{(['inspect', 'install', 'upgrade', 'rollback', 'uninstall'] as const).map(action => <Button key={action} size="sm" variant="outline" disabled={busy || (action !== 'inspect' && action !== 'uninstall' && unsettled) || (action === 'install' && installed) || (action === 'upgrade' && !installed) || (action === 'rollback' && (!installed || !record?.previous)) || (action === 'uninstall' && !record?.current && !record?.requested)} onClick={() => void act(action)}>{c[action]}</Button>)}</div>
    <p className="text-muted-foreground">{c.preserved}</p>
    {(error || record?.errorCode) && <p role="alert" className="break-words text-destructive">{error || c.generic} <span className="break-all font-mono">{code || record?.errorCode}</span></p>}{notice && <p role="status">{notice}</p>}
    <details className="min-w-0 border-t pt-2"><summary className="cursor-pointer">{c.policy}</summary><p className="my-2 text-muted-foreground">{c.policyHint}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void work(async current => { const value = await compatibleAgentPolicy(); if (current()) setPolicy(value) })}>{c.loadPolicy}</Button>
      {policy && <div className="mt-2 space-y-2">
        <label className="block">{c.source}<select aria-label={c.source} disabled={busy} value={policy.source ?? 'custom'} onChange={e => setPolicy({ ...policy, source: e.target.value as 'official' | 'custom' })} className="ml-2 rounded border border-border bg-background p-1"><option value="official">{c.official}</option><option value="custom">{c.custom}</option></select></label>
        <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })} />{c.enabled}</label>
        {policy.source !== 'official' && (['manifestUrl', 'trustedPublicKey', 'allowedHosts'] as const).map(key => <label className="block" key={key}>{key === 'manifestUrl' ? c.catalog : key === 'trustedPublicKey' ? c.publicKey : c.hosts}<Input disabled={busy} value={key === 'allowedHosts' ? policy.allowedHosts.join(', ') : policy[key]} onChange={e => setPolicy({ ...policy, [key]: key === 'allowedHosts' ? e.target.value.split(',').map(x => x.trim()).filter(Boolean) : e.target.value })} /></label>)}
        <Button size="sm" disabled={busy} onClick={() => void work(async current => { const answer = await requestUserDecision({ vaultId, risk: 'high', message: c.policyConfirm, isCurrent: current }); if (!answer.accepted || !current() || answer.isCurrent?.() === false) return; const value = await compatibleAgentPolicy(policy, true); if (current()) { setPolicy(value); setNotice(c.saved) } })}>{c.savePolicy}</Button>
      </div>}
    </details>
  </div>
}
