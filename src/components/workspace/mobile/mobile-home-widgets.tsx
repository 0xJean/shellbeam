import type { ReactNode } from 'react'
import { Box, CalendarClock, ChartSpline, Globe, LockKeyhole, RadioTower } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceMobileV3Copy, type WorkspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import { formatBytesRate } from '@/lib/metric-series'
import { monitoringProviderLabel } from '@/lib/monitoring-presentation'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { WIDGET_APP, type MobileWidgetId } from './mobile-home-prefs'
import { compactRate, daysLeft, formatClock, formatUptime, healthDotClass, relativeTime } from './mobile-format'
import { isExitedContainer, isRunningContainer, type MobileHomeData } from './use-mobile-home-data'

const METRIC_COLORS = { cpu: 'var(--workspace-primary-400)', memory: 'var(--workspace-metric-memory-to)', disk: 'var(--workspace-metric-disk-to)', network: 'var(--workspace-metric-network-to)' } as const
const TX_COLOR = 'var(--workspace-status-bad)'

function WidgetFrame({ id, title, sub, icon, onOpen, children, className, preview }: { id: MobileWidgetId; title: ReactNode; sub?: ReactNode; icon: ReactNode; onOpen?: () => void; children: ReactNode; className?: string; preview?: boolean }) {
  const body = <>
    <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {title}
      {sub && <span className="truncate text-[11.5px] text-[var(--workspace-text-muted)]">{sub}</span>}
      <span aria-hidden="true" className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)] [&_svg]:h-3 [&_svg]:w-3">{icon}</span>
    </div>
    {children}
  </>
  const classes = cn('flex h-full min-h-0 w-full min-w-0 flex-col gap-1 overflow-hidden rounded-[22px] border border-[color:var(--workspace-mobile-stroke)] bg-[var(--workspace-mobile-card)] px-3.5 py-3 text-left text-[var(--workspace-text-strong)] shadow-[var(--workspace-shadow-card)] backdrop-blur-2xl', className)
  if (preview || !onOpen) return <div data-testid={`mobile-widget-${id}`} className={classes}>{body}</div>
  return <button type="button" data-testid={`mobile-widget-${id}`} onClick={onOpen} className={cn(classes, 'transition-transform active:scale-[0.98]')}>{body}</button>
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return <div data-empty="true" className="flex flex-1 flex-col justify-center text-[12px]">
    <span className="text-[var(--workspace-text-muted)]">{title}</span>
    {hint && <span className="mt-0.5 text-[11px] text-[var(--workspace-text-subtle)]">{hint}</span>}
  </div>
}

function Ring({ label, percent, text, color }: { label: string; percent: number | null; text: string; color: string }) {
  const radius = 23
  const length = 2 * Math.PI * radius
  const fraction = percent == null ? 0 : Math.min(1, Math.max(0, percent / 100))
  return <div className="flex min-w-0 flex-col items-center gap-0.5">
    <div className="relative h-[58px] w-[58px]">
      <svg viewBox="0 0 58 58" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="29" cy="29" r={radius} fill="none" stroke="var(--workspace-border-soft)" strokeWidth="7" />
        {fraction > 0 && <circle cx="29" cy="29" r={radius} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${fraction * length} ${length}`} />}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[12.5px] font-semibold">{text}</span>
    </div>
    <span className="text-[11px] text-[var(--workspace-text-muted)]">{label}</span>
  </div>
}

/** Scales with its box: several series share one max. */
function MiniTrend({ series, className }: { series: Array<{ values: Array<number | null>; color: string; area?: boolean }>; className?: string }) {
  const all = series.flatMap((entry) => entry.values.filter((value): value is number => value != null))
  if (all.length < 2) return null
  const top = Math.max(...all) || 1
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className={cn('w-full', className)} aria-hidden="true">
    {series.map((entry, index) => {
      const step = 100 / Math.max(1, entry.values.length - 1)
      const points = entry.values.map((value, i) => value == null ? null : `${(i * step).toFixed(2)},${(38 - value / top * 34).toFixed(2)}`).filter(Boolean) as string[]
      if (points.length < 2) return null
      const first = points[0].split(',')[0]
      const last = points[points.length - 1].split(',')[0]
      return <g key={index}>
        {entry.area && <path d={`M${points.join(' L')} L${last},40 L${first},40 Z`} fill={entry.color} opacity={0.22} />}
        <path d={`M${points.join(' L')}`} fill="none" stroke={entry.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </g>
    })}
  </svg>
}

function HalfGauge({ fraction, color, children }: { fraction: number; color: string; children: ReactNode }) {
  const length = Math.PI * 46
  return <div className="relative mx-auto h-[70px] w-[120px]">
    <svg viewBox="0 0 120 64" className="h-[64px] w-[120px]" aria-hidden="true">
      <path d="M14,58 A46,46 0 0 1 106,58" fill="none" stroke="var(--workspace-border-soft)" strokeWidth="10" strokeLinecap="round" />
      {fraction > 0 && <path d="M14,58 A46,46 0 0 1 106,58" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${Math.min(1, fraction) * length} ${length}`} />}
    </svg>
    <div className="absolute inset-x-0 bottom-0 text-center">{children}</div>
  </div>
}

interface WidgetProps { data: MobileHomeData; copy: WorkspaceMobileV3Copy; locale: string; onOpen?: () => void; preview?: boolean }

function HostWidget({ data, copy, locale, onOpen, preview }: WidgetProps) {
  const { metrics, provider, host } = data
  const uptime = formatUptime(metrics?.uptimeSeconds, locale)
  const sampledAt = provider.source?.sampledAt ?? metrics?.sampledAt ?? null
  const ago = relativeTime(data.now, sampledAt, copy)
  const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? null : value
  const label = (value: number | null) => value == null ? '—' : `${Math.round(value)}%`
  return <WidgetFrame id="host" preview={preview} onOpen={onOpen} icon={<RadioTower />}
    title={<><span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', healthDotClass(provider.view?.health.state))} /><b className="truncate font-semibold">{host?.name ?? copy.hostStatus}</b></>}
    sub={uptime ? fill(copy.uptime, { value: uptime }) : undefined}>
    {metrics ? <>
      <div className="mt-1 grid grid-cols-4 gap-1">
        <Ring label={copy.cpu} percent={percent(metrics.cpuPercent)} text={label(percent(metrics.cpuPercent))} color={METRIC_COLORS.cpu} />
        <Ring label={copy.memory} percent={percent(metrics.memoryPercent)} text={label(percent(metrics.memoryPercent))} color={METRIC_COLORS.memory} />
        <Ring label={copy.disk} percent={percent(metrics.diskPercent)} text={label(percent(metrics.diskPercent))} color={METRIC_COLORS.disk} />
        <Ring label={copy.net} percent={null} text={compactRate(metrics.networkRxBytesPerSec) ?? '—'} color={METRIC_COLORS.network} />
      </div>
      {provider.source && ago && <div className="mt-auto truncate text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.sampled, { source: monitoringProviderLabel(provider.source.kind, locale as 'en' | 'zh-CN'), time: ago })}</div>}
    </> : <Empty title={copy.noMetrics} hint={copy.noMetricsHint} />}
  </WidgetFrame>
}

function CpuWidget({ data, copy, onOpen, preview }: WidgetProps) {
  const values = data.history.map((point) => point.metrics.cpuPercent ?? null)
  const real = values.filter((value): value is number => value != null)
  const current = data.metrics?.cpuPercent ?? real[real.length - 1] ?? null
  const peakValue = real.length ? Math.max(...real) : null
  return <WidgetFrame id="cpu" preview={preview} onOpen={onOpen} icon={<ChartSpline />} title={<b className="font-semibold">{copy.cpu}</b>}>
    {current == null && real.length < 2 ? <Empty title={copy.noHistory} /> : <>
      {current != null && <div className="text-[34px] font-bold leading-[1.05] tracking-tight">{Math.round(current)}<small className="text-base font-semibold opacity-60">%</small></div>}
      <span className="text-[11px] text-[var(--workspace-text-muted)]">{peakValue != null ? fill(copy.peak, { value: Math.round(peakValue) }) : copy.hours24}</span>
      <MiniTrend className="mt-auto h-[46px]" series={[{ values, color: METRIC_COLORS.cpu, area: true }]} />
    </>}
  </WidgetFrame>
}

function CertificatesWidget({ data, copy, onOpen, preview }: WidgetProps) {
  const rows = data.certificates.filter((row) => row.notAfter != null).sort((a, b) => (a.notAfter ?? 0) - (b.notAfter ?? 0))
  const nearest = rows[0]
  const left = nearest ? daysLeft(nearest.notAfter, data.now) : null
  const color = left == null ? 'var(--workspace-text-subtle)' : left > 30 ? 'var(--workspace-status-good)' : left > 7 ? 'var(--workspace-status-warn)' : 'var(--workspace-status-bad)'
  return <WidgetFrame id="certs" preview={preview} onOpen={onOpen} icon={<LockKeyhole />} title={<b className="font-semibold">{copy.certificates}</b>}>
    {!nearest || left == null ? <Empty title={copy.noCerts} hint={copy.noCertsHint} /> : <>
      <HalfGauge fraction={Math.max(0, left) / 90} color={color}>
        <div className="text-[22px] font-bold leading-none">{left < 0 ? copy.certExpired : <>{left}<small className="text-[11px] font-semibold opacity-60">{copy.days}</small></>}</div>
        <div className="truncate px-1 text-[10.5px] text-[var(--workspace-text-muted)]">{nearest.domains[0] ?? nearest.path}</div>
      </HalfGauge>
      <span className="mt-auto text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.certCount, { count: data.certificates.length })}</span>
    </>}
  </WidgetFrame>
}

function DockerWidget({ data, copy, onOpen, preview }: WidgetProps) {
  const containers = data.inventory?.containers ?? []
  return <WidgetFrame id="docker" preview={preview} onOpen={onOpen} icon={<Box />} title={<b className="font-semibold">{copy.docker}</b>}
    sub={containers.length ? [fill(copy.containers, { count: containers.length }), data.exitedContainers ? fill(copy.exited, { count: data.exitedContainers }) : ''].filter(Boolean).join(' · ') : undefined}>
    {!data.inventory ? <Empty title={copy.notScanned} hint={copy.notScannedHint} /> : !containers.length ? <Empty title={copy.noContainers} /> : <ul className="mt-1 space-y-1">
      {containers.slice(0, 4).map((container) => <li key={container.name} className="flex min-w-0 items-center gap-2 text-[12px]">
        <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', isRunningContainer(container.status) ? 'bg-[var(--workspace-status-good)]' : isExitedContainer(container.status) ? 'bg-[var(--workspace-status-warn)]' : 'bg-[var(--workspace-status-bad)]')} />
        <b className="truncate font-semibold">{container.name}</b>
        <span className="ml-auto shrink-0 truncate text-[11px] text-[var(--workspace-text-muted)]">{container.status}</span>
      </li>)}
    </ul>}
  </WidgetFrame>
}

function NetworkWidget({ data, copy, onOpen, preview }: WidgetProps) {
  const rx = data.history.map((point) => point.metrics.networkRxBytesPerSec ?? null)
  const tx = data.history.map((point) => point.metrics.networkTxBytesPerSec ?? null)
  const hasHistory = rx.filter((value) => value != null).length > 1 || tx.filter((value) => value != null).length > 1
  const latestRx = data.metrics?.networkRxBytesPerSec ?? null
  const latestTx = data.metrics?.networkTxBytesPerSec ?? null
  return <WidgetFrame id="network" preview={preview} onOpen={onOpen} icon={<Globe />} title={<b className="font-semibold">{copy.network}</b>} sub={copy.hours24}>
    {!hasHistory && latestRx == null && latestTx == null ? <Empty title={copy.noNetwork} /> : <>
      <MiniTrend className="h-[64px] flex-1" series={[{ values: rx, color: METRIC_COLORS.network, area: true }, { values: tx, color: TX_COLOR }]} />
      <div className="mt-auto flex gap-3 text-[11px] text-[var(--workspace-text-muted)]">
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: METRIC_COLORS.network }} />{copy.inbound} {formatBytesRate(latestRx)}</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: TX_COLOR }} />{copy.outbound} {formatBytesRate(latestTx)}</span>
      </div>
    </>}
  </WidgetFrame>
}

function TasksWidget({ data, copy, locale, onOpen, preview }: WidgetProps) {
  const enabled = data.tasks.filter((task) => task.enabled)
  const next = enabled.filter((task) => task.nextRunAt != null).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  const unknown = data.tasks.filter((task) => task.lastStatus === 'unknown' && task.lastRunAt != null).length
  const failed = data.tasks.filter((task) => task.lastStatus === 'failed').length
  return <WidgetFrame id="tasks" preview={preview} onOpen={onOpen} icon={<CalendarClock />} title={<b className="font-semibold">{copy.scheduledTasks}</b>}>
    {!data.tasks.length ? <Empty title={copy.noTasks} /> : <>
      {next?.nextRunAt != null ? <>
        <div className="text-[26px] font-bold leading-[1.05] tracking-tight">{formatClock(next.nextRunAt, locale)}</div>
        <span className="truncate text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.nextRun, { name: next.name })}</span>
      </> : <span className="text-[12px] text-[var(--workspace-text-muted)]">{copy.paused}</span>}
      <div className="mt-auto space-y-0.5 text-[11.5px]">
        <div className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--workspace-status-good)]" />{fill(copy.enabled, { count: enabled.length })}</div>
        {failed > 0 && <div className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--workspace-status-bad)]" />{fill(copy.failedResult, { count: failed })}</div>}
        {unknown > 0 && <div className="flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--workspace-status-warn)]" />{fill(copy.unknownResult, { count: unknown })}</div>}
      </div>
    </>}
  </WidgetFrame>
}

const WIDGETS: Record<MobileWidgetId, (props: WidgetProps) => ReactNode> = { host: HostWidget, cpu: CpuWidget, certs: CertificatesWidget, docker: DockerWidget, network: NetworkWidget, tasks: TasksWidget }

export function MobileHomeWidget({ id, data, onOpenApp, preview }: { id: MobileWidgetId; data: MobileHomeData; onOpenApp?: (app: WorkspaceAppId) => void; preview?: boolean }) {
  const { locale } = useT()
  const Widget = WIDGETS[id]
  return <Widget data={data} copy={workspaceMobileV3Copy[locale]} locale={locale} preview={preview} onOpen={onOpenApp ? () => onOpenApp(WIDGET_APP[id]) : undefined} />
}
