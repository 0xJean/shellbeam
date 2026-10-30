import { monitoringProviderLabel } from '@/lib/monitoring-presentation'
import { NativeSelect } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { hostOverlaysCopy } from '@/lib/locales/host-overlays-v3'
import { activeHostOpsFilterCount, DEFAULT_HOST_OPS_FILTERS, type HostOpsFilters } from '@/lib/host-ops-filters'
import { ChevronRight, Info } from 'lucide-react'
export function HostOpsAdvancedFilters({ value, onChange, osOptions, providerOptions = ['ssh-agentless', 'komari', 'shellbeam-agent', 'unknown'] }: { value: HostOpsFilters; onChange: (next: HostOpsFilters) => void; osOptions: string[]; providerOptions?: HostOpsFilters['provider'][] }) {
  const { t, locale } = useT()
  const v3 = hostOverlaysCopy[locale]
  function change<K extends keyof HostOpsFilters>(key: K, next: HostOpsFilters[K]) { onChange({ ...value, [key]: next }) }
  const active = activeHostOpsFilterCount(value)
  const selectClass = 'h-8 w-full min-w-0 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs text-[var(--workspace-text)]'
  const numberClass = 'h-8 w-20 shrink-0 border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-xs'
  const label = 'text-xs text-[var(--workspace-text-muted)]'
  const unit = 'shrink-0 whitespace-nowrap text-xs text-[var(--workspace-text-muted)]'
  return <details className="group mb-3 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-3" data-testid="host-ops-advanced-filters">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-[var(--workspace-text-strong)]">
      <ChevronRight className="h-3.5 w-3.5 text-[var(--workspace-text-subtle)] transition-transform group-open:rotate-90" />{t('hosts.opsFilters.title')}
      <span className={active ? 'rounded bg-[var(--workspace-accent-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--workspace-accent-text)]' : 'text-[11px] text-[var(--workspace-text-subtle)]'}>({active})</span>
    </summary>
    <div className="mt-3 grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
      <span className={label}>{t('hosts.opsFilters.provider')}</span>
      <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.provider')} value={value.provider} onChange={(e) => change('provider', e.target.value as HostOpsFilters['provider'])}>{[...new Set(['all', ...providerOptions, ...(value.provider !== 'all' ? [value.provider] : [])])].map((key) => <option key={key} value={key}>{key === 'all' || key === 'unknown' ? t(`hosts.opsFilters.${key}`) : monitoringProviderLabel(key, locale)}</option>)}</NativeSelect>
      <span className={label}>{t('hosts.opsFilters.os')}</span>
      <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.os')} value={value.os} onChange={(e) => change('os', e.target.value)}><option value="">{t('hosts.opsFilters.all')}</option><option value="__unknown__">{t('hosts.opsFilters.unknown')}</option>{osOptions.map((os) => <option key={os} value={os}>{os}</option>)}</NativeSelect>
      <span className={label}>{t('hosts.opsFilters.severity')}</span>
      <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.severity')} value={value.severity} onChange={(e) => change('severity', e.target.value as HostOpsFilters['severity'])}>{['all', 'none', 'info', 'warning', 'critical', 'unknown'].map((key) => <option key={key} value={key}>{t(`hosts.opsFilters.${key}`)}</option>)}</NativeSelect>
      <span className={label}>{t('hosts.opsFilters.capability')}</span>
      <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.capability')} value={value.capability} onChange={(e) => change('capability', e.target.value as HostOpsFilters['capability'])}>{['all', 'files', 'processes', 'services', 'logs', 'docker', 'port-checks', 'metrics'].map((key) => <option key={key} value={key}>{t(key === 'all' ? 'hosts.opsFilters.all' : `hosts.opsFilters.capability.${key}`)}</option>)}</NativeSelect>
      <span className={label}>{t('hosts.opsFilters.resource')}</span>
      <div className="flex min-w-0 items-center gap-2">
        <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.resource')} value={value.resource} onChange={(e) => change('resource', e.target.value as HostOpsFilters['resource'])}>{['none', 'cpu', 'memory', 'disk'].map((key) => <option key={key} value={key}>{t(key === 'none' ? 'hosts.opsFilters.all' : `localOps.metric.${key}`)}</option>)}</NativeSelect>
        <span className={unit}>{v3.atLeast}</span>
        <Input type="number" min={0} max={100} className={numberClass} aria-label={t('hosts.opsFilters.minimum')} disabled={value.resource === 'none'} value={value.minPercent} onChange={(e) => change('minPercent', Number(e.target.value))} />
        <span className={unit}>%</span>
      </div>
      <span className={label}>{t('hosts.opsFilters.freshness')}</span>
      <div className="flex min-w-0 items-center gap-2">
        <NativeSelect className={selectClass} aria-label={t('hosts.opsFilters.freshness')} value={value.freshness} onChange={(e) => change('freshness', e.target.value as HostOpsFilters['freshness'])}>{['all', 'fresh', 'stale', 'older', 'unknown'].map((key) => <option key={key} value={key}>{t(`hosts.opsFilters.${key}`)}</option>)}</NativeSelect>
        <span className={unit}>{v3.olderThan}</span>
        <Input type="number" min={0} max={10080} className={numberClass} aria-label={t('hosts.opsFilters.olderMinutes')} disabled={value.freshness !== 'older'} value={value.olderThanMinutes} onChange={(e) => change('olderThanMinutes', Number(e.target.value))} />
        <span className={unit}>{v3.minutes}</span>
      </div>
    </div>
    <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-4 text-[var(--workspace-text-muted)]"><Info className="mt-px h-3 w-3 shrink-0" />{v3.filtersHint}</p>
    <div className="mt-2 flex justify-end">
      <button type="button" className="text-xs font-medium text-[var(--workspace-accent-text)] hover:underline" onClick={() => onChange({ ...DEFAULT_HOST_OPS_FILTERS })}>{t('hosts.opsFilters.clear')}</button>
    </div>
  </details>
}
