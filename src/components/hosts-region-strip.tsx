import { CountryFlag } from '@/components/country-flag'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface RegionHealthBucket {
  key: string
  label: string
  countryCode?: string
  countryName?: string
  online: number
  total: number
  offline: number
}

/**
 * Compact horizontal region health pill strip (inspired by DStatus fleet region pills).
 * Displays `online/total` in amber/red whenever a region has degraded or offline nodes
 * so operators spot regional outages at a glance without scrolling the table.
 */
export function HostsRegionStrip({
  buckets,
  selected,
  onSelect,
}: {
  buckets: ReadonlyArray<RegionHealthBucket>
  selected: string | null
  onSelect: (regionKey: string | null) => void
}) {
  const { locale } = useT()
  if (buckets.length < 2) return null

  const allLabel = locale === 'zh-CN' ? '全部地区' : 'All regions'
  const totalHosts = buckets.reduce((sum, item) => sum + item.total, 0)

  return (
    <div
      data-testid="hosts-region-strip"
      role="group"
      aria-label={locale === 'zh-CN' ? '地区健康筛选' : 'Region health filter'}
      className="flex flex-wrap items-center gap-1.5"
    >
      <button
        type="button"
        data-testid="region-pill-all"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
          selected === null
            ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
            : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]',
        )}
      >
        <span>{allLabel}</span>
        <span className="rounded bg-[var(--workspace-surface-700)] px-1 font-mono text-[10px] tabular-nums text-[var(--workspace-text-muted)]">
          {totalHosts}
        </span>
      </button>

      {buckets.map((bucket) => {
        const active = selected === bucket.key
        const hasIssue = bucket.offline > 0
        const allOffline = bucket.online === 0 && bucket.offline > 0
        return (
          <button
            key={bucket.key}
            type="button"
            data-testid={`region-pill-${bucket.key}`}
            aria-pressed={active}
            onClick={() => onSelect(active ? null : bucket.key)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
              active
                ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
                : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text)] hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]',
            )}
          >
            {(bucket.countryCode || bucket.countryName) && (
              <CountryFlag
                countryCode={bucket.countryCode}
                countryName={bucket.countryName}
                className="h-3 w-4"
              />
            )}
            <span className="max-w-[9rem] truncate">{bucket.label}</span>
            <span
              data-testid={`region-pill-ratio-${bucket.key}`}
              className={cn(
                'rounded px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums',
                allOffline
                  ? 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]'
                  : hasIssue
                    ? 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]'
                    : 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]',
              )}
            >
              {hasIssue ? `${bucket.online}/${bucket.total}` : bucket.total}
            </span>
          </button>
        )
      })}
    </div>
  )
}
