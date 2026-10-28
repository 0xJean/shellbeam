import { useMemo, useState } from 'react'
import { ArrowDownWideNarrow, ArrowUpWideNarrow, ChevronRight, Plus, Search, TriangleAlert, X } from 'lucide-react'
import { HostEditorDialog } from '@/components/host-editor-dialog'
import { ProbeCoverageBanner } from '@/components/hosts-overview'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { PullToRefresh } from '@/components/pull-to-refresh'
import { SegmentedMeter, type MeterKind } from '@/components/ui/segmented-meter'
import { useFleetMetrics, type FleetHost } from '@/hooks/use-fleet-metrics'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { matchesHostSearch } from '@/lib/host-search'
import { DEFAULT_GROUPS, type HostProfile, type HostProfileDraft } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { mobileHostsCopy } from '@/lib/locales/mobile-hosts-v3'
import { fill } from '@/lib/locales/probe-install'
import { getResourceUsageTone } from '@/lib/resource-usage'
import { cn } from '@/lib/utils'
import type { WorkspaceAppId } from '@/lib/workspace'
import { OsBadge } from './mobile-host-parts'
import { hostEndpoint, hostOs, hostReadings, mobileHostStatus, STATUS_DOT, STATUS_PILL, type MobileHostStatus } from './mobile-host-status'
import { MobileHostDetail } from './mobile-host-detail'
import { MobileNewHost } from './mobile-new-host'

type Filter = 'all' | 'online' | 'attention' | 'offline'
const FILTERS: Filter[] = ['all', 'online', 'attention', 'offline']
const FILTER_DOT: Record<Exclude<Filter, 'all'>, string> = { online: STATUS_DOT.online, attention: STATUS_DOT.attention, offline: STATUS_DOT.offline }
const METERS: MeterKind[] = ['cpu', 'memory', 'disk']
const ATTENTION_PREVIEW = 2

export interface MobileHostsPageProps {
  hosts: HostProfile[]
  activeVaultId?: string
  vaultUnlocked: boolean
  vaultKeys?: string[]
  vaultName?: string
  defaultUsername?: string
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  onCreateHost: (draft: HostProfileDraft) => Promise<HostProfile | void>
  onUpdateHost: (host: HostProfile, draft: HostProfileDraft) => Promise<void>
  onDeleteHost: (hostId: string) => Promise<void>
  onRefreshHosts?: () => Promise<void> | void
  onSelectHost?: (hostId: string) => void
  onConnectHost: (hostId: string) => void
  onOpenWorkspace: (hostId: string, app: WorkspaceAppId) => void
  onOpenPortForwarding?: () => void
  /** External "add host" requests (guide, quick connect) open the full-screen form. */
  openAddForm?: boolean
  onAddFormClose?: () => void
}

/** v3 mobile hosts tab: m:hosts list, m:host detail and the m:newhost sheet. */
export function MobileHostsPage({
  hosts, activeVaultId, vaultUnlocked, vaultKeys, vaultName, defaultUsername, onSaveToVault, onLoadVaultSecret,
  onCreateHost, onUpdateHost, onDeleteHost, onRefreshHosts, onSelectHost, onConnectHost, onOpenWorkspace, onOpenPortForwarding,
  openAddForm = false, onAddFormClose,
}: MobileHostsPageProps) {
  const { t, locale } = useT()
  const c = mobileHostsCopy[locale]
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [descending, setDescending] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<HostProfile | null>(null)
  const [probeHost, setProbeHost] = useState<HostProfile | null>(null)

  const scoped = useMemo(() => hosts.filter((host) => !host.vaultId || !activeVaultId || host.vaultId === activeVaultId), [hosts, activeVaultId])
  const fleet = useFleetMetrics({ hosts: scoped, vaultId: activeVaultId, unlocked: vaultUnlocked, rangeHours: 1 })
  const entries = useMemo(() => new Map(fleet.hosts.map((entry) => [entry.host.id, entry])), [fleet.hosts])
  const networkByAddress = useHostNetworkMetadata(scoped.map((host) => host.address))
  const existingGroups = useMemo(() => Array.from(new Set<string>([...DEFAULT_GROUPS, ...scoped.map((host) => host.group).filter(Boolean)])), [scoped])
  const existingTags = useMemo(() => Array.from(new Set(scoped.flatMap((host) => host.tags ?? []))).sort(), [scoped])

  const statusOf = (host: HostProfile) => mobileHostStatus(entries.get(host.id), fleet.loading)
  const counts = { all: scoped.length, online: 0, attention: 0, offline: 0 }
  for (const host of scoped) {
    const status = statusOf(host)
    if (status === 'online') counts.online += 1
    else if (status === 'attention') counts.attention += 1
    else if (status === 'offline') counts.offline += 1
  }
  const attention = scoped.filter((host) => statusOf(host) === 'attention')
  const visible = scoped
    .filter((host) => matchesHostSearch(host, query, scoped))
    .filter((host) => filter === 'all' || statusOf(host) === filter)
    .sort((a, b) => (descending ? -1 : 1) * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const groupOrder = (group: string) => { const index = (DEFAULT_GROUPS as readonly string[]).indexOf(group); return index < 0 ? DEFAULT_GROUPS.length : index }
  const groups = Array.from(visible.reduce((map, host) => map.set(host.group || 'Custom', [...(map.get(host.group || 'Custom') ?? []), host]), new Map<string, HostProfile[]>()))
    .sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
  const groupLabel = (group: string) => t(`group.${group}`) !== `group.${group}` ? t(`group.${group}`) : group
  const meterLabel = { cpu: c.cpu, memory: c.memory, disk: c.disk }

  const attentionReason = (host: HostProfile) => {
    const entry = entries.get(host.id)
    const worst = hostReadings(entry).map((value, index) => ({ value, kind: METERS[index] }))
      .filter((reading): reading is { value: number; kind: MeterKind } => reading.value != null && getResourceUsageTone(reading.value) === 'bad')
      .sort((a, b) => b.value - a.value)[0]
    if (worst) return `${host.name} ${fill(c.resourceLine, { label: meterLabel[worst.kind], value: Math.round(worst.value) })}`
    if (entry?.openAlerts) return fill(c.attentionAlerts, { name: host.name, count: entry.openAlerts })
    return fill(c.attentionStale, { name: host.name })
  }

  const closeCreate = () => { setCreating(false); onAddFormClose?.() }
  const refresh = async () => { fleet.refresh(); await onRefreshHosts?.() }
  const openDetail = (hostId: string) => { setDetailId(hostId); onSelectHost?.(hostId) }
  const android = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
  const detailHost = detailId ? scoped.find((host) => host.id === detailId) : undefined

  const overlays = (
    <>
      {(creating || openAddForm) && (
        <MobileNewHost vaultId={activeVaultId} availableHosts={scoped} defaultUsername={defaultUsername} vaultKeys={vaultKeys} vaultUnlocked={vaultUnlocked}
          onSaveToVault={onSaveToVault} onLoadVaultSecret={onLoadVaultSecret} vaultName={vaultName} existingGroups={existingGroups} existingTags={existingTags}
          onSubmit={async (draft, options) => { const created = await onCreateHost(draft); closeCreate(); if (options?.installProbe && created) setProbeHost(created) }}
          onCancel={closeCreate} />
      )}
      <HostEditorDialog availableHosts={scoped.filter((host) => host.id !== editing?.id)} host={editing} defaultUsername={defaultUsername} vaultKeys={vaultKeys}
        vaultUnlocked={vaultUnlocked} onSaveToVault={onSaveToVault} onLoadVaultSecret={onLoadVaultSecret} vaultName={vaultName}
        existingGroups={existingGroups} existingTags={existingTags}
        onSubmit={async (host, draft) => { await onUpdateHost(host, draft); setEditing(null) }} onCancel={() => setEditing(null)} />
      {probeHost && <ProbeInstallDialog host={scoped.find((host) => host.id === probeHost.id) ?? probeHost} open onOpenChange={(open) => { if (!open) setProbeHost(null) }} />}
    </>
  )

  if (detailHost) {
    return (
      <>
        <MobileHostDetail host={detailHost} entry={entries.get(detailHost.id)} loading={fleet.loading} network={networkByAddress[detailHost.address]}
          onBack={() => setDetailId(null)}
          onConnect={() => onConnectHost(detailHost.id)}
          onOpenWorkspace={(app) => onOpenWorkspace(detailHost.id, app)}
          onOpenPortForwarding={onOpenPortForwarding}
          onEdit={() => setEditing(detailHost)}
          onDelete={() => { setDetailId(null); void onDeleteHost(detailHost.id) }} />
        {overlays}
      </>
    )
  }

  const iconButton = 'flex h-11 w-11 items-center justify-center rounded-lg text-[var(--workspace-accent-text)]'
  return (
    <div data-testid="mobile-hosts-page" className="mx-auto max-w-xl">
      <div className="flex h-12 items-center justify-between px-1.5">
        <button type="button" data-testid="mobile-hosts-sort" aria-label={`${c.sort} · ${descending ? c.sortZa : c.sortAz}`} onClick={() => setDescending((value) => !value)} className={iconButton}>
          {descending ? <ArrowUpWideNarrow className="h-5 w-5" /> : <ArrowDownWideNarrow className="h-5 w-5" />}
        </button>
        {!android && (
          <button type="button" data-testid="mobile-hosts-add" aria-label={c.newHost} onClick={() => setCreating(true)} className={iconButton}>
            <Plus className="h-6 w-6" />
          </button>
        )}
      </div>
      <h1 className="px-4 text-[32px] font-bold leading-tight tracking-tight text-[var(--workspace-text-strong)]">{c.title}</h1>

      <label className="mx-4 mt-2 flex h-10 items-center gap-2 rounded-xl bg-[var(--workspace-surface-800)] px-3 text-[var(--workspace-text-subtle)]">
        <Search className="h-4 w-4 shrink-0" />
        <input data-testid="mobile-hosts-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={c.search} aria-label={c.search}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
        {query && <button type="button" aria-label={c.cancel} onClick={() => setQuery('')} className="-mr-2 flex h-10 w-10 items-center justify-center"><X className="h-4 w-4" /></button>}
      </label>

      <div role="tablist" className="flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none]">
        {FILTERS.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={filter === key} data-testid={`mobile-hosts-filter-${key}`} onClick={() => setFilter(key)}
            className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-medium',
              filter === key ? 'bg-[var(--workspace-text-strong)] text-[var(--workspace-surface-950)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text)]')}>
            {key !== 'all' && <span className={cn('h-2 w-2 rounded-full', FILTER_DOT[key])} />}
            {c[key]}<span className="tabular-nums opacity-60">{counts[key]}</span>
          </button>
        ))}
      </div>

      <PullToRefresh onRefresh={refresh} className="space-y-3 px-4 pb-28">
        {attention.length > 0 && (
          <button type="button" data-testid="mobile-hosts-attention" onClick={() => setFilter('attention')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-[var(--workspace-status-warn-bg)] px-3.5 py-3 text-left text-[color:var(--workspace-status-warn-text)]">
            <TriangleAlert className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <b className="block text-[14px] font-semibold">{fill(c.attentionTitle, { count: attention.length })}</b>
              <span className="block truncate text-[12.5px] opacity-85">{attention.slice(0, ATTENTION_PREVIEW).map(attentionReason).join(' · ')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0" />
          </button>
        )}
        {vaultUnlocked && <ProbeCoverageBanner hosts={scoped} osOf={(host) => hostOs(entries.get(host.id)) || undefined} />}

        {scoped.length === 0 ? (
          <div data-testid="mobile-hosts-empty" className="sb-card px-4 py-8 text-center">
            <p className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{c.empty}</p>
            <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{c.emptyHint}</p>
          </div>
        ) : groups.length === 0 ? (
          <p data-testid="mobile-hosts-no-match" className="py-8 text-center text-[13px] text-[var(--workspace-text-muted)]">{c.noMatch}</p>
        ) : groups.map(([group, members], index) => (
          <section key={group} data-testid="mobile-hosts-group" className="space-y-1.5 pt-1">
            <h3 className="flex items-center justify-between px-1 text-[13px] text-[var(--workspace-text-muted)]">
              <span>{fill(c.groupCount, { group: groupLabel(group), count: members.length })}</span>
              {index === 0 && <span className="text-xs text-[var(--workspace-text-subtle)]">{c.resources}</span>}
            </h3>
            <div className="sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden p-0">
              {members.map((host) => <HostRow key={host.id} host={host} entry={entries.get(host.id)} status={statusOf(host)} copy={c} onOpen={() => openDetail(host.id)} />)}
            </div>
          </section>
        ))}
      </PullToRefresh>

      {android && (
        <button type="button" data-testid="mobile-hosts-fab" onClick={() => setCreating(true)}
          className="fixed right-4 z-40 flex h-14 items-center gap-2 rounded-2xl bg-[color:var(--workspace-primary-500)] px-5 text-[15px] font-semibold text-white shadow-lg md:hidden"
          style={{ bottom: 'calc(3.25rem + env(safe-area-inset-bottom, 0px) + 16px)' }}>
          <Plus className="h-5 w-5" />{c.newHost}
        </button>
      )}
      {overlays}
    </div>
  )
}

function HostRow({ host, entry, status, copy, onOpen }: { host: HostProfile; entry?: FleetHost; status: MobileHostStatus; copy: (typeof mobileHostsCopy)[keyof typeof mobileHostsCopy]; onOpen: () => void }) {
  const readings = hostReadings(entry)
  const hasReadings = readings.some((value) => value != null)
  const meterText = METERS.map((kind, index) => `${{ cpu: copy.cpu, memory: copy.memory, disk: copy.disk }[kind]} ${readings[index] == null ? '—' : `${Math.round(readings[index])}%`}`).join(' · ')
  return (
    <button type="button" data-testid="mobile-host-row" data-host-id={host.id} data-status={status} onClick={onOpen}
      className="flex min-h-[60px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-[var(--workspace-surface-800)]">
      <OsBadge os={hostOs(entry)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[15.5px] text-[var(--workspace-text-strong)]">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} />
          <span className="truncate">{host.name}</span>
        </span>
        <span className="block truncate font-mono text-[12px] text-[var(--workspace-text-muted)]">{hostEndpoint(host, copy.monitoringOnly)}</span>
      </span>
      {status === 'offline'
        ? <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', STATUS_PILL.offline)}>{copy.offline}</span>
        : hasReadings && (
          <span role="img" aria-label={meterText} title={meterText} className="grid w-12 shrink-0 gap-[3px]">
            {METERS.map((kind, index) => <SegmentedMeter key={kind} kind={kind} value={readings[index]} segments={8} className="h-[3px]" />)}
          </span>
        )}
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
    </button>
  )
}
