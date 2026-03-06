import { useEffect, useMemo, useState } from 'react'
import { Search, Plus, Server, RefreshCw, LayoutGrid, List, FileDown, ArrowDownAZ, ArrowUpZA, CalendarArrowDown, CalendarArrowUp, ChevronDown, Tag, X } from 'lucide-react'
import { HostForm } from '@/components/host-form'
import { SshImportDialog } from './ssh-import-dialog'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'
import { DEFAULT_GROUPS } from '@/lib/hosts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { HostGridCard, HostListItem } from '@/components/host-card'
import { PullToRefresh } from '@/components/pull-to-refresh'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

type SortMode = 'az' | 'za' | 'newest' | 'oldest'
const SORT_KEY = 'shellbeam.hostSortMode'

function computeGroupTabs(hosts: HostProfile[]) {
  const groups = new Set(hosts.map((h) => h.group).filter(Boolean))
  DEFAULT_GROUPS.forEach((g) => groups.add(g))
  return ['All', ...Array.from(groups)]
}

interface HostsDashboardProps {
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
  onCheckHostStatus?: (host: HostProfile) => Promise<'online' | 'offline'>
  onRefreshHosts?: () => Promise<void>
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  vaultName?: string
}

export function HostsDashboard({
  hosts, selectedHostId, loading, defaultUsername = 'root',
  onSelectHost, onConnectHost, onCreateHost, onUpdateHost, onDeleteHost,
    openAddForm = false, onAddFormClose,
    externalSearch, onExternalSearchChange, onCheckHostStatus, onRefreshHosts,
    vaultKeys = [], vaultUnlocked = false, onSaveToVault, vaultName = 'Vault',
}: HostsDashboardProps) {
  const [internalSearch, setInternalSearch] = useState('')
  const effectiveSearch = externalSearch ?? internalSearch
  const setEffectiveSearch = onExternalSearchChange ?? setInternalSearch
  const [groupFilter, setGroupFilter] = useState('All')
  const allGroups = useMemo(() => computeGroupTabs(hosts), [hosts])
  const [showAddForm, setShowAddForm] = useState(openAddForm)
  useEffect(() => { setShowAddForm((prev) => (openAddForm ? true : prev)) }, [openAddForm])
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [statusByHostId, setStatusByHostId] = useState<Record<string, 'online' | 'offline' | 'checking'>>({})
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [showSshImport, setShowSshImport] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem(SORT_KEY) as SortMode) || 'newest')
  const [sortOpen, setSortOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const { t } = useT()

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
    if (!onCheckHostStatus || filteredHosts.length === 0) return
    setCheckingStatus(true)
    setStatusByHostId((prev) => {
      const next = { ...prev }
      for (const h of filteredHosts) next[h.id] = 'checking'
      return next
    })
    for (const host of filteredHosts) {
      try {
        const status = await onCheckHostStatus(host)
        setStatusByHostId((prev) => ({ ...prev, [host.id]: status }))
      } catch {
        setStatusByHostId((prev) => ({ ...prev, [host.id]: 'offline' as const }))
      }
    }
    setCheckingStatus(false)
  }

  const filteredHosts = useMemo(() => {
    const q = effectiveSearch.trim().toLowerCase()
    let filtered = hosts
    if (q) {
      filtered = hosts.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.address.toLowerCase().includes(q) ||
          (h.username && h.username.toLowerCase().includes(q)) ||
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
    const sorted = [...filtered]
    switch (sortMode) {
      case 'az': sorted.sort((a, b) => a.name.localeCompare(b.name)); break
      case 'za': sorted.sort((a, b) => b.name.localeCompare(a.name)); break
      case 'newest': sorted.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)); break
      case 'oldest': sorted.sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt)); break
    }
    return sorted
  }, [hosts, effectiveSearch, groupFilter, tagFilter, sortMode])

  const groupedHosts = useMemo(() => {
    const groups = new Map<string, HostProfile[]>()
    for (const host of filteredHosts) {
      const key = host.group || 'Custom'
      groups.set(key, [...(groups.get(key) ?? []), host])
    }
    return Array.from(groups.entries())
  }, [filteredHosts])

  const onlineCount = Object.values(statusByHostId).filter((s) => s === 'online').length

  const allGroupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    hosts.forEach((h) => {
      const g = h.group || 'Custom'
      counts.set(g, (counts.get(g) ?? 0) + 1)
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [hosts])

  return (
    <div className="flex w-full flex-col">
      <StatsRow hostsTotal={hosts.length} onlineCount={onlineCount} groupCounts={allGroupCounts} />

      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('hosts.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('hosts.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button type="button" onClick={() => { setTagFilterOpen((v) => !v); setSortOpen(false) }}
                className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                  tagFilter.size > 0 ? 'border-primary/50 bg-primary/5 text-primary' : 'text-muted-foreground hover:text-foreground')}>
                <Tag className="h-3.5 w-3.5" />
                {tagFilter.size > 0 ? (
                  <>
                    <span className="hidden sm:inline">{tagFilter.size} {t('hosts.tagsSelected')}</span>
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 sm:hidden"><span className="text-[10px]">{tagFilter.size}</span></span>
                  </>
                ) : (
                  <span className="hidden sm:inline">{t('hosts.filterByTag')}</span>
                )}
                <ChevronDown className="h-3 w-3" />
              </button>
              {tagFilterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setTagFilterOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
                    {tagFilter.size > 0 && (
                      <button type="button" onClick={() => { setTagFilter(new Set()); setTagFilterOpen(false) }}
                        className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
                        <X className="h-3 w-3" />{t('hosts.clearTags')}
                      </button>
                    )}
                    <div className="max-h-60 overflow-y-auto p-1">
                      {allExistingTags.length === 0 ? (
                        <p className="px-3 py-3 text-center text-xs text-muted-foreground">{t('hosts.noTags')}</p>
                      ) : allExistingTags.map((tg) => {
                        const active = tagFilter.has(tg)
                        return (
                          <button key={tg} type="button"
                            onClick={() => setTagFilter((prev) => { const next = new Set(prev); if (active) next.delete(tg); else next.add(tg); return next })}
                            className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                              active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted')}>
                            <span className={cn('flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                              active ? 'border-primary bg-primary text-white' : 'border-border')}>
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
                className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
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
                  <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                    {([['az', ArrowDownAZ], ['za', ArrowUpZA], ['newest', CalendarArrowDown], ['oldest', CalendarArrowUp]] as const).map(([mode, Icon]) => (
                      <button key={mode} type="button" onClick={() => handleSortChange(mode)}
                        className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                          sortMode === mode ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted')}>
                        <Icon className="h-4 w-4" />
                        <span className="flex-1 text-left">{t(`hosts.sort.${mode}`)}</span>
                        {sortMode === mode && <span className="text-primary">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="flex rounded-lg border p-0.5">
              <button type="button" onClick={() => setViewMode('grid')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')} title={t('hosts.gridView')}>
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setViewMode('list')} className={cn('rounded-md p-1.5 transition-colors', viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')} title={t('hosts.listView')}>
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="flex min-h-[200px] min-w-0 flex-1 flex-col px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {externalSearch === undefined && (
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={effectiveSearch} onChange={(e) => setEffectiveSearch(e.target.value)} placeholder={t('hosts.search')} className="h-9 pl-9 text-sm" />
              </div>
            )}
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-0.5">
              {allGroups.map((g) => {
                const label = g === 'All' ? t('hosts.all') : (t(`group.${g}`) !== `group.${g}` ? t(`group.${g}`) : g)
                return (
                  <button key={g} type="button" onClick={() => setGroupFilter(g)} className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3', groupFilter === g ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="flex-1" />
            {onCheckHostStatus && filteredHosts.length > 0 && (
              <Button size="sm" variant="outline" onClick={handleCheckAllStatus} disabled={checkingStatus} className="h-9 gap-1.5 text-xs">
                <RefreshCw className={cn('h-3.5 w-3.5', checkingStatus && 'animate-spin')} />
                {checkingStatus ? t('hosts.checking') : t('hosts.checkStatus')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => setShowSshImport(true)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted"
            >
              <FileDown className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('hosts.importSsh')}</span>
            </button>
            <Button size="sm" onClick={() => setShowAddForm(!showAddForm)} className="h-9 gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> {t('hosts.newConnection')}
            </Button>
          </div>

          <Dialog open={showAddForm} onOpenChange={(o) => { setShowAddForm(o); if (!o) onAddFormClose?.() }}>
            <DialogContent>
              <HostForm
                defaultUsername={defaultUsername} vaultKeys={vaultKeys} vaultUnlocked={vaultUnlocked}
                onSaveToVault={onSaveToVault} vaultName={vaultName}
                existingGroups={allExistingGroups} existingTags={allExistingTags}
                onSubmit={async (draft) => { await onCreateHost(draft); setShowAddForm(false); onAddFormClose?.() }}
                onCancel={() => { setShowAddForm(false); onAddFormClose?.() }}
              />
            </DialogContent>
          </Dialog>

          <Dialog open={!!editingHost} onOpenChange={(o) => { if (!o) setEditingHost(null) }}>
            <DialogContent>
              {editingHost && (
                <HostForm
                  initial={editingHost}
                  defaultUsername={defaultUsername} vaultKeys={vaultKeys} vaultUnlocked={vaultUnlocked}
                  onSaveToVault={onSaveToVault} vaultName={vaultName}
                  existingGroups={allExistingGroups} existingTags={allExistingTags}
                  onSubmit={async (draft) => { await onUpdateHost(editingHost, draft); setEditingHost(null) }}
                  onCancel={() => setEditingHost(null)}
                />
              )}
            </DialogContent>
          </Dialog>

          <PullToRefresh onRefresh={onRefreshHosts ?? (async () => {})} className="pb-6">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">{t('hosts.loading')}</p>
              </div>
            ) : filteredHosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
                  <Server className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatch') : t('hosts.noHosts')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {effectiveSearch.trim() || groupFilter !== 'All' ? t('hosts.noMatchHint') : t('hosts.noHostsHint')}
                </p>
                {!effectiveSearch.trim() && groupFilter === 'All' && (
                  <Button className="mt-5 gap-1.5" onClick={() => setShowAddForm(true)}><Plus className="h-4 w-4" /> {t('hosts.addHost')}</Button>
                )}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredHosts.map((host) => (
                  <HostGridCard
                    key={host.id}
                    host={host}
                    isSelected={selectedHostId === host.id}
                    status={statusByHostId[host.id]}
                    onConnect={handleConnect}
                    onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                    onDelete={(id) => void onDeleteHost(id)}
                    onSelect={onSelectHost}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-5">
                {groupedHosts.map(([grp, groupHosts]) => (
                  <div key={grp}>
                    <div className="mb-2 flex items-center gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t(`group.${grp}`) !== `group.${grp}` ? t(`group.${grp}`) : grp}</p>
                      <span className="text-[10px] text-muted-foreground/50">{groupHosts.length}</span>
                      <div className="flex-1 border-t border-border/30" />
                    </div>
                    <div className="space-y-1">
                      {groupHosts.map((host) => (
                        <HostListItem
                          key={host.id}
                          host={host}
                          isSelected={selectedHostId === host.id}
                          status={statusByHostId[host.id]}
                          onSelect={onSelectHost}
                          onConnect={handleConnect}
                          onEdit={(id) => { const h = hosts.find((x) => x.id === id); if (h) setEditingHost(h) }}
                          onDelete={(id) => void onDeleteHost(id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PullToRefresh>
        </div>
      </div>

        {showSshImport && (
          <SshImportDialog
            onClose={() => setShowSshImport(false)}
            onImported={() => { setShowSshImport(false); onRefreshHosts?.() }}
          />
        )}
    </div>
  )
}

const groupColors = ['bg-primary', 'bg-emerald-500', 'bg-blue-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500', 'bg-cyan-500', 'bg-orange-500']

function StatsRow({ hostsTotal, onlineCount, groupCounts }: { hostsTotal: number; onlineCount: number; groupCounts: [string, number][] }) {
  const { t } = useT()
  const groupLabel = (g: string) => t(`group.${g}`) !== `group.${g}` ? t(`group.${g}`) : g
  if (hostsTotal === 0) return null
  return (
    <div className="shrink-0 px-6 pt-6 pb-2">
      <div className="flex items-center gap-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold tracking-tight">{hostsTotal}</span>
          <span className="text-sm text-muted-foreground">{t('hosts.totalHosts')}</span>
        </div>
        {onlineCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t('hosts.online', { n: onlineCount })}
          </span>
        )}
      </div>
      {groupCounts.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            {groupCounts.map(([g, count], i) => (
              <div key={g} className={cn('h-full transition-all', groupColors[i % groupColors.length])}
                style={{ width: `${(count / hostsTotal) * 100}%` }}
                title={`${groupLabel(g)}: ${count}`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {groupCounts.map(([g, count], i) => (
              <div key={g} className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', groupColors[i % groupColors.length])} />
                <span className="text-xs text-muted-foreground">{groupLabel(g)}</span>
                <span className="text-xs font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
