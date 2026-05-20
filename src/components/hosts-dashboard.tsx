import { HostGridCard, HostListItem } from '@/components/host-card'
import { HostCreateDialog } from '@/components/host-create-dialog'
import { HostEditorDialog } from '@/components/host-editor-dialog'
import { PullToRefresh } from '@/components/pull-to-refresh'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { HostProfile, HostProfileDraft } from '@/lib/hosts'
import { DEFAULT_GROUPS } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getWorkspaceInventoryDisplayStatus, useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import { ArrowDownAZ, ArrowUpZA, CalendarArrowDown, CalendarArrowUp, ChevronDown, FileDown, LayoutGrid, List, Plus, RefreshCw, Search, Server, Tag, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SshImportDialog } from './ssh-import-dialog'
import { WorkspaceResourceOverviewHeader, type WorkspaceResourceGroup } from './workspace/workspace-resource-overview-header'

type SortMode = 'az' | 'za' | 'newest' | 'oldest'
const SORT_KEY = 'shellbeam.hostSortMode'

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
  onScanHosts?: (hosts: HostProfile[]) => Promise<void>
  onRefreshHosts?: () => Promise<void>
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  vaultName?: string
}

export function HostsDashboard({
  hosts, selectedHostId, loading, defaultUsername = 'root',
  onSelectHost, onConnectHost, onCreateHost, onUpdateHost, onDeleteHost,
  openAddForm = false, onAddFormClose,
    externalSearch, onExternalSearchChange, onScanHosts, onRefreshHosts,
    vaultKeys = [], vaultUnlocked = false, onSaveToVault, onLoadVaultSecret, vaultName = 'Vault',
}: HostsDashboardProps) {
  const [internalSearch, setInternalSearch] = useState('')
  const effectiveSearch = externalSearch ?? internalSearch
  const setEffectiveSearch = onExternalSearchChange ?? setInternalSearch
  const [groupFilter, setGroupFilter] = useState('All')
  const [showAddForm, setShowAddForm] = useState(openAddForm)
  useEffect(() => { setShowAddForm((prev) => (openAddForm ? true : prev)) }, [openAddForm])
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [showSshImport, setShowSshImport] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem(SORT_KEY) as SortMode) || 'newest')
  const [sortOpen, setSortOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const { t } = useT()
  const sharedStates = useWorkspaceInventoryStates()

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
    } finally {
      setCheckingStatus(false)
    }
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

  const onlineCount = hosts.filter((host) => getWorkspaceInventoryDisplayStatus(sharedStates[hostKey(host)]) === 'online').length

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

  return (
    <div className="flex w-full flex-col overflow-x-hidden text-[var(--workspace-text)]">
      <WorkspaceResourceOverviewHeader
        title={t('hosts.title')}
        description={t('hosts.subtitle')}
        total={hosts.length}
        totalLabel={t('hosts.totalHosts')}
        totalMeta={onlineCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--workspace-status-good-bg)] px-2.5 py-1 text-xs font-medium text-[color:var(--workspace-status-good-text)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--workspace-status-good)]" />
            {t('hosts.online', { n: onlineCount })}
          </span>
        )}
        visibleCount={filteredHosts.length}
        visibleLabel={t('hosts.totalHosts')}
        groups={resourceGroups}
        selectedGroup={groupFilter}
        allGroupLabel={t('hosts.all')}
        onGroupSelect={setGroupFilter}
        actions={
          <>
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
          <Button size="sm" onClick={() => setShowAddForm(!showAddForm)} className="h-9 gap-1.5 text-xs bg-[color:var(--workspace-primary-500)] text-[color:var(--workspace-primary-foreground)] hover:bg-[color:var(--workspace-primary-400)]">
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

        <PullToRefresh onRefresh={onRefreshHosts ?? (async () => {})} className="pb-6">
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
                    status={getWorkspaceInventoryDisplayStatus(sharedStates[hostKey(host)])}
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
                      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--workspace-text-muted)]">{t(`group.${grp}`) !== `group.${grp}` ? t(`group.${grp}`) : grp}</p>
                      <span className="text-[10px] text-[var(--workspace-text-subtle)]">{groupHosts.length}</span>
                      <div className="flex-1 border-t border-[color:var(--workspace-border-soft)]" />
                    </div>
                    <div className="space-y-1">
                      {groupHosts.map((host) => (
                        <HostListItem
                          key={host.id}
                          host={host}
                          isSelected={selectedHostId === host.id}
                          status={getWorkspaceInventoryDisplayStatus(sharedStates[hostKey(host)])}
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
