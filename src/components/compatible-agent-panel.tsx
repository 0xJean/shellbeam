import { NativeSelect } from '@/components/ui/select'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cancelCompatibleAgent, compatibleAgentPolicy, operateCompatibleAgent, prepareCompatibleAgent, readCompatibleAgent, type CompatibleAgentAction, type CompatibleAgentPolicy, type CompatibleAgentRecord } from '@/lib/compatible-agent'
import { monitoringModeCopy } from '@/lib/locales/monitoring-mode'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { probeReleaseDisplay, probeReleaseIdentity } from '@/lib/probe-release-identity'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ProbeTransferPanel } from './probe-transfer-panel'
import { Note, SwitchInput, fieldLabel, mutedText, primaryButton, softBorder } from './monitor-settings-ui'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { cn } from '@/lib/utils'
import { RotateCw, ShieldCheck } from 'lucide-react'

/** No server requests on mount. Hosts without a source or prior managed probe
 * keep their ordinary connection experience, including after a source removal. */
export function CompatibleAgentTools({ host, integrationId, bindingKey }: { host: HostProfile; integrationId?: string; bindingKey?: string }) {
  const { locale } = useT(); const c = compatibleAgentCopy[locale]
  const [record, setRecord] = useState<CompatibleAgentRecord | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true; let epoch = 0
    const reload = () => { const current = ++epoch; if (host.vaultId) void readCompatibleAgent(host.vaultId, host.id).then(r => { if (live && current === epoch) setRecord(r) }).catch(() => {}) }
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ vaultId: string; hostIds: string[] }>).detail; if (detail?.vaultId === host.vaultId && detail.hostIds.includes(host.id)) reload() }
    reload(); window.addEventListener('shellbeam:probe-deployment-changed', changed)
    return () => { live = false; window.removeEventListener('shellbeam:probe-deployment-changed', changed) }
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
  const { locale } = useT(); const c = compatibleAgentCopy[locale]; const trust = monitorSettingsCopy[locale]
  const { activeVaultId, captureVaultScope } = useVault(); const vaultId = host.vaultId ?? activeVaultId
  const [record, setRecord] = useState<CompatibleAgentRecord | null>(null)
  const [endpoint, setEndpoint] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('')
  const [transferPending, setTransferPending] = useState(false)
  const refreshTransfer = useCallback(() => { const valid = captureVaultScope(); const epoch = ++readEpoch.current; void readCompatibleAgent(vaultId, host.id).then(r => { if (live.current && valid() && epoch === readEpoch.current) setRecord(r) }).catch(() => {}) }, [captureVaultScope, vaultId, host.id])
  const [legacyUnit, setLegacyUnit] = useState('komari-agent.service'); const [migrationEndpoint, setMigrationEndpoint] = useState('')
  const [error, setError] = useState(''); const [code, setCode] = useState(''); const [policy, setPolicy] = useState<CompatibleAgentPolicy | null>(null)
  // Preserve unfinished separators while editing. Splitting and filtering on
  // each keystroke erases a just-typed comma and joins the next host to it.
  const [policyHosts, setPolicyHosts] = useState('')
  const readEpoch = useRef(0); const live = useRef(true); const running = useRef(false); const plans = useRef(new Set<string>())
  useEffect(() => { live.current = true; const ids = plans.current; return () => { live.current = false; for (const id of ids) void cancelCompatibleAgent(id).catch(() => {}); ids.clear() } }, [])
  useEffect(() => { const epoch = ++readEpoch.current; const valid = captureVaultScope(); let current = true; void readCompatibleAgent(vaultId, host.id).then(r => { if (current && epoch === readEpoch.current && valid()) { setRecord(r); if (r) setEndpoint(r.endpoint) } }).catch(() => {}); return () => { current = false } }, [vaultId, host.id, captureVaultScope])
  useEffect(() => {
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ vaultId: string; hostIds: string[] }>).detail; if (detail?.vaultId === vaultId && detail.hostIds.includes(host.id)) refreshTransfer() }
    window.addEventListener('shellbeam:probe-deployment-changed', changed)
    return () => window.removeEventListener('shellbeam:probe-deployment-changed', changed)
  }, [vaultId, host.id, refreshTransfer])
  const explain = (cause: unknown) => {
    const raw = String(cause).match(/(?:KOMARI_AGENT|MONITORING)_[A-Z_]+/)?.[0] ?? 'KOMARI_AGENT_OPERATION_FAILED'; setCode(raw)
    return /SHELLBEAM_REQUIRED/.test(raw) ? c.ownRelease : /LEGACY_UNTRUSTED|LEGACY_UNSUPPORTED/.test(raw) ? c.legacyUnsupported : /NO_UPGRADE/.test(raw) ? c.noUpgrade : /READBACK/.test(raw) ? c.readback : /ALREADY_REPORTING/.test(raw) ? c.nodeOnline : /EXTERNAL|UNMANAGED/.test(raw) ? c.external : /CHANGED|SCOPE/.test(raw) ? c.changed : /CATALOG_EXPIRED|CATALOG_ROLLBACK/.test(raw) ? c.catalogStale : /RELEASE|CATALOG|SIGNATURE|ARTIFACT|POLICY|ARCHITECTURE/.test(raw) ? c.releaseError : /REPORT/.test(raw) ? c.report : /SSH/.test(raw) ? c.connection : c.generic
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
      const address = action === 'migrate' ? migrationEndpoint.trim() : endpoint.trim()
      const p = await prepareCompatibleAgent({ vaultId, hostId: host.id, integrationId: record?.integrationId ?? integrationId, action, ...(address ? { endpoint: address } : {}), ...(action === 'adopt' ? { legacyUnit: legacyUnit.trim() } : {}) })
      id = p.planId; plans.current.add(id)
      if (!current()) return
      if (action !== 'inspect') {
        const handoff = ['adopt', 'migrate', 'restore-config', 'restore-legacy'].includes(action)
        const answer = await requestUserDecision({ vaultId, risk: 'high', message: `${c[action]} · ${p.hostName}\n${p.nodeId}\n${p.previousEndpoint ? p.previousEndpoint + ' → ' : ''}${p.endpoint}\n${p.legacyUnit ?? ''}\n${p.transport} · ${c.account}: ${p.account} · ${p.serviceScope === 'system' ? c.systemService : c.userService}\n${probeReleaseDisplay(p.currentArtifact, p.currentVersion, c.distributions)} → ${probeReleaseDisplay(p.targetArtifact, p.targetVersion, c.distributions)} · ${c.artifact}: ${p.artifactBytes ? (p.artifactBytes / 1048576).toFixed(1) + ' MiB' : '—'}\n${p.dataDirectory}\n${handoff ? c.handoffConfirm : c.cadence + '\n' + c.confirm}\n${c.preserved}`, isCurrent: current })
        if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
      }
      const next = await operateCompatibleAgent(id, action !== 'inspect')
      if (!current()) return
      setRecord(next); setEndpoint(next.endpoint)
      if (next.errorCode) setError(explain(next.errorCode))
    } finally { if (id) { plans.current.delete(id); await cancelCompatibleAgent(id).catch(() => {}) } }
  })
  const statusValue = record ? c[record.status as keyof typeof c] : c.notManaged
  const status = typeof statusValue === 'string' ? statusValue : c.unknown
  const unsettled = transferPending || record?.status === 'migrated' || !!record && ['prepared', 'dispatched', 'unknown'].includes(record.status)
  const released = record?.observation.status === 'released'
  const installed = !!record?.current && !['retired', 'absent'].includes(record.observation.status)
  const origin = probeReleaseIdentity(record?.current?.manifest)
  const sshOnly = host.monitoringMode === 'ssh'
  return <div data-testid="compatible-agent-panel" data-status={record?.status} data-deployment={record?.deployment} data-job-id={record?.jobId} data-version={record?.current?.manifest.version} data-previous-version={record?.previous?.manifest.version} data-product={origin?.product ?? 'compatible'} className="min-w-0 space-y-3 py-3 text-xs" onClick={e => e.stopPropagation()}>
    {sshOnly && <p role="status">{monitoringModeCopy[locale].chooseFirst} {monitoringModeCopy[locale].retained}</p>}
    <p>{c.description}</p><p className="text-muted-foreground">{c.officialHint}</p><p className="text-muted-foreground">{c.requirements}</p>
    <div role="status" className="break-words">{busy ? c.working : status}</div>
    {record && <dl data-testid="compatible-agent-identity" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt>{c.version}</dt><dd>{record.current?.manifest.version ?? '—'}</dd><dt>{c.previous}</dt><dd>{record.previous?.manifest.version ?? '—'}</dd>
      {origin && <><dt>{c.provenance}</dt><dd data-testid="compatible-agent-origin" className="break-words">{c.distributions[origin.product]}<span className="block text-muted-foreground break-all">{origin.repository}{origin.commit ? ` · ${origin.commit.slice(0, 12)}` : ''}</span></dd></>}
      <dt>{c.observed}</dt><dd>{record.observedAt ? new Date(record.observedAt).toLocaleString(locale) : c.idle}</dd>
      <dt>{c.job}</dt><dd className="break-all font-mono" title={record.jobId}>{record.jobId}</dd>
    </dl>}
    <label className="block">{c.endpoint}<Input data-testid="compatible-agent-endpoint" aria-label={c.endpoint} value={endpoint} disabled={busy || !!record?.current} onChange={e => setEndpoint(e.target.value)} className="mt-1 min-w-0" /><span className="mt-1 block text-muted-foreground">{c.endpointHint}</span></label>
    <div className="flex flex-wrap gap-2">{(['inspect', 'install', 'upgrade', 'rollback', 'uninstall'] as const).map(action => <Button key={action} data-testid={`compatible-agent-${action}`} size="sm" variant="outline" disabled={busy || (sshOnly && (action === 'install' || action === 'upgrade')) || transferPending || record?.status === 'migrated' || (released && action !== 'inspect') || (action !== 'inspect' && action !== 'uninstall' && unsettled) || (action === 'install' && installed) || (action === 'upgrade' && !installed) || (action === 'rollback' && (!installed || !record?.previous)) || (action === 'uninstall' && !record?.current && !record?.requested)} onClick={() => void act(action)}>{c[action]}</Button>)}</div>
    <p className="text-muted-foreground">{c.preserved}</p>
    <details data-testid="compatible-agent-handoff" className="min-w-0 border-t pt-2"><summary className="cursor-pointer">{c.handoff}</summary>
      <p className="my-2 text-muted-foreground">{c.handoffHint}</p>
      {!installed && record?.observation.status !== 'retired' && <div className="space-y-2"><label className="block">{c.legacyUnit}<Input aria-label={c.legacyUnit} value={legacyUnit} disabled={busy} onChange={e => setLegacyUnit(e.target.value)} /></label><Button data-testid="compatible-agent-adopt" size="sm" variant="outline" disabled={busy || sshOnly || unsettled || !legacyUnit.trim()} onClick={() => void act('adopt')}>{c.adopt}</Button></div>}
      {installed && <div className="space-y-2"><label className="block">{c.migrationEndpoint}<Input aria-label={c.migrationEndpoint} value={migrationEndpoint} disabled={busy} onChange={e => setMigrationEndpoint(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || sshOnly || unsettled || !migrationEndpoint.trim()} onClick={() => void act('migrate')}>{c.migrate}</Button>
          {record?.previousConfiguration && <Button size="sm" variant="outline" disabled={busy || transferPending || record?.status === 'migrated'} onClick={() => void act('restore-config')}>{c['restore-config']}</Button>}
        </div></div>}
      {record?.observation.legacy && record.observation.status !== 'released' && <Button className="mt-2" size="sm" variant="outline" disabled={busy || transferPending || record?.status === 'migrated'} onClick={() => void act('restore-legacy')}>{c['restore-legacy']}</Button>}
    </details>
    <ProbeTransferPanel vaultId={vaultId} hostId={host.id} canMove={record?.status === 'active' && !busy} onChanged={refreshTransfer} onPending={setTransferPending} />
    {(error || record?.errorCode) && <p role="alert" className="break-words text-destructive">{error || c.generic} <span className="break-all font-mono">{code || record?.errorCode}</span></p>}{notice && <p role="status">{notice}</p>}
    <details data-testid="compatible-agent-policy" className={cn('min-w-0 overflow-hidden rounded-lg border', softBorder)}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium text-[color:var(--workspace-text-strong)]"><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[color:var(--workspace-accent-text)]" aria-hidden="true" />{c.policy}</summary>
      <div className={cn('space-y-3 border-t px-3 py-3', softBorder)}>
        <p className={mutedText}>{trust.trustSubtitle}</p>
        {policy && <>
          <label className="block">
            <span className={fieldLabel}>{c.source}</span>
            <NativeSelect data-testid="compatible-agent-policy-source" aria-label={c.source} disabled={busy} value={policy.source ?? 'custom'} onChange={e => setPolicy({ ...policy, source: e.target.value as 'official' | 'custom' })} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs"><option value="official">{c.official}</option><option value="custom">{c.custom}</option></NativeSelect>
            <span className={cn('mt-1 block', mutedText)}>{policy.source === 'official' ? trust.sourceOfficialHint : trust.sourceCustomHint}</span>
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3"><span className="font-medium text-[color:var(--workspace-text-strong)]">{c.enabled}</span><SwitchInput aria-label={c.enabled} disabled={busy} checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })} /></label>
          {policy.source !== 'official' && (['manifestUrl', 'trustedPublicKey', 'allowedHosts'] as const).map(key => <label className="block" key={key}><span className={fieldLabel}>{key === 'manifestUrl' ? c.catalog : key === 'trustedPublicKey' ? c.publicKey : c.hosts}</span><Input data-testid={`compatible-agent-policy-${key}`} disabled={busy} className="mt-1 h-8 font-mono text-xs" value={key === 'allowedHosts' ? policyHosts : policy[key]} onChange={e => key === 'allowedHosts' ? setPolicyHosts(e.target.value) : setPolicy({ ...policy, [key]: e.target.value })} /></label>)}
        </>}
        <Note icon={ShieldCheck}>{c.policyHint}</Note>
      </div>
      <div className={cn('flex flex-wrap items-center gap-2 border-t px-3 py-2.5', softBorder)}>
        <Button data-testid="compatible-agent-policy-load" size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={() => void work(async current => { const value = await compatibleAgentPolicy(); if (current()) { setPolicy(value); setPolicyHosts(value.allowedHosts.join(', ')) } })}><RotateCw className="h-3.5 w-3.5" />{c.loadPolicy}</Button>
        <span className="flex-1" />
        {policy && <Button data-testid="compatible-agent-policy-save" size="sm" className={primaryButton} disabled={busy} onClick={() => void work(async current => { const answer = await requestUserDecision({ vaultId, risk: 'high', message: c.policyConfirm, isCurrent: current }); if (!answer.accepted || !current() || answer.isCurrent?.() === false) return; const value = await compatibleAgentPolicy({ ...policy, allowedHosts: policyHosts.split(',').map(x => x.trim()).filter(Boolean) }, true); if (current()) { setPolicy(value); setPolicyHosts(value.allowedHosts.join(', ')); setNotice(c.saved) } })}>{c.savePolicy}</Button>}
      </div>
    </details>
  </div>
}
