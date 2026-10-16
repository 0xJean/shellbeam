import { HostGridCard, HostListItem, type HostOperationalSummary } from '@/components/host-card'
import { HostListScrollArea } from '@/components/host-list-scroll-area'
import { HostCreateDialog } from '@/components/host-create-dialog'
import { HostEditorDialog } from '@/components/host-editor-dialog'
import { PullToRefresh } from '@/components/pull-to-refresh'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'
import { DEFAULT_GROUPS } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceInventoryHealthStatus, useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { loadHostOpsViews, type HostOpsView } from '@/lib/host-ops-view'
import { listKomariIntegrations } from '@/lib/komari-config'
import { loadKomariPersistence, persistKomariSync } from '@/lib/komari-persistence'
import { readKomariAlertState } from '@/lib/komari-persistence'
import { DEFAULT_KOMARI_SYNC_TTL_MS, isKomariSyncFresh, syncKomariIntegration } from '@/lib/komari-sync'
import { ArrowDownAZ, ArrowUpZA, CalendarArrowDown, CalendarArrowUp, CheckCircle2, ChevronDown, FileDown, LayoutGrid, List, Plus, RefreshCw, Search, Server, Tag, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SshImportDialog } from './ssh-import-dialog'
import { WorkspaceResourceOverviewHeader, type WorkspaceResourceGroup } from './workspace/workspace-resource-overview-header'

type SortMode = 'az' | 'za' | 'newest' | 'oldest'
type HostStatusFilter = 'all' | 'online' | 'stale' | 'checking' | 'offline' | 'paused' | 'unknown' | 'jump-unavailable'
type HostHealthStatus = Exclude<HostStatusFilter, 'all'>
const SORT_KEY = 'shellbeam.hostSortMode'
const SHOW_HOST_SUMMARY_STRIP = false

function getHostHealthStatus(view: HostOpsView | undefined, fallback: HostHealthStatus, loading: boolean): HostHealthStatus {
  if (view?.health.state === 'paused') return 'paused'
  if (view?.health.state === 'jump-unavailable') return 'jump-unavailable'
  if (view?.health.state === 'online' || view?.health.state === 'stale' || view?.health.state === 'offline' || view?.health.state === 'checking' || view?.health.state === 'unknown') return view.health.state
  return loading && fallback === 'unknown' ? 'checking' : fallback
}

function HostSummaryStrip({
  totalHosts,
  onlineCount,
  checkingCount,
  offlineCount,
  groups,
}: {
  totalHosts: number
  onlineCount: number
  checkingCount: number
  offlineCount: number
  groups: WorkspaceResourceGroup[]
}) {
  const { t } = useT()

  if (totalHosts === 0) return null

  const cards = [
    {
      key: 'total',
      label: t('hosts.totalHosts'),
      value: totalHosts,
      icon: Server,
      shellClassName: 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]',
      fillClassName: 'bg-[color:var(--workspace-primary-500)]',
    },
    {
      key: 'online',
      label: t('hosts.statusOnline'),
      value: onlineCount,
      icon: CheckCircle2,
      shellClassName: 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
      fillClassName: 'bg-[color:var(--workspace-status-good)]',
    },
    {
      key: 'checking',
      label: t('hosts.statusChecking'),
      value: checkingCount,
      icon: RefreshCw,
      shellClassName: 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
      fillClassName: 'bg-[color:var(--workspace-status-warn)]',
    },
    {
      key: 'offline',
      label: t('hosts.statusOffline'),
      value: offlineCount,
      icon: X,
      shellClassName: 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
      fillClassName: 'bg-[color:var(--workspace-status-bad)]',
    },
  ]

  return (
    <div className="mb-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon
          const ratio = totalHosts === 0 ? 0 : Math.max(0, Math.min(100, (card.value / totalHosts) * 100))

          return (
            <div
              key={card.key}
              className="min-w-0 rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-4 shadow-[var(--workspace-shadow-card)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--workspace-text-subtle)]">
                    {card.label}
                  </div>
                  <div className="mt-2 text-3xl font-semibold leading-none tracking-tight text-[var(--workspace-text-strong)]">
                    {card.value}
                  </div>
                </div>
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--workspace-border-soft)]', card.shellClassName)}>
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--workspace-meter-track)]">
                <div className={cn('h-full rounded-full', card.fillClassName)} style={{ width: `${ratio}%` }} />
              </div>
            </div>
          )
        })}
      </div>

      {groups.length > 0 && (
        <div className="rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-4 py-3 shadow-[var(--workspace-shadow-card)]">
          <div className="flex h-2 overflow-hidden rounded-full bg-[var(--workspace-meter-track)]">
            {groups.map((group) => (
              <div
                key={group.key}
                className={cn('h-full', group.colorClassName)}
                style={{ width: `${totalHosts === 0 ? 0 : (group.count / totalHosts) * 100}%` }}
                title={`${group.label} ${group.count}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {groups.map((group) => (
              <div key={group.key} className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', group.colorClassName)} />
                <span className="text-xs text-[var(--workspace-text-muted)]">{group.label}</span>
                <span className="text-xs font-semibold text-[var(--workspace-text-strong)]">{group.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface HostsDashboardProps {
  activeVaultId?: string
  hosts: HostProfile[]
  selectedHostId: string | null
  loading: boolean
  defaultUsername?: string
  onSelectHost: (hostId: string) => void
  onConnectHost?: (hostId: string) => void
  onCreateHost: (draft: HostProfileDraft) => Promise<void>
  onUpdateHost: (host: HostProfile, draft: HostProfileDraft) => Promise<void>
  onDeleteHost: (hostId: string) => Promise<void>
  openAddForm?: boolean
  onAddFormClose?: () => void
  externalSearch?: string
  onExternalSearchChange?: (q: string) => void
  onScanHosts?: (hosts: HostProfile[]) => Promise<void>
  onRefreshHosts?: () => Promise<void>
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultName?: string
  headerExtraAction?: ReactNode
}

function hostOpsToCardSummary(view?: HostOpsView): HostOperationalSummary | undefined {
  if (!view) return undefined
  const latestAudit = view.latestAudit
  const alertSummary = view.health.alertSummary
  return {
    serviceTotal: view.serviceSummary.total,
    serviceActive: view.serviceSummary.active,
    serviceFailed: view.serviceSummary.failed,
    processTotal: view.processSummary.total,
    processRunning: view.processSummary.pm2,
    ...(alertSummary ? {
      alertTotal: alertSummary.total,
      alertActive: alertSummary.active,
      alertUnsupported: alertSummary.unsupported === true,
    } : {}),
    auditCount: view.operationSummary.total,
    latestAudit: latestAudit
      ? {
          action: latestAudit.action,
          target: latestAudit.target,
          status: latestAudit.status,
          createdAt: latestAudit.createdAt,
          transport: latestAudit.transport,
          provider: latestAudit.provider,
        }
      : undefined,
    provider: view.health.provider === 'unknown' ? undefined : view.health.provider,
    sampledAt: view.health.freshness.sampledAt ?? undefined,
    transport: view.health.transport,
    ...(view.health.agent ? {
      agentStatus: view.health.agent.status,
      agentHealth: view.health.agent.health,
      agentVersion: view.health.agent.version,
      agentHeartbeatAt: view.health.agent.lastHeartbeatAt,
    } : {}),
  }
}

export function HostsDashboard({
  activeVaultId,
  hosts, selectedHostId, loading, defaultUsername = 'root',
  onSelectHost, onConnectHost, onCreateHost, onUpdateHost, onDeleteHost,
  openAddForm = false, onAddFormClose,
    externalSearch, onExternalSearchChange, onScanHosts, onRefreshHosts,
    vaultKeys = [], vaultUnlocked = false, onSaveToVault, onLoadVaultSecret, vaultName = 'Vault',
    headerExtraAction,
}: HostsDashboardProps) {
  const [internalSearch, setInternalSearch] = useState('')
  const effectiveSearch = externalSearch ?? internalSearch
  const setEffectiveSearch = onExternalSearchChange ?? setInternalSearch
  const [groupFilter, setGroupFilter] = useState('All')
  const [showAddForm, setShowAddForm] = useState(openAddForm)
  useEffect(() => { setShowAddForm((prev) => (openAddForm ? true : prev)) }, [openAddForm])
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [showSshImport, setShowSshImport] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem(SORT_KEY) as SortMode) || 'newest')
  const [statusFilter, setStatusFilter] = useState<HostStatusFilter>('all')
  const [sortOpen, setSortOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const { t } = useT()
  const sharedStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))
  const [hostOpsViews, setHostOpsViews] = useState<Record<string, HostOpsView>>({})
  const [hostOpsLoading, setHostOpsLoading] = useState(false)
  const refreshHostOps = useCallback(async (forceKomari = false) => {
    setHostOpsLoading(true)
    try {
      let komariSnapshots = undefined
      if (activeVaultId && onLoadVaultSecret) {
        const integrations = await listKomariIntegrations(activeVaultId).catch(() => [])
        const syncResults = await Promise.allSettled(
          integrations
            .filter((integration) => integration.enabled)
            .map(async (integration) => {
              const cached = await loadKomariPersistence(integration.id).catch(() => ({ snapshots: [], mappings: [], syncState: null, lastSyncedAt: null }))
              const cachedSnapshots = cached.snapshots.map((entry) => entry.snapshot)
              const cachedAlertState = readKomariAlertState(cached.syncState)
              const lastSyncedAt = cached.lastSyncedAt
              const ttlMs = cached.syncState?.ttlMs ?? DEFAULT_KOMARI_SYNC_TTL_MS
              if (!forceKomari && isKomariSyncFresh(lastSyncedAt, Date.now(), ttlMs)) {
                return cachedSnapshots
              }

              const apiKey = await onLoadVaultSecret(integration.credentialRef)
              if (!apiKey) return cachedSnapshots
              const result = await syncKomariIntegration({
                integrationId: integration.id,
                config: { endpoint: integration.endpoint, token: apiKey },
                hosts,
                lastSyncedAt,
                ttlMs,
                force: forceKomari,
                alertState: cachedAlertState,
              })
              if (!result.skipped) {
                await persistKomariSync({
                  integrationId: integration.id,
                  // Keep the last successful metric row when a later probe
                  // only returns an error or an empty Komari record.
                  snapshots: result.snapshots.filter((snapshot) => snapshot.metrics !== null),
                  mappings: result.mapping.mappings,
                  updatedAt: result.syncedAt,
                  ttlMs,
                  alertSummary: result.alerts,
                  alertState: result.alertState,
                }).catch(() => undefined)
              }
              return result.skipped ? cachedSnapshots : result.snapshots
            }),
        )
        komariSnapshots = syncResults
          .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof syncKomariIntegration>>['snapshots']> => result.status === 'fulfilled')
          .flatMap((result) => result.value)
      }
      setHostOpsViews(await loadHostOpsViews(hosts, { auditLimit: 250, komariSnapshots, vaultId: activeVaultId }))
    } catch {
      setHostOpsViews({})
    } finally {
      setHostOpsLoading(false)
    }
  }, [activeVaultId, hosts, onLoadVaultSecret])

  useEffect(() => { void refreshHostOps() }, [activeVaultId, refreshHostOps])



  const operationalSummaryByHost = useMemo(() => {
    const summaries = new Map<string, HostOperationalSummary | undefined>()
    hosts.forEach((host) => summaries.set(host.id, hostOpsToCardSummary(hostOpsViews[host.id])))
    return summaries
  }, [hostOpsViews, hosts])

  function hostKey(host: HostProfile) {
    return getWorkspaceInventoryHostKey(host)
  }

  function handleSortChange(mode: SortMode) {
    setSortMode(mode)
    localStorage.setItem(SORT_KEY, mode)
    setSortOpen(false)
  }

  const allExistingGroups = useMemo(() => {
    const set = new Set<string>([...DEFAULT_GROUPS])
    hosts.forEach((h) => { if (h.group) set.add(h.group) })
    return Array.from(set)
  }, [hosts])

  const allExistingTags = useMemo(() => {
    const set = new Set<string>()
    hosts.forEach((h) => h.tags?.forEach((tg) => set.add(tg)))
    return Array.from(set).sort()
  }, [hosts])

  function handleConnect(hostId: string) {
    onSelectHost(hostId)
    onConnectHost?.(hostId)
  }

  async function handleCheckAllStatus() {
    if (!onScanHosts || filteredHosts.length === 0) return
    setCheckingStatus(true)
    try {
      await onScanHosts(filteredHosts)
      await refreshHostOps()
    } finally {
      setCheckingStatus(false)
    }
  }

  const handleRefreshAll = useCallback(async () => {
    await Promise.allSettled([
      onRefreshHosts?.(),
      refreshHostOps(true),
    ])
  }, [onRefreshHosts, refreshHostOps])

  const filteredHosts = useMemo(() => {
    const q = effectiveSearch.trim().toLowerCase()
    let filtered = hosts
    if (q) {
      filtered = hosts.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.address.toLowerCase().includes(q) ||
          (h.username && h.username.toLowerCase().includes(q)) ||
          (h.jumpHost && h.jumpHost.toLowerCase().includes(q)) ||
          (h.jumpUser && h.jumpUser.toLowerCase().includes(q)) ||
          (h.jumpPort && String(h.jumpPort).includes(q)) ||
          (h.group && h.group.toLowerCase().includes(q)) ||
          (h.tags && h.tags.some((tag) => tag.toLowerCase().includes(q)))
      )
    }
    if (groupFilter !== 'All') {
      filtered = filtered.filter((h) => (h.group || 'Custom') === groupFilter)
    }
    if (tagFilter.size > 0) {
      filtered = filtered.filter((h) => h.tags?.some((tg) => tagFilter.has(tg)))
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter((h) => getHostHealthStatus(hostOpsViews[h.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(h)]), hostOpsLoading) === statusFilter)
    }
    const sorted = [...filtered]
    switch (sortMode) {
      case 'az': sorted.sort((a, b) => a.name.localeCompare(b.name)); break
      case 'za': sorted.sort((a, b) => b.name.localeCompare(a.name)); break
      case 'newest': sorted.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)); break
      case 'oldest': sorted.sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt)); break
    }
    return sorted
  }, [hosts, effectiveSearch, groupFilter, sharedStates, statusFilter, tagFilter, sortMode, hostOpsLoading, hostOpsViews])

  const statusCounts = useMemo(() => hosts.reduce<Record<Exclude<HostStatusFilter, 'all'>, number>>((counts, host) => {
    const status = getHostHealthStatus(hostOpsViews[host.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(host)]), hostOpsLoading)
    counts[status] += 1
    return counts
  }, { online: 0, stale: 0, checking: 0, offline: 0, paused: 0, unknown: 0, 'jump-unavailable': 0 }), [hosts, sharedStates, hostOpsLoading, hostOpsViews])

  const allGroupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    hosts.forEach((h) => {
      const g = h.group || 'Custom'
      counts.set(g, (counts.get(g) ?? 0) + 1)
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [hosts])
  const resourceGroups = useMemo<WorkspaceResourceGroup[]>(() => (
    allGroupCounts.map(([group, count], index) => ({
      key: group,
      label: t(`group.${group}`) !== `group.${group}` ? t(`group.${group}`) : group,
      count,
      colorClassName: groupColors[index % groupColors.length],
    }))
  ), [allGroupCounts, t])
  const statusFilterLabels: Record<HostStatusFilter, string> = {
    all: t('hosts.statusAll'),
    online: t('hosts.statusOnline'),
    stale: t('hosts.statusStale'),
    checking: t('hosts.statusChecking'),
    offline: t('hosts.statusOffline'),
    paused: t('hosts.statusPaused'),
    unknown: t('hosts.statusUnknown'),
    'jump-unavailable': t('hosts.statusJumpUnavailable'),
  }

  return (
    <div className="flex min-w-0 w-full flex-col text-[var(--workspace-text)]">
      {SHOW_HOST_SUMMARY_STRIP && (
        <HostSummaryStrip
          totalHosts={hosts.length}
          onlineCount={statusCounts.online}
          checkingCount={statusCounts.checking}
          offlineCount={statusCounts.offline}
          groups={resourceGroups}
        />
      )}
      <WorkspaceResourceOverviewHeader
        title={t('hosts.title')}
        description={t('hosts.subtitle')}
        total={hosts.length}
        totalLabel={t('hosts.totalHosts')}
        visibleCount={filteredHosts.length}
        visibleLabel={t('hosts.totalHosts')}
        groups={resourceGroups}
        selectedGroup={groupFilter}
        allGroupLabel={t('hosts.all')}
        onGroupSelect={setGroupFilter}
        actions={
          <>
            {headerExtraAction}
            <select
              aria-label={t('hosts.statusFilter')}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as HostStatusFilter)}
              className="h-9 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs font-medium text-[var(--workspace-text-muted)] outline-none transition-colors hover:text-[var(--workspace-text-strong)] focus:border-[color:var(--workspace-border-glow)]"
            >
              {(Object.keys(statusFilterLabels) as HostStatusFilter[]).map((status) => (
                <option key={status} value={status}>{statusFilterLabels[status]}</option>
              ))}
            </select>
            <div className="relative">
              <button type="button" onClick={() => { setTagFilterOpen((v) => !v); setSortOpen(false) }}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  tagFilter.size > 0 ? 'border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
                <Tag className="h-3.5 w-3.5" />
                {tagFilter.size > 0 ? (
                  <>
                    <span className="hidden sm:inline">{tagFilter.size} {t('hosts.tagsSelected')}</span>
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--workspace-accent-muted)] sm:hidden"><span className="text-[10px] text-[var(--workspace-text-strong)]">{tagFilter.size}</span></span>
                  </>
                ) : (
                  <span className="hidden sm:inline">{t('hosts.filterByTag')}</span>
                )}
                <ChevronDown className="h-3 w-3" />
              </button>
              {tagFilterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTagFilterOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-xl">
                    {tagFilter.size > 0 && (
                      <button type="button" onClick={() => { setTagFilter(new Set()); setTagFilterOpen(false) }}
                        className="flex w-full items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2 text-xs text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]">
                        <X className="h-3 w-3" />{t('hosts.clearTags')}
                      </button>
                    )}
                    <div className="max-h-60 overflow-y-auto p-1">
                      {allExistingTags.length === 0 ? (
                        <p className="px-3 py-3 text-center text-xs text-[var(--workspace-text-muted)]">{t('hosts.noTags')}</p>
                      ) : allExistingTags.map((tg) => {
                        const active = tagFilter.has(tg)
                        return (
                          <button key={tg} type="button"
                            onClick={() => setTagFilter((prev) => { const next = new Set(prev); if (active) next.delete(tg); else next.add(tg); return next })}
                            className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                              active ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]')}>
                            <span className={cn('flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                              active ? 'border-[color:var(--workspace-accent-solid)] bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)]' : 'border-[color:var(--workspace-border-soft)]')}>
                              {active && '✓'}
                            </span>
                            <span className="flex-1 text-left truncate">{tg}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button type="button" onClick={() => { setSortOpen((v) => !v); setTagFilterOpen(false) }}
                className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 py-1.5 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]">
                {sortMode === 'az' && <ArrowDownAZ className="h-3.5 w-3.5" />}
                {sortMode === 'za' && <ArrowUpZA className="h-3.5 w-3.5" />}
                {sortMode === 'newest' && <CalendarArrowDown className="h-3.5 w-3.5" />}
                {sortMode === 'oldest' && <CalendarArrowUp className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">{t(`hosts.sort.${sortMode}`)}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-xl">
                    {([['az', ArrowDownAZ], ['za', ArrowUpZA], ['newest', CalendarArrowDown], ['oldest', CalendarArrowUp]] as const).map(([mode, Icon]) => (
                      <button key={mode} type="button" onClick={() => handleSortChange(mode)}
                        className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                          sortMode === mode ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]')}>
                        <Icon className="h-4 w-4" />
                        <span className="flex-1 text-left">{t(`hosts.sort.${mode}`)}</span>
                        {sortMode === mode && <span className="text-[color:var(--workspace-accent-solid)]">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-0.5">
              <button type="button" onClick={() => setViewMode('grid')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'grid' ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')} title={t('hosts.gridView')}>
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setViewMode('list')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'list' ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')} title={t('hosts.listView')}>
                <List className="h-4 w-4" />
              </button>
            </div>
          </>
        }
        search={externalSearch === undefined && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <Input value={effectiveSearch} onChange={(e) => setEffectiveSearch(e.target.value)} placeholder={t('hosts.search')} className="h-10 border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] pl-9 text-sm text-[var(--workspace-text-strong)] placeholder:text-[var(--workspace-text-subtle)]" />
          </div>
        )}
        controls={
          <>
          <div className="flex-1" />
          {onScanHosts && filteredHosts.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => void handleCheckAllStatus()} disabled={checkingStatus} className="h-9 gap-1.5 text-xs">
              <RefreshCw className={cn('h-3.5 w-3.5', checkingStatus && 'animate-spin')} />
              {checkingStatus ? t('hosts.checking') : t('hosts.checkStatus')}
            </Button>
          )}
          <button
            type="button"
            onClick={() => setShowSshImport(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
          >
            <FileDown className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('hosts.importSsh')}</span>
          </button>
          <Button data-tour="host-create" size="sm" onClick={() => setShowAddForm(!showAddForm)} className="h-9 gap-1.5 text-xs bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-400)]">
            <Plus className="h-3.5 w-3.5" /> {t('hosts.newConnection')}
          </Button>
          </>
        }
      >
          <HostCreateDialog
            open={showAddForm}
            defaultUsername={defaultUsername}
            vaultKeys={vaultKeys}
            vaultUnlocked={vaultUnlocked}
            onSaveToVault={onSaveToVault}
            onLoadVaultSecret={onLoadVaultSecret}
            vaultName={vaultName}
            existingGroups={allExistingGroups}
            existingTags={allExistingTags}
            onSubmit={async (draft) => { await onCreateHost(draft); setShowAddForm(false); onAddFormClose?.() }}
            onCancel={() => { setShowAddForm(false); onAddFormClose?.() }}
          />

          <HostEditorDialog
            host={editingHost}
            defaultUsername={defaultUsername}
            vaultKeys={vaultKeys}
            vaultUnlocked={vaultUnlocked}
            onSaveToVault={onSaveToVault}
            onLoadVaultSecret={onLoadVaultSecret}
            vaultName={vaultName}
            existingGroups={allExistingGroups}
            existingTags={allExistingTags}
            onSubmit={async (host, draft) => { await onUpdateHost(host, draft); setEditingHost(null) }}
            onCancel={() => setEditingHost(null)}
          />

        <PullToRefresh onRefresh={handleRefreshAll} className="min-w-0 overflow-visible pb-6">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <RefreshCw className="h-8 w-8 animate-spin text-[var(--workspace-text-subtle)]" />
                <p className="mt-3 text-sm text-[var(--workspace-text-muted)]">{t('hosts.loading')}</p>
              </div>
            ) : filteredHosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--workspace-surface-700)]">
                  <Server className="h-8 w-8 text-[var(--workspace-text-subtle)]" />
                </div>
                <p className="text-sm font-medium text-[var(--workspace-text-strong)]">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatch') : t('hosts.noHosts')}
                </p>
                <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatchHint') : t('hosts.noHostsHint')}
                </p>
                {!effectiveSearch.trim() && groupFilter === 'All' && (
                  <Button className="mt-5 gap-1.5 bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-400)]" onClick={() => setShowAddForm(true)}><Plus className="h-4 w-4" /> {t('hosts.addHost')}</Button>
                )}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredHosts.map((host) => (
                  <HostGridCard
                    key={host.id}
                    host={host}
                    isSelected={selectedHostId === host.id}
                    status={getHostHealthStatus(hostOpsViews[host.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(host)]), hostOpsLoading)}
                    resource={hostOpsViews[host.id]?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource}
                    operations={operationalSummaryByHost.get(host.id)}
                    network={networkByAddress[host.address]}
                    onConnect={handleConnect}
                    onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                    onDelete={(id) => void onDeleteHost(id)}
                    onSelect={onSelectHost}
                  />
                ))}
              </div>
            ) : (
              <div className="min-w-0 rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-card)]">
                <div className="flex flex-col gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-[var(--workspace-text-strong)]">{t('hosts.activeHosts')}</div>
                    <div className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{t('hosts.listPanelMeta', { visible: filteredHosts.length, total: hosts.length })}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {statusFilter !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-accent-text)] transition-colors hover:bg-[var(--workspace-accent-muted)]"
                      >
                        <X className="h-3 w-3" />
                        {statusFilterLabels[statusFilter]}
                      </button>
                    )}
                    {tagFilter.size > 0 && (
                      <span className="rounded-full border border-[color:var(--workspace-border-glow)] bg-[var(--workspace-accent-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-accent-text)]">
                        {tagFilter.size} {t('hosts.tagsSelected')}
                      </span>
                    )}
                    {groupFilter !== 'All' && (
                      <span className="rounded-full border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 py-1 text-[11px] font-medium text-[var(--workspace-text-muted)]">
                        {t(`group.${groupFilter}`) !== `group.${groupFilter}` ? t(`group.${groupFilter}`) : groupFilter}
                      </span>
                    )}
                  </div>
                </div>
                <HostListScrollArea>
                    <div className="hidden border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-subtle)] xl:grid xl:grid-cols-[3.25rem_minmax(14rem,1.14fr)_minmax(12rem,0.92fr)_minmax(10rem,0.75fr)_7rem_minmax(15rem,1.02fr)_minmax(14rem,1fr)_7rem_6.5rem] xl:items-center xl:gap-4">
                      <span>{t('hosts.columnIndex')}</span>
                      <span>{t('hosts.columnHost')}</span>
                      <span>{t('hosts.columnLocation')}</span>
                      <span>{t('hosts.columnIp')}</span>
                      <span>{t('hosts.columnUpdated')}</span>
                      <span>{t('hosts.columnResource')}</span>
                      <span>{t('hosts.columnOperations')}</span>
                      <span>{t('hosts.columnStatus')}</span>
                      <span className="text-right">{t('hosts.columnActions')}</span>
                    </div>
                    <div className="space-y-2 p-3">
                      {filteredHosts.map((host, index) => (
                        <HostListItem
                          key={host.id}
                          index={index + 1}
                          host={host}
                          isSelected={selectedHostId === host.id}
                          status={getHostHealthStatus(hostOpsViews[host.id], getWorkspaceInventoryHealthStatus(sharedStates[hostKey(host)]), hostOpsLoading)}
                          resource={hostOpsViews[host.id]?.resource ?? sharedStates[hostKey(host)]?.inventory?.resource}
                          operations={operationalSummaryByHost.get(host.id)}
                          network={networkByAddress[host.address]}
                          onSelect={onSelectHost}
                          onConnect={handleConnect}
                          onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                          onDelete={(id) => void onDeleteHost(id)}
                        />
                      ))}
                    </div>
                </HostListScrollArea>
              </div>
            )}
        </PullToRefresh>
      </WorkspaceResourceOverviewHeader>

        {showSshImport && (
          <SshImportDialog
            onClose={() => setShowSshImport(false)}
            onImported={() => { setShowSshImport(false); onRefreshHosts?.() }}
          />
        )}
    </div>
  )
}

const groupColors = [
  'bg-[color:var(--workspace-primary-500)]',
  'bg-[color:var(--workspace-status-good)]',
  'bg-[color:var(--workspace-status-info)]',
  'bg-[color:var(--workspace-status-warn)]',
  'bg-[color:var(--workspace-group-staging)]',
  'bg-[color:var(--workspace-status-bad)]',
  'bg-[color:var(--workspace-metric-network-from)]',
  'bg-[color:var(--workspace-group-default)]',
]
