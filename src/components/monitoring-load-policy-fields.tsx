import { useT } from '@/lib/i18n'
import { policyCopy, type LoadRule, type LoadSilence, type LoadEvent, type MonitoringNode } from '@/lib/monitoring-policy'
import type { ServiceValues } from '@/lib/monitoring-service'
import { NativeSelect } from './ui/select'
import { Button } from './ui/button'
import { Input } from './ui/input'
const localDate = (n?: number) => n && Number.isFinite(n) ? new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
const minutes = (n = 0) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
const fromMinutes = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
export function MonitoringLoadPolicyFields({ values, onChange, disabled, nodes, status, events = [] }: { values: ServiceValues; onChange: (v: ServiceValues) => void; disabled: boolean; nodes: MonitoringNode[]; events?: LoadEvent[]; status?: Record<string, { status: string; sampledAt?: number }> }) {
  const { locale } = useT(); const c = policyCopy[locale]
  const rules = (values.rules ?? []) as LoadRule[]; const silences = (values.silences ?? []) as LoadSilence[]
  const updateRule = (id: string, patch: Partial<LoadRule>) => onChange({ ...values, rules: rules.map(r => r.id === id ? { ...r, ...patch } : r) })
  const updateSilence = (id: string, patch: Partial<LoadSilence>) => onChange({ ...values, silences: silences.map(s => s.id === id ? { ...s, ...patch } : s) })
  return <div className="min-w-0 space-y-4" data-testid="monitoring-load-policy-fields">
    <p className="text-xs text-muted-foreground">{c.scope}</p>
    <fieldset disabled={disabled} className="min-w-0 space-y-3"><legend className="text-sm font-medium">{c.rules}</legend>
      {rules.map(r => <div key={r.id} className="min-w-0 space-y-2 rounded border p-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="text-sm">{c.name}<Input value={r.name} onChange={e => updateRule(r.id, { name: e.target.value })} /></label>
          <label className="min-w-0 text-sm">{c.host}<NativeSelect className="mt-1 w-full rounded border bg-background p-2" value={r.nodeId} onChange={e => { const n = nodes.find(n => n.id === e.target.value); if (n) updateRule(r.id, { nodeId: n.id, nodeCreatedAt: n.createdAt }) }}><option value={r.nodeId}>{nodes.find(n => n.id === r.nodeId)?.name ?? r.nodeId}</option>{nodes.filter(n => n.id !== r.nodeId).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</NativeSelect></label>
          <label className="text-sm">{c.metric}<NativeSelect className="mt-1 w-full rounded border bg-background p-2" value={r.metric} onChange={e => updateRule(r.id, { metric: e.target.value as LoadRule['metric'] })}>{(['cpu', 'memory', 'disk', 'load1'] as const).map(m => <option key={m} value={m}>{c[m]}</option>)}</NativeSelect></label>
          {(['threshold', 'recovery', 'durationSeconds', 'recoverySeconds'] as const).map((key, i) => <label key={key} className="text-sm">{[c.threshold, c.recovery, c.duration, c.recoveryDuration][i]}<Input type="number" min={0} value={Number.isFinite(r[key]) ? r[key] : ''} onChange={e => updateRule(r.id, { [key]: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>)}
        </div>
        <label className="mr-3 text-sm"><input type="checkbox" checked={r.enabled} onChange={e => updateRule(r.id, { enabled: e.target.checked })} /> {c.enabled}</label>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...values, rules: rules.filter(x => x.id !== r.id), silences: silences.map(s => ({ ...s, ruleIds: s.ruleIds.filter(id => id !== r.id), enabled: s.ruleIds.length === 1 && s.ruleIds[0] === r.id ? false : s.enabled })) })}>{c.remove}</Button>
        {status?.[r.id] && <p className="text-xs text-muted-foreground">{c.status}: {({ unknown: c.unknown, disabled: c.disabled, silenced: c.silenced, firing: c.firing, pending: c.pending, healthy: c.healthy } as Record<string, string>)[status[r.id].status] ?? c.unknown}{status[r.id].sampledAt ? ` · ${new Date(status[r.id].sampledAt!).toLocaleString()}` : ''}</p>}
      </div>)}
      <Button variant="outline" size="sm" disabled={disabled || !nodes.length || rules.length >= 64} onClick={() => onChange({ ...values, rules: [...rules, { id: crypto.randomUUID(), name: c.cpu, nodeId: nodes[0].id, nodeCreatedAt: nodes[0].createdAt, metric: 'cpu', threshold: 90, recovery: 80, durationSeconds: 60, recoverySeconds: 30, enabled: true }] })}>{c.addRule}</Button>
      {!nodes.length && <p className="text-xs">{c.noHosts}</p>}
    </fieldset>
    <fieldset disabled={disabled} className="min-w-0 space-y-3"><legend className="text-sm font-medium">{c.silences}</legend>
      {silences.map(s => <div key={s.id} className="min-w-0 space-y-3 rounded border p-3">
        <label className="block text-sm">{c.name}<Input value={s.name} onChange={e => updateSilence(s.id, { name: e.target.value })} /></label>
        <label className="block text-sm">{c.kind}<NativeSelect className="mt-1 w-full rounded border bg-background p-2" value={s.kind} onChange={e => updateSilence(s.id, e.target.value === 'weekly' ? { kind: 'weekly', days: [1, 2, 3, 4, 5], startMinute: 1320, endMinute: 420, timezone: 'UTC' } : { kind: 'once', startAt: Date.now(), endAt: Date.now() + 3600000 })}><option value="once">{c.once}</option><option value="weekly">{c.weekly}</option></NativeSelect></label>
        {s.kind === 'once' ? <div className="grid gap-3 sm:grid-cols-2">{(['startAt', 'endAt'] as const).map((key, i) => <label key={key} className="text-sm">{i ? c.end : c.start}<Input type="datetime-local" value={localDate(s[key])} onChange={e => updateSilence(s.id, { [key]: Date.parse(e.target.value) })} /></label>)}</div> : <>
          <div className="grid gap-3 sm:grid-cols-2">{(['startMinute', 'endMinute'] as const).map((key, i) => <label key={key} className="text-sm">{i ? c.endTime : c.startTime}<Input type="time" value={minutes(s[key])} onChange={e => updateSilence(s.id, { [key]: fromMinutes(e.target.value) })} /></label>)}</div>
          <div className="flex flex-wrap gap-3">{c.weekdays.map((day, i) => <label key={day} className="text-sm"><input type="checkbox" checked={s.days?.includes(i) ?? false} onChange={e => updateSilence(s.id, { days: e.target.checked ? [...s.days ?? [], i] : s.days?.filter(d => d !== i) })} /> {day}</label>)}</div><p className="text-xs text-muted-foreground">{c.overnight}</p>
        </>}
        <p className="text-sm">{c.applies} · {s.ruleIds.length ? c.selectRules : c.all}</p>
        <div className="flex flex-wrap gap-3">{rules.map(r => <label key={r.id} className="text-sm"><input type="checkbox" checked={s.ruleIds.includes(r.id)} onChange={e => updateSilence(s.id, { ruleIds: e.target.checked ? [...s.ruleIds, r.id] : s.ruleIds.filter(id => id !== r.id) })} /> {r.name}</label>)}</div>
        <label className="mr-3 text-sm"><input type="checkbox" checked={s.enabled} onChange={e => updateSilence(s.id, { enabled: e.target.checked })} /> {c.enabled}</label><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...values, silences: silences.filter(x => x.id !== s.id) })}>{c.remove}</Button>
      </div>)}
      <Button variant="outline" size="sm" disabled={disabled || silences.length >= 64} onClick={() => onChange({ ...values, silences: [...silences, { id: crypto.randomUUID(), name: c.once, enabled: true, ruleIds: [], kind: 'once', startAt: Date.now(), endAt: Date.now() + 3600000 }] })}>{c.addSilence}</Button>
    </fieldset>
    {events.length > 0 && <details><summary className="cursor-pointer text-sm">{c.events} ({events.length})</summary><ul className="mt-2 max-h-64 space-y-2 overflow-auto">{events.slice(-50).reverse().map((e, i) => <li key={`${e.ruleId}-${e.sampledAt}-${i}`} className="break-words rounded border p-2 text-xs">{e.name} · {e.kind === 'recovered' ? c.recovered : c.firing}<p className="text-muted-foreground">{new Date(e.sampledAt).toLocaleString()} · {({ 'service-accepted': c.accepted, silenced: c.silenced, 'channel-disabled': c.channelDisabled, 'configuration-changed': c.policyChanged } as Record<string, string>)[e.delivery] ?? c.deliveryUnknown}</p></li>)}</ul></details>}
  </div>
}
