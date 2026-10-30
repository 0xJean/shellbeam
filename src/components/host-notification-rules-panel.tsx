import { NativeSelect } from '@/components/ui/select'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { KomariApiError } from '@/lib/komari'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { listHosts } from '@/lib/hosts'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { getKomariMappingState } from '@/lib/komari-persistence'
import { metadataSession } from '@/lib/host-metadata-sync'
import { vaultGetSecret } from '@/lib/vault'
import { useVault } from '@/contexts/vault-context'
import { HOST_RULES_CHANGED, listHostRules, notifyHostRulesChanged, readOfflineRule, ruleAction, saveHostRule, syncHostRules, validOfflineRule, type HostRuleIntent, type OfflineRule, type RuleObservation } from '@/lib/host-notification-rules'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { GitCompare, RotateCw, CircleCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { monitorSettingsCopy } from '@/lib/locales/monitor-settings-v3'
import { hostNotificationRulesCopy } from '@/lib/locales/host-notification-rules'
import { Banner, CardHead, SwitchInput, mutedText, primaryButton, softBorder } from './monitor-settings-ui'

interface Target { integration: KomariIntegration; nodeId: string; revision: number }
type Props = { host: HostProfile; unlocked: boolean; embedded?: boolean }
export function HostNotificationRulesPanel(props: Props) {
  return <ScopedRules key={`${props.host.vaultId}:${props.host.id}:${props.unlocked}`} {...props} />
}
function ScopedRules({ host, unlocked, embedded }: Props) {
  const { locale } = useT(); const copy = hostNotificationRulesCopy[locale]
  const [targets, setTargets] = useState<Target[]>([])
  const [rows, setRows] = useState<HostRuleIntent[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!unlocked || !host.vaultId || !('__TAURI_INTERNALS__' in window)) return
    let alive = true
    const refresh = async () => {
      try {
        const [integrations, saved] = await Promise.all([listKomariIntegrations(host.vaultId!), listHostRules(host.vaultId!)])
        const found = await Promise.all(integrations.filter(i => i.enabled && i.vaultId === host.vaultId).map(async integration => {
          const state = await getKomariMappingState(host.vaultId!, integration.id)
          return state.mappings.filter(m => m.hostId === host.id && m.source === 'manual').map(m => ({ integration, nodeId: m.nodeId, revision: state.revision }))
        }))
        if (alive) { setTargets(found.flat()); setRows(saved.filter(row => row.hostId === host.id)); setError(false) }
      } catch { if (alive) setError(true) }
    }
    void refresh()
    const listener = (event: Event) => { if ((event as CustomEvent<{ vaultId: string }>).detail?.vaultId === host.vaultId) void refresh() }
    window.addEventListener(HOST_RULES_CHANGED, listener)
    return () => { alive = false; window.removeEventListener(HOST_RULES_CHANGED, listener) }
  }, [host.id, host.vaultId, unlocked])
  if (!unlocked || (!targets.length && !rows.length)) return null
  const body = <>
    <p className={cn('px-4 py-3 text-xs', mutedText)}>{copy.scope}</p>
    {error && <p role="alert" className="px-4 pb-2 text-xs text-[color:var(--workspace-status-bad-text)]">{copy.error}</p>}
    {targets.map(target => <RuleEditor key={`${target.integration.id}:${target.integration.updatedAt}:${target.revision}:${target.nodeId}`} host={host} target={target} saved={rows.find(row => row.integrationId === target.integration.id)} />)}
    {rows.filter(row => !targets.some(target => target.integration.id === row.integrationId)).map(row => <p key={row.id} className={cn('break-all border-t px-4 py-2 text-xs', softBorder, mutedText)}>{copy.disabled} · {row.jobId}</p>)}
  </>
  if (embedded) return <div className="min-w-0" data-testid="host-notification-rules">{body}</div>
  return <details className={cn('min-w-0 overflow-hidden rounded-lg border', softBorder)} data-testid="host-notification-rules">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--workspace-text-strong)]">{copy.title}</summary>
    {body}
  </details>
}
export function RuleEditor({ host, target, saved }: { host: HostProfile; target: Target; saved?: HostRuleIntent }) {
  const { locale } = useT(); const copy = hostNotificationRulesCopy[locale]; const v3 = monitorSettingsCopy[locale]
  const [observation, setObservation] = useState<RuleObservation | null>(null)
  const [draft, setDraft] = useState<OfflineRule>(saved?.desired ?? { enabled: false, gracePeriod: 180 })
  const [row, setRow] = useState(saved)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const active = useRef(true); const inFlight = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  // Background results never replace a draft being edited.
  const latest = saved && (!row || saved.version > row.version) ? saved : row
  async function run(kind: 'load' | 'save' | 'retry' | 'keep-local' | 'use-remote' | 'cancel') {
    if (inFlight.current || !host.vaultId) return
    if (kind === 'save' && !validOfflineRule(draft)) { setError(copy.invalid); return }
    inFlight.current = true; setBusy(true); setError('')
    const vaultId = host.vaultId
    try {
      const session = await metadataSession(vaultId)
      const guard = async () => { if (!active.current || await metadataSession(vaultId) !== session || !active.current) throw new Error('HOST_RULE_SCOPE_CHANGED') }
      await guard()
      if (kind === 'load') {
        const token = await vaultGetSecret(target.integration.credentialRef, vaultId); await guard()
        if (!token) throw new Error('HOST_RULE_CREDENTIAL_REQUIRED')
        const remote = await readOfflineRule({ endpoint: target.integration.endpoint, token }, target.nodeId); await guard()
        let current = latest
        if (current && current.status !== 'disabled') current = await ruleAction(current, 'observe', session, { remote })
        await guard(); setObservation(remote); setRow(current)
        setDraft(current && !['synced', 'disabled'].includes(current.status) ? current.desired : remote.rule ?? { enabled: false, gracePeriod: 180 })
      } else if (kind === 'save') {
        if (!observation) return
        const result = await saveHostRule({ session, vaultId, hostId: host.id, integrationId: target.integration.id, nodeId: target.nodeId, expectedVersion: latest?.version ?? 0, expectedMappingRevision: target.revision, expectedIntegrationVersion: target.integration.updatedAt, remote: latest?.status === 'synced' ? latest.remote : observation, desired: draft })
        await guard(); setRow(result)
      } else if (latest) {
        const result = await ruleAction(latest, kind, session); await guard(); setRow(result)
        if (kind === 'use-remote') { setObservation(result.remote); setDraft(result.remote.rule ?? { enabled: false, gracePeriod: 180 }) }
      }
      await guard(); notifyHostRulesChanged(vaultId)
      await syncHostRules(vaultId, () => active.current)
    } catch (cause) { if (active.current) setError(cause instanceof KomariApiError && cause.code === 'endpoint-version' ? copy.unsupported : copy.error) }
    finally { inFlight.current = false; if (active.current) setBusy(false) }
  }
  const value = (rule: OfflineRule | null) => rule ? `${rule.enabled ? copy.on : copy.off} · ${rule.gracePeriod}s` : copy.absent
  const status = latest?.status
  const reason = latest?.errorCode ? ({ permission: copy.permission, unavailable: copy.unavailable, 'endpoint-version': copy.unsupported, 'invalid-response': copy.invalidResponse, 'readback-mismatch': copy.mismatch, 'scope-changed': copy.changedScope, 'identity-changed': copy.changedScope, dismissed: copy.dismissed } as Record<string, string>)[latest.errorCode] : null
  const locked = busy || status === 'applying'
  const tone = status === 'synced' ? 'good' : status === 'conflict' || status === 'failed' ? 'warn' : undefined
  return <section className={cn('min-w-0 border-t', softBorder)} aria-label={`${target.integration.name} · ${copy.rule}`}>
    <div className="px-4 py-3">
      <h4 className="text-sm font-medium text-[color:var(--workspace-text-strong)]">{target.integration.name} · {copy.rule}</h4>
      <p className={cn('mt-0.5 text-xs', mutedText)}>{copy.channels}</p>
    </div>
    {observation && <fieldset disabled={locked} className="min-w-0">
      {!observation.rule && <p className={cn('px-4 pb-2 text-xs', mutedText)}>{copy.absent}</p>}
      <label className={cn('flex cursor-pointer items-center justify-between gap-4 border-t px-4 py-3', softBorder)}>
        <span className="min-w-0"><span className="block text-sm font-medium text-[color:var(--workspace-text-strong)]">{copy.enable}</span><span className={cn('block text-xs', mutedText)}>{v3.offlineToggleHint}</span></span>
        <SwitchInput aria-label={copy.enable} checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
      </label>
      <div className={cn('flex flex-wrap items-center justify-between gap-4 border-t px-4 py-3', softBorder)}>
        <span className="min-w-0"><span className="block text-sm font-medium text-[color:var(--workspace-text-strong)]">{copy.grace}</span><span className={cn('block text-xs', mutedText)}>{v3.graceHint}</span></span>
        <span className="flex items-center gap-2"><Input aria-label={copy.grace} className="h-8 w-24 text-right font-mono text-xs" type="number" min={1} max={86400} value={Number.isNaN(draft.gracePeriod) ? '' : draft.gracePeriod} onChange={event => setDraft({ ...draft, gracePeriod: event.target.value === '' ? NaN : Number(event.target.value) })} /><span className={cn('text-xs', mutedText)}>{v3.seconds}</span></span>
      </div>
    </fieldset>}
    <div className={cn('flex flex-wrap items-center gap-2 border-t px-4 py-3', softBorder)}>
      <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={() => void run('load')}><RotateCw className="h-3.5 w-3.5" />{observation ? copy.refresh : copy.load}</Button>
      <span className="flex-1" />
      {observation && <Button size="sm" className={primaryButton} disabled={locked || (!!status && !['synced', 'disabled'].includes(status))} onClick={() => void run('save')}>{busy ? copy.saving : copy.save}</Button>}
    </div>
    {latest && <div className="space-y-2 px-4 pb-3 text-xs" role="status">
      <Banner tone={tone} icon={status === 'synced' ? CircleCheck : GitCompare}><strong>{copy[status === 'synced' ? 'verified' : status!]}</strong>{reason && <p className="mt-0.5">{reason}</p>}</Banner>
      {status === 'conflict' && <>
        <div className="grid gap-2 sm:grid-cols-2">
          <p className="rounded-lg bg-[color:var(--workspace-surface-800)] p-3 text-sm font-medium text-[color:var(--workspace-text-strong)]">{copy.local}: {value(latest.desired)}</p>
          <p className="rounded-lg bg-[color:var(--workspace-surface-800)] p-3 text-sm font-medium text-[color:var(--workspace-text-strong)]">{copy.remote}: {value(latest.remote.rule)}</p>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" className={primaryButton} disabled={busy} onClick={() => void run('keep-local')}>{copy.keep}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void run('use-remote')}>{copy.adopt}</Button></div>
      </>}
      {['pending', 'failed', 'conflict'].includes(status!) && <div className="flex flex-wrap gap-2">
        {status === 'failed' && <Button size="sm" className={primaryButton} disabled={busy} onClick={() => void run('retry')}>{copy.retry}</Button>}
        {['pending', 'failed', 'conflict'].includes(status!) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('cancel')}>{copy.cancel}</Button>}
      </div>}
      <details className={mutedText}><summary className="cursor-pointer">{copy.history}</summary><div className="mt-1.5 space-y-1 font-mono"><p className="break-all">{latest.jobId}</p><p>{latest.observedAt > 0 ? `${new Date(latest.observedAt).toLocaleString()} · ${value(latest.remote.rule)}` : copy.awaiting}</p></div><p className="mt-1">{copy.limits}</p></details>
    </div>}
    {error && <p role="alert" className="px-4 pb-3 text-xs text-[color:var(--workspace-status-bad-text)]">{error}</p>}
  </section>
}
/** Same editor, alternate discovery entry in the existing monitoring settings. */
export function HostRuleSettingsSection({ emptyState }: { emptyState?: ReactNode } = {}) {
  const { activeVaultId, vaultStatusState } = useVault()
  return <ScopedSettings key={`${activeVaultId}:${vaultStatusState?.unlocked}`} emptyState={emptyState} />
}
function ScopedSettings({ emptyState }: { emptyState?: ReactNode }) {
  const { activeVaultId, vaultStatusState } = useVault()
  const { locale } = useT(); const copy = hostNotificationRulesCopy[locale]; const v3 = monitorSettingsCopy[locale]
  const [choices, setChoices] = useState<{ vault: string; hosts: HostProfile[] }>({ vault: '', hosts: [] })
  const [selected, setSelected] = useState('')
  useEffect(() => {
    if (!vaultStatusState?.unlocked || !('__TAURI_INTERNALS__' in window)) return
    let alive = true
    void (async () => {
      try {
        const [hosts, integrations] = await Promise.all([listHosts(activeVaultId), listKomariIntegrations(activeVaultId)])
        const mappings = await Promise.all(integrations.filter(i => i.enabled && i.vaultId === activeVaultId).map(i => getKomariMappingState(activeVaultId, i.id)))
        const ids = new Set(mappings.flatMap(state => state.mappings.filter(m => m.source === 'manual').map(m => m.hostId)))
        if (alive) setChoices({ vault: activeVaultId, hosts: hosts.filter(h => ids.has(h.id)) })
      } catch { /* no fabricated empty rules or write authorization */ }
    })()
    return () => { alive = false }
  }, [activeVaultId, vaultStatusState?.unlocked])
  const hosts = choices.vault === activeVaultId && vaultStatusState?.unlocked ? choices.hosts : []
  if (!hosts.length) return choices.vault === activeVaultId || !vaultStatusState?.unlocked ? emptyState ?? null : null
  const host = hosts.find(h => h.id === selected)
  return <section className="sb-card min-w-0 overflow-hidden" data-testid="host-rule-settings">
    <CardHead title={copy.title} hint={v3.offlineExecutor}>
      <NativeSelect aria-label={copy.host} className="h-8 w-full max-w-56 rounded-md border bg-background px-2 text-sm" value={host?.id ?? ''} onChange={e => setSelected(e.target.value)}><option value="">{copy.choose}</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</NativeSelect>
    </CardHead>
    <p className={cn('px-4 pt-3 text-xs', mutedText)}>{copy.description}</p>
    {host ? <HostNotificationRulesPanel host={host} unlocked embedded /> : <p className={cn('px-4 py-6 text-center text-xs', mutedText)}>{copy.choose}</p>}
  </section>
}
