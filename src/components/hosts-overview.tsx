import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Activity, Box, Cpu, HardDrive, HeartPulse, Layers, Radar, RotateCw, Siren, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProbeBatchInstallDialog } from '@/components/probe-batch-install'
import { loadProbeInstallReadiness, PROBE_DEPLOYMENT_CHANGED_EVENT } from '@/hooks/use-probe-install-readiness'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { KOMARI_MAPPING_CHANGED_EVENT } from '@/lib/komari-persistence'
import { hostsOverviewCopy } from '@/lib/locales/hosts-overview'
import { fill } from '@/lib/locales/probe-install'
import { MAX_BATCH_HOSTS } from '@/lib/multi-host-operations'
import type { MultiHostOperationKind } from '@/components/multi-host-operations-panel'
import { offersProbeInstall } from '@/lib/probe-install'
import { cn } from '@/lib/utils'

export interface HostReading { host: HostProfile; cpu: number | null | undefined; disk: number | null | undefined; os?: string | null }

function Kpi({ icon, label, value, sub, tone, onClick }: { icon: ReactNode; label: string; value: ReactNode; sub: string; tone?: 'warn'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick}
      className={cn('sb-card flex min-w-0 flex-col gap-1 px-4 py-3 text-left', onClick && 'cursor-pointer')}>
      <span className="flex items-center justify-between text-xs text-[var(--workspace-text-muted)]">{label}<span className="text-[var(--workspace-text-subtle)]" aria-hidden="true">{icon}</span></span>
      <span className={cn('text-[26px] font-semibold leading-tight tracking-tight tabular-nums', tone === 'warn' ? 'text-[color:var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-strong)]')}>{value}</span>
      <span className="truncate text-[11px] text-[var(--workspace-text-muted)]">{sub}</span>
    </Tag>
  )
}

/** Fleet summary above the host list; every number is derived from current samples only. */
export function HostKpiRow({ total, online, offline, stale, openAlerts, readings, onOpenAlerts }: { total: number; online: number; offline: number; stale: number; openAlerts: number; readings: HostReading[]; onOpenAlerts?: () => void }) {
  const { locale } = useT()
  const c = hostsOverviewCopy[locale]
  const stat = (key: 'cpu' | 'disk') => {
    const known = readings.filter((row) => typeof row[key] === 'number' && Number.isFinite(row[key])) as Array<HostReading & Record<typeof key, number>>
    if (!known.length) return null
    const top = known.reduce((a, b) => (b[key] > a[key] ? b : a))
    return { average: Math.round(known.reduce((sum, row) => sum + row[key], 0) / known.length), peak: Math.round(top[key]), host: top.host.name }
  }
  const cpu = stat('cpu'); const disk = stat('disk')
  if (total === 0) return null
  return (
    <div data-testid="host-kpis" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi icon={<Activity className="h-4 w-4" />} label={c.online} value={<>{online}<small className="ml-1 text-sm font-medium text-[var(--workspace-text-muted)]">/ {total}</small></>} sub={offline || stale ? fill(c.onlineSub, { offline, stale }) : c.onlineAll} />
      <Kpi icon={<Siren className="h-4 w-4" />} label={c.alerts} value={openAlerts} tone={openAlerts > 0 ? 'warn' : undefined} sub={openAlerts > 0 ? c.alertsSub : c.alertsNone} onClick={openAlerts > 0 ? onOpenAlerts : undefined} />
      <Kpi icon={<Cpu className="h-4 w-4" />} label={c.cpu} value={cpu ? `${cpu.average}%` : '—'} sub={cpu ? fill(c.cpuSub, { value: cpu.peak, host: cpu.host }) : c.noData} />
      <Kpi icon={<HardDrive className="h-4 w-4" />} label={c.disk} value={disk ? `${disk.average}%` : '—'} sub={disk ? fill(c.diskSub, { value: disk.peak, host: disk.host }) : c.noData} />
    </div>
  )
}

/** Segmented health filter that lists only the states present in the fleet. */
export function HostStatusSegments<S extends string>({ value, counts, labels, label, onChange }: { value: S | 'all'; counts: Record<S, number>; labels: Record<S | 'all', string>; label: string; onChange: (value: S | 'all') => void }) {
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0)
  const present = (Object.keys(counts) as S[]).filter((key) => counts[key] > 0 || key === value)
  const option = (key: S | 'all', count: number) => (
    <button key={key} type="button" role="radio" aria-checked={value === key} data-testid={`host-status-${key}`} onClick={() => onChange(key)}
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
        value === key ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
      {labels[key]}<span className="font-mono text-[10px] text-[var(--workspace-text-subtle)]">{count}</span>
    </button>
  )
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-[var(--workspace-surface-800)] p-0.5">
      {option('all', total)}{present.map((key) => option(key, counts[key]))}
    </div>
  )
}

const DISMISS_KEY = 'shellbeam.probeBanner.dismissedAt'

/** Prompts for hosts that can still get a managed probe and opens batch install for them. */
export function ProbeCoverageBanner({ hosts, osOf }: { hosts: HostProfile[]; osOf: (host: HostProfile) => string | null | undefined }) {
  const { locale } = useT()
  const c = hostsOverviewCopy[locale]
  const [eligible, setEligible] = useState<HostProfile[]>([])
  const [dismissed, setDismissed] = useState(() => { try { return Number(localStorage.getItem(DISMISS_KEY)) || 0 } catch { return 0 } })
  const [open, setOpen] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const candidates = useMemo(() => hosts.filter((host) => host.vaultId && hasSshConnection(host)), [hosts])

  useEffect(() => {
    const bump = () => setEpoch((value) => value + 1)
    window.addEventListener(KOMARI_MAPPING_CHANGED_EVENT, bump)
    window.addEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, bump)
    return () => { window.removeEventListener(KOMARI_MAPPING_CHANGED_EVENT, bump); window.removeEventListener(PROBE_DEPLOYMENT_CHANGED_EVENT, bump) }
  }, [])

  useEffect(() => {
    let live = true
    void (async () => {
      const rows = await Promise.all(candidates.map(async (host) => {
        const { readiness } = await loadProbeInstallReadiness(host)
        return offersProbeInstall(readiness, osOf(host)) ? host : null
      }))
      if (live) setEligible(rows.filter((host): host is HostProfile => !!host))
    })()
    return () => { live = false }
  // osOf is derived from the same host list; re-reading on every render would refetch needlessly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, epoch])

  // A dismissed banner returns only when more hosts become eligible than were dismissed.
  if (eligible.length === 0 || eligible.length <= dismissed) return null
  const batch = eligible.slice(0, MAX_BATCH_HOSTS)
  return (
    <div data-testid="probe-coverage-banner" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-primary/20 [background:linear-gradient(90deg,hsl(var(--primary)/0.10),transparent_60%)]">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-[var(--workspace-accent-text)]"><Radar className="h-4 w-4" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-0">
        <b className="block text-[13px] font-semibold text-[var(--workspace-text-strong)]">{fill(c.bannerTitle, { count: eligible.length })}</b>
        <span className="block text-xs text-[var(--workspace-text-muted)]">{c.bannerBody}{eligible.length > MAX_BATCH_HOSTS ? ` ${fill(c.bannerMore, { count: MAX_BATCH_HOSTS })}` : ''}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={() => { setDismissed(eligible.length); try { localStorage.setItem(DISMISS_KEY, String(eligible.length)) } catch { /* session-only preference */ } }}>{c.bannerLater}</Button>
      <Button size="sm" variant="outline" data-testid="probe-coverage-install" className="gap-1.5" onClick={() => setOpen(true)}><Layers className="h-3.5 w-3.5" />{c.bannerInstall}</Button>
      {open && <ProbeBatchInstallDialog hosts={batch} open onOpenChange={setOpen} />}
    </div>
  )
}

/**
 * Floating action pill for batch selection (v3 host table): the count, a
 * probe install for the selection, and shortcuts that preset the batch
 * operations panel below the list.
 */
export function HostBatchFloatingBar({ hosts, onOperation, onExit }: { hosts: HostProfile[]; onOperation: (operation: MultiHostOperationKind) => void; onExit: () => void }) {
  const { t, locale } = useT()
  const c = hostsOverviewCopy[locale]
  const [installing, setInstalling] = useState(false)
  if (hosts.length === 0) return null
  const action = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]'
  return (
    <div data-testid="host-batch-bar" role="toolbar" aria-label={fill(c.selected, { count: hosts.length })}
      className="sb-card fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 px-2 py-1.5 shadow-[var(--workspace-shadow-overlay)]">
      <span className="px-2 text-xs font-semibold text-[var(--workspace-text-strong)]">{fill(c.selected, { count: hosts.length })}</span>
      <span className="mx-1 h-5 w-px bg-[color:var(--workspace-border-soft)]" />
      <button type="button" data-testid="probe-batch-entry" className={cn(action, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')} onClick={() => setInstalling(true)}><Radar className="h-3.5 w-3.5" />{c.installProbe}</button>
      <button type="button" className={action} onClick={() => onOperation('health-check')}><HeartPulse className="h-3.5 w-3.5" />{t('multiHost.operations.healthCheck')}</button>
      <button type="button" className={action} onClick={() => onOperation('service.restart')}><RotateCw className="h-3.5 w-3.5" />{t('multiHost.operations.serviceRestart')}</button>
      <button type="button" className={action} onClick={() => onOperation('docker.restart')}><Box className="h-3.5 w-3.5" />{t('multiHost.operations.dockerRestart')}</button>
      <span className="mx-1 h-5 w-px bg-[color:var(--workspace-border-soft)]" />
      <button type="button" aria-label={c.exitBatch} title={c.exitBatch} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-700)]" onClick={onExit}><X className="h-4 w-4" /></button>
      {installing && <ProbeBatchInstallDialog hosts={hosts.slice(0, MAX_BATCH_HOSTS)} open onOpenChange={setInstalling} />}
    </div>
  )
}
