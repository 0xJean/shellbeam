import { useEffect, useMemo, useState } from 'react'
import { Network, Plus, Trash2, Play, Square, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { HostProfile } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import {
  addPortForwardRule,
  deletePortForwardRule,
  listPortForwardRules,
  portForwardTunnelStatus,
  startPortForwardTunnel,
  stopPortForwardTunnel,
  type PortForwardRule,
  type PortForwardRuleDraft,
} from '@/lib/port-forward'

/** Form draft type: UI supports "dynamic" (SOCKS5) in addition to local/remote. */
type PortForwardDraftState = Omit<Partial<PortForwardRuleDraft>, 'type'> & { type?: 'local' | 'remote' | 'dynamic' }

interface PortForwardPanelProps {
  hosts: HostProfile[]
  vaultId?: string
  onOutput?: (message: string) => void
  onError?: (message: string) => void
  resolvePrivateKey?: (hostId: string) => Promise<string | undefined>
}

export function PortForwardPanel({
  hosts,
  vaultId,
  onOutput,
  onError,
  resolvePrivateKey,
}: PortForwardPanelProps) {
  const { t } = useT()
  const [rules, setRules] = useState<PortForwardRule[]>([])
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'local' | 'remote'>('all')
  const [draft, setDraft] = useState<PortForwardDraftState>({
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 8080,
    targetHost: '127.0.0.1',
    targetPort: 3000,
  })

  async function refresh() {
    setLoading(true)
    try {
      const items = await listPortForwardRules(vaultId)
      setRules(items)
      const statuses = await Promise.all(
        items.map(async (r) => ({ id: r.id, running: await portForwardTunnelStatus(r.id) }))
      )
      setRunningIds(new Set(statuses.filter((s) => s.running).map((s) => s.id)))
    } catch (e) {
      onError?.(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [vaultId])

  const filteredRules = useMemo(() => {
    let result = rules
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((r) => r.name.toLowerCase().includes(q) || hostName(r.hostId).toLowerCase().includes(q))
    }
    if (filterType !== 'all') result = result.filter((r) => r.type === filterType)
    return result
  }, [rules, search, filterType])

  async function handleAdd() {
    const isDynamic = draft.type === 'dynamic'
    if (!draft.hostId || !draft.name?.trim() || !draft.bindPort || (!isDynamic && (!draft.targetHost?.trim() || !draft.targetPort))) {
      onError?.('Fill all required fields')
      return
    }
    try {
      await addPortForwardRule(
        {
          hostId: draft.hostId,
          name: draft.name.trim(),
          type: (draft.type === 'dynamic' ? 'local' : draft.type) ?? 'local',
          bindHost: draft.bindHost ?? '127.0.0.1',
          bindPort: Number(draft.bindPort) || 0,
          targetHost: (draft.targetHost ?? '').trim() || '127.0.0.1',
          targetPort: Number(draft.targetPort) || 0,
        },
        vaultId,
      )
      setShowAdd(false)
      setDraft({ type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 3000 })
      await refresh()
      onOutput?.('Port forward rule added')
    } catch (e) {
      onError?.(String(e))
    }
  }

  async function handleDelete(ruleId: string) {
    try {
      await deletePortForwardRule(ruleId, vaultId)
      await refresh()
      onOutput?.('Rule deleted')
    } catch (e) {
      onError?.(String(e))
    }
  }

  async function handleStart(rule: PortForwardRule) {
    const key = await resolvePrivateKey?.(rule.hostId)
    if (!key?.trim()) {
      onError?.('Private key required. Unlock Vault and ensure host has privateKeyRef.')
      return
    }
    try {
      await startPortForwardTunnel(rule.id, key, vaultId)
      setRunningIds((prev) => new Set([...prev, rule.id]))
      onOutput?.(`Tunnel started: ${rule.name}`)
    } catch (e) {
      onError?.(String(e))
    }
  }

  async function handleStop(ruleId: string) {
    try {
      await stopPortForwardTunnel(ruleId)
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(ruleId)
        return next
      })
      onOutput?.('Tunnel stopped')
    } catch (e) {
      onError?.(String(e))
    }
  }

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id

  return (
    <div className="flex w-full flex-col">
      {/* Add Rule Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg">
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">{t('portForward.newRule')}</h3>
              <p className="text-sm text-muted-foreground">{t('portForward.desc')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('portForward.host')}</label>
                <Select
                  value={draft.hostId ?? ''}
                  onChange={(v) => setDraft((p) => ({ ...p, hostId: v }))}
                  placeholder={t('portForward.selectHost')}
                  options={[
                    { value: '', label: t('portForward.selectHost') },
                    ...hosts.map((h) => ({ value: h.id, label: h.name })),
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('portForward.name')}</label>
                <Input
                  value={draft.name ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('portForward.nameExample')}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('portForward.type')}</label>
                <Select
                  value={draft.type ?? 'local'}
                  onChange={(v) => setDraft((p) => ({ ...p, type: v as PortForwardDraftState['type'] }))}
                  options={[
                    { value: 'local', label: t('portForward.localType') },
                    { value: 'remote', label: t('portForward.remoteType') },
                    { value: 'dynamic', label: t('portForward.dynamicType') },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('portForward.bindHost')}</label>
                <Input
                  value={draft.bindHost ?? '127.0.0.1'}
                  onChange={(e) => setDraft((p) => ({ ...p, bindHost: e.target.value }))}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('portForward.bindPort')}</label>
                <Input
                  type="number"
                  value={draft.bindPort ?? 8080}
                  onChange={(e) => setDraft((p) => ({ ...p, bindPort: Number(e.target.value) || 0 }))}
                />
              </div>
              {draft.type !== 'dynamic' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{t('portForward.targetHost')}</label>
                    <Input
                      value={draft.targetHost ?? ''}
                      onChange={(e) => setDraft((p) => ({ ...p, targetHost: e.target.value }))}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{t('portForward.targetPort')}</label>
                    <Input
                      type="number"
                      value={draft.targetPort ?? 3000}
                      onChange={(e) => setDraft((p) => ({ ...p, targetPort: Number(e.target.value) || 0 }))}
                    />
                  </div>
                </>
              )}
            </div>
            <Button size="sm" onClick={() => void handleAdd()}>
              {t('portForward.add')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Title section */}
      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('portForward.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('portForward.desc')}</p>
          </div>
        </div>
      </div>

      {/* Toolbar + Content */}
      <div className="min-h-0 flex-1">
        <div className="flex min-h-[200px] min-w-0 flex-1 flex-col px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('hosts.search')} className="h-9 pl-9 text-sm" />
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-0.5">
              {(['all', 'local', 'remote'] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilterType(f)} className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3', filterType === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {f === 'all' ? t('hosts.all') : f === 'local' ? t('portForward.localType') : t('portForward.remoteType')}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading} className="h-9 gap-1.5 text-xs">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('portForward.refresh')}
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)} className="h-9 gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> {t('portForward.addRule')}
            </Button>
          </div>

          {/* Rules grid */}
          <div className="pb-6">
            {filteredRules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
                  <Network className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {rules.length === 0 ? t('portForward.noRules') : t('hosts.noMatch')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {rules.length === 0 ? t('portForward.desc') : t('hosts.noMatchHint')}
                </p>
                {rules.length === 0 && (
                  <Button className="mt-5 gap-1.5" onClick={() => setShowAdd(true)}>
                    <Plus className="h-4 w-4" /> {t('portForward.addRule')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredRules.map((rule) => (
                  <div key={rule.id} className="group relative overflow-hidden rounded-xl border bg-card p-4 transition-colors hover:border-primary/30 hover:shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', runningIds.has(rule.id) ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground')}>
                        <Network className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{rule.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {rule.type} · {hostName(rule.hostId)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                          {rule.bindHost}:{rule.bindPort} → {rule.targetHost}:{rule.targetPort}
                        </span>
                      </div>
                    </div>
                    {runningIds.has(rule.id) && (
                      <div className="mt-2">
                        <span className="inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">Running</span>
                      </div>
                    )}
                    <div className="mt-3 flex items-center justify-end gap-1">
                      {runningIds.has(rule.id) ? (
                        <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-amber-600 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => void handleStop(rule.id)}>
                          <Square className="h-3 w-3" /> {t('portForward.stop')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" onClick={() => void handleStart(rule)} disabled={!resolvePrivateKey}>
                          <Play className="h-3 w-3" /> {t('portForward.start')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive" onClick={() => void handleDelete(rule.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
