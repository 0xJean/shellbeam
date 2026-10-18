import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useT } from '@/lib/i18n'
import { generateSshKey, importPrivateKeyFromFile } from '@/lib/keys'
import { cn } from '@/lib/utils'
import { vaultGetSecret, vaultSetSecret } from '@/lib/vault'
import { confirmUserAction } from '@/lib/user-confirmation'
import { ClipboardPaste, Copy, Eye, EyeOff, FileUp, Key, Plus, RefreshCw, Search, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

function isSshKey(key: string): boolean {
  return key.includes('privateKey') || key.endsWith('.key') || key.startsWith('ssh.')
}

function isPublicKey(key: string): boolean {
  return key.includes('publicKey') || key.endsWith('.pub')
}

function maskSecretValue(value: string): string {
  if (!value.includes('\n')) return '••••••••'
  return value.split('\n').map((line) => (line ? '••••••••' : '')).join('\n')
}

type AddKeyMode = 'generate' | 'import' | 'paste'

interface KeychainTabProps {
  vaultKeys: string[]
  vaultUnlocked: boolean
  vaultBusy: boolean
  activeVaultId: string
  onRefresh: () => Promise<void>
  onLoadSecret?: (key: string) => Promise<string | null>
  onDeleteSecret: (key: string) => Promise<void>
  onOutput?: (message: string) => void
  onError?: (message: string) => void
}

export function KeychainTab({
  vaultKeys, vaultUnlocked, vaultBusy, activeVaultId,
  onRefresh, onLoadSecret, onDeleteSecret, onOutput, onError,
}: KeychainTabProps) {
  const { t } = useT()
  const [showAddKey, setShowAddKey] = useState(false)
  const [addKeyMode, setAddKeyMode] = useState<AddKeyMode>('generate')
  const [newKeyName, setNewKeyName] = useState('ssh.default.privateKey')
  const [generateComment, setGenerateComment] = useState('')
  const [pastedKeyContent, setPastedKeyContent] = useState('')
  const [generating, setGenerating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [savingPaste, setSavingPaste] = useState(false)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'ssh' | 'public' | 'other'>('all')
  const [revealingKey, setRevealingKey] = useState<string | null>(null)
  const [revealedSecret, setRevealedSecret] = useState<{ key: string; value: string } | null>(null)
  const [showRevealedValue, setShowRevealedValue] = useState(true)
  const deletionGeneration = useRef(0)
  const currentKeys = useRef(vaultKeys)
  useEffect(() => {
    const generation = deletionGeneration
    generation.current++
    return () => { generation.current++ }
  }, [activeVaultId, vaultUnlocked])
  useEffect(() => { currentKeys.current = vaultKeys }, [vaultKeys])

  const addKeyModes: { id: AddKeyMode; label: string; icon: React.ReactNode }[] = [
    { id: 'generate', label: t('keychain.generate'), icon: <Wand2 className="h-4 w-4" /> },
    { id: 'import', label: t('keychain.importFile'), icon: <FileUp className="h-4 w-4" /> },
    { id: 'paste', label: t('keychain.paste'), icon: <ClipboardPaste className="h-4 w-4" /> },
  ]

  const filteredKeys = useMemo(() => {
    let result = vaultKeys
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((k) => k.toLowerCase().includes(q))
    }
    if (filterType === 'ssh') result = result.filter((k) => isSshKey(k))
    else if (filterType === 'public') result = result.filter((k) => isPublicKey(k))
    else if (filterType === 'other') result = result.filter((k) => !isSshKey(k) && !isPublicKey(k))
    return result
  }, [vaultKeys, search, filterType])


  async function handleGenerate() {
    if (!vaultUnlocked) { onError?.('Vault must be unlocked.'); return }
    const name = newKeyName.trim()
    if (!name) { onError?.('Key name is required.'); return }
    setGenerating(true)
    try {
      const { privateKey, publicKey } = await generateSshKey(generateComment.trim() || undefined)
      await vaultSetSecret(name, privateKey, activeVaultId)
      const pubName = name.replace(/\.privateKey$/, '.publicKey').replace(/\.key$/, '.pub')
      if (pubName !== name) await vaultSetSecret(pubName, publicKey, activeVaultId)
      onOutput?.(`Generated: ${name}\n\nPublic key:\n${publicKey}`)
      await onRefresh()
      setShowAddKey(false)
      setNewKeyName('ssh.default.privateKey')
      setGenerateComment('')
    } catch (e) { onError?.(String(e)) }
    finally { setGenerating(false) }
  }

  async function handleImport() {
    if (!vaultUnlocked) { onError?.('Vault must be unlocked.'); return }
    const name = newKeyName.trim()
    if (!name) { onError?.('Key name is required.'); return }
    setImporting(true)
    try {
      const content = await importPrivateKeyFromFile()
      await vaultSetSecret(name, content, activeVaultId)
      onOutput?.(`Imported: ${name}`)
      await onRefresh()
      setShowAddKey(false)
      setNewKeyName('ssh.default.privateKey')
    } catch (e) { onError?.(String(e)) }
    finally { setImporting(false) }
  }

  async function handlePaste() {
    if (!vaultUnlocked) { onError?.('Vault must be unlocked.'); return }
    const name = newKeyName.trim()
    if (!name) { onError?.('Key name is required.'); return }
    const content = pastedKeyContent.trim()
    if (!content) { onError?.('Please paste the private key content.'); return }
    setSavingPaste(true)
    try {
      await vaultSetSecret(name, content, activeVaultId)
      onOutput?.(`Saved: ${name}`)
      setPastedKeyContent('')
      await onRefresh()
      setShowAddKey(false)
      setNewKeyName('ssh.default.privateKey')
    } catch (e) { onError?.(String(e)) }
    finally { setSavingPaste(false) }
  }

  async function handleDeleteKey(key: string) {
    const generation = deletionGeneration.current
    const isCurrent = () => vaultUnlocked && generation === deletionGeneration.current && currentKeys.current.includes(key)
    if (!isCurrent()) return
    try {
      if (await confirmUserAction({ message: `Delete key "${key}"?`, risk: 'high', vaultId: activeVaultId, isCurrent }) !== true || !isCurrent()) return
      await onDeleteSecret(key)
      if (generation !== deletionGeneration.current) return
      await onRefresh()
      if (generation === deletionGeneration.current) onOutput?.(`Deleted: ${key}`)
    } catch (e) { if (generation === deletionGeneration.current) onError?.(String(e)) }
  }

  async function handleRevealKey(key: string) {
    if (!vaultUnlocked) { onError?.('Vault must be unlocked.'); return }
    setRevealingKey(key)
    try {
      const value = onLoadSecret ? await onLoadSecret(key) : await vaultGetSecret(key, activeVaultId)
      if (value === null) { onError?.(`Vault key not found: ${key}`); return }
      setRevealedSecret({ key, value })
      setShowRevealedValue(true)
    } catch (e) {
      onError?.(String(e))
    } finally {
      setRevealingKey(null)
    }
  }

  async function handleCopySecret() {
    if (!revealedSecret) return
    try {
      await navigator.clipboard.writeText(revealedSecret.value)
      onOutput?.(`Copied: ${revealedSecret.key}`)
    } catch (e) {
      onError?.(String(e))
    }
  }

  const filterTabs = [
    { id: 'all' as const, label: t('hosts.all') },
    { id: 'ssh' as const, label: 'SSH' },
    { id: 'public' as const, label: 'Public' },
    { id: 'other' as const, label: t('group.Custom') },
  ]

  return (
    <div className="flex w-full flex-col">
      <Dialog open={showAddKey} onOpenChange={setShowAddKey}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden shadow-2xl">
          <div className="px-4 pt-5 pb-4 sm:px-8 sm:pt-7 sm:pb-5">
            <h3 className="text-lg font-semibold text-foreground">{t('keychain.addKey')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('keychain.addKeyDesc')}</p>
            <div className="mt-4 flex gap-1 rounded-lg bg-muted p-1">
              {addKeyModes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setAddKeyMode(m.id)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-2.5 text-sm font-medium transition-colors outline-none',
                    addKeyMode === m.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {m.icon}
                  <span className="whitespace-nowrap">{m.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-border" />
          <div className="space-y-4 px-4 py-5 sm:px-8 sm:py-6">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('keychain.keyName')}</label>
              <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="ssh.default.privateKey" className="h-10 text-foreground" />
            </div>
            {addKeyMode === 'generate' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">{t('keychain.note')}</label>
                  <Input value={generateComment} onChange={(e) => setGenerateComment(e.target.value)} placeholder="e.g. user@example.com" className="h-10 text-foreground" />
                </div>
                <Button className="h-10 w-full" disabled={vaultBusy || generating || !newKeyName.trim()} onClick={() => void handleGenerate()}>
                  {generating ? t('keychain.generating') : t('keychain.generateBtn')}
                </Button>
              </>
            )}
            {addKeyMode === 'import' && (
              <Button className="h-10 w-full" disabled={vaultBusy || importing || !newKeyName.trim()} onClick={() => void handleImport()}>
                <FileUp className="mr-2 h-4 w-4" />
                {importing ? t('keychain.importing') : t('keychain.importBtn')}
              </Button>
            )}
            {addKeyMode === 'paste' && (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">{t('keychain.privateKey')}</label>
                  <Textarea
                    value={pastedKeyContent}
                    onChange={(e) => setPastedKeyContent(e.target.value)}
                    placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                    className="min-h-[140px] font-mono text-sm text-foreground"
                  />
                </div>
                <Button className="h-10 w-full" disabled={vaultBusy || savingPaste || !newKeyName.trim() || !pastedKeyContent.trim()} onClick={() => void handlePaste()}>
                  {savingPaste ? t('keychain.saving') : t('keychain.saveBtn')}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revealedSecret}
        onOpenChange={(open) => {
          if (!open) {
            setRevealedSecret(null)
            setShowRevealedValue(true)
          }
        }}
      >
        <DialogContent className="max-w-2xl p-0 overflow-hidden shadow-2xl">
          {revealedSecret && (
            <div className="space-y-4 px-4 py-5 sm:px-8 sm:py-7">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('keychain.revealTitle')}</h3>
                <p className="mt-1 break-all text-sm text-muted-foreground">{revealedSecret.key}</p>
              </div>
              <div className="relative">
                {revealedSecret.value.includes('\n') ? (
                  <Textarea
                    readOnly
                    value={showRevealedValue ? revealedSecret.value : maskSecretValue(revealedSecret.value)}
                    className="min-h-[220px] pr-11 font-mono text-sm text-foreground"
                  />
                ) : (
                  <Input
                    readOnly
                    type={showRevealedValue ? 'text' : 'password'}
                    value={revealedSecret.value}
                    className="h-10 pr-11 font-mono text-foreground"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setShowRevealedValue((v) => !v)}
                  title={showRevealedValue ? t('keychain.hideSecret') : t('keychain.showSecret')}
                  className="absolute right-2 top-5 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showRevealedValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => void handleCopySecret()} className="gap-2">
                  <Copy className="h-4 w-4" /> {t('common.copy')}
                </Button>
                <Button onClick={() => setRevealedSecret(null)}>{t('common.close')}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Title section */}
      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('keychain.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('keychain.count', { n: vaultKeys.length })}</p>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="min-h-0 flex-1">
        <div className="flex min-h-[200px] min-w-0 flex-1 flex-col px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('snippets.search')} className="h-9 pl-9 text-sm" />
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted/50 p-0.5">
              {filterTabs.map((f) => (
                <button key={f.id} type="button" onClick={() => setFilterType(f.id)} className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3', filterType === f.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <Button size="sm" onClick={() => setShowAddKey(true)} className="h-9 gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> {t('keychain.addKey')}
            </Button>
          </div>

          {/* Key list */}
          <div className="pb-6">
            {filteredKeys.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
                  <Key className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-foreground">
                  {vaultKeys.length === 0 ? t('keychain.empty') : t('hosts.noMatch')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {vaultKeys.length === 0 ? t('keychain.emptyHint') : t('hosts.noMatchHint')}
                </p>
                {vaultKeys.length === 0 && (
                  <Button className="mt-5 gap-1.5" onClick={() => setShowAddKey(true)}>
                    <Plus className="h-4 w-4" /> {t('keychain.addKey')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredKeys.map((key) => (
                  <div key={key} className="group relative overflow-hidden rounded-xl border bg-card p-4 transition-colors hover:border-primary/30 hover:shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', isSshKey(key) ? 'bg-emerald-500/10 text-emerald-500' : isPublicKey(key) ? 'bg-blue-500/10 text-blue-500' : 'bg-muted text-muted-foreground')}>
                        <Key className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{key}</span>
                        <span className={cn('mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', isSshKey(key) ? 'bg-emerald-500/10 text-emerald-500' : isPublicKey(key) ? 'bg-blue-500/10 text-blue-500' : 'bg-muted text-muted-foreground')}>
                          {isSshKey(key) ? 'SSH Key' : isPublicKey(key) ? 'Public Key' : 'Secret'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0 text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 hover:text-foreground disabled:opacity-50" onClick={() => void handleRevealKey(key)} title={t('keychain.showSecret')} disabled={!vaultUnlocked || revealingKey === key}>
                        {revealingKey === key ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0 text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 hover:text-destructive" onClick={() => void handleDeleteKey(key)} title={t('common.delete')} aria-label={`${t('common.delete')} ${key}`}>
                        <Trash2 className="h-4 w-4" />
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
