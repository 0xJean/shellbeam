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
  const { locale } = useT(); const c = monitoringServiceCopy[locale]
  const { captureVaultScope } = useVault()
  const [values, setValues] = useState<ServiceValues | null>(null)
  const [baseline, setBaseline] = useState<ServiceValues | null>(null)
  const [target, setTarget] = useState<string>('settings')
  const [metrics, setMetrics] = useState<string[]>([])
  const [channels, setChannels] = useState<string[]>([])
  const [reviewing, setReviewing] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [history, setHistory] = useState<ServiceIntent[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const activeScopes = useRef(new Set<ServiceScope>())
  const alive = useRef(true); const running = useRef(false)
  useEffect(() => { alive.current = true; const scopes = activeScopes.current; return () => { alive.current = false; for (const scope of scopes) void closeServiceScope(scope).catch(() => {}); scopes.clear() } }, [])
  const message = (cause: unknown) => {
    const code = serviceErrorCode(cause)
    return code.includes('PENDING_EDIT') ? c.pending : code.includes('SCOPE') || code.includes('STALE') ? c.scope : code.includes('PERMISSION') || code.includes('AUTH') ? c.permission : code.includes('UNSUPPORTED') ? c.unsupported : code.includes('INVALID') ? c.invalid : code.includes('BUSY') ? c.busy : code.includes('NO_CHANGES') ? c.noChanges : code.includes('DISABLED') ? c.disabled : c.network
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
    setValues(next); setBaseline(next); setReviewing(false); setRevealed({})
  })
  const save = () => work(async (scope, current) => {
    if (!baseline || !values || reviewing) return
    const risk = target.startsWith('retention:') || (baseline.private_site === true && values.private_site === false) ? 'high' : 'low'
    const impact = target.startsWith('retention:') ? c.retentionHint : baseline.private_site === true && values.private_site === false ? c.privateHint : ''
    const answer = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${c.saveConfirm}\n${impact}`, risk, isCurrent: current })
    if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    const pending = await serviceRequest<ServiceIntent>(scope, 'prepare', { target, baseline, desired: values, confirmed: true })
    if (!current()) return
    const result = await serviceIntentAction(scope, pending, 'apply')
    if (!current()) return
    if (result.intent.status === 'verified') { setValues(result.observed); setBaseline(result.observed); setNotice(c.verified) }
    else setError(result.intent.status === 'conflict' ? c.conflict : c.network)
  })
  const act = (row: ServiceIntent, action: string) => work(async (scope, current) => {
    if (action === 'retry') {
      const answer = await requestUserDecision({ vaultId: service.vaultId, message: `${service.name}\n${c.retryConfirm}\n${row.intent.target.startsWith('retention:') ? c.retentionHint : row.baseline.private_site === true && row.desired.private_site === false ? c.privateHint : ''}`, risk: row.intent.target.startsWith('retention:') || (row.baseline.private_site === true && row.desired.private_site === false) ? 'high' : 'low', isCurrent: current })
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
  const field = (key: string, label: string, type = 'text') => values && key in values && <label key={key} className="block min-w-0 text-sm">{label}<span className="mt-1 flex min-w-0 gap-2"><Input aria-label={label} className="min-w-0" type={type === 'password' && revealed[key] ? 'text' : type} value={String(values[key] ?? '')} disabled={busy} readOnly={reviewing} autoComplete="off" onChange={e => setValues({ ...values, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} />{type === 'password' && <Button type="button" size="sm" variant="outline" aria-label={`${revealed[key] ? c.hide : c.show} ${label}`} onClick={() => setRevealed({ ...revealed, [key]: !revealed[key] })}>{revealed[key] ? c.hide : c.show}</Button>}</span></label>
  const toggle = (key: string, label: string) => values && key in values && <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values[key] === true} disabled={busy || reviewing} onChange={e => setValues({ ...values, [key]: e.target.checked })} />{label}</label>
  const status = (row: ServiceIntent) => ({ verified: c.verified, prepared: c.prepared, applying: c.applying, uncertain: c.uncertain, retry: c.retryState, conflict: c.conflict, cancelled: c.cancelled })[row.intent.status]
  return <details className="mt-4 border-t pt-3" data-testid="monitoring-service-panel">
    <summary className="cursor-pointer text-sm font-medium">{c.title}</summary>
    <p className="my-3 max-w-3xl text-xs text-muted-foreground">{c.description}</p>
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect aria-label={c.title} className="max-w-full rounded border bg-background px-2 py-1 text-sm" value={target} disabled={busy} onChange={e => { setTarget(e.target.value as typeof target); setValues(null); setBaseline(null); setNotice(''); setError(''); setReviewing(false); setRevealed({}) }}><option value="settings">{c.settings}</option><option value="webhook">{c.channel}</option>{[...new Set([...metrics, ...(target.startsWith('retention:') ? [target.slice(10)] : [])])].map(name => <option key={name} value={`retention:${name}`}>{c.retention} · {name}</option>)}</NativeSelect>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void read()}>{busy ? c.waiting : c.read}</Button>
    </div>
    {values && <div className="mt-3 space-y-3">
      {reviewing && <p role="status" className="text-xs text-muted-foreground">{c.reviewing}</p>}
      {target === 'settings' ? <>
        <div className="grid gap-3 sm:grid-cols-2">{field('sitename', c.name)}{field('description', c.descriptionField)}</div>
        {toggle('private_site', c.private)}{toggle('notification_enabled', c.enabled)}
        <label className="block text-sm">{c.method}<NativeSelect className="mt-1 block max-w-full rounded border bg-background p-2" value={String(values.notification_method ?? 'none')} disabled={busy || reviewing} onChange={e => setValues({ ...values, notification_method: e.target.value })}>
          <option value="none">{c.none}</option>{[...new Set([...channels, String(values.notification_method ?? 'none')])].filter(id => id && id !== 'none').map(id => <option key={id} value={id}>{id}</option>)}
        </NativeSelect></label>
        {values.notification_method !== 'none' && values.notification_method !== 'webhook' && <p className="text-xs text-muted-foreground">{c.unsupportedChannel}</p>}
        {field('notification_template', c.template)}{toggle('login_notification', c.login)}{toggle('expire_notification_enabled', c.expiry)}
        <div className="grid gap-3 sm:grid-cols-2">{field('expire_notification_lead_days', c.expiryDays, 'number')}{field('traffic_limit_percentage', c.traffic, 'number')}</div>
      </> : target.startsWith('retention:') ? <>{field('retention_days', c.retentionDays, 'number')}<p className="text-xs text-amber-600">{c.retentionHint}</p></> : <>
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
      <p className="break-words">{row.intent.target === 'webhook' ? c.channel : row.intent.target.startsWith('retention:') ? `${c.retention} · ${row.intent.target.slice(10)}` : c.settings} · {status(row)}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setTarget(row.intent.target); setValues(row.desired); setBaseline(row.baseline); setReviewing(true); setRevealed({}); setNotice(''); setError('') }}>{c.review}</Button><p className="mt-1 break-all text-muted-foreground">{row.intent.jobId} · {new Date(row.intent.updatedAt).toLocaleString()}</p>
      {!['verified', 'cancelled'].includes(row.intent.status) && <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(row, 'reconcile')}>{c.recover}</Button>{['retry', 'conflict'].includes(row.intent.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(row, 'retry')}>{c.retry}</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(row, 'cancel')}>{c.cancel}</Button></div>}
    </li>)}</ul></details>}
  </details>
}
