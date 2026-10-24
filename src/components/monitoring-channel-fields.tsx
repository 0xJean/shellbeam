import { useState } from 'react'
import { useT } from '@/lib/i18n'
import { channelFields, channelLabel, policyCopy, type MonitoringNode } from '@/lib/monitoring-policy'
import { monitoringServiceCopy } from '@/lib/locales/monitoring-service'
import type { ServiceValues } from '@/lib/monitoring-service'
import { NativeSelect } from './ui/select'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function MonitoringChannelFields({ values, onChange, disabled, nodes, tasks }: { values: ServiceValues; onChange: (v: ServiceValues) => void; disabled: boolean; nodes: MonitoringNode[]; tasks: { id: number; name: string }[] }) {
  const { locale } = useT(); const c = policyCopy[locale]; const common = monitoringServiceCopy[locale]
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const fields = channelFields(values)
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value })
  return <div className="min-w-0 space-y-3" data-testid="monitoring-channel-fields">
    <p className="text-xs text-muted-foreground">{c.channelHint}</p>
    <p className="text-xs text-amber-600">{c.scriptHint}</p>
    {!fields.length && <p>{c.unsupported}</p>}
    {fields.map(f => {
      const label = channelLabel(f.name, f.key, locale); const value = values[f.key]
      const options = (f.options ?? '').split(',').map(x => x.trim())
      if (f.type === 'title') return <p key={f.key} className="break-words text-sm font-medium">{label}</p>
      if (f.type === 'switch') return <label key={f.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value === true} disabled={disabled} onChange={e => set(f.key, e.target.checked)} />{label}</label>
      if (f.type === 'select') return <label key={f.key} className="block text-sm">{label}<NativeSelect className="mt-1 w-full rounded border bg-background p-2" value={String(value ?? '')} disabled={disabled} onChange={e => set(f.key, e.target.value)}>{!options.includes(String(value)) && <option value={String(value ?? '')} disabled>{String(value ?? '')}</option>}{options.map(o => <option key={o} value={o}>{o}</option>)}</NativeSelect></label>
      if (f.type === 'nodes' || f.type === 'pingtasks') {
        const selected = Array.isArray(value) ? value : []; const available = f.type === 'nodes' ? nodes : tasks
        const choices = [...available, ...selected.filter(id => !available.some(n => n.id === id)).map(id => ({ id, name: String(id) }))]
        return <fieldset key={f.key} className="rounded border p-2" disabled={disabled}><legend className="text-sm">{label}</legend><div className="max-h-48 overflow-auto">{choices.map(n => <label key={String(n.id)} className="flex items-center gap-2 break-all text-sm"><input type="checkbox" checked={selected.includes(n.id)} onChange={e => set(f.key, e.target.checked ? [...selected, n.id] : selected.filter(id => id !== n.id))} />{n.name}</label>)}</div></fieldset>
      }
      if (f.type === 'number') return <label key={f.key} className="block text-sm">{label}<Input type="number" value={typeof value === 'number' ? value : ''} disabled={disabled} onChange={e => set(f.key, e.target.value === '' ? null : Number(e.target.value))} /></label>
      if (!['string', 'textbox', 'richtext'].includes(f.type)) return <p key={f.key} className="text-xs">{label} · {c.unsupported}</p>
      return <div key={f.key} className="min-w-0"><div className="flex items-center justify-between gap-2"><label htmlFor={`channel-${f.key}`} className="break-words text-sm">{label}{f.required ? ' *' : ''}</label><Button type="button" size="sm" variant="ghost" onClick={() => setRevealed({ ...revealed, [f.key]: !revealed[f.key] })}>{revealed[f.key] ? common.hide : common.show} {label}</Button></div>{revealed[f.key] && ['textbox', 'richtext'].includes(f.type) ? <textarea id={`channel-${f.key}`} className="min-h-32 w-full rounded border bg-background p-2 font-mono text-sm" disabled={disabled} value={String(value ?? '')} onChange={e => set(f.key, e.target.value)} autoComplete="off" spellCheck={false} /> : <Input id={`channel-${f.key}`} type={revealed[f.key] ? 'text' : 'password'} readOnly={!revealed[f.key]} disabled={disabled} value={String(value ?? '')} onChange={e => set(f.key, e.target.value)} autoComplete="off" />}</div>
    })}
  </div>
}
