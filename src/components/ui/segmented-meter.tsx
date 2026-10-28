import { getResourceUsageTone } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'

export type MeterKind = 'cpu' | 'memory' | 'disk'

// Normal-range colour per resource; warn / bad tones override it (src/lib/resource-usage.ts).
const METER_COLOR: Record<MeterKind, string> = {
  cpu: 'var(--chart-4, var(--workspace-primary-500))',
  memory: 'var(--chart-6, var(--workspace-primary-500))',
  disk: 'var(--chart-2, var(--workspace-primary-500))',
}

function meterColor(kind: MeterKind, value: number | null | undefined) {
  const tone = getResourceUsageTone(value)
  return tone === 'bad' ? 'var(--workspace-status-bad)' : tone === 'warn' ? 'var(--workspace-status-warn)' : METER_COLOR[kind]
}

/** The v3 segmented capsule meter; decorative, so callers provide the accessible label. */
export function SegmentedMeter({ kind, value, segments = 10, className }: { kind: MeterKind; value: number | null | undefined; segments?: number; className?: string }) {
  const tone = getResourceUsageTone(value)
  const color = meterColor(kind, value)
  const percent = value == null ? 0 : Math.min(100, Math.max(0, value))
  const lit = Math.round((percent / 100) * segments)
  return (
    <span data-meter-kind={kind} data-tone={tone ?? 'unknown'} aria-hidden="true" className={cn('grid h-1.5 gap-0.5', className)} style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}>
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className="rounded-[2px]"
          style={index < lit
            ? { background: color, opacity: tone === 'good' ? 0.5 + (index / segments) * 0.5 : 1, boxShadow: tone === 'warn' || tone === 'bad' ? `0 0 6px -1px ${color}` : undefined }
            : { background: 'var(--workspace-meter-track)' }} />
      ))}
    </span>
  )
}
