import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Series colours that read on every palette; the first follows the accent. */
export const CHART_COLORS = ['var(--workspace-primary-400)', '#f5a524', '#ec6a9c', '#34c77b', '#38bdf8', '#a78bfa', '#fb7185'] as const
export const STATUS_COLORS = { good: 'var(--workspace-status-good)', warn: 'var(--workspace-status-warn)', bad: 'var(--workspace-status-bad)', idle: 'var(--workspace-text-subtle)' } as const

const AXIS = 'var(--workspace-text-subtle)'
const GRID = 'var(--workspace-border-soft)'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function niceMax(value: number) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10
  return step * magnitude
}

export interface ChartSeries {
  key: string
  label: string
  color: string
  /** Values aligned with `times`; null breaks the line. */
  values: Array<number | null>
  area?: boolean
  dashed?: boolean
}

export interface TimeSeriesChartProps {
  times: number[]
  series: ChartSeries[]
  height?: number
  /** Fixed maximum (e.g. 100 for percentages); otherwise a rounded data maximum. */
  max?: number
  threshold?: number
  stacked?: boolean
  formatValue?: (value: number) => string
  formatTime?: (time: number) => string
  emptyLabel?: string
  className?: string
}

/** Multi-series line / area chart with a hover crosshair and value tooltip. */
export function TimeSeriesChart({ times, series, height = 220, max, threshold, stacked = false, formatValue = (v) => v.toFixed(1), formatTime = defaultTime, emptyLabel, className }: TimeSeriesChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const count = times.length
  const hasData = series.some((item) => item.values.some((value) => value != null))
  const stackedValues = stacked
    ? series.map((_, sIndex) => times.map((_, index) => {
      if (series[sIndex].values[index] == null) return null
      return series.slice(0, sIndex + 1).reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
    }))
    : series.map((item) => item.values)
  const dataMax = Math.max(0, ...stackedValues.flat().filter((value): value is number => value != null), threshold ?? 0)
  const top = max ?? niceMax(dataMax * 1.1)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * top)
  // Room for the widest y label (about 6px per character at 10px mono).
  const pad = { left: Math.max(28, Math.max(...ticks.map((tick) => formatValue(tick).length)) * 6 + 10), right: 8, top: 8, bottom: 22 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const x = (index: number) => pad.left + (count <= 1 ? plotW / 2 : index / (count - 1) * plotW)
  const y = (value: number) => pad.top + plotH - Math.min(1, Math.max(0, value / top)) * plotH
  const segments = (values: Array<number | null>) => {
    const runs: Array<Array<[number, number]>> = []
    let run: Array<[number, number]> = []
    values.forEach((value, index) => {
      if (value == null) { if (run.length) runs.push(run); run = []; return }
      run.push([x(index), y(value)])
    })
    if (run.length) runs.push(run)
    return runs
  }
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / 80))))

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)} style={{ height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={series.map((item) => item.label).join(', ')}
        onMouseMove={(event) => {
          if (!count || !hasData) return
          const rect = event.currentTarget.getBoundingClientRect()
          const index = Math.round((event.clientX - rect.left - pad.left) / Math.max(1, plotW) * (count - 1))
          setHover(Math.min(count - 1, Math.max(0, index)))
        }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke={GRID} strokeDasharray={tick === 0 ? undefined : '2 4'} />
          <text x={pad.left - 6} y={y(tick) + 3} textAnchor="end" fontSize="10" fill={AXIS} className="font-mono">{formatValue(tick)}</text>
        </g>)}
        {times.map((time, index) => index % labelEvery === 0 && <text key={index} x={x(index)} y={height - 6} textAnchor="middle" fontSize="10" fill={AXIS} className="font-mono">{formatTime(time)}</text>)}
        {threshold != null && <line x1={pad.left} x2={width - pad.right} y1={y(threshold)} y2={y(threshold)} stroke={STATUS_COLORS.bad} strokeDasharray="5 4" opacity={0.8} />}
        {[...series].map((item, sIndex) => ({ item, values: stackedValues[sIndex], below: stacked && sIndex > 0 ? stackedValues[sIndex - 1] : null })).reverse().map(({ item, values, below }) => (
          <g key={item.key}>
            {(item.area || stacked) && segments(values).map((run, rIndex) => {
              const bottom = [...run].reverse().map(([px]) => {
                const index = count <= 1 ? 0 : Math.round((px - pad.left) / Math.max(1, plotW) * (count - 1))
                const lower = below?.[index]
                return `L${px.toFixed(1)},${(lower != null ? y(lower) : y(0)).toFixed(1)}`
              }).join(' ')
              return <path key={rIndex} d={`M${run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')} ${bottom} Z`} fill={item.color} opacity={stacked ? 0.55 : 0.14} />
            })}
            {segments(values).map((run, rIndex) => run.length === 1
              ? <circle key={rIndex} cx={run[0][0]} cy={run[0][1]} r={1.8} fill={item.color} />
              : <path key={rIndex} d={`M${run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}`} fill="none" stroke={item.color} strokeWidth={1.6} strokeDasharray={item.dashed ? '4 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />)}
          </g>
        ))}
        {hover != null && <g>
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke={AXIS} strokeDasharray="3 3" />
          {series.map((item, sIndex) => stackedValues[sIndex][hover] != null && <circle key={item.key} cx={x(hover)} cy={y(stackedValues[sIndex][hover]!)} r={3.2} fill="var(--workspace-surface-950)" stroke={item.color} strokeWidth={1.6} />)}
        </g>}
      </svg>}
      {!hasData && emptyLabel && <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--workspace-text-subtle)]">{emptyLabel}</div>}
      {hover != null && hasData && (
        <div role="tooltip" className="pointer-events-none absolute top-2 z-10 min-w-[9rem] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2.5 py-2 text-[11px] shadow-[var(--workspace-shadow-overlay)]"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}>
          <div className="mb-1 font-medium text-[var(--workspace-text-strong)]">{formatTime(times[hover])}</div>
          {series.map((item) => <div key={item.key} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="min-w-0 flex-1 truncate text-[var(--workspace-text-muted)]">{item.label}</span>
            <span className="font-mono text-[var(--workspace-text-strong)]">{item.values[hover] == null ? '—' : formatValue(item.values[hover]!)}</span>
          </div>)}
        </div>
      )}
    </div>
  )
}

function defaultTime(time: number) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ChartLegend({ items, className }: { items: Array<{ label: ReactNode; color: string; value?: ReactNode }>; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--workspace-text-muted)]', className)}>
    {items.map((item, index) => <span key={index} className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: item.color }} />{item.label}
      {item.value != null && <b className="font-mono font-medium text-[var(--workspace-text-strong)]">{item.value}</b>}
    </span>)}
  </div>
}

/** Stacked vertical bars, one group per label. */
export function StackedBarChart({ labels, keys, rows, height = 200, highlightLast = false }: {
  labels: string[]; keys: Array<{ key: string; label: string; color: string }>; rows: Array<Record<string, number>>; height?: number; highlightLast?: boolean
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const pad = { left: 28, right: 4, top: 8, bottom: 22 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const totals = rows.map((row) => keys.reduce((sum, key) => sum + (row[key.key] ?? 0), 0))
  const top = niceMax(Math.max(1, ...totals))
  const slot = plotW / Math.max(1, rows.length)
  const barW = Math.min(56, slot * 0.6)
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={keys.map((key) => key.label).join(', ')}>
        {[0, 0.5, 1].map((fraction) => <g key={fraction}>
          <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH * (1 - fraction)} y2={pad.top + plotH * (1 - fraction)} stroke={GRID} strokeDasharray={fraction ? '2 4' : undefined} />
          {Number.isInteger(top * fraction) && <text x={pad.left - 6} y={pad.top + plotH * (1 - fraction) + 3} textAnchor="end" fontSize="10" fill={AXIS} className="font-mono">{top * fraction}</text>}
        </g>)}
        {rows.map((row, index) => {
          let offset = 0
          const cx = pad.left + slot * index + slot / 2
          return <g key={index}>
            {keys.map((key) => {
              const value = row[key.key] ?? 0
              if (!value) return null
              const h = value / top * plotH
              offset += h
              return <rect key={key.key} x={cx - barW / 2} y={pad.top + plotH - offset} width={barW} height={Math.max(0, h - 1)} rx={2} fill={key.color}><title>{`${labels[index]} · ${key.label} ${value}`}</title></rect>
            })}
            <text x={cx} y={height - 6} textAnchor="middle" fontSize="10" fill={highlightLast && index === rows.length - 1 ? 'var(--workspace-text-strong)' : AXIS}>{labels[index]}</text>
          </g>
        })}
      </svg>}
    </div>
  )
}

export function DonutChart({ segments, size = 140, thickness = 16, center, sub }: {
  segments: Array<{ label: string; value: number; color: string }>; size?: number; thickness?: number; center?: ReactNode; sub?: ReactNode
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const gap = segments.filter((segment) => segment.value > 0).length > 1 ? 3 : 0
  let offset = 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((segment) => `${segment.label} ${segment.value}`).join(', ')} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--workspace-surface-700)" strokeWidth={thickness} />
        {total > 0 && segments.map((segment) => {
          const length = segment.value / total * circumference
          const dash = Math.max(0, length - gap)
          const element = segment.value > 0 && <circle key={segment.label} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={segment.color} strokeWidth={thickness}
            strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} strokeLinecap="butt"><title>{`${segment.label} ${segment.value}`}</title></circle>
          offset += length
          return element
        })}
      </svg>
      {(center != null || sub != null) && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {center != null && <span className="text-2xl font-bold leading-none text-[var(--workspace-text-strong)]">{center}</span>}
        {sub != null && <span className="mt-1 text-[11px] text-[var(--workspace-text-muted)]">{sub}</span>}
      </div>}
    </div>
  )
}

export function DonutLegend({ segments }: { segments: Array<{ label: ReactNode; value: number; color: string }> }) {
  return <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
    {segments.map((segment, index) => <li key={index} className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: segment.color }} />
      <span className="min-w-0 flex-1 truncate text-[var(--workspace-text)]">{segment.label}</span>
      <span className="font-mono tabular-nums text-[var(--workspace-text-strong)]">{segment.value}</span>
    </li>)}
  </ul>
}

/** Hosts × time buckets; cell shade follows the value, cells at or above `alertAt` turn red. */
export function Heatmap({ rows, columnLabels, alertAt = 85, formatValue = (v) => `${Math.round(v)}%` }: {
  rows: Array<{ label: string; cells: Array<number | null> }>; columnLabels: string[]; alertAt?: number; formatValue?: (value: number) => string
}) {
  const columns = Math.max(1, ...rows.map((row) => row.cells.length))
  const labelEvery = Math.max(1, Math.ceil(columns / 6))
  return (
    <div className="grid gap-y-1" style={{ gridTemplateColumns: `minmax(5rem, 8rem) repeat(${columns}, minmax(0, 1fr))`, columnGap: 3 }}>
      {rows.map((row) => <div key={row.label} className="contents">
        <span className="truncate pr-2 text-xs leading-5 text-[var(--workspace-text)]" title={row.label}>{row.label}</span>
        {Array.from({ length: columns }, (_, index) => {
          const value = row.cells[index] ?? null
          const style = value == null
            ? { background: 'var(--workspace-surface-800)' }
            : value >= alertAt
              ? { background: STATUS_COLORS.bad }
              : { background: `color-mix(in srgb, var(--workspace-primary-400) ${Math.round(18 + Math.min(1, value / alertAt) * 70)}%, var(--workspace-surface-800))` }
          return <span key={index} className="h-5 rounded-[3px]" style={style} title={`${row.label} · ${columnLabels[index] ?? ''} · ${value == null ? '—' : formatValue(value)}`} />
        })}
      </div>)}
      <span />
      {Array.from({ length: columns }, (_, index) => <span key={index} className="font-mono text-[10px] text-[var(--workspace-text-subtle)]">{index % labelEvery === 0 ? columnLabels[index] : ''}</span>)}
    </div>
  )
}

/** Horizontal bars with a label and value, e.g. "Top 5 by disk". */
export function BarList({ rows, max = 100, format = (v) => `${Math.round(v)}%` }: {
  rows: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode; color?: string }>; max?: number; format?: (value: number) => string
}) {
  return <ul className="space-y-3">
    {rows.map((row) => <li key={row.key} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-0.5 text-[13px]">
      <span className="truncate text-[var(--workspace-text)]">{row.label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-[var(--workspace-surface-700)]"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, row.value / Math.max(1, max) * 100))}%`, background: row.color ?? CHART_COLORS[0] }} /></span>
      <span className="text-right font-mono text-xs tabular-nums text-[var(--workspace-text-strong)]">{format(row.value)}</span>
      {row.hint && <span className="col-start-2 col-end-4 truncate text-[11px] text-[var(--workspace-text-subtle)]">{row.hint}</span>}
    </li>)}
  </ul>
}

export function Sparkline({ values, color = CHART_COLORS[0], kind = 'line', width = 96, height = 32 }: { values: Array<number | null>; color?: string; kind?: 'line' | 'bars'; width?: number; height?: number }) {
  const real = values.filter((value): value is number => value != null)
  if (!real.length) return <svg width={width} height={height} aria-hidden="true" />
  const top = Math.max(...real) || 1
  const step = width / Math.max(1, values.length - (kind === 'bars' ? 0 : 1))
  if (kind === 'bars') {
    const barW = Math.max(2, step * 0.55)
    return <svg width={width} height={height} aria-hidden="true">{values.map((value, index) => value != null && value > 0 && <rect key={index} x={index * step + (step - barW) / 2} y={height - value / top * height} width={barW} height={value / top * height} rx={1} fill={color} opacity={index === values.length - 1 ? 1 : 0.55} />)}</svg>
  }
  const points = values.map((value, index) => value == null ? null : `${(index * step).toFixed(1)},${(height - 2 - value / top * (height - 4)).toFixed(1)}`)
  const runs: string[][] = [[]]
  for (const point of points) { if (point) runs[runs.length - 1].push(point); else if (runs[runs.length - 1].length) runs.push([]) }
  return <svg width={width} height={height} aria-hidden="true">
    {runs.filter((run) => run.length > 1).map((run, index) => <g key={index}>
      <path d={`M${run.join(' L')} L${run[run.length - 1].split(',')[0]},${height} L${run[0].split(',')[0]},${height} Z`} fill={color} opacity={0.15} />
      <path d={`M${run.join(' L')}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </g>)}
  </svg>
}

/** Bubble chart: x and y in percent, radius from `size` (0–100). */
export function ScatterChart({ points, height = 520, danger = { x: 85, y: 85 }, xLabel, yLabel }: {
  points: Array<{ key: string; label: string; x: number; y: number; size: number; color: string }>; height?: number; danger?: { x: number; y: number }; xLabel?: string; yLabel?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const pad = { left: 30, right: 12, top: 12, bottom: 24 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const sx = (value: number) => pad.left + Math.min(100, Math.max(0, value)) / 100 * plotW
  const sy = (value: number) => pad.top + plotH - Math.min(100, Math.max(0, value)) / 100 * plotH
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={points.map((point) => point.label).join(', ')}>
        <rect x={sx(danger.x)} y={pad.top} width={sx(100) - sx(danger.x)} height={plotH} fill={STATUS_COLORS.bad} opacity={0.12} />
        <rect x={pad.left} y={pad.top} width={plotW} height={sy(danger.y) - pad.top} fill={STATUS_COLORS.bad} opacity={0.12} />
        {[0, 25, 50, 75, 100].map((tick) => <g key={tick}>
          <line x1={pad.left} x2={pad.left + plotW} y1={sy(tick)} y2={sy(tick)} stroke={GRID} strokeDasharray={tick ? '2 4' : undefined} />
          <text x={pad.left - 6} y={sy(tick) + 3} textAnchor="end" fontSize="10" fill={AXIS} className="font-mono">{tick}</text>
          <text x={sx(tick)} y={height - 6} textAnchor="middle" fontSize="10" fill={AXIS} className="font-mono">{tick}</text>
        </g>)}
        {yLabel && <text x={pad.left + 6} y={pad.top + 12} fontSize="10" fill={AXIS}>↑ {yLabel}</text>}
        {xLabel && <text x={pad.left + plotW - 4} y={pad.top + plotH - 6} textAnchor="end" fontSize="10" fill={AXIS} className="font-mono">{xLabel} →</text>}
        {points.map((point) => {
          const r = 4 + Math.min(100, Math.max(0, point.size)) / 100 * 8
          const right = sx(point.x) > pad.left + plotW * 0.75
          return <g key={point.key}>
            <circle cx={sx(point.x)} cy={sy(point.y)} r={r} fill={point.color} opacity={0.9}><title>{`${point.label} · CPU ${Math.round(point.x)}% · ${Math.round(point.y)}% · ${Math.round(point.size)}%`}</title></circle>
            <text x={sx(point.x) + (right ? -(r + 4) : r + 4)} y={sy(point.y) + 3} textAnchor={right ? 'end' : 'start'} fontSize="11" fill="var(--workspace-text)">{point.label}</text>
          </g>
        })}
      </svg>}
    </div>
  )
}

/** Half-ring gauge, e.g. load relative to core count. */
export function Gauge({ value, max, label, sub, color = CHART_COLORS[0] }: { value: number | null; max: number; label: ReactNode; sub?: ReactNode; color?: string }) {
  const size = 180
  const radius = 70
  const length = Math.PI * radius
  const fraction = value == null ? 0 : Math.min(1, Math.max(0, value / Math.max(0.01, max)))
  return <div className="relative mx-auto" style={{ width: size, height: size / 2 + 24 }}>
    <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`} aria-hidden="true">
      <path d={`M${size / 2 - radius},${size / 2} A${radius},${radius} 0 0 1 ${size / 2 + radius},${size / 2}`} fill="none" stroke="var(--workspace-surface-700)" strokeWidth={14} strokeLinecap="round" />
      {value != null && <path d={`M${size / 2 - radius},${size / 2} A${radius},${radius} 0 0 1 ${size / 2 + radius},${size / 2}`} fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" strokeDasharray={`${fraction * length} ${length}`} />}
    </svg>
    <div className="absolute inset-x-0 bottom-0 text-center">
      <div className="text-3xl font-bold leading-none text-[var(--workspace-text-strong)]">{label}</div>
      {sub && <div className="mt-1 text-[11px] text-[var(--workspace-text-muted)]">{sub}</div>}
    </div>
  </div>
}

export function ChartCard({ title, subtitle, actions, children, className, testId }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return <section data-testid={testId} className={cn('sb-card flex min-w-0 flex-col p-4', className)}>
    <header className="mb-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{title}</h3>
        {subtitle && <p className="mt-0.5 truncate text-[11px] text-[var(--workspace-text-muted)]">{subtitle}</p>}
      </div>
      {actions}
    </header>
    <div className="min-h-0 flex-1">{children}</div>
  </section>
}

export function SegmentedTabs<T extends string>({ value, options, onChange, label, size = 'sm' }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void; label: string; size?: 'sm' | 'md' }) {
  return <div role="tablist" aria-label={label} className="inline-flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-0.5">
    {options.map((option) => <button key={option.value} type="button" role="tab" aria-selected={value === option.value} onClick={() => onChange(option.value)}
      className={cn('rounded-md font-medium transition-colors', size === 'md' ? 'px-3 py-1.5 text-[13px]' : 'px-2 py-1 text-[11px]',
        value === option.value ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
      {option.label}
    </button>)}
  </div>
}
