import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { HostProfileDraft } from '@/lib/hosts'
import { validateHostDraft } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import type { AuthType } from '@/lib/ssh'
import { cn } from '@/lib/utils'
import { Archive, ChevronDown, Eye, EyeOff, Key, Lock, RefreshCw, Server, User, X } from 'lucide-react'
import { useEffect, useState } from 'react'

interface HostFormProps {
  initial?: Partial<HostProfileDraft> | null
  defaultUsername?: string
  vaultKeys?: string[]
  vaultUnlocked?: boolean
  onSaveToVault?: (key: string, value: string) => Promise<void>
  onLoadVaultSecret?: (key: string) => Promise<string | null>
  onSubmit: (draft: HostProfileDraft) => Promise<void>
  onCancel: () => void
  vaultName?: string
  existingGroups?: string[]
  existingTags?: string[]
}

export function HostForm({
  initial,
  defaultUsername = 'root',
  vaultKeys = [],
  vaultUnlocked = false,
  onSaveToVault,
  onLoadVaultSecret,
  onSubmit,
  onCancel,
  vaultName = 'Vault',
  existingGroups = [],
  existingTags = [],
}: HostFormProps) {
  const [address, setAddress] = useState(initial?.address ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [group, setGroup] = useState(initial?.group ?? 'Custom')
  const [tagsInput, setTagsInput] = useState(initial?.tags?.join(', ') ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? defaultUsername)
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [vaultKeyRef, setVaultKeyRef] = useState(initial?.passwordKeyRef ?? initial?.privateKeyRef ?? '')
  const [useInlineSecret, setUseInlineSecret] = useState(!initial?.passwordKeyRef && !initial?.privateKeyRef)
  const [vaultSaveName, setVaultSaveName] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [groupDraft, setGroupDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [jumpHost, setJumpHost] = useState(initial?.jumpHost ?? '')
  const [jumpPort, setJumpPort] = useState(String(initial?.jumpPort ?? ''))
  const [jumpUser, setJumpUser] = useState(initial?.jumpUser ?? '')
  const [showAdvanced, setShowAdvanced] = useState(!!initial?.jumpHost)

  const { t } = useT()

  const tags = tagsInput.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const addrSlug = (address || 'host').replace(/[^a-zA-Z0-9.-]/g, '-')
  const unusedTags = existingTags.filter((et) => !tags.includes(et))
  const groupLabel = (g: string) => t(`group.${g}`) !== `group.${g}` ? t(`group.${g}`) : g

  useEffect(() => {
    if (!initial) return
    const nextRef = authType === 'password' ? (initial.passwordKeyRef ?? '') : (initial.privateKeyRef ?? '')
    setVaultKeyRef(nextRef)
    setUseInlineSecret(!nextRef)
    setVaultSaveName('')
  }, [authType, initial])

  async function handleSubmit() {
    setError('')
    let passwordKeyRef = initial?.passwordKeyRef
    let privateKeyRef = initial?.privateKeyRef

    if (useInlineSecret) {
      const suffix = authType === 'password' ? 'password' : 'key'
      const existingRef = authType === 'password' ? initial?.passwordKeyRef : initial?.privateKeyRef
      const saveName = vaultSaveName.trim() || existingRef || `${addrSlug}-${suffix}`
      const secret = authType === 'password' ? password : privateKey
      if (secret) {
        try {
          await onSaveToVault?.(saveName, secret)
          if (authType === 'password') passwordKeyRef = saveName
          else privateKeyRef = saveName
        } catch (e) {
          setError(t('hostForm.vaultSaveError', { error: String(e) }))
          return
        }
      }
    } else if (vaultKeyRef) {
      if (authType === 'password') passwordKeyRef = vaultKeyRef
      else privateKeyRef = vaultKeyRef
    }

    const draft: HostProfileDraft = {
      name: name.trim() || address.trim() || t('hostForm.unnamed'),
      address: address.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim() || defaultUsername,
      group,
      authType,
      tags,
      passwordKeyRef: authType === 'password' ? passwordKeyRef : undefined,
      privateKeyRef: authType === 'privateKey' ? privateKeyRef : undefined,
      secretKeyRef: undefined,
      jumpHost: jumpHost.trim() || undefined,
      jumpPort: jumpPort.trim() ? parseInt(jumpPort, 10) || undefined : undefined,
      jumpUser: jumpUser.trim() || undefined,
    }

    const validation = validateHostDraft(draft)
    if (!validation.isValid) {
      setError(validation.errors[0] ?? 'Invalid configuration')
      return
    }

    setSubmitting(true)
    try {
      await onSubmit(draft)
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-xl md:max-w-xl max-md:max-w-none max-md:border-0 max-md:rounded-none max-md:shadow-none">
      <CardContent className="space-y-5 p-5">
        {/* Title */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{initial ? t('hostForm.editHost') : t('hostForm.newHost')}</h2>
          <span className="text-xs text-muted-foreground">{vaultName}</span>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        {/* Connection: Address + Port */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('hostForm.address')}</label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Server className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={address} onChange={(e) => setAddress(e.target.value)}
                placeholder={t('hostForm.addressPlaceholder')} className="pl-9"
              />
            </div>
            <div className="w-20">
              <Input
                type="number" value={port} onChange={(e) => setPort(e.target.value)}
                placeholder="22" className="text-center"
              />
            </div>
          </div>
        </div>

        {/* Username + Label on same row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('hostForm.username')}</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="root" className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('hostForm.label')}</label>
            <Input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t('hostForm.labelPlaceholder')}
            />
          </div>
        </div>

        {/* Group selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('hostForm.parentGroup')}</label>
          <div className="flex flex-wrap gap-1.5">
            {existingGroups.map((g) => (
              <button key={g} type="button" onClick={() => { setGroup(g); setGroupDraft('') }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  group === g && !groupDraft ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                )}>
                {groupLabel(g)}
              </button>
            ))}
            {!existingGroups.includes(group) && group && !groupDraft && (
              <span className="flex items-center gap-1 rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                {group}
                <button type="button" onClick={() => setGroup(existingGroups[0] ?? 'Custom')} className="hover:text-primary/70"><X className="h-3 w-3" /></button>
              </span>
            )}
            <input
              value={groupDraft}
              onChange={(e) => setGroupDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && groupDraft.trim()) {
                  e.preventDefault()
                  setGroup(groupDraft.trim())
                  setGroupDraft('')
                }
              }}
              onBlur={() => {
                if (groupDraft.trim()) { setGroup(groupDraft.trim()); setGroupDraft('') }
              }}
              placeholder={t('hostForm.parentGroupPlaceholder')}
              className="min-w-[100px] flex-1 rounded-md border border-dashed border-border bg-transparent px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('hostForm.tags')}</label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
            {tags.map((tg) => (
              <span key={tg} className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {tg}
                <button type="button" onClick={() => setTagsInput(tags.filter((x) => x !== tg).join(', '))} className="hover:text-primary/70"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && tagDraft.trim()) {
                  e.preventDefault()
                  const v = tagDraft.trim().replace(/[,，]$/, '')
                  if (v && !tags.includes(v)) setTagsInput([...tags, v].join(', '))
                  setTagDraft('')
                } else if (e.key === 'Backspace' && !tagDraft && tags.length > 0) {
                  setTagsInput(tags.slice(0, -1).join(', '))
                }
              }}
              onBlur={() => {
                const v = tagDraft.trim().replace(/[,，]$/, '')
                if (v && !tags.includes(v)) setTagsInput([...tags, v].join(', '))
                setTagDraft('')
              }}
              placeholder={tags.length === 0 ? t('hostForm.tagsPlaceholder') : ''}
              className="min-w-[60px] flex-1 border-none bg-transparent px-0 py-0 text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          {unusedTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {unusedTags.slice(0, 12).map((et) => (
                <button key={et} type="button"
                  onClick={() => { setTagsInput([...tags, et].join(', ')); setTagDraft('') }}
                  className="rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground">
                  + {et}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-border" />

        {/* Auth type toggle */}
        <div className="space-y-3">
          <label className="text-xs font-medium text-muted-foreground">{t('hostForm.credentials')}</label>
          <div className="flex rounded-lg border border-border p-0.5">
            <button type="button" onClick={() => setAuthType('password')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                authType === 'password' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}>
              <Lock className="h-3.5 w-3.5" />{t('hostForm.password')}
            </button>
            <button type="button" onClick={() => setAuthType('privateKey')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                authType === 'privateKey' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}>
              <Key className="h-3.5 w-3.5" />{t('hostForm.key')}
            </button>
          </div>

          {!vaultUnlocked ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t('hostForm.vaultLocked')}</p>
          ) : (
            <CredentialInput
              authType={authType} vaultKeys={vaultKeys} vaultKeyRef={vaultKeyRef} useInline={useInlineSecret}
              password={password} privateKey={privateKey} vaultSaveName={vaultSaveName} addrSlug={addrSlug}
              defaultVaultSaveName={(authType === 'password' ? initial?.passwordKeyRef : initial?.privateKeyRef) || `${addrSlug}-${authType === 'password' ? 'password' : 'key'}`}
              onLoadVaultSecret={onLoadVaultSecret}
              onVaultKeyRef={setVaultKeyRef} onUseInline={setUseInlineSecret}
              onPassword={setPassword} onPrivateKey={setPrivateKey} onVaultSaveName={setVaultSaveName}
            />
          )}
        </div>

        {/* Advanced: Jump Host (collapsible) */}
        <div className="space-y-3">
          <button type="button" onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-180')} />
            {t('hostForm.jumpHost')}
          </button>
          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">{t('hostForm.jumpHostDesc')}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('hostForm.jumpAddress')}</label>
                  <Input value={jumpHost} onChange={(e) => setJumpHost(e.target.value)}
                    placeholder={t('hostForm.jumpAddressPlaceholder')} className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('hostForm.jumpPort')}</label>
                  <Input value={jumpPort} onChange={(e) => setJumpPort(e.target.value)}
                    placeholder="22" className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">{t('hostForm.jumpUser')}</label>
                  <Input value={jumpUser} onChange={(e) => setJumpUser(e.target.value)}
                    placeholder={t('hostForm.jumpUserPlaceholder')} className="h-8 text-sm" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Action buttons at bottom */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel}>{t('hostForm.cancel')}</Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('hostForm.saving') : t('hostForm.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function CredentialInput({ authType, vaultKeys, vaultKeyRef, useInline, password, privateKey, vaultSaveName, addrSlug,
  defaultVaultSaveName, onLoadVaultSecret,
  onVaultKeyRef, onUseInline, onPassword, onPrivateKey, onVaultSaveName,
}: {
  authType: AuthType; vaultKeys: string[]; vaultKeyRef: string; useInline: boolean
  password: string; privateKey: string; vaultSaveName: string; addrSlug: string
  defaultVaultSaveName: string; onLoadVaultSecret?: (key: string) => Promise<string | null>
  onVaultKeyRef: (v: string) => void; onUseInline: (v: boolean) => void
  onPassword: (v: string) => void; onPrivateKey: (v: string) => void; onVaultSaveName: (v: string) => void
}) {
  const { t } = useT()
  const hasVaultKeys = vaultKeys.length > 0
  const isPassword = authType === 'password'
  const Icon = isPassword ? Lock : Key
  const [showManualPassword, setShowManualPassword] = useState(false)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [showRevealedSecret, setShowRevealedSecret] = useState(false)
  const [loadingSecret, setLoadingSecret] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    setRevealedSecret(null)
    setShowRevealedSecret(false)
    setLoadError('')
  }, [vaultKeyRef, authType])

  async function handleToggleSavedSecret() {
    if (showRevealedSecret) {
      setShowRevealedSecret(false)
      return
    }
    if (revealedSecret !== null) {
      setShowRevealedSecret(true)
      return
    }
    if (!vaultKeyRef || !onLoadVaultSecret) return
    setLoadingSecret(true)
    setLoadError('')
    try {
      const value = await onLoadVaultSecret(vaultKeyRef)
      if (value === null) {
        setLoadError(t('hostForm.secretNotFound'))
        return
      }
      setRevealedSecret(value)
      setShowRevealedSecret(true)
    } catch (e) {
      setLoadError(t('hostForm.loadSecretError', { error: String(e) }))
    } finally {
      setLoadingSecret(false)
    }
  }

  return (
    <div className="space-y-2.5">
      {/* Vault key picker */}
      {(hasVaultKeys || vaultKeyRef) && !useInline && (
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{t('hostForm.selectVaultKey')}</label>
          {hasVaultKeys ? (
            <div className="flex flex-wrap gap-1.5">
              {vaultKeys.map((k) => (
                <button key={k} type="button" onClick={() => { onVaultKeyRef(k); onUseInline(false) }}
                  className={cn(
                    'flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    vaultKeyRef === k && !useInline
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-muted/50 text-muted-foreground hover:border-primary/50 hover:text-foreground',
                  )}>
                  <Icon className="h-3 w-3" />{k}
                </button>
              ))}
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <Icon className="h-3 w-3" />{vaultKeyRef}
            </div>
          )}
          {vaultKeyRef && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">{t('hostForm.savedCredential')}</label>
              <div className="relative">
                {isPassword ? (
                  <Input
                    readOnly
                    type={showRevealedSecret ? 'text' : 'password'}
                    value={revealedSecret ?? ''}
                    placeholder="••••••••"
                    className="pr-9 font-mono"
                  />
                ) : (
                  <Textarea
                    readOnly
                    value={showRevealedSecret ? (revealedSecret ?? '') : (revealedSecret ? '••••••••' : '')}
                    placeholder="••••••••"
                    className="min-h-[72px] pr-9 font-mono text-sm"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void handleToggleSavedSecret()}
                  disabled={loadingSecret || !onLoadVaultSecret}
                  title={showRevealedSecret ? t('hostForm.hideSecret') : t('hostForm.showSecret')}
                  className="absolute right-1.5 top-4 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingSecret
                    ? <RefreshCw className="h-4 w-4 animate-spin" />
                    : showRevealedSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {loadError && <p className="text-xs text-destructive">{loadError}</p>}
            </div>
          )}
          <button type="button" onClick={() => { onUseInline(true); onVaultKeyRef('') }}
            className="text-xs text-primary hover:underline">{t('hostForm.orEnterNew')}</button>
        </div>
      )}

      {/* Manual entry */}
      {(useInline || (!hasVaultKeys && !vaultKeyRef)) && (
        <div className="space-y-2">
          {isPassword ? (
            <div className="relative">
              <Input type={showManualPassword ? 'text' : 'password'} value={password}
                onChange={(e) => { onPassword(e.target.value); onUseInline(true) }}
                placeholder={t('hostForm.passwordPlaceholder')} className="pr-9 font-mono" />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowManualPassword((v) => !v)}
                title={showManualPassword ? t('hostForm.hideSecret') : t('hostForm.showSecret')}
                className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
              >
                {showManualPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          ) : (
            <Textarea value={privateKey}
              onChange={(e) => { onPrivateKey(e.target.value); onUseInline(true) }}
              placeholder={t('hostForm.privateKeyPlaceholder')} className="min-h-[80px] font-mono text-sm" />
          )}
          <div className="flex items-center gap-2">
            <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input value={vaultSaveName} onChange={(e) => onVaultSaveName(e.target.value)}
              placeholder={defaultVaultSaveName || `${addrSlug}-${isPassword ? 'password' : 'key'}`} className="h-7 text-xs" />
          </div>
          {hasVaultKeys && (
            <button type="button" onClick={() => { onUseInline(false); onPassword(''); onPrivateKey('') }}
              className="text-xs text-primary hover:underline">{t('hostForm.orSelectExisting')}</button>
          )}
        </div>
      )}
    </div>
  )
}
