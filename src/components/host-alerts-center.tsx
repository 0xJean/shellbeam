import { monitoringAlertTitle } from '@/lib/monitoring-presentation'
import { NativeSelect } from '@/components/ui/select'
import { useState } from 'react'
import type { HostIncident } from '@/lib/host-incidents'
export type { HostIncident } from '@/lib/host-incidents'
import { hostPresentationCopy } from '@/lib/locales/host-presentation'
import { hostOverlaysCopy } from '@/lib/locales/host-overlays-v3'
import { fill } from '@/lib/locales/probe-install'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { loadEvidenceCopy } from '@/lib/monitoring-load-evidence'
import { Archive, BellOff, ChevronRight, CircleCheck, Flame, Hand, Info, LayoutDashboard, TriangleAlert } from 'lucide-react'

const selectClass = 'h-8 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs text-[var(--workspace-text)]'
const toneText = { bad: 'text-[var(--workspace-status-bad-text)]', warn: 'text-[var(--workspace-status-warn-text)]', good: 'text-[var(--workspace-status-good-text)]', idle: 'text-[var(--workspace-text-muted)]' }
const toneDot = { bad: 'bg-[var(--workspace-status-bad)]', warn: 'bg-[var(--workspace-status-warn)]', good: 'bg-[var(--workspace-status-good)]', idle: 'bg-[var(--workspace-text-subtle)]' }

function statusTone(status: string) {
  return status === 'active' ? 'bad' : status === 'acknowledged' ? 'warn' : status === 'resolved' ? 'good' : 'idle'
}

export function HostAlertsCenter({ incidents, onOpenHost }: { incidents: HostIncident[]; onOpenHost?: (hostId: string) => void }) {
  const { t, locale } = useT()
  const copy = hostPresentationCopy[locale]
  const v3 = hostOverlaysCopy[locale]
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
  const isOpen = (row: HostIncident) => !row.historyOnly && (row.status === 'active' || row.status === 'acknowledged')
  const openCount = incidents.filter(isOpen).length
  const rows = incidents.filter(row => (!currentHostId || row.hostId === currentHostId) && (!currentSource || row.source === currentSource) && (includeHistory || isOpen(row)))
  async function act(row: HostIncident, action: 'acknowledge' | 'close') {
    if (pending || row.busy || !row.act || (action === 'acknowledge' ? row.status !== 'active' : !['active', 'acknowledged', 'resolved'].includes(row.status))) return
    setPending(row.key); setError(false)
    try { await row.act(action) } catch { setError(true) } finally { setPending(null) }
  }
  return <section data-testid="host-alerts-center" className="space-y-3 text-[var(--workspace-text)]">
    <div className="pr-10">
      <h2 id="host-alerts-title" className="text-lg font-semibold text-[var(--workspace-text-strong)]">{fill(v3.alertsTitle, { count: openCount })}</h2>
      <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{v3.alertsSub}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <NativeSelect aria-label={copy.host} className={cn(selectClass, 'min-w-36')} value={hostId} onChange={event => setHostId(event.target.value)}>
        <option value="">{v3.allHosts}</option>{hosts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </NativeSelect>
      {sources.length > 1 && <NativeSelect aria-label={copy.source} className={cn(selectClass, 'min-w-32')} value={source} onChange={event => setSource(event.target.value)}>
        <option value="">{v3.allSources}</option>{sources.map(value => <option key={value} value={value}>{sourceLabel(value)}</option>)}
      </NativeSelect>}
      <label className="ml-auto flex items-center gap-2 text-[var(--workspace-text)]"><input type="checkbox" className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />{copy.history}</label>
    </div>
    <p className="flex items-start gap-2 rounded-lg bg-[var(--workspace-accent-subtle)] px-3 py-2.5 text-xs leading-5 text-[var(--workspace-text)]"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />{v3.alertsExplain}</p>
    {error && <p role="alert" className="text-sm text-[var(--workspace-status-bad-text)]">{t('localOps.actionFailed')}</p>}
    {rows.length === 0 && <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <BellOff className="mb-1 h-6 w-6 text-[var(--workspace-text-subtle)]" />
      <p className="text-sm font-medium text-[var(--workspace-text-strong)]">{copy.noAlerts}</p>
      <p className="text-xs text-[var(--workspace-text-muted)]">{v3.alertsEmptyHint}</p>
    </div>}
    <div className="max-h-[65vh] space-y-2.5 overflow-y-auto">
      {rows.map(row => {
        const tone = statusTone(row.status)
        const Icon = tone === 'bad' ? Flame : tone === 'warn' ? TriangleAlert : CircleCheck
        const observationTone = row.lastObservation === 'abnormal' ? 'bad' : row.lastObservation === 'recovered' ? 'good' : 'idle'
        return <article key={row.key} data-testid="host-incident" data-host-id={row.hostId} data-source={row.source} className="sb-card rounded-xl bg-[var(--workspace-surface-900)] p-3.5">
          <div className="flex items-start gap-3">
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--workspace-border-soft)]', toneText[tone], tone === 'bad' ? 'bg-[var(--workspace-status-bad-bg)]' : tone === 'warn' ? 'bg-[var(--workspace-status-warn-bg)]' : 'bg-[var(--workspace-surface-800)]')}><Icon className="h-3.5 w-3.5" /></span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-[var(--workspace-text-strong)]">{row.source === 'komari' && row.monitoringKind ? monitoringAlertTitle({ kind: row.monitoringKind, title: row.title }, locale) : row.title}</p>
              {row.loadEvidence && <p data-testid="load-alert-evidence" className="mt-0.5 break-words text-xs text-[var(--workspace-text-muted)]">{loadEvidenceCopy(row.loadEvidence, locale)}
                {row.loadEvidence.sampledAt > 0 && row.loadEvidence.sampledAt <= Date.now() ? ` · ${locale === 'zh-CN' ? '采样' : 'Sample'} ${new Date(row.loadEvidence.sampledAt).toLocaleString(locale)}` : ''}
              </p>}
              {row.evidenceUnavailable && <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{locale === 'zh-CN' ? '历史规则统计缺少事件证据，未计入当前异常。' : 'Historical rule count without event evidence; excluded from current incidents.'}</p>}
              {row.historyOnly && <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{copy.historicalSource}</p>}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-10 text-xs text-[var(--workspace-text-muted)]">
            <span>{row.hostName}</span><span aria-hidden>·</span><span>{sourceLabel(row.source)}</span><span aria-hidden>·</span>
            <span className={cn('inline-flex items-center gap-1.5', toneText[tone])}><span className={cn('h-1.5 w-1.5 rounded-full', toneDot[tone])} />{row.status === 'closed' ? (locale === 'zh-CN' ? '已归档' : 'Archived') : t(`localOps.status.${row.status}`)}</span>
            {Number.isFinite(row.updatedAt) && row.updatedAt > 0 && row.updatedAt <= Date.now() && <><span aria-hidden>·</span><time>{new Date(row.updatedAt).toLocaleString(locale)}</time></>}
            {row.lastObservation && <span className={cn('ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium', toneText[observationTone], observationTone === 'bad' ? 'bg-[var(--workspace-status-bad-bg)]' : observationTone === 'good' ? 'bg-[var(--workspace-status-good-bg)]' : 'bg-[var(--workspace-surface-800)]')}>{locale === 'zh-CN' ? '最近观测：' : 'Last observation: '}{({ abnormal: locale === 'zh-CN' ? '异常' : 'Abnormal', recovered: locale === 'zh-CN' ? '已恢复' : 'Recovered', unknown: locale === 'zh-CN' ? '未知' : 'Unknown' })[row.lastObservation]}</span>}
          </div>
          {(onOpenHost && row.hostId) || (row.act && ['active', 'acknowledged', 'resolved'].includes(row.status)) ? <div className="mt-2.5 flex flex-wrap gap-2 pl-10">
            {onOpenHost && row.hostId && <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onOpenHost(row.hostId)}><LayoutDashboard className="h-3.5 w-3.5" />{copy.overview}</Button>}
            {row.act && !row.evidenceUnavailable && row.status === 'active' && <Button size="sm" variant="ghost" className="h-7 gap-1.5 bg-[var(--workspace-accent-subtle)] px-2 text-xs text-[var(--workspace-accent-text)]" disabled={!!pending || row.busy} onClick={() => void act(row, 'acknowledge')}><Hand className="h-3.5 w-3.5" />{t('localOps.acknowledge')}</Button>}
            {row.act && ['active', 'acknowledged', 'resolved'].includes(row.status) && <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" disabled={!!pending || row.busy} onClick={() => void act(row, 'close')}><Archive className="h-3.5 w-3.5" />{locale === 'zh-CN' ? '归档' : 'Archive'}</Button>}
          </div> : null}
          {!!row.audit?.length && <details className="group mt-2.5 pl-10 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]"><ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />{t('komariAlerts.auditTitle', { count: row.audit.length })}</summary>
            <div className="mt-1.5 max-h-48 space-y-1 overflow-y-auto pl-4">
              {[...row.audit].sort((a, b) => b.at - a.at).map(entry => <div key={entry.auditId} className="flex flex-wrap gap-x-2.5 gap-y-1 break-all text-[var(--workspace-text-muted)]">
                <time className="font-mono">{new Date(entry.at).toLocaleString(locale)}</time>
                <span className="text-[var(--workspace-text)]">{t(`komariAlerts.event.${entry.event}`)}</span><span>{entry.actor}</span>
                {entry.operationJobId && <span className="font-mono text-[var(--workspace-text-subtle)]">#{entry.operationJobId}</span>}
              </div>)}
            </div>
          </details>}
        </article>
      })}
    </div>
  </section>
}
