import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Boxes, CalendarClock, ChevronLeft, Container, Cpu, Ellipsis, Globe, LayoutGrid, LockKeyhole, Pencil, ScrollText, SquareTerminal, Trash2, Wrench } from 'lucide-react'
import { Sparkline } from '@/components/charts/chart-primitives'
import { HostRegionMeta } from '@/components/host-display-meta'
import type { FleetHost } from '@/hooks/use-fleet-metrics'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { mobileHostsCopy } from '@/lib/locales/mobile-hosts-v3'
import { fill } from '@/lib/locales/probe-install'
import { getResourceUsageTone } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import type { WorkspaceAppId } from '@/lib/workspace'
import { OsBadge } from './mobile-host-parts'
import { hostEndpoint, hostOs, mobileHostStatus, STATUS_PILL } from './mobile-host-status'

type Copy = (typeof mobileHostsCopy)[keyof typeof mobileHostsCopy]

const SPARK_POINTS = 30
const GB = 1024 ** 3
const MB = 1024 ** 2

const toneOf = (value: number) => { const tone = getResourceUsageTone(value); return tone === 'warn' || tone === 'bad' ? tone : null }
const formatGb = (bytes: number) => (bytes / GB >= 100 ? Math.round(bytes / GB) : Number((bytes / GB).toFixed(1))).toString()
const formatRate = (bytes: number) => (bytes / MB >= 100 ? Math.round(bytes / MB) : Number((bytes / MB).toFixed(1))).toString()

function formatAgo(ms: number, c: Copy) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const value = seconds < 60 ? fill(c.seconds, { value: seconds }) : seconds < 3600 ? fill(c.minutes, { value: Math.round(seconds / 60) }) : fill(c.hours, { value: Math.round(seconds / 3600) })
  return fill(c.ago, { value })
}

/** Wall clock for "n seconds ago", ticking outside render. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, intervalMs)
    return () => { window.clearTimeout(first); window.clearInterval(timer) }
  }, [intervalMs])
  return now
}

const TOOLS: Array<{ app: WorkspaceAppId; key: 'processes' | 'services' | 'docker' | 'logs' | 'network' | 'scheduledTasks' | 'sitesSsl' | 'toolManager'; icon: ReactNode }> = [
  { app: 'processes', key: 'processes', icon: <Cpu /> },
  { app: 'services', key: 'services', icon: <Boxes /> },
  { app: 'docker', key: 'docker', icon: <Container /> },
  { app: 'logs', key: 'logs', icon: <ScrollText /> },
  { app: 'network', key: 'network', icon: <Globe /> },
  { app: 'scheduledTasks', key: 'scheduledTasks', icon: <CalendarClock /> },
  { app: 'sitesSsl', key: 'sitesSsl', icon: <LockKeyhole /> },
  { app: 'toolManager', key: 'toolManager', icon: <Wrench /> },
]

function Tile({ testId, label, aside, value, unit, series, tone }: { testId: string; label: string; aside?: string; value: string; unit?: string; series: Array<number | null>; tone?: 'warn' | 'bad' | null }) {
  const color = tone === 'bad' ? 'var(--workspace-status-bad)' : tone === 'warn' ? 'var(--workspace-status-warn)' : 'var(--workspace-primary-500)'
  return (
    <div data-testid={testId} className="sb-card flex min-w-0 flex-col gap-1 overflow-hidden p-3">
      <span className="flex items-center justify-between gap-2 text-xs text-[var(--workspace-text-muted)]">
        <span>{label}</span>{aside && <span className="truncate tabular-nums">{aside}</span>}
      </span>
      <b className="text-[22px] font-semibold leading-tight tabular-nums text-[var(--workspace-text-strong)]">
        {value}{unit && <small className="ml-1 text-xs font-normal text-[var(--workspace-text-muted)]">{unit}</small>}
      </b>
      <span className="-mx-1 block h-8 overflow-hidden"><Sparkline values={series} width={160} height={32} color={color} /></span>
    </div>
  )
}

export interface MobileHostDetailProps {
  host: HostProfile
  entry?: FleetHost
  loading: boolean
  network?: HostNetworkDisplay
  onBack: () => void
  onConnect: () => void
  onOpenWorkspace: (app: WorkspaceAppId) => void
  onOpenPortForwarding?: () => void
  onEdit: () => void
  onDelete: () => void
}

/** v3 m:host — header, primary actions, live 2×2 status and the workspace app grid. */
export function MobileHostDetail({ host, entry, loading, network, onBack, onConnect, onOpenWorkspace, onOpenPortForwarding, onEdit, onDelete }: MobileHostDetailProps) {
  const { locale } = useT()
  const c = mobileHostsCopy[locale]
  const now = useNow(5_000)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { rootRef.current?.scrollIntoView?.({ block: 'start' }) }, [host.id])
  const [menu, setMenu] = useState<'closed' | 'open' | 'confirm'>('closed')
  const status = mobileHostStatus(entry, loading)
  const ssh = hasSshConnection(host)
  const metrics = entry?.view?.metrics ?? null
  const resource = entry?.view?.resource ?? null
  const history = entry?.history.slice(-SPARK_POINTS) ?? []
  const series = (pick: (point: (typeof history)[number]) => number | null) => history.length > 1 ? history.map(pick) : []
  const uptime = metrics?.uptimeSeconds
  const cpu = metrics?.cpuPercent ?? resource?.cpuPercent ?? null
  const memory = metrics?.memoryPercent ?? resource?.memoryPercent ?? null
  const disk = metrics?.diskPercent ?? resource?.diskPercent ?? null
  const containers = entry?.view?.inventory?.containers.length ?? 0
  const sampledAt = metrics?.sampledAt ?? null
  const statusLabel = { online: c.online, attention: c.attention, offline: c.offline, checking: c.checking, unknown: c.unknown }[status]
  const pctAside = (value: number | null) => value == null ? undefined : `${Math.round(value)}%`

  const tiles: ReactNode[] = []
  if (cpu != null) tiles.push(<Tile key="cpu" testId="mobile-host-tile-cpu" label={c.cpu} aside={metrics?.load1 != null ? fill(c.load, { value: metrics.load1.toFixed(2) }) : undefined} value={String(Math.round(cpu))} unit="%" tone={toneOf(cpu)} series={series((point) => point.metrics.cpuPercent)} />)
  if (memory != null) {
    const used = metrics?.memoryUsedBytes; const total = metrics?.memoryTotalBytes
    tiles.push(<Tile key="memory" testId="mobile-host-tile-memory" label={c.memory} aside={used != null && total ? pctAside(memory) : undefined}
      value={used != null && total ? formatGb(used) : String(Math.round(memory))} unit={used != null && total ? `/ ${formatGb(total)} GB` : '%'}
      tone={toneOf(memory)} series={series((point) => point.metrics.memoryPercent)} />)
  }
  if (disk != null) {
    const used = metrics?.diskUsedBytes; const total = metrics?.diskTotalBytes
    tiles.push(<Tile key="disk" testId="mobile-host-tile-disk" label={c.disk} aside={used != null && total ? pctAside(disk) : undefined}
      value={used != null && total ? formatGb(used) : String(Math.round(disk))} unit={used != null && total ? `/ ${formatGb(total)} GB` : '%'}
      tone={toneOf(disk)} series={series((point) => point.metrics.diskPercent)} />)
  }
  if (metrics?.networkRxBytesPerSec != null) {
    tiles.push(<Tile key="network" testId="mobile-host-tile-network" label={c.networkDown} aside={metrics.networkTxBytesPerSec != null ? `↑ ${formatRate(metrics.networkTxBytesPerSec)}` : undefined}
      value={formatRate(metrics.networkRxBytesPerSec)} unit="MB/s" series={series((point) => point.metrics.networkRxBytesPerSec)} />)
  }

  const action = 'flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold disabled:opacity-50'
  return (
    <div ref={rootRef} data-testid="mobile-host-detail" data-host-id={host.id} className="mx-auto max-w-xl pb-8">
      <div className="flex h-12 items-center gap-1 px-1.5">
        <button type="button" data-testid="mobile-host-back" onClick={onBack} className="flex h-11 min-w-11 items-center gap-0.5 rounded-lg pr-2 text-[16px] text-[var(--workspace-accent-text)]">
          <ChevronLeft className="h-6 w-6" />{c.back}
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[16px] font-semibold text-[var(--workspace-text-strong)]">{host.name}</span>
        <button type="button" data-testid="mobile-host-more" aria-label={c.more} aria-expanded={menu !== 'closed'} onClick={() => setMenu(menu === 'closed' ? 'open' : 'closed')}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--workspace-accent-text)]">
          <Ellipsis className="h-5 w-5" />
        </button>
      </div>
      {menu !== 'closed' && (
        <div data-testid="mobile-host-menu" className="sb-card mx-4 mb-3 divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden p-0">
          <button type="button" onClick={() => { setMenu('closed'); onEdit() }} className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-[15px] text-[var(--workspace-text-strong)]">
            <Pencil className="h-4 w-4 text-[var(--workspace-text-muted)]" />{c.edit}
          </button>
          <button type="button" data-testid="mobile-host-delete" onClick={() => { if (menu === 'confirm') { setMenu('closed'); onDelete() } else setMenu('confirm') }}
            className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-[15px] text-[color:var(--workspace-status-bad-text)]">
            <Trash2 className="h-4 w-4" />{menu === 'confirm' ? fill(c.confirmDelete, { name: host.name }) : c.delete}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 px-4 pb-4 pt-1">
        <OsBadge os={hostOs(entry)} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-[22px] font-bold tracking-tight text-[var(--workspace-text-strong)]">
            <span className="truncate">{host.name}</span>
            <span data-testid="mobile-host-status" data-status={status} className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', STATUS_PILL[status])}>{statusLabel}</span>
          </h2>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-[12.5px] text-[var(--workspace-text-muted)]">
            <span className="truncate font-mono">{hostEndpoint(host, c.monitoringOnly)}</span>
            {network?.locationStatus === 'ready' && <><span>·</span><HostRegionMeta network={network} /></>}
            {uptime != null && uptime > 0 && <><span>·</span><span>{uptime >= 86_400 ? fill(c.uptimeDays, { value: Math.floor(uptime / 86_400) }) : fill(c.uptimeHours, { value: Math.max(1, Math.floor(uptime / 3600)) })}</span></>}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 px-4">
        <button type="button" data-testid="mobile-host-connect" disabled={!ssh} onClick={onConnect} className={cn(action, 'bg-[color:var(--workspace-primary-500)] text-white')}>
          <SquareTerminal className="h-4 w-4 shrink-0" /><span className="truncate">{c.openTerminal}</span>
        </button>
        <button type="button" data-testid="mobile-host-workspace" disabled={!ssh} onClick={() => onOpenWorkspace('overview')} className={cn(action, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}>
          <LayoutGrid className="h-4 w-4 shrink-0" /><span className="truncate">{c.workspace}</span>
        </button>
        {onOpenPortForwarding && (
          <button type="button" data-testid="mobile-host-forward" onClick={onOpenPortForwarding} className={cn(action, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}>
            <ArrowLeftRight className="h-4 w-4 shrink-0" /><span className="truncate">{c.forward}</span>
          </button>
        )}
      </div>

      <section className="mt-5 px-4">
        <h3 className="mb-2 flex items-center justify-between px-1 text-[13px] text-[var(--workspace-text-muted)]">
          <span>{c.live}</span>
          {sampledAt != null && now != null && <span data-testid="mobile-host-sampled">{formatAgo(now - sampledAt, c)}</span>}
        </h3>
        {tiles.length > 0
          ? <div data-testid="mobile-host-live" className="grid grid-cols-2 gap-2.5">{tiles}</div>
          : (
            <div data-testid="mobile-host-no-live" className="sb-card p-4">
              <p className="text-sm font-medium text-[var(--workspace-text-strong)]">{c.noLive}</p>
              <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{c.noLiveHint}</p>
            </div>
          )}
      </section>

      {ssh && (
        <section className="mt-5 px-4">
          <h3 className="mb-2 px-1 text-[13px] text-[var(--workspace-text-muted)]">{c.tools}</h3>
          <div className="sb-card grid grid-cols-4 gap-y-3 px-2 py-4">
            {TOOLS.map((tool) => (
              <button key={tool.app} type="button" data-testid={`mobile-host-tool-${tool.app}`} onClick={() => onOpenWorkspace(tool.app)}
                className="relative flex min-h-[72px] flex-col items-center justify-start gap-1.5 rounded-xl text-[12px] text-[var(--workspace-text)]">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] [&_svg]:h-5 [&_svg]:w-5">{tool.icon}</span>
                {c[tool.key]}
                {tool.app === 'docker' && containers > 0 && (
                  <span data-testid="mobile-host-docker-count" className="absolute right-[calc(50%-1.6rem)] top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--workspace-text-subtle)] px-1 text-[10px] font-bold text-[var(--workspace-surface-950)]">{containers}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
