import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { hasSshConnection, hostConnections, listHosts, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { generateSshKey, importPrivateKeyFromFile } from '@/lib/keys'
import { keychainV3Copy } from '@/lib/locales/keychain-v3'
import { fill } from '@/lib/locales/probe-install'
import { runConfirmedOperation } from '@/lib/operation-job'
import { buildCommandOutput } from '@/lib/sessions'
import { AUTHORIZED_KEY_ADDED, AUTHORIZED_KEY_PRESENT, buildAuthorizedKeysAppendCommand, openSshFingerprint, parseOpenSshPublicKey, type OpenSshPublicKey } from '@/lib/ssh-public-key'
import { cn } from '@/lib/utils'
import { vaultGetSecret, vaultSetSecret } from '@/lib/vault'
import { confirmUserAction } from '@/lib/user-confirmation'
import { runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { ClipboardPaste, Copy, Eye, EyeOff, FileDown, FileUp, Info, KeyRound, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Trash2, Upload, X } from 'lucide-react'
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

function publicKeyNameFor(key: string): string | null {
  if (isPublicKey(key)) return key
  const pub = key.replace(/\.privateKey$/, '.publicKey').replace(/\.key$/, '.pub')
  return pub !== key ? pub : null
}

function privateKeyNameFor(key: string): string | null {
  if (!isPublicKey(key)) return isSshKey(key) ? key : null
  const priv = key.replace(/\.publicKey$/, '.privateKey').replace(/\.pub$/, '.key')
  return priv !== key ? priv : null
}

type AddKeyMode = 'generate' | 'import' | 'paste'
type PublicKeyInfo = { scope: string; parsed: OpenSshPublicKey | null; fingerprint: string | null; missing: boolean }

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
  const { t, locale } = useT()
  const copy = keychainV3Copy[locale]
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [publicKeyInfo, setPublicKeyInfo] = useState<PublicKeyInfo | null>(null)
  const [hostState, setHostState] = useState<{ vaultId: string; hosts: HostProfile[] } | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [deployHostId, setDeployHostId] = useState('')
  const [deploying, setDeploying] = useState(false)
  const deletionGeneration = useRef(0)
  const currentKeys = useRef(vaultKeys)
  useEffect(() => {
    const generation = deletionGeneration
    generation.current++
    return () => { generation.current++ }
  }, [activeVaultId, vaultUnlocked])
  useEffect(() => { currentKeys.current = vaultKeys }, [vaultKeys])

  const addKeyModes: { id: AddKeyMode; label: string; icon: React.ReactNode }[] = [
    { id: 'generate', label: t('keychain.generate'), icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: 'import', label: t('keychain.importFile'), icon: <FileDown className="h-3.5 w-3.5" /> },
    { id: 'paste', label: t('keychain.paste'), icon: <ClipboardPaste className="h-3.5 w-3.5" /> },
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

  const selected = selectedKey && filteredKeys.includes(selectedKey) ? selectedKey : filteredKeys[0] ?? null
  const pairedPublicName = selected ? publicKeyNameFor(selected) : null
  const publicName = pairedPublicName && vaultKeys.includes(pairedPublicName) ? pairedPublicName : null
  const privateName = selected ? privateKeyNameFor(selected) : null
  const pairedName = selected && isPublicKey(selected) ? (privateName && vaultKeys.includes(privateName) ? privateName : null) : publicName
  const publicScope = vaultUnlocked && publicName ? `${activeVaultId}\n${publicName}` : null
  const publicInfo = publicScope && publicKeyInfo?.scope === publicScope ? publicKeyInfo : null
  const publicKey = publicInfo?.parsed ?? null

  // Only entries named as public keys are read here, and only a valid single-line OpenSSH public key is ever shown.
  useEffect(() => {
    if (!vaultUnlocked || !publicName) return
    const scope = `${activeVaultId}\n${publicName}`
    let cancelled = false
    void (async () => {
      try {
        const value = await vaultGetSecret(publicName, activeVaultId)
        const parsed = value === null ? null : parseOpenSshPublicKey(value)
        const fingerprint = parsed ? await openSshFingerprint(parsed).catch(() => null) : null
        if (!cancelled) setPublicKeyInfo({ scope, parsed, fingerprint, missing: value === null })
      } catch {
        if (!cancelled) setPublicKeyInfo({ scope, parsed: null, fingerprint: null, missing: false })
      }
    })()
    return () => { cancelled = true }
  }, [activeVaultId, publicName, vaultUnlocked, vaultKeys])

  useEffect(() => {
    if (!vaultUnlocked) return
    let cancelled = false
    listHosts(activeVaultId).then((hosts) => { if (!cancelled) setHostState({ vaultId: activeVaultId, hosts }) }, () => {})
    return () => { cancelled = true }
  }, [activeVaultId, vaultUnlocked])

  const hosts = useMemo(() => (vaultUnlocked && hostState?.vaultId === activeVaultId ? hostState.hosts : []), [activeVaultId, hostState, vaultUnlocked])
  const hostsUsing = useMemo(() => privateName
    ? hosts.filter((host) => hostConnections(host).some((connection) => connection.authType === 'privateKey'
      && (connection.privateKeyRef?.trim() || connection.secretKeyRef?.trim()) === privateName))
    : [], [hosts, privateName])
  const deployHosts = useMemo(() => hosts.filter((host) => hasSshConnection(host)), [hosts])
  const deployHost = deployHosts.find((host) => host.id === deployHostId) ?? deployHosts[0] ?? null

  function openAddKey(mode: AddKeyMode) {
    setAddKeyMode(mode)
    setShowAddKey(true)
  }

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

  async function handleCopyPublicKey() {
    if (!publicKey || !publicName) return
    try {
      await navigator.clipboard.writeText(publicKey.line)
      onOutput?.(fill(copy.publicKeyCopied, { key: publicName }))
    } catch (e) {
      onError?.(String(e))
    }
  }

  async function handleDeploy() {
    const key = publicKey
    const host = deployHost
    const keyName = publicName
    if (!key || !host || !keyName || !vaultUnlocked) return
    const generation = deletionGeneration.current
    const isCurrent = () => generation === deletionGeneration.current
    const names = { key: keyName, host: host.name, user: host.username || 'root' }
    setDeploying(true)
    try {
      const execution = await runConfirmedOperation({
        host, vaultId: activeVaultId, isCurrent,
        action: 'ssh.authorized_keys.add', target: `${keyName} -> ~/.ssh/authorized_keys`, risk: 'high',
        paramsSummary: `append ${keyName} (${publicInfo?.fingerprint ?? key.type}) to ~/.ssh/authorized_keys`,
        confirmMessage: fill(copy.deployConfirm, names),
        execute: () => runWorkspaceRemoteCommand({
          host, vaultId: activeVaultId, command: buildAuthorizedKeysAppendCommand(key),
          resolveAuthSecret: () => Promise.reject(new Error('Host credentials are resolved from the vault.')),
        }),
        getResult: (result) => result,
      })
      if (!execution || !isCurrent()) return
      const result = execution.value
      const stdout = result.stdout.split('\n').map((line) => line.trim())
      if (result.exitCode === 0 && stdout.includes(AUTHORIZED_KEY_ADDED)) onOutput?.(fill(copy.deployAdded, names))
      else if (result.exitCode === 0 && stdout.includes(AUTHORIZED_KEY_PRESENT)) onOutput?.(fill(copy.deployPresent, names))
      else { onError?.(`${fill(copy.deployFailed, names)}\n\n${buildCommandOutput(result)}`); return }
      setDeployOpen(false)
    } catch (e) {
      if (isCurrent()) onError?.(`${fill(copy.deployFailed, names)}\n\n${String(e)}`)
    } finally {
      setDeploying(false)
    }
  }

  const filterTabs = [
    { id: 'all' as const, label: t('hosts.all') },
    { id: 'ssh' as const, label: 'SSH' },
    { id: 'public' as const, label: 'Public' },
    { id: 'other' as const, label: t('group.Custom') },
  ]

  const kindLabel = (key: string) => (isSshKey(key) ? copy.sshKey : isPublicKey(key) ? copy.publicKey : copy.secret)
  const tabClass = (active: boolean) => cn('-mb-px flex items-center gap-1.5 border-b-2 px-1 pb-2.5 text-[13px] font-medium outline-none transition-colors', active ? 'border-[hsl(var(--primary))] text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')
  const fieldLabel = 'text-[13px] font-medium text-[var(--workspace-text-strong)]'
  const dialogHead = (title: string, subtitle: string, onClose: () => void, id: string) => (
    <div className="flex items-start gap-3 px-5 pt-5">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold text-[var(--workspace-text-strong)]">{title}</h2>
        <p className="mt-0.5 break-all text-xs text-[var(--workspace-text-muted)]">{subtitle}</p>
      </div>
      <button type="button" onClick={onClose} aria-label={copy.close} title={copy.close} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
  const note = (text: string, tone: 'info' | 'warn' = 'info') => (
    <p className={cn('flex items-start gap-1.5 text-xs leading-relaxed', tone === 'warn' ? 'text-[var(--workspace-status-warn-text)]' : 'text-[var(--workspace-text-muted)]')}>
      {tone === 'warn' ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span>{text}</span>
    </p>
  )

  return (
    <div data-tour="keychain-page" className="flex w-full flex-col">
      <Dialog open={showAddKey} onOpenChange={setShowAddKey} labelledBy="keychain-add-title">
        <DialogContent className="flex flex-col overflow-hidden p-0 shadow-2xl md:w-[560px] md:max-w-[95vw]">
          {dialogHead(t('keychain.addKey'), copy.addKeyDesc, () => setShowAddKey(false), 'keychain-add-title')}
          <div role="tablist" className="mt-4 flex gap-5 border-b border-[var(--workspace-border-soft)] px-5">
            {addKeyModes.map((m) => (
              <button key={m.id} type="button" role="tab" aria-selected={addKeyMode === m.id} onClick={() => setAddKeyMode(m.id)} className={tabClass(addKeyMode === m.id)}>
                {m.icon}
                <span className="whitespace-nowrap">{m.label}</span>
              </button>
            ))}
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <label className={fieldLabel}>{t('keychain.keyName')}</label>
              <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="ssh.default.privateKey" className="h-9 font-mono text-[13px] text-[var(--workspace-text-strong)]" />
            </div>
            {addKeyMode === 'generate' && (
              <>
                <div className="space-y-1.5">
                  <label className={fieldLabel}>{t('keychain.note')}</label>
                  <Input value={generateComment} onChange={(e) => setGenerateComment(e.target.value)} placeholder="e.g. user@example.com" className="h-9 text-[var(--workspace-text-strong)]" />
                </div>
                {note(copy.generateHint)}
              </>
            )}
            {addKeyMode === 'import' && note(copy.importHint)}
            {addKeyMode === 'paste' && (
              <div className="space-y-1.5">
                <label className={fieldLabel}>{t('keychain.privateKey')}</label>
                <Textarea
                  value={pastedKeyContent}
                  onChange={(e) => setPastedKeyContent(e.target.value)}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                  className="min-h-[130px] font-mono text-[13px] text-[var(--workspace-text-strong)]"
                />
              </div>
            )}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--workspace-border-soft)] px-5 py-3">
            <Button variant="outline" size="sm" onClick={() => setShowAddKey(false)}>{t('common.cancel')}</Button>
            {addKeyMode === 'generate' && (
              <Button size="sm" disabled={vaultBusy || generating || !newKeyName.trim()} onClick={() => void handleGenerate()}>
                {generating ? t('keychain.generating') : t('keychain.generateBtn')}
              </Button>
            )}
            {addKeyMode === 'import' && (
              <Button size="sm" className="gap-1.5" disabled={vaultBusy || importing || !newKeyName.trim()} onClick={() => void handleImport()}>
                <FileUp className="h-3.5 w-3.5" />
                {importing ? t('keychain.importing') : t('keychain.importBtn')}
              </Button>
            )}
            {addKeyMode === 'paste' && (
              <Button size="sm" disabled={vaultBusy || savingPaste || !newKeyName.trim() || !pastedKeyContent.trim()} onClick={() => void handlePaste()}>
                {savingPaste ? t('keychain.saving') : t('keychain.saveBtn')}
              </Button>
            )}
          </footer>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revealedSecret}
        labelledBy="keychain-reveal-title"
        onOpenChange={(open) => {
          if (!open) {
            setRevealedSecret(null)
            setShowRevealedValue(true)
          }
        }}
      >
        <DialogContent className="flex flex-col overflow-hidden p-0 shadow-2xl md:w-[560px] md:max-w-[95vw]">
          {revealedSecret && (
            <>
              {dialogHead(t('keychain.revealTitle'), `${revealedSecret.key} · ${kindLabel(revealedSecret.key)}`, () => setRevealedSecret(null), 'keychain-reveal-title')}
              <div className="space-y-3 px-5 py-4">
                <div className="relative">
                  {revealedSecret.value.includes('\n') ? (
                    <Textarea
                      readOnly
                      value={showRevealedValue ? revealedSecret.value : maskSecretValue(revealedSecret.value)}
                      className="min-h-[200px] bg-[var(--workspace-surface-950)] pr-11 font-mono text-xs text-[var(--workspace-text-strong)]"
                    />
                  ) : (
                    <Input
                      readOnly
                      type={showRevealedValue ? 'text' : 'password'}
                      value={revealedSecret.value}
                      className="h-10 bg-[var(--workspace-surface-950)] pr-11 font-mono text-[var(--workspace-text-strong)]"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setShowRevealedValue((v) => !v)}
                    title={showRevealedValue ? t('keychain.hideSecret') : t('keychain.showSecret')}
                    className="absolute right-2 top-5 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]"
                  >
                    {showRevealedValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {note(copy.revealHint, 'warn')}
              </div>
              <footer className="flex items-center justify-end gap-2 border-t border-[var(--workspace-border-soft)] px-5 py-3">
                <Button variant="outline" size="sm" onClick={() => void handleCopySecret()} className="gap-1.5">
                  <Copy className="h-3.5 w-3.5" /> {t('common.copy')}
                </Button>
                <Button size="sm" onClick={() => setRevealedSecret(null)}>{t('common.close')}</Button>
              </footer>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deployOpen && !!publicKey} onOpenChange={(open) => { if (!deploying) setDeployOpen(open) }} labelledBy="keychain-deploy-title">
        <DialogContent className="flex flex-col overflow-hidden p-0 shadow-2xl md:w-[520px] md:max-w-[95vw]">
          {dialogHead(copy.deployTitle, `${publicName ?? ''}${publicInfo?.fingerprint ? ` · ${publicInfo.fingerprint}` : ''}`, () => { if (!deploying) setDeployOpen(false) }, 'keychain-deploy-title')}
          <div className="space-y-4 px-5 py-4">
            {deployHosts.length ? (
              <div className="space-y-1.5">
                <label className={fieldLabel} htmlFor="keychain-deploy-host">{copy.deployHost}</label>
                <NativeSelect id="keychain-deploy-host" value={deployHost?.id ?? ''} disabled={deploying} onChange={(e) => setDeployHostId(e.target.value)} className="h-9 w-full rounded-md border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2 text-sm">
                  {deployHosts.map((host) => <option key={host.id} value={host.id}>{`${host.name} · ${host.username || 'root'}@${host.address}`}</option>)}
                </NativeSelect>
              </div>
            ) : (
              <p className="text-sm text-[var(--workspace-text-muted)]">{copy.deployNoHosts}</p>
            )}
            {note(copy.deployHint)}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--workspace-border-soft)] px-5 py-3">
            <Button variant="outline" size="sm" disabled={deploying} onClick={() => setDeployOpen(false)}>{t('common.cancel')}</Button>
            <Button size="sm" className="gap-1.5" disabled={deploying || !deployHost || !vaultUnlocked} onClick={() => void handleDeploy()}>
              {deploying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {deploying ? copy.deploying : copy.deployBtn}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('keychain.title')}</h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{fill(copy.summary, { n: vaultKeys.length })}</p>
        </div>
        <div data-tour="keychain-actions" className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => openAddKey('paste')} className="h-8 gap-1.5">
            <FileDown className="h-3.5 w-3.5" /> {copy.importPaste}
          </Button>
          <Button size="sm" onClick={() => openAddKey('generate')} className="h-8 gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> {copy.generateNew}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 px-6 pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <section data-tour="keychain-list" className="sb-card flex min-h-[200px] min-w-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--workspace-border-soft)] p-3">
            <div className="relative w-full max-w-[260px] flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={copy.searchPlaceholder} className="h-8 pl-8 text-[13px]" />
            </div>
            <div className="flex-1" />
            <div className="flex flex-wrap gap-0.5 rounded-lg border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-0.5">
              {filterTabs.map((f) => (
                <button key={f.id} type="button" aria-pressed={filterType === f.id} onClick={() => setFilterType(f.id)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', filterType === f.id ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {filteredKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--workspace-surface-800)]">
                <KeyRound className="h-7 w-7 text-[var(--workspace-text-subtle)]" />
              </div>
              <p className="text-sm font-medium text-[var(--workspace-text-strong)]">
                {vaultKeys.length === 0 ? t('keychain.empty') : t('hosts.noMatch')}
              </p>
              <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">
                {vaultKeys.length === 0 ? t('keychain.emptyHint') : t('hosts.noMatchHint')}
              </p>
              {vaultKeys.length === 0 && (
                <Button size="sm" className="mt-5 gap-1.5" onClick={() => openAddKey('generate')}>
                  <Plus className="h-4 w-4" /> {t('keychain.addKey')}
                </Button>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-[var(--workspace-border-soft)] text-left text-xs font-medium text-[var(--workspace-text-subtle)]">
                    <th className="px-4 py-2.5 font-medium">{copy.colName}</th>
                    <th className="w-32 px-3 py-2.5 font-medium">{copy.colType}</th>
                    <th className="w-24 px-3 py-2.5"><span className="sr-only">{t('common.delete')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredKeys.map((key) => {
                    const active = key === selected
                    return (
                      <tr
                        key={key}
                        aria-selected={active}
                        onClick={() => setSelectedKey(key)}
                        className={cn('group cursor-pointer border-b border-[var(--workspace-border-soft)] transition-colors last:border-b-0', active ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[var(--workspace-surface-800)]')}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]">
                              <KeyRound className="h-4 w-4" />
                            </span>
                            <span className="truncate font-medium text-[var(--workspace-text-strong)]" title={key}>{key}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('inline-block rounded-md px-1.5 py-0.5 text-[11px] font-medium', isSshKey(key) ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : isPublicKey(key) ? 'bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>
                            {kindLabel(key)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)] disabled:opacity-50" onClick={() => void handleRevealKey(key)} title={t('keychain.showSecret')} disabled={!vaultUnlocked || revealingKey === key}>
                              {revealingKey === key ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 text-[var(--workspace-text-muted)] hover:text-[var(--workspace-status-bad-text)]" onClick={() => void handleDeleteKey(key)} title={t('common.delete')} aria-label={`${t('common.delete')} ${key}`}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="sb-card flex min-w-0 flex-col gap-4 p-4">
          {!selected ? (
            <p className="py-10 text-center text-sm text-[var(--workspace-text-muted)]">{copy.selectKey}</p>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
                  <KeyRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="break-all text-base font-semibold text-[var(--workspace-text-strong)]">{selected}</h3>
                  <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]">{[publicKey?.algorithm, kindLabel(selected)].filter(Boolean).join(' · ')}</p>
                </div>
              </div>

              {(publicInfo?.fingerprint || publicKey?.comment || pairedName) && (
                <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  {publicInfo?.fingerprint && <><dt className="text-[var(--workspace-text-subtle)]">{copy.fingerprint}</dt><dd className="break-all font-mono text-[var(--workspace-text)]">{publicInfo.fingerprint}</dd></>}
                  {publicKey?.comment && <><dt className="text-[var(--workspace-text-subtle)]">{copy.comment}</dt><dd className="break-all font-mono text-[var(--workspace-text)]">{publicKey.comment}</dd></>}
                  {pairedName && <><dt className="text-[var(--workspace-text-subtle)]">{copy.pairedWith}</dt><dd className="break-all font-mono text-[var(--workspace-text)]">{pairedName}</dd></>}
                </dl>
              )}

              {pairedPublicName && (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.publicKeyTitle}</span>
                    <small className="truncate text-[11px] text-[var(--workspace-text-subtle)]">{copy.publicKeyHint}</small>
                  </div>
                  {publicKey ? (
                    <div className="relative rounded-lg border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] py-2.5 pl-3 pr-10 font-mono text-[11px] leading-relaxed text-[var(--workspace-text)]">
                      <span className="break-all">{publicKey.line}</span>
                      <button type="button" onClick={() => void handleCopyPublicKey()} title={copy.copyPublicKey} aria-label={copy.copyPublicKey} className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)]">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-[var(--workspace-border-soft)] px-3 py-2.5 text-xs text-[var(--workspace-text-muted)]">
                      {!publicName || publicInfo?.missing ? copy.publicKeyMissing : publicInfo ? copy.publicKeyInvalid : vaultUnlocked ? copy.publicKeyLoading : copy.publicKeyMissing}
                    </p>
                  )}
                </div>
              )}

              {privateName && (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-[var(--workspace-text-strong)]">{copy.hostsUsing}</span>
                    <small className="text-[11px] text-[var(--workspace-text-subtle)]">{fill(copy.hostCount, { n: hostsUsing.length })}</small>
                  </div>
                  {hostsUsing.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {hostsUsing.map((host) => (
                        <span key={host.id} className="rounded-md border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2 py-0.5 text-xs text-[var(--workspace-text)]">{host.name}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--workspace-text-muted)]">{copy.hostsUsingNone}</p>
                  )}
                </div>
              )}

              <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--workspace-border-soft)] pt-3">
                <Button size="sm" className="gap-1.5" onClick={() => void handleRevealKey(selected)} disabled={!vaultUnlocked || revealingKey === selected}>
                  {revealingKey === selected ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} {copy.viewCredential}
                </Button>
                {publicKey && (
                  <>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void handleCopyPublicKey()}>
                      <Copy className="h-3.5 w-3.5" /> {copy.copyPublicKey}
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={!vaultUnlocked} onClick={() => setDeployOpen(true)}>
                      <Upload className="h-3.5 w-3.5" /> {copy.deploy}
                    </Button>
                  </>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-[var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)]" onClick={() => void handleDeleteKey(selected)} title={copy.deleteKey} aria-label={copy.deleteKey}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
