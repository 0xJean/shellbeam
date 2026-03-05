import { useState } from 'react'
import { Plus, Trash2, Key, Wand2, FileUp, ClipboardPaste } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { generateSshKey, importPrivateKeyFromFile } from '@/lib/keys'
import { vaultSetSecret } from '@/lib/vault'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

function isSshKey(key: string): boolean {
  return key.includes('privateKey') || key.endsWith('.key') || key.startsWith('ssh.')
}

type AddKeyMode = 'generate' | 'import' | 'paste'

interface KeychainTabProps {
  vaultKeys: string[]
  vaultUnlocked: boolean
  vaultBusy: boolean
  activeVaultId: string
  onRefresh: () => Promise<void>
  onDeleteSecret: (key: string) => Promise<void>
  onOutput?: (message: string) => void
  onError?: (message: string) => void
}

export function KeychainTab({
  vaultKeys, vaultUnlocked, vaultBusy, activeVaultId,
  onRefresh, onDeleteSecret, onOutput, onError,
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

  const addKeyModes: { id: AddKeyMode; label: string; icon: React.ReactNode }[] = [
    { id: 'generate', label: t('keychain.generate'), icon: <Wand2 className="h-4 w-4" /> },
    { id: 'import', label: t('keychain.importFile'), icon: <FileUp className="h-4 w-4" /> },
    { id: 'paste', label: t('keychain.paste'), icon: <ClipboardPaste className="h-4 w-4" /> },
  ]

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
    if (!confirm(`Delete key "${key}"?`)) return
    try {
      await onDeleteSecret(key)
      await onRefresh()
      onOutput?.(`Deleted: ${key}`)
    } catch (e) { onError?.(String(e)) }
  }

  return (
    <>
      <Dialog open={showAddKey} onOpenChange={setShowAddKey}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden shadow-2xl">
          <div className="px-4 pt-5 pb-4 sm:px-8 sm:pt-7 sm:pb-5">
            <h3 className="text-lg font-semibold text-foreground">{t('keychain.addKey')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('keychain.addKeyDesc')}</p>
            <div className="mt-4 flex flex-wrap gap-1 rounded-lg bg-muted p-1">
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
                  <span className="hidden sm:inline">{m.label}</span>
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

      <div className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('keychain.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('keychain.count', { n: vaultKeys.length })}</p>
          </div>
          <Button size="sm" onClick={() => setShowAddKey(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('keychain.addKey')}
          </Button>
        </div>

        {vaultKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Key className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('keychain.empty')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('keychain.emptyHint')}</p>
            <Button size="sm" className="mt-4" onClick={() => setShowAddKey(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('keychain.addKey')}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {vaultKeys.map((key) => (
              <div key={key} className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Key className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium">{key}</span>
                    {isSshKey(key) && <span className="text-[11px] text-muted-foreground">SSH Key</span>}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => void handleDeleteKey(key)} title={t('common.delete')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
