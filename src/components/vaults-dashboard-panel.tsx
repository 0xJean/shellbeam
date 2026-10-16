import { useEffect, useState } from 'react'
import { Vault, Plus, Pencil, Trash2, Check, X, Server, FileCode, ChevronDown, KeyRound, Network, Bot } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  createVault,
  deleteVault,
  updateVault,
  DEFAULT_VAULT_ID,
  type VaultMeta,
} from '@/lib/vaults'
import { listHosts } from '@/lib/hosts'
import { listSnippets } from '@/lib/snippets'
import { listPortForwardRules } from '@/lib/port-forward'
import { vaultStatus, vaultListSecretKeys } from '@/lib/vault'
import type { VaultStatus } from '@/lib/vault'
import { KeychainTab } from '@/components/keychain-tab'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { listMcpDeploymentRecords } from '@/lib/mcp'

interface VaultStats {
  hosts: number
  snippets: number
  keys: number
  portForwards: number
  deployments: number
  deploymentUpdatedAt: number | null
}

export type VaultTab = 'hosts' | 'keychain' | 'snippets'

interface VaultsDashboardPanelProps {
  activeVaultId: string
  vaults: VaultMeta[]
  vaultStatusState: VaultStatus | null
  vaultKeys: string[]
  vaultBusy: boolean
  autoLockMinutes: number
  lastActivityAt: number
  securityEvents: Array<{ id: string; timestamp: number; level: 'info' | 'warn' | 'error'; message: string }>
  onSwitchVault: (vaultId: string) => void
  onInitialize: (masterPassword: string) => Promise<void>
  onUnlock: (masterPassword: string) => Promise<void>
  onLock: () => Promise<void>
  onAutoLockMinutesChange: (value: number) => void
  onRefresh: () => Promise<void>
  onRefreshVaults?: () => Promise<void>
  onSaveSecret: (key: string, value: string) => Promise<void>
  onLoadSecret: (key: string) => Promise<void>
  onDeleteSecret: (key: string) => Promise<void>
  onClearSecurityEvents: () => void
  onOutput?: (message: string) => void
  onError?: (message: string) => void
  activeTab?: VaultTab
  onTabChange?: (tab: VaultTab) => void
  hostsTabContent?: React.ReactNode
  snippetsTabContent?: React.ReactNode
  portForwardTabContent?: React.ReactNode
  knownHostsTabContent?: React.ReactNode
}

export function VaultsDashboardPanel({
  activeVaultId, vaults, vaultStatusState, vaultKeys, vaultBusy,
  autoLockMinutes, lastActivityAt,
  securityEvents: _securityEvents,
  onSwitchVault, onInitialize: _onInitialize, onUnlock: _onUnlock, onLock, onAutoLockMinutesChange,
  onRefresh, onRefreshVaults,
  onSaveSecret: _onSaveSecret, onLoadSecret: _onLoadSecret, onDeleteSecret,
  onClearSecurityEvents: _onClearSecurityEvents,
  onOutput, onError,
  activeTab: controlledTab, onTabChange,
  hostsTabContent, snippetsTabContent,
}: VaultsDashboardPanelProps) {
  const [statsByVault, setStatsByVault] = useState<Record<string, VaultStats>>({})
  const [statsLoading, setStatsLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newVaultName, setNewVaultName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const { t } = useT()
  const [showVaultDropdown, setShowVaultDropdown] = useState(false)
  const [internalTab, setInternalTab] = useState<VaultTab>('hosts')
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = onTabChange ?? setInternalTab
  const vaultUnlocked = vaultStatusState?.unlocked ?? false
  const activeVault = vaults.find((v) => v.id === activeVaultId)

  async function loadStats(vaultId: string): Promise<VaultStats> {
    try {
      const [hosts, snippets, keys, rules, deployments] = await Promise.all([
        listHosts(vaultId),
        listSnippets(vaultId),
        vaultStatus(vaultId).then((s) => (s.initialized ? vaultListSecretKeys(vaultId) : [])),
        listPortForwardRules(vaultId),
        listMcpDeploymentRecords(vaultId),
      ])
      return {
        hosts: hosts.length,
        snippets: snippets.length,
        keys: keys.length,
        portForwards: rules.length,
        deployments: deployments.projects.length,
        deploymentUpdatedAt: deployments.projects.reduce<number | null>((latest, project) => Math.max(latest ?? 0, project.updatedAt), null),
      }
    } catch {
      return { hosts: 0, snippets: 0, keys: 0, portForwards: 0, deployments: 0, deploymentUpdatedAt: null }
    }
  }

  async function refresh() {
    setStatsLoading(true)
    try {
      const stats: Record<string, VaultStats> = {}
      for (const v of vaults) stats[v.id] = await loadStats(v.id)
      setStatsByVault(stats)
    } catch (e) { onError?.(String(e)) }
    finally { setStatsLoading(false) }
  }

  useEffect(() => { void refresh() }, [vaults])

  async function handleCreate() {
    const name = newVaultName.trim()
    if (!name) { onError?.('Vault name is required'); return }
    try {
      const vault = await createVault(name)
      setShowCreate(false); setNewVaultName('')
      await onRefreshVaults?.(); await onRefresh()
      onSwitchVault(vault.id)
      onOutput?.(`Vault created: ${vault.name}`)
    } catch (e) { onError?.(String(e)) }
  }

  async function handleUpdate(vaultId: string) {
    const name = editName.trim()
    if (!name) { onError?.('Vault name is required'); return }
    try {
      await updateVault(vaultId, name)
      setEditingId(null); setEditName('')
      await onRefreshVaults?.()
      onOutput?.(`Vault renamed: ${name}`)
    } catch (e) { onError?.(String(e)) }
  }

  async function handleDelete(vaultId: string) {
    if (vaultId === DEFAULT_VAULT_ID) { onError?.('Cannot delete the default Personal vault'); return }
    if (!confirm('Delete this vault? All data will be lost.')) return
    try {
      await deleteVault(vaultId)
      await onRefreshVaults?.(); await onRefresh()
      if (activeVaultId === vaultId) onSwitchVault(DEFAULT_VAULT_ID)
      onOutput?.('Vault deleted')
    } catch (e) { onError?.(String(e)) }
  }

  const tabs: { id: VaultTab; label: string; icon: React.ReactNode }[] = [
    { id: 'hosts', label: t('vaults.hosts'), icon: <Server className="h-4 w-4" /> },
    { id: 'keychain', label: t('vaults.keychain'), icon: <KeyRound className="h-4 w-4" /> },
    { id: 'snippets', label: t('vaults.snippets'), icon: <FileCode className="h-4 w-4" /> },
  ]

  return (
    <>
      <Card className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 sm:gap-3 sm:px-4">
          <VaultDropdown
            vaults={vaults} activeVaultId={activeVaultId} activeVault={activeVault}
            showDropdown={showVaultDropdown} onToggleDropdown={() => setShowVaultDropdown((o) => !o)} onCloseDropdown={() => setShowVaultDropdown(false)}
            editingId={editingId} editName={editName} showCreate={showCreate} newVaultName={newVaultName}
            onSwitchVault={onSwitchVault} onSetEditingId={setEditingId} onSetEditName={setEditName}
            onSetShowCreate={setShowCreate} onSetNewVaultName={setNewVaultName}
            onUpdate={handleUpdate} onDelete={handleDelete} onCreate={handleCreate}
          />
          {vaultUnlocked && (
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-500/30" title={`Last: ${new Date(lastActivityAt).toLocaleTimeString()}`}>{t('vaults.unlocked')}</Badge>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={vaultBusy} onClick={() => void onLock()}>{t('vaults.lock')}</Button>
              <Input type="number" min={1} max={120} value={autoLockMinutes} onChange={(e) => onAutoLockMinutesChange(Number(e.target.value))} className="h-7 w-14 text-[11px] text-center" title={t('vaults.autoLockMin')} />
            </div>
          )}
          {(() => {
            const s = statsByVault[activeVaultId]
            if (!s && !statsLoading) return null
            return (
              <div className="hidden items-center gap-3 text-[10px] text-muted-foreground md:flex">
                <span className="flex items-center gap-1" title="Hosts"><Server className="h-3 w-3" />{s?.hosts ?? '-'}</span>
                <span className="flex items-center gap-1" title="Keys"><KeyRound className="h-3 w-3" />{s?.keys ?? '-'}</span>
                <span className="flex items-center gap-1" title="Snippets"><FileCode className="h-3 w-3" />{s?.snippets ?? '-'}</span>
                <span className="flex items-center gap-1" title="Port Forwards"><Network className="h-3 w-3" />{s?.portForwards ?? '-'}</span>
                <span className="flex items-center gap-1" title={t('vaults.agentDeploymentsCount')}><Bot className="h-3 w-3" />{s?.deployments ?? '-'}</span>
                {s?.deploymentUpdatedAt && <span className="flex items-center gap-1" title={t('vaults.agentDeploymentsUpdated', { time: new Date(s.deploymentUpdatedAt).toLocaleString() })}>{t('vaults.agentDeploymentsUpdated', { time: new Date(s.deploymentUpdatedAt).toLocaleString() })}</span>}
              </div>
            )
          })()}
          <div className="ml-auto flex items-center gap-1">
            {tabs.map((t) => (
              <button key={t.id} type="button" onClick={() => setActiveTab(t.id)} className={cn('flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm', activeTab === t.id ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
                {t.icon} <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <CardContent className="min-h-0 flex-1 overflow-auto p-0">
          {activeTab === 'hosts' && hostsTabContent && <div className="p-4">{hostsTabContent}</div>}
          {activeTab === 'snippets' && snippetsTabContent && <div className="p-4">{snippetsTabContent}</div>}
          {activeTab === 'keychain' && (
            <KeychainTab
              vaultKeys={vaultKeys} vaultUnlocked={vaultUnlocked} vaultBusy={vaultBusy}
              activeVaultId={activeVaultId} onRefresh={onRefresh} onDeleteSecret={onDeleteSecret}
              onOutput={onOutput} onError={onError}
            />
          )}
        </CardContent>
      </Card>
    </>
  )
}

function VaultDropdown({
  vaults, activeVaultId, activeVault, showDropdown, onToggleDropdown, onCloseDropdown,
  editingId, editName, showCreate, newVaultName,
  onSwitchVault, onSetEditingId, onSetEditName, onSetShowCreate, onSetNewVaultName,
  onUpdate, onDelete, onCreate,
}: {
  vaults: VaultMeta[]; activeVaultId: string; activeVault: VaultMeta | undefined
  showDropdown: boolean; onToggleDropdown: () => void; onCloseDropdown: () => void
  editingId: string | null; editName: string; showCreate: boolean; newVaultName: string
  onSwitchVault: (id: string) => void; onSetEditingId: (id: string | null) => void
  onSetEditName: (name: string) => void; onSetShowCreate: (show: boolean) => void; onSetNewVaultName: (name: string) => void
  onUpdate: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onCreate: () => Promise<void>
}) {
  const { t } = useT()
  return (
    <div className="relative">
      <button type="button" onClick={onToggleDropdown} className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium hover:bg-muted/50">
        <Vault className="h-4 w-4 text-muted-foreground" />
        <span className="max-w-[120px] truncate">{activeVault?.name ?? t('vaults.vault')}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {showDropdown && (
        <>
          <div className="fixed inset-0 z-40" onClick={onCloseDropdown} />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border bg-card py-1 shadow-lg">
            {vaults.map((v) => {
              const isActive = v.id === activeVaultId
              return (
                <div key={v.id} className={cn('flex items-center justify-between px-3 py-1.5 text-sm', isActive && 'bg-primary/10')}>
                  {editingId === v.id ? (
                    <div className="flex flex-1 items-center gap-1">
                      <Input value={editName} onChange={(e) => onSetEditName(e.target.value)} className="h-7 flex-1 text-xs" autoFocus />
                      <Button size="sm" className="h-7 w-7 p-0" onClick={() => void onUpdate(v.id)}><Check className="h-3 w-3" /></Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { onSetEditingId(null); onSetEditName('') }}><X className="h-3 w-3" /></Button>
                    </div>
                  ) : (
                    <>
                      <button type="button" onClick={() => { onSwitchVault(v.id); onCloseDropdown() }} className="flex-1 text-left truncate">
                        {v.name}
                        {v.isDefault && <span className="ml-1.5 text-[10px] text-muted-foreground">{t('vaults.default')}</span>}
                      </button>
                      <div className="flex items-center gap-0.5 ml-2">
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { onSetEditingId(v.id); onSetEditName(v.name) }}><Pencil className="h-3 w-3" /></Button>
                        {v.id !== DEFAULT_VAULT_ID && (
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => void onDelete(v.id)}><Trash2 className="h-3 w-3" /></Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            <div className="border-t mt-1 pt-1 px-3 py-1">
              {showCreate ? (
                <div className="flex items-center gap-1">
                  <Input value={newVaultName} onChange={(e) => onSetNewVaultName(e.target.value)} className="h-7 flex-1 text-xs" placeholder={t('vaults.namePlaceholder')} autoFocus />
                  <Button size="sm" className="h-7 w-7 p-0" onClick={() => void onCreate()}><Check className="h-3 w-3" /></Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { onSetShowCreate(false); onSetNewVaultName('') }}><X className="h-3 w-3" /></Button>
                </div>
              ) : (
                <button type="button" onClick={() => onSetShowCreate(true)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                  <Plus className="h-3.5 w-3.5" /> {t('vaults.newVault')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
