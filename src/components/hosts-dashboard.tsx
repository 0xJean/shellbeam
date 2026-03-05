import { useEffect, useMemo, useState } from 'react'
import { Search, Plus, Server, RefreshCw, LayoutGrid, List, FileDown } from 'lucide-react'
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
  onSelectHost, onConnectHost, onCreateHost, onDeleteHost,
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
  const { t } = useT()

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
    return filtered
  }, [hosts, effectiveSearch, groupFilter])

  const groupedHosts = useMemo(() => {
    const groups = new Map<string, HostProfile[]>()
    for (const host of filteredHosts) {
      const key = host.group || 'Custom'
      groups.set(key, [...(groups.get(key) ?? []), host])
    }
    return Array.from(groups.entries())
  }, [filteredHosts])

  const onlineCount = Object.values(statusByHostId).filter((s) => s === 'online').length

  const topGroups = useMemo(() => {
    const counts = new Map<string, number>()
    hosts.forEach((h) => {
      const g = h.group || 'Custom'
      counts.set(g, (counts.get(g) ?? 0) + 1)
    })
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
  }, [hosts])

  return (
    <div className="flex w-full flex-col">
      <StatsRow hostsTotal={hosts.length} onlineCount={onlineCount} topGroups={topGroups} />

      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('hosts.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('hosts.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
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

      <div className="min-h-0 flex-1 overflow-hidden">
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

const groupIconCycle: (keyof typeof iconStyles)[] = ['emerald', 'blue', 'amber']

function StatsRow({ hostsTotal, onlineCount, topGroups }: { hostsTotal: number; onlineCount: number; topGroups: [string, number][] }) {
  const { t } = useT()
  const groupLabel = (g: string) => t(`group.${g}`) !== `group.${g}` ? t(`group.${g}`) : g
  const items = [
    { label: t('hosts.totalHosts'), value: hostsTotal, icon: 'primary' as const, note: onlineCount > 0 ? t('hosts.online', { n: onlineCount }) : t('hosts.noActivity') },
    ...topGroups.map(([g, count], i) => ({
      label: groupLabel(g), value: count, icon: groupIconCycle[i % groupIconCycle.length],
    })),
  ]
  return (
    <div className="shrink-0 p-6 pb-0">
      <div className="-mx-6 flex gap-2 overflow-x-auto px-6 scrollbar-none md:hidden">
        {items.map((s) => (
          <div key={s.label} className={cn('flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2', `bg-gradient-to-br to-transparent ${iconStyles[s.icon].split(' ').at(-1)}`)}>
            <div className={cn('flex h-6 w-6 items-center justify-center rounded-md', iconStyles[s.icon].split(' ').slice(0, 2).join(' '))}>
              <Server className="h-3 w-3" />
            </div>
            <span className="text-lg font-bold">{s.value}</span>
            <span className="text-[11px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="hidden gap-3 md:grid md:grid-cols-2 lg:grid-cols-4">
        {items.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} icon={s.icon} barPct={hostsTotal ? (s.value / hostsTotal) * 100 : 0} note={'note' in s ? s.note : undefined} />
        ))}
      </div>
    </div>
  )
}

const iconStyles = { primary: 'bg-primary/10 text-primary from-primary/5', emerald: 'bg-emerald-500/10 text-emerald-500 from-emerald-500/5', blue: 'bg-blue-500/10 text-blue-500 from-blue-500/5', amber: 'bg-amber-500/10 text-amber-500 from-amber-500/5' }
const barColors = { primary: 'bg-primary', emerald: 'bg-emerald-500', blue: 'bg-blue-500', amber: 'bg-amber-500' }

function StatCard({ label, value, icon, barPct, note }: { label: string; value: number; icon: keyof typeof iconStyles; barPct: number; note?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border bg-gradient-to-br to-transparent p-4', iconStyles[icon].split(' ').at(-1))}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', iconStyles[icon].split(' ').slice(0, 2).join(' '))}>
          <Server className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
      {barPct > 0 ? (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-all', barColors[icon])} style={{ width: `${barPct}%` }} />
        </div>
      ) : note ? (
        <p className="mt-1 text-xs text-muted-foreground/50">{note}</p>
      ) : null}
    </div>
  )
}
