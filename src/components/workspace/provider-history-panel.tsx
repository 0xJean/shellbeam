import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import { metricHistoryPaths, listProviderMetricHistory, type ProviderMetricHistoryPoint } from '@/lib/provider-history'

const RANGES = [1, 6, 24, 168]
const METRICS = [{ key: 'cpuPercent', label: 'CPU', color: '#38bdf8' }, { key: 'memoryPercent', label: 'Memory', color: '#a78bfa' }, { key: 'diskPercent', label: 'Disk', color: '#fb923c' }] as const
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

export function ProviderHistoryPanel({ vaultId, hostId, providerId }: { vaultId: string; hostId: string; providerId?: string }) {
  const { t } = useT()
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
  return (
    <section data-testid="provider-history-panel" className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-semibold">{t('provider.history.title')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('provider.history.description')}</p></div>
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((value) => <Button key={value} type="button" size="sm" variant={hours === value ? 'default' : 'outline'} onClick={() => { setHours(value); setCursor(0) }}>{value === 168 ? '7d' : `${value}h`}</Button>)}
          <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>{t('provider.history.refresh')}</Button>
        </div>
      </div>
      {!current ? <p role="status" className="mt-4 text-xs text-muted-foreground">{t('provider.history.loading')}</p> : current.error ? <p role="alert" className="mt-4 text-xs text-destructive">{t('provider.history.failed')}</p> : points.length === 0 ? <p className="mt-4 text-xs text-muted-foreground">{t('provider.history.empty')}</p> : <>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <label>{t('provider.history.source')} <select aria-label={t('provider.history.source')} value={selectedSource} onChange={(event) => { setSource(event.target.value); setCursor(0) }} className="ml-1 max-w-80 rounded border border-border bg-background p-1">{sources.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <span>{t('provider.history.latest')}: {latest ? new Date(latest.sampledAt).toLocaleString() : '—'} · {latest && latest.expiresAt < to ? t('provider.history.stale') : t('provider.history.fresh')}</span>
        </div>
        {points.some((point) => point.historyPartial) && <p role="status" className="mt-2 text-xs text-amber-600">{t('provider.history.partial')}</p>}
        <svg viewBox="0 0 800 165" role="img" aria-label={t('provider.history.chart')} className="mt-3 w-full rounded border border-border/40 bg-muted/10">
          {[0, 50, 100].map((value) => <g key={value}><line x1="20" x2="780" y1={140 - value * 1.2} y2={140 - value * 1.2} stroke="currentColor" opacity="0.12" /><text x="2" y={143 - value * 1.2} fontSize="9" fill="currentColor" opacity="0.6">{value}</text></g>)}
          {METRICS.map((metric) => <path key={metric.key} d={metricHistoryPaths(points, metric.key, from, to).map((path) => path.includes(' L') ? path : `${path} l0,0`).join(' ')} fill="none" stroke={metric.color} strokeWidth="2" strokeLinecap="round" />)}
          <text x="20" y="160" fontSize="10" fill="currentColor" opacity="0.6">{new Date(from).toLocaleString()}</text><text x="780" y="160" textAnchor="end" fontSize="10" fill="currentColor" opacity="0.6">{new Date(to).toLocaleString()}</text>
        </svg>
        <label className="mt-3 block text-xs text-muted-foreground">{t('provider.history.inspect')}<input aria-label={t('provider.history.inspect')} type="range" min="0" max={Math.max(0, points.length - 1)} value={Math.min(cursor, points.length - 1)} onChange={(event) => setCursor(Number(event.target.value))} className="mt-1 w-full" /></label>
        {inspected && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span>{new Date(inspected.sampledAt).toLocaleString()}</span>{METRICS.map((metric) => <span key={metric.key} style={{ color: metric.color }}>{t(`provider.history.${metric.key}`)}: {inspected.metrics[metric.key] === null ? t('provider.history.unknown') : `${inspected.metrics[metric.key]?.toFixed(1)}%`}</span>)}<span className="text-muted-foreground">TTL {Math.max(0, inspected.expiresAt - inspected.sampledAt) / 1000}s · {inspected.confidence}</span></div>}
        <p className="mt-2 text-[11px] text-muted-foreground">{t('provider.history.gaps')}</p>
      </>}
    </section>
  )
}
