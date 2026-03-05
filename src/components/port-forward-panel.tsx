import { useEffect, useState } from 'react'
import { Network, Plus, Trash2, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { HostProfile } from '@/lib/hosts'
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          {t('portForward.title')}
        </CardTitle>
        <CardDescription>{t('portForward.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {t('portForward.refresh')}
          </Button>
          <Button size="sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="mr-1 h-4 w-4" />
            {t('portForward.addRule')}
          </Button>
        </div>

        {showAdd && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <span className="text-sm font-medium">{t('portForward.newRule')}</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <span className="text-xs text-muted-foreground">{t('portForward.host')}</span>
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
              <div>
                <span className="text-xs text-muted-foreground">{t('portForward.name')}</span>
                <Input
                  value={draft.name ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('portForward.nameExample')}
                />
              </div>
              <div>
                <span className="text-xs text-muted-foreground">{t('portForward.type')}</span>
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
              <div>
                <span className="text-xs text-muted-foreground">{t('portForward.bindHost')}</span>
                <Input
                  value={draft.bindHost ?? '127.0.0.1'}
                  onChange={(e) => setDraft((p) => ({ ...p, bindHost: e.target.value }))}
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <span className="text-xs text-muted-foreground">{t('portForward.bindPort')}</span>
                <Input
                  type="number"
                  value={draft.bindPort ?? 8080}
                  onChange={(e) => setDraft((p) => ({ ...p, bindPort: Number(e.target.value) || 0 }))}
                />
              </div>
              {draft.type !== 'dynamic' && (
                <>
                  <div>
                    <span className="text-xs text-muted-foreground">{t('portForward.targetHost')}</span>
                    <Input
                      value={draft.targetHost ?? ''}
                      onChange={(e) => setDraft((p) => ({ ...p, targetHost: e.target.value }))}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">{t('portForward.targetPort')}</span>
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
        )}

        <div className="space-y-2">
          {rules.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">{t('portForward.noRules')}</p>
          )}
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
            >
              <div className="min-w-0">
                <p className="font-medium truncate">{rule.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {rule.type} · {hostName(rule.hostId)} · {rule.bindHost}:{rule.bindPort} → {rule.targetHost}:{rule.targetPort}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {runningIds.has(rule.id) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleStop(rule.id)}
                    className="text-amber-600"
                  >
                    <Square className="mr-1 h-3 w-3" />
                    {t('portForward.stop')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleStart(rule)}
                    disabled={!resolvePrivateKey}
                  >
                    <Play className="mr-1 h-3 w-3" />
                    {t('portForward.start')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void handleDelete(rule.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
