import { useState } from 'react'
import type { HostIncident } from '@/lib/host-incidents'
export type { HostIncident } from '@/lib/host-incidents'
import { hostPresentationCopy } from '@/lib/locales/host-presentation'
import { useT } from '@/lib/i18n'
import { Button } from './ui/button'

export function HostAlertsCenter({ incidents, onOpenHost }: { incidents: HostIncident[]; onOpenHost?: (hostId: string) => void }) {
  const { t, locale } = useT()
  const copy = hostPresentationCopy[locale]
  const [hostId, setHostId] = useState('')
  const [source, setSource] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const hosts = [...new Map(incidents.filter(row => row.hostId).map(row => [row.hostId, row.hostName])).entries()]
  const sources = [...new Set(incidents.map(row => row.source))]
  // A refresh can remove the selected host/source. Reset before rendering so
  // a hidden selector never leaves the remaining incidents filtered out.
  const currentHostId = hosts.some(([id]) => id === hostId) ? hostId : ''
  const currentSource = sources.includes(source) ? source : ''
  if (currentHostId !== hostId) setHostId(currentHostId)
  if (currentSource !== source) setSource(currentSource)
  const sourceLabel = (value: string) => value === 'komari' ? 'Komari' : value === 'ssh-agentless' ? 'SSH' : value === 'local' ? copy.local : value
  const rows = incidents.filter(row => (!currentHostId || row.hostId === currentHostId) && (!currentSource || row.source === currentSource)
    && (includeHistory || (!row.historyOnly && (row.status === 'active' || row.status === 'acknowledged'))))
  async function act(row: HostIncident, action: 'acknowledge' | 'close') {
    if (pending || row.busy || !row.act || (action === 'acknowledge' ? row.status !== 'active' : !['active', 'acknowledged', 'resolved'].includes(row.status))) return
    setPending(row.key); setError(false)
    try { await row.act(action) } catch { setError(true) } finally { setPending(null) }
  }
  return <section data-testid="host-alerts-center" className="space-y-4">
    <h2 id="host-alerts-title" className="text-lg font-semibold">{copy.alerts}</h2>
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>{copy.host} <select aria-label={copy.host} className="rounded border bg-background p-1.5" value={hostId} onChange={event => setHostId(event.target.value)}>
        <option value="">{copy.all}</option>{hosts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      {sources.length > 1 && <label>{copy.source} <select aria-label={copy.source} className="rounded border bg-background p-1.5" value={source} onChange={event => setSource(event.target.value)}>
        <option value="">{copy.all}</option>{sources.map(value => <option key={value} value={value}>{sourceLabel(value)}</option>)}
      </select></label>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />{copy.history}</label>
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{t('localOps.actionFailed')}</p>}
    {rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{copy.noAlerts}</p>}
    <div className="max-h-[65vh] space-y-3 overflow-y-auto">
      {rows.map(row => <article key={row.key} data-testid="host-incident" data-host-id={row.hostId} data-source={row.source} className="rounded-lg border p-3">
        <p className="break-words text-sm font-medium">{row.title}</p>
        {row.historyOnly && <p className="mt-1 text-xs text-muted-foreground">{copy.historicalSource}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{row.hostName} · {sourceLabel(row.source)} · {t(`localOps.status.${row.status}`)}
          {Number.isFinite(row.updatedAt) && row.updatedAt > 0 && row.updatedAt <= Date.now() ? ` · ${new Date(row.updatedAt).toLocaleString(locale)}` : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {onOpenHost && row.hostId && <Button size="sm" variant="outline" onClick={() => onOpenHost(row.hostId)}>{copy.overview}</Button>}
          {row.act && row.status === 'active' && <Button size="sm" variant="outline" disabled={!!pending || row.busy} onClick={() => void act(row, 'acknowledge')}>{t('localOps.acknowledge')}</Button>}
          {row.act && ['active', 'acknowledged', 'resolved'].includes(row.status) && <Button size="sm" variant="outline" disabled={!!pending || row.busy} onClick={() => void act(row, 'close')}>{t('localOps.close')}</Button>}
        </div>
        {!!row.audit?.length && <details className="mt-3 border-t pt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('komariAlerts.auditTitle', { count: row.audit.length })}</summary>
          <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
            {[...row.audit].sort((a, b) => b.at - a.at).map(entry => <div key={entry.auditId} className="flex flex-wrap gap-x-2 gap-y-1 break-all text-muted-foreground">
              <span>{t(`komariAlerts.event.${entry.event}`)}</span><span>{entry.actor}</span>
              <time>{new Date(entry.at).toLocaleString(locale)}</time>
              {entry.operationJobId && <span className="font-mono">#{entry.operationJobId}</span>}
            </div>)}
          </div>
        </details>}
      </article>)}
    </div>
  </section>
}
