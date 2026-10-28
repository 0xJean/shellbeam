import { monitoringHistorySourceLabel } from '@/lib/monitoring-presentation'
import { NativeSelect } from '@/components/ui/select'
import { useEffect, useMemo, useState } from 'react'
import { SegmentedTabs } from '@/components/charts/chart-primitives'
import { cn } from '@/lib/utils'
import { RotateCw } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import { metricHistoryPaths, listProviderMetricHistory, type ProviderMetricHistoryPoint } from '@/lib/provider-history'

const RANGES = [1, 6, 24, 168]
const METRICS = [{ key: 'cpuPercent', color: '#38bdf8' }, { key: 'memoryPercent', color: '#a78bfa' }, { key: 'diskPercent', color: '#fb923c' }] as const
const sourceKey = (point: ProviderMetricHistoryPoint) => `${point.providerKind}:${point.providerId}:${point.nodeId}`
interface ProviderHistoryPanelProps { vaultId: string; hostId: string; providerId?: string }

/** Only the explicit history view subscribes and reads persisted samples. A
 * host/Vault change remounts the disclosure, including an A → B → A return. */
export function ProviderHistoryDisclosure(props: ProviderHistoryPanelProps) {
  return <ScopedProviderHistoryDisclosure key={JSON.stringify([props.vaultId, props.hostId, props.providerId])} {...props} />
}

function ScopedProviderHistoryDisclosure(props: ProviderHistoryPanelProps) {
  const { locale } = useT()
  const [expanded, setExpanded] = useState(false)
  return <div data-testid="provider-history-disclosure">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="rounded border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">{workspaceOverviewCopy[locale].history}</button>
    {expanded && <div className="mt-3"><ProviderHistoryPanel {...props} /></div>}
  </div>
}

export function ProviderHistoryPanel({ vaultId, hostId, providerId, className }: { vaultId: string; hostId: string; providerId?: string; className?: string }) {
  const { t, locale } = useT()
  const [hours, setHours] = useState(24)
  const [revision, setRevision] = useState(0)
  const [source, setSource] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; points: ProviderMetricHistoryPoint[]; error: boolean; from: number; to: number } | null>(null)
  const queryKey = `${vaultId}:${hostId}:${providerId ?? ''}:${hours}:${revision}`
  useEffect(() => {
    let active = true
    const to = Date.now(); const from = to - hours * 3600_000
    void listProviderMetricHistory({ vaultId, hostId, providerId, from, to, limit: 2000 }).then((points) => {
      if (active) setLoaded({ key: queryKey, points, error: false, from, to })
    }).catch(() => { if (active) setLoaded({ key: queryKey, points: [], error: true, from, to }) })
    return () => { active = false }
  }, [vaultId, hostId, providerId, hours, queryKey])
  useEffect(() => {
    const onChange = (event: Event) => { if ((event as CustomEvent<{ vaultId?: string }>).detail?.vaultId === vaultId) setRevision((current) => current + 1) }
    window.addEventListener('provider-metric-history-changed', onChange)
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') setRevision((current) => current + 1) }, 60_000)
    return () => { window.removeEventListener('provider-metric-history-changed', onChange); window.clearInterval(timer) }
  }, [vaultId])
  const current = loaded?.key === queryKey ? loaded : null
  const sources = useMemo(() => [...new Set((current?.points ?? []).map(sourceKey))], [current])
  const selectedSource = sources.includes(source) ? source : sources[0] ?? ''
  const points = (current?.points ?? []).filter((point) => sourceKey(point) === selectedSource)
  const inspected = points[Math.min(cursor, points.length - 1)]
  const latest = points[points.length - 1]
  const from = current?.from ?? 0; const to = current?.to ?? 0
  const metricLabel = (key: (typeof METRICS)[number]['key']) => t(`provider.history.${key}`)
  return (
    <section data-testid="provider-history-panel" className={cn('sb-card flex min-w-0 flex-col', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2">
        <h3 title={t('provider.history.description')} className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{workspaceOverviewCopy[locale].history}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {sources.length > 0 && <NativeSelect aria-label={t('provider.history.source')} value={selectedSource} onChange={(event) => { setSource(event.target.value); setCursor(0) }} className="h-7 max-w-56 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 text-xs">{sources.map((value) => <option key={value} value={value}>{monitoringHistorySourceLabel(value, locale)}</option>)}</NativeSelect>}
          <SegmentedTabs label={t('provider.history.title')} value={String(hours)} onChange={(value) => { setHours(Number(value)); setCursor(0) }} options={RANGES.map((value) => ({ value: String(value), label: value === 168 ? '7d' : `${value}h` }))} />
          <button type="button" title={t('provider.history.refresh')} aria-label={t('provider.history.refresh')} onClick={() => setRevision((value) => value + 1)} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]"><RotateCw className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
        {!current ? <p role="status" className="text-xs text-[var(--workspace-text-muted)]">{t('provider.history.loading')}</p> : current.error ? <p role="alert" className="text-xs text-destructive">{t('provider.history.failed')}</p> : points.length === 0 ? <p className="text-xs text-[var(--workspace-text-muted)]">{t('provider.history.empty')}</p> : <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--workspace-text-muted)]">
            {METRICS.map((metric) => <span key={metric.key} className="inline-flex items-center gap-1.5"><i className="h-0.5 w-2.5 rounded-full" style={{ background: metric.color }} />{metricLabel(metric.key)}</span>)}
            <span className="flex-1" />
            <span>{t('provider.history.latest')}: {latest ? new Date(latest.sampledAt).toLocaleString(locale) : '—'} · <span className={latest && latest.expiresAt < to ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[color:var(--workspace-status-good-text)]'}>{latest && latest.expiresAt < to ? t('provider.history.stale') : t('provider.history.fresh')}</span></span>
          </div>
          {points.some((point) => point.historyPartial) && <p role="status" className="text-xs text-[color:var(--workspace-status-warn-text)]">{t('provider.history.partial')}</p>}
          <div className="relative min-h-[150px] flex-1">
            <svg viewBox="0 0 800 160" preserveAspectRatio="none" role="img" aria-label={t('provider.history.chart')} className="absolute inset-0 h-full w-full">
              {[0, 50, 100].map((value) => <line key={value} x1="0" x2="800" y1={150 - value * 1.4} y2={150 - value * 1.4} stroke="var(--workspace-border-soft)" vectorEffect="non-scaling-stroke" />)}
              {METRICS.map((metric) => <path key={metric.key} d={metricHistoryPaths(points, metric.key, from, to).map((path) => path.includes(' L') ? path : `${path} l0,0`).join(' ')} fill="none" stroke={metric.color} strokeWidth="1.8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
              {inspected && to > from && <line x1={((inspected.sampledAt - from) / (to - from)) * 800} x2={((inspected.sampledAt - from) / (to - from)) * 800} y1="0" y2="160" stroke="var(--workspace-text-subtle)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
            </svg>
            {inspected && <div className="absolute right-2 top-2 flex flex-col gap-0.5 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--workspace-text)] shadow-sm">
              <span className="text-[var(--workspace-text-muted)]">{new Date(inspected.sampledAt).toLocaleString(locale)} · TTL {Math.max(0, inspected.expiresAt - inspected.sampledAt) / 1000}s · {inspected.confidence}</span>
              {METRICS.map((metric) => <span key={metric.key}>{metricLabel(metric.key)}: {inspected.metrics[metric.key] === null ? t('provider.history.unknown') : `${inspected.metrics[metric.key]?.toFixed(1)}%`}</span>)}
            </div>}
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-[var(--workspace-text-muted)]">
            <span>{new Date(from).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <input aria-label={t('provider.history.inspect')} type="range" min="0" max={Math.max(0, points.length - 1)} value={Math.min(cursor, points.length - 1)} onChange={(event) => setCursor(Number(event.target.value))} className="flex-1 accent-[var(--workspace-primary-500)]" />
            <span>{new Date(to).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p className="text-[11px] text-[var(--workspace-text-subtle)]">{t('provider.history.gaps')}</p>
        </>}
      </div>
    </section>
  )
}
