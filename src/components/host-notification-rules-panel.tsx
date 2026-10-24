import { NativeSelect } from '@/components/ui/select'
import { useEffect, useRef, useState } from 'react'
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

const ruleCopy = {
  en: { title: 'Host notification rules', rule: 'Offline notification', description: 'The monitoring service can notify after this host stays offline. It continues when this app is closed. Device reminders are configured separately below.', scope: 'Changes affect this host on the selected service and its existing notification channels. Saving a rule does not verify notification delivery.', load: 'Read current rule', refresh: 'Refresh from service', enable: 'Notify when offline', grace: 'Offline grace period (seconds)', absent: 'No rule configured', save: 'Save and verify', saving: 'Working…', verified: 'Rule verified on service', pending: 'Saved locally; awaiting verification', applying: 'Writing and verifying', failed: 'Needs attention; changes retained', conflict: 'Service rule changed', disabled: 'This intent has stopped', retry: 'Retry saved changes', keep: 'Apply my changes', adopt: 'Use service rule', local: 'My saved changes', remote: 'Current service rule', cancel: 'Cancel pending changes', history: 'Operation and verification', error: 'Could not complete this operation. Unlock the Vault, refresh the rule and retry. Your saved changes remain available.', unsupported: 'This server version does not support verified rule editing.', limits: 'The service has no conditional writes. Detected concurrent edits require review; an already sent request cannot be recalled.', host: 'Host', choose: 'Choose a monitored host', channels: 'Service delivery depends on its existing channel configuration. This editor does not send a test notification or change device reminders.', invalid: 'Enter an integer from 1 to 86400 seconds.', locked: 'Unlock the Vault to manage notification rules.', on: 'Enabled', off: 'Disabled', awaiting: 'Awaiting a fresh service observation', permission: 'The service rejected access. Check the saved access credential before retrying.', unavailable: 'The service could not be reached or the write result is uncertain. Refresh before retrying.', invalidResponse: 'The service returned unsupported rule data. No further write was sent.', mismatch: 'Readback did not match the saved changes. Review the service rule before retrying.', changedScope: 'The host, service or binding changed. This saved intent will not be sent.', dismissed: 'Pending changes were cancelled; the service rule was not changed by cancellation.' },
  'zh-CN': { title: '主机通知规则', rule: '离线通知', description: '主机持续离线后由监控服务通知，关闭 App 后仍可运行。设备提醒在下方单独配置。', scope: '修改影响所选服务中的这台主机及其现有通知渠道。保存规则不代表通知已送达。', load: '读取当前规则', refresh: '从服务刷新', enable: '主机离线时通知', grace: '离线宽限期（秒）', absent: '尚未配置规则', save: '保存并验证', saving: '处理中…', verified: '服务端规则已核验', pending: '已保存到本机，等待核验', applying: '正在写入并核验', failed: '需要处理，修改已保留', conflict: '服务端规则已变化', disabled: '此修改已停止', retry: '重试已保存的修改', keep: '应用我的修改', adopt: '采用服务端规则', local: '我已保存的修改', remote: '服务端当前规则', cancel: '取消待处理修改', history: '操作与核验记录', error: '操作未完成。请解锁保管库、刷新规则后重试；已保存的修改仍可恢复。', unsupported: '此服务版本尚不支持已验证的规则编辑。', limits: '此服务不支持条件写入。检测到并发修改时需处理冲突；已发出的请求无法保证撤回。', host: '主机', choose: '选择已监控主机', channels: '实际投递依赖服务上已有的渠道配置；这里不会发送测试通知或更改设备提醒。', invalid: '请输入 1 至 86400 之间的整数秒数。', locked: '解锁保管库后可管理通知规则。', on: '已启用', off: '已停用', awaiting: '等待新的服务端观测', permission: '服务拒绝访问。请检查已保存的访问凭据后重试。', unavailable: '服务暂时无法访问，或写入结果尚不确定。请先刷新再重试。', invalidResponse: '服务返回的规则数据尚不支持，未继续写入。', mismatch: '回读结果与已保存的修改不一致。请核对服务端规则后重试。', changedScope: '主机、服务或关联已变化，此修改不会继续发送。', dismissed: '待处理修改已取消；取消操作本身未改变服务端规则。' },
} as const
interface Target { integration: KomariIntegration; nodeId: string; revision: number }
type Props = { host: HostProfile; unlocked: boolean }
export function HostNotificationRulesPanel(props: Props) {
  return <ScopedRules key={`${props.host.vaultId}:${props.host.id}:${props.unlocked}`} {...props} />
}
function ScopedRules({ host, unlocked }: Props) {
  const { locale } = useT(); const copy = ruleCopy[locale]
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
  return <details className="rounded-lg border p-3" data-testid="host-notification-rules">
    <summary className="cursor-pointer text-sm font-medium">{copy.title}</summary>
    <p className="my-3 text-xs text-muted-foreground">{copy.scope}</p>
    {error && <p role="alert" className="text-xs text-destructive">{copy.error}</p>}
    {targets.map(target => <RuleEditor key={`${target.integration.id}:${target.integration.updatedAt}:${target.revision}:${target.nodeId}`} host={host} target={target} saved={rows.find(row => row.integrationId === target.integration.id)} />)}
    {rows.filter(row => !targets.some(target => target.integration.id === row.integrationId)).map(row => <p key={row.id} className="my-2 break-all text-xs">{copy.disabled} · {row.jobId}</p>)}
  </details>
}
export function RuleEditor({ host, target, saved }: { host: HostProfile; target: Target; saved?: HostRuleIntent }) {
  const { locale } = useT(); const copy = ruleCopy[locale]
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
  return <section className="space-y-3 border-t py-3" aria-label={`${target.integration.name} · ${copy.rule}`}>
    <h4 className="text-sm font-medium">{target.integration.name} · {copy.rule}</h4>
    <p className="text-xs text-muted-foreground">{copy.channels}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('load')}>{observation ? copy.refresh : copy.load}</Button>
    {observation && <fieldset disabled={busy || status === 'applying'} className="space-y-3">
      {!observation.rule && <p className="text-xs">{copy.absent}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{copy.enable}</label>
      <label className="block space-y-1 text-xs">{copy.grace}<Input aria-label={copy.grace} type="number" min={1} max={86400} value={Number.isNaN(draft.gracePeriod) ? '' : draft.gracePeriod} onChange={event => setDraft({ ...draft, gracePeriod: event.target.value === '' ? NaN : Number(event.target.value) })} /></label>
      <Button size="sm" disabled={!!status && !['synced', 'disabled'].includes(status)} onClick={() => void run('save')}>{busy ? copy.saving : copy.save}</Button>
    </fieldset>}
    {latest && <div className="space-y-2 text-xs" role="status">
      <strong>{copy[status === 'synced' ? 'verified' : status!]}</strong>
      {reason && <p>{reason}</p>}
      {status === 'conflict' && <><p>{copy.local}: {value(latest.desired)}</p><p>{copy.remote}: {value(latest.remote.rule)}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void run('keep-local')}>{copy.keep}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void run('use-remote')}>{copy.adopt}</Button></div></>}
      {status === 'failed' && <Button size="sm" disabled={busy} onClick={() => void run('retry')}>{copy.retry}</Button>}
      {['pending', 'failed', 'conflict'].includes(status!) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('cancel')}>{copy.cancel}</Button>}
      <details><summary className="cursor-pointer">{copy.history}</summary><p className="mt-2 break-all font-mono">{latest.jobId}</p><p>{latest.observedAt > 0 ? `${new Date(latest.observedAt).toLocaleString()} · ${value(latest.remote.rule)}` : copy.awaiting}</p><p>{copy.limits}</p></details>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
/** Same editor, alternate discovery entry in the existing monitoring settings. */
export function HostRuleSettingsSection() {
  const { activeVaultId, vaultStatusState } = useVault()
  return <ScopedSettings key={`${activeVaultId}:${vaultStatusState?.unlocked}`} />
}
function ScopedSettings() {
  const { activeVaultId, vaultStatusState } = useVault()
  const { locale } = useT(); const copy = ruleCopy[locale]
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
  if (!hosts.length) return null
  const host = hosts.find(h => h.id === selected)
  return <section className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">{copy.title}</h3><p className="text-xs text-muted-foreground">{copy.description}</p>
    <NativeSelect aria-label={copy.host} className="h-9 w-full rounded border bg-background px-2 text-sm" value={host?.id ?? ''} onChange={e => setSelected(e.target.value)}><option value="">{copy.choose}</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</NativeSelect>
    {host && <HostNotificationRulesPanel host={host} unlocked />}
  </section>
}
