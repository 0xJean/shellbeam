import { NativeSelect } from '@/components/ui/select'
import { useState } from 'react'
import type { HostIncident } from '@/lib/host-incidents'
export type { HostIncident } from '@/lib/host-incidents'
import { hostPresentationCopy } from '@/lib/locales/host-presentation'
import { useT } from '@/lib/i18n'
import { Button } from './ui/button'
import { loadEvidenceCopy } from '@/lib/monitoring-load-evidence'

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
  const sourceLabel = (value: string) => value === 'komari' ? (locale === 'zh-CN' ? '监控服务' : 'Monitoring service') : value === 'ssh-agentless' ? 'SSH' : value === 'local' ? copy.local : value
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
      <label>{copy.host} <NativeSelect aria-label={copy.host} className="rounded border bg-background p-1.5" value={hostId} onChange={event => setHostId(event.target.value)}>
        <option value="">{copy.all}</option>{hosts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </NativeSelect></label>
      {sources.length > 1 && <label>{copy.source} <NativeSelect aria-label={copy.source} className="rounded border bg-background p-1.5" value={source} onChange={event => setSource(event.target.value)}>
        <option value="">{copy.all}</option>{sources.map(value => <option key={value} value={value}>{sourceLabel(value)}</option>)}
      </NativeSelect></label>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />{copy.history}</label>
    </div>
    <p className="text-xs text-muted-foreground">{locale === 'zh-CN' ? '确认表示已接手，归档保留处理记录；两者均不代表故障恢复或停止通知。' : 'Acknowledgement records ownership; archiving retains the record. Neither proves recovery nor silences notifications.'}</p>
    {error && <p role="alert" className="text-sm text-red-500">{t('localOps.actionFailed')}</p>}
    {rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{copy.noAlerts}</p>}
    <div className="max-h-[65vh] space-y-3 overflow-y-auto">
      {rows.map(row => <article key={row.key} data-testid="host-incident" data-host-id={row.hostId} data-source={row.source} className="rounded-lg border p-3">
        <p className="break-words text-sm font-medium">{row.title}</p>
        {row.loadEvidence && <p data-testid="load-alert-evidence" className="mt-1 break-words text-xs text-muted-foreground">{loadEvidenceCopy(row.loadEvidence, locale)}
          {row.loadEvidence.sampledAt > 0 && row.loadEvidence.sampledAt <= Date.now() ? ` · ${locale === 'zh-CN' ? '采样' : 'Sample'} ${new Date(row.loadEvidence.sampledAt).toLocaleString(locale)}` : ''}
        </p>}
        {row.evidenceUnavailable && <p className="mt-1 text-xs text-muted-foreground">{locale === 'zh-CN' ? '历史规则统计缺少事件证据，未计入当前异常。' : 'Historical rule count without event evidence; excluded from current incidents.'}</p>}
        {row.historyOnly && <p className="mt-1 text-xs text-muted-foreground">{copy.historicalSource}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{row.hostName} · {sourceLabel(row.source)} · {row.status === 'closed' ? (locale === 'zh-CN' ? '已归档' : 'Archived') : t(`localOps.status.${row.status}`)}
          {Number.isFinite(row.updatedAt) && row.updatedAt > 0 && row.updatedAt <= Date.now() ? ` · ${new Date(row.updatedAt).toLocaleString(locale)}` : ''}
        </p>
        {row.lastObservation && <p className="mt-1 text-xs text-muted-foreground">{locale === 'zh-CN' ? '最近观测：' : 'Last observation: '}{({ abnormal: locale === 'zh-CN' ? '异常' : 'Abnormal', recovered: locale === 'zh-CN' ? '已恢复' : 'Recovered', unknown: locale === 'zh-CN' ? '未知' : 'Unknown' })[row.lastObservation]}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {onOpenHost && row.hostId && <Button size="sm" variant="outline" onClick={() => onOpenHost(row.hostId)}>{copy.overview}</Button>}
          {row.act && !row.evidenceUnavailable && row.status === 'active' && <Button size="sm" variant="outline" disabled={!!pending || row.busy} onClick={() => void act(row, 'acknowledge')}>{t('localOps.acknowledge')}</Button>}
          {row.act && ['active', 'acknowledged', 'resolved'].includes(row.status) && <Button size="sm" variant="outline" disabled={!!pending || row.busy} onClick={() => void act(row, 'close')}>{locale === 'zh-CN' ? '归档' : 'Archive'}</Button>}
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
