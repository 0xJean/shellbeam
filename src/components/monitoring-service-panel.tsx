import { MonitoringChannelFields } from './monitoring-channel-fields'
import { MonitoringLoadPolicyFields } from './monitoring-load-policy-fields'
import { policyCopy, channelFields, type LoadEvent, type MonitoringNode } from '@/lib/monitoring-policy'
import { NativeSelect } from '@/components/ui/select'
import { useRef, useState, useEffect, useCallback } from 'react'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import type { KomariIntegration } from '@/lib/komari-config'
import { closeServiceScope, serviceErrorCode, serviceIntentAction, serviceRequest, serviceScope, type ServiceIntent, type ServiceValues, type ServiceScope } from '@/lib/monitoring-service'
import { monitoringServiceCopy } from '@/lib/locales/monitoring-service'
import { requestUserDecision } from '@/lib/user-confirmation'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function MonitoringServicePanel({ service }: { service: KomariIntegration }) {
  return <MonitoringServiceContent key={JSON.stringify(service)} service={service} />
}
function MonitoringServiceContent({ service }: { service: KomariIntegration }) {
  const { locale } = useT(); const c = monitoringServiceCopy[locale]; const p = policyCopy[locale]
  const { captureVaultScope } = useVault()
  const [values, setValues] = useState<ServiceValues | null>(null)
  const [baseline, setBaseline] = useState<ServiceValues | null>(null)
  const [target, setTarget] = useState<string>('settings')
  const [metrics, setMetrics] = useState<string[]>([])
  const [channels, setChannels] = useState<string[]>([])
  const [nodes, setNodes] = useState<MonitoringNode[]>([])
  const [tasks, setTasks] = useState<{ id: number; name: string }[]>([])
  const [observations, setObservations] = useState<Record<string, { status: string; sampledAt?: number }>>()
  const [events, setEvents] = useState<LoadEvent[]>([])
  const [readVersion, setReadVersion] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [history, setHistory] = useState<ServiceIntent[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const activeScopes = useRef(new Set<ServiceScope>())
  const alive = useRef(true); const running = useRef(false)
  useEffect(() => { alive.current = true; const scopes = activeScopes.current; return () => { alive.current = false; for (const scope of scopes) void closeServiceScope(scope).catch(() => {}); scopes.clear() } }, [])
  const message = (cause: unknown) => {
    const code = serviceErrorCode(cause)
    return code.includes('EXTENSION_REQUIRED') ? p.missing : code.includes('EXTENSION_MISMATCH') ? p.mismatch : code.includes('PENDING_EDIT') ? c.pending : code.includes('SCOPE') || code.includes('STALE') ? c.scope : code.includes('PERMISSION') || code.includes('AUTH') ? c.permission : code.includes('UNSUPPORTED') ? c.unsupported : code.includes('INVALID') ? c.invalid : code.includes('BUSY') ? c.busy : code.includes('NO_CHANGES') ? c.noChanges : code.includes('DISABLED') ? c.disabled : c.network
  }
  const refreshHistory = useCallback(async () => {
    const scopeValid = captureVaultScope(); const scope = await serviceScope(service)
    activeScopes.current.add(scope)
    try {
      if (!alive.current || !scopeValid()) return
      const rows = await serviceRequest<ServiceIntent[]>(scope, 'list')
      if (!Array.isArray(rows)) throw new Error('MONITORING_INVALID_RESPONSE')
      if (alive.current && scopeValid()) setHistory(rows)
    } finally { activeScopes.current.delete(scope); await closeServiceScope(scope) }
  }, [captureVaultScope, service])
  useEffect(() => { void refreshHistory().catch(() => {}) }, [refreshHistory])
  const work = async (operation: (scope: Awaited<ReturnType<typeof serviceScope>>, current: () => boolean) => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setNotice('')
    const valid = captureVaultScope(); const current = () => alive.current && valid()
    let scope: ServiceScope | undefined
    try {
      scope = await serviceScope(service)
      activeScopes.current.add(scope)
      if (current()) await operation(scope, current)
      if (current()) await refreshHistory()
    } catch (cause) { if (current()) setError(message(cause)) }
    finally { if (scope) { activeScopes.current.delete(scope); await closeServiceScope(scope).catch(() => {}) }; running.current = false; if (current()) setBusy(false) }
  }
  const read = () => work(async (scope, current) => {
    const next = await serviceRequest<ServiceValues>(scope, 'read', { target })
    if (!current()) return
    if (target === 'settings') {
      const list = await serviceRequest<{ id: string }[]>(scope, 'channels')
      if (!current()) return
      setChannels(list.map(x => x.id).filter(x => typeof x === 'string'))
      const definitions = await serviceRequest<{ name: string }[]>(scope, 'metrics')
      if (!current()) return
      setMetrics(definitions.map(x => x.name).filter(x => typeof x === 'string' && /^[a-zA-Z0-9_.-]{1,190}$/.test(x)))
    }
    if (target === 'load-policy' || channelFields(next).some(f => f.type === 'nodes')) {
      const rows = await serviceRequest<MonitoringNode[]>(scope, 'channel-nodes'); if (!current()) return; setNodes(rows)
    }
    if (channelFields(next).some(f => f.type === 'pingtasks')) { const rows = await serviceRequest<{ id: number; name: string }[]>(scope, 'channel-pingtasks'); if (!current()) return; setTasks(rows) }
    if (target === 'load-policy') { const status = await serviceRequest<{ evaluations: Record<string, { status: string; sampledAt?: number }>; events: LoadEvent[] }>(scope, 'load-status'); if (!current()) return; setObservations(status.evaluations); setEvents(Array.isArray(status.events) ? status.events : []) }
    setReadVersion(v => v + 1); setValues(next); setBaseline(next); setReviewing(false); setRevealed({})
  })
  const save = () => work(async (scope, current) => {
    if (!baseline || !values || reviewing) return
    const risk = target.startsWith('retention:') || target.startsWith('channel:') || target === 'load-policy' || (baseline.private_site === true && values.private_site === false) ? 'high' : 'low'
    const impact = target === 'load-policy' ? p.scope : target.startsWith('channel:') ? p.scriptHint : target.startsWith('retention:') ? c.retentionHint : baseline.private_site === true && values.private_site === false ? c.privateHint : ''
    const answer = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${c.saveConfirm}\n${impact}`, risk, isCurrent: current })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    const pending = await serviceRequest<ServiceIntent>(scope, 'prepare', { target, baseline, desired: values, confirmed: true })
    if (!current()) return
    const result = await serviceIntentAction(scope, pending, 'apply')
    if (!current()) return
    if (result.intent.status === 'verified') { setValues(result.observed); setBaseline(result.observed); setNotice(c.verified); setObservations(undefined) }
    else setError(result.intent.status === 'conflict' ? c.conflict : c.network)
  })
  const act = (row: ServiceIntent, action: string) => work(async (scope, current) => {
    if (action === 'retry') {
      const answer = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${c.retryConfirm}\n${row.intent.target === 'extension' ? p.setupConfirm : row.intent.target === 'load-policy' ? p.scope : row.intent.target.startsWith('channel:') ? p.scriptHint : row.intent.target.startsWith('retention:') ? c.retentionHint : row.baseline.private_site === true && row.desired.private_site === false ? c.privateHint : ''}`, risk: row.intent.target.startsWith('retention:') || row.intent.target.startsWith('channel:') || ['extension', 'load-policy'].includes(row.intent.target) || (row.baseline.private_site === true && row.desired.private_site === false) ? 'high' : 'low', isCurrent: current })
      if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    }
    let result = await serviceIntentAction(scope, row, action, action === 'retry')
    if (action === 'retry' && result.intent.status === 'prepared' && current()) result = await serviceIntentAction(scope, result, 'apply')
    if (current() && result.intent.target === target) { setValues(result.observed); setBaseline(result.observed); setReviewing(false); setRevealed({}) }
  })
  const test = () => work(async (scope, current) => {
    const answer = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${c.testConfirm}`, risk: 'low', isCurrent: current })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    await serviceRequest(scope, 'test', { confirmed: true })
    if (current()) setNotice(c.testAccepted)
  })
  const setup = () => work(async (scope, current) => {
    const before = await serviceRequest<ServiceValues>(scope, 'read', { target: 'extension' })
    if (!current()) return
    if (before.installed === true && before.enabled === true) { setNotice(c.verified); return }
    const decision = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${p.setupConfirm}`, risk: 'high', isCurrent: current })
    if (!decision.accepted || decision.isCurrent?.() === false || !current()) return
    const pending = await serviceRequest<ServiceIntent>(scope, 'prepare', { target: 'extension', baseline: before, desired: { installed: true, enabled: true }, confirmed: true })
    if (!current()) return
    const result = await serviceIntentAction(scope, pending, 'apply')
    if (current()) { if (result.intent.status === 'verified') setNotice(c.verified); else setError(c.network) }
  })
  const targetName = (name: string) => name === 'extension' || name === 'load-policy' ? p.title : name.startsWith('channel:') ? `${p.channelTitle} · ${name.slice(8)}` : name === 'webhook' ? c.channel : name.startsWith('retention:') ? `${c.retention} · ${name.slice(10)}` : c.settings
  const field = (key: string, label: string, type = 'text') => values && key in values && <label key={key} className="block min-w-0 text-sm">{label}<span className="mt-1 flex min-w-0 gap-2"><Input aria-label={label} className="min-w-0" type={type === 'password' && revealed[key] ? 'text' : type} value={String(values[key] ?? '')} disabled={busy} readOnly={reviewing} autoComplete="off" onChange={e => setValues({ ...values, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} />{type === 'password' && <Button type="button" size="sm" variant="outline" aria-label={`${revealed[key] ? c.hide : c.show} ${label}`} onClick={() => setRevealed({ ...revealed, [key]: !revealed[key] })}>{revealed[key] ? c.hide : c.show}</Button>}</span></label>
  const toggle = (key: string, label: string) => values && key in values && <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values[key] === true} disabled={busy || reviewing} onChange={e => setValues({ ...values, [key]: e.target.checked })} />{label}</label>
  const status = (row: ServiceIntent) => ({ verified: c.verified, prepared: c.prepared, applying: c.applying, uncertain: c.uncertain, retry: c.retryState, conflict: c.conflict, cancelled: c.cancelled })[row.intent.status]
  return <details className="mt-4 border-t pt-3" data-testid="monitoring-service-panel">
    <summary className="cursor-pointer text-sm font-medium">{c.title}</summary>
    <p className="my-3 max-w-3xl text-xs text-muted-foreground">{c.description}</p>
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect aria-label={c.title} className="max-w-full rounded border bg-background px-2 py-1 text-sm" value={target} disabled={busy} onChange={e => { setTarget(e.target.value as typeof target); setValues(null); setBaseline(null); setNotice(''); setError(''); setReviewing(false); setRevealed({}) }}><option value="settings">{c.settings}</option><option value="webhook">{c.channel}</option><option value="load-policy">{p.title}</option>{[...new Set([...channels.filter(id => id !== 'webhook' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(id)), ...(target.startsWith('channel:') ? [target.slice(8)] : [])])].map(id => <option key={id} value={`channel:${id}`}>{p.channelTitle} · {id}</option>)}{[...new Set([...metrics, ...(target.startsWith('retention:') ? [target.slice(10)] : [])])].map(name => <option key={name} value={`retention:${name}`}>{c.retention} · {name}</option>)}</NativeSelect>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void read()}>{busy ? c.waiting : c.read}</Button>
    </div>
    {target === 'load-policy' && <div className="mt-3 space-y-2"><p className="text-xs text-muted-foreground">{p.scope}</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void setup()}>{p.setup}</Button></div>}
    {values && <div className="mt-3 space-y-3">
      {reviewing && <p role="status" className="text-xs text-muted-foreground">{c.reviewing}</p>}
      {target === 'settings' ? <>
        <div className="grid gap-3 sm:grid-cols-2">{field('sitename', c.name)}{field('description', c.descriptionField)}</div>
        {toggle('private_site', c.private)}{toggle('notification_enabled', c.enabled)}
        <label className="block text-sm">{c.method}<NativeSelect className="mt-1 block max-w-full rounded border bg-background p-2" value={String(values.notification_method ?? 'none')} disabled={busy || reviewing} onChange={e => setValues({ ...values, notification_method: e.target.value })}>
          <option value="none">{c.none}</option>{[...new Set([...channels, String(values.notification_method ?? 'none')])].filter(id => id && id !== 'none').map(id => <option key={id} value={id}>{id}</option>)}
        </NativeSelect></label>
        {values.notification_method !== 'none' && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setTarget(values.notification_method === 'webhook' ? 'webhook' : `channel:${String(values.notification_method)}`); setValues(null); setBaseline(null); setReviewing(false) }}>{p.channelTitle}</Button>}
        {field('notification_template', c.template)}{toggle('login_notification', c.login)}{toggle('expire_notification_enabled', c.expiry)}
        <div className="grid gap-3 sm:grid-cols-2">{field('expire_notification_lead_days', c.expiryDays, 'number')}{field('traffic_limit_percentage', c.traffic, 'number')}</div>
      </> : target === 'load-policy' ? <MonitoringLoadPolicyFields values={values} onChange={setValues} disabled={busy || reviewing} nodes={nodes} status={reviewing ? undefined : observations} events={events} /> : target.startsWith('channel:') ? <MonitoringChannelFields key={target + String(values.__shellbeam_channel_identity) + readVersion} values={values} onChange={setValues} disabled={busy || reviewing} nodes={nodes} tasks={tasks} /> : target === 'extension' ? <p className="text-xs">{p.setupConfirm}</p> : target.startsWith('retention:') ? <>{field('retention_days', c.retentionDays, 'number')}<p className="text-xs text-amber-600">{c.retentionHint}</p></> : <>
        {field('url', c.url, 'password')}
        <label className="block text-sm">{c.httpMethod}<NativeSelect className="ml-2 rounded border bg-background p-1" value={String(values.method ?? 'GET')} disabled={busy || reviewing} onChange={e => setValues({ ...values, method: e.target.value })}><option>POST</option><option>GET</option></NativeSelect></label>
        {field('content_type', c.content_type)}{field('headers', c.headers, 'password')}{field('body', c.body)}
        <div className="grid gap-3 sm:grid-cols-2">{field('username', c.username)}{field('password', c.password, 'password')}</div>
      </>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || reviewing || JSON.stringify(values) === JSON.stringify(baseline)} onClick={() => void save()}>{c.save}</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void test()}>{c.test}</Button></div>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>}{notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
    <p className="mt-3 text-xs text-muted-foreground">{c.noRules}</p>
    {history.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm">{c.history} ({history.length})</summary><ul className="mt-2 space-y-3">{history.map(row => <li key={row.intent.id} className="rounded border p-3 text-xs">
      <p className="break-words">{targetName(row.intent.target)} · {status(row)}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setTarget(row.intent.target); setValues(row.desired); setBaseline(row.baseline); setReviewing(true); setRevealed({}); setNotice(''); setError('') }}>{c.review}</Button><p className="mt-1 break-all text-muted-foreground">{row.intent.jobId} · {new Date(row.intent.updatedAt).toLocaleString()}</p>
      {!['verified', 'cancelled'].includes(row.intent.status) && <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(row, 'reconcile')}>{c.recover}</Button>{['retry', 'conflict'].includes(row.intent.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(row, 'retry')}>{c.retry}</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(row, 'cancel')}>{c.cancel}</Button></div>}
    </li>)}</ul></details>}
  </details>
}
