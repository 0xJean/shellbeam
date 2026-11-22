import { cn } from '@/lib/utils'

export type SparklineSegmentTone = 'good' | 'warn' | 'bad' | 'unknown'

export interface SparklineSegment {
  key: string
  tone: SparklineSegmentTone
  /** Optional 0–100 height ratio for bar amplitude; defaults to full height. */
  ratio?: number
  label?: string
}

const TONE_CLASS: Record<SparklineSegmentTone, string> = {
  good: 'bg-[var(--workspace-status-good)]',
  warn: 'bg-[var(--workspace-status-warn)]',
  bad: 'bg-[var(--workspace-status-bad)]',
  unknown: 'bg-[var(--workspace-meter-track)]',
}

/**
 * Compact 24-segment vertical status history bar (inspired by DStatus 24h latency
 * & uptime bars). Pads leading empty slots on the left so the newest sample
 * always sits flush right.
 */
export function SegmentedSparkline({
  segments,
  slots = 24,
  label,
  className,
}: {
  segments: ReadonlyArray<SparklineSegment>
  slots?: number
  label?: string
  className?: string
}) {
  const safeSlots = Math.max(4, Math.min(48, Math.round(slots)))
  const visible = segments.slice(-safeSlots)
  const padCount = Math.max(0, safeSlots - visible.length)

  return (
    <div
      role="img"
      aria-label={label ?? 'Status history'}
      data-testid="segmented-sparkline"
      className={cn('flex h-4 items-end gap-[2px]', className)}
    >
      {Array.from({ length: padCount }, (_, idx) => (
        <span
          key={`pad-${idx}`}
          data-tone="unknown"
          className="h-1.5 flex-1 rounded-[1.5px] bg-[var(--workspace-meter-track)] opacity-45"
        />
      ))}
      {visible.map((seg) => {
        const clamped = seg.ratio == null
          ? 100
          : Math.max(25, Math.min(100, Math.round(seg.ratio)))
        return (
          <span
            key={seg.key}
            data-tone={seg.tone}
            title={seg.label}
            style={{ height: `${clamped}%` }}
            className={cn(
              'min-w-[2px] flex-1 rounded-[1.5px] transition-opacity hover:opacity-80',
              TONE_CLASS[seg.tone],
            )}
          />
        )
      })}
    </div>
  )
}
