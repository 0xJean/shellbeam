import { useState, useMemo } from 'react'
import { useT } from '@/lib/i18n'
import {
  Shield, CloudUpload, ArchiveRestore, AlertTriangle, Eye, EyeOff,
  Check, X, Lock, Server, Code2, KeyRound, RefreshCw, Clock,
  ChevronDown, Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { backupCreate, backupRestore } from '@/lib/backup'
import { cn } from '@/lib/utils'

const DATA_ITEMS = [
  { key: 'hosts', label: 'backup.hosts', icon: Server, desc: 'backup.hostsDesc' },
  { key: 'snippets', label: 'backup.snippetsData', icon: Code2, desc: 'backup.snippetsDesc' },
  { key: 'vault', label: 'backup.vaultData', icon: KeyRound, desc: 'backup.vaultDesc' },
  { key: 'sync', label: 'backup.syncData', icon: RefreshCw, desc: 'backup.syncDesc' },
  { key: 'history', label: 'backup.historyData', icon: Clock, desc: 'backup.historyDesc' },
] as const

type DataKey = (typeof DATA_ITEMS)[number]['key']

function getPasswordStrength(pw: string) {
  if (pw.length === 0) return { level: 0, label: '', color: '' }
  if (pw.length < 8) return { level: 1, label: 'backup.tooShort', color: 'bg-red-500' }
  let score = 0
  if (/[a-z]/.test(pw)) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^a-zA-Z0-9]/.test(pw)) score++
  if (pw.length >= 12) score++
  if (score <= 2) return { level: 2, label: 'backup.weak', color: 'bg-amber-500' }
  if (score <= 3) return { level: 3, label: 'backup.good', color: 'bg-blue-500' }
  return { level: 4, label: 'backup.strong', color: 'bg-emerald-500' }
}

function DataToggle({ item, checked, onChange, disabled }: {
  item: (typeof DATA_ITEMS)[number]
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const { t } = useT()
  const Icon = item.icon
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
        checked
          ? 'border-primary/40 bg-primary/5'
          : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      <div className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
        checked ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-none">{t(item.label)}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{t(item.desc)}</div>
      </div>
      <div className={cn(
        'h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/30',
      )}>
        {checked && <Check className="h-2.5 w-2.5 text-white" />}
      </div>
    </button>
  )
}

function PasswordInput({ value, onChange, placeholder, disabled }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="pr-9"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(!show)}
        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

interface BackupRestorePanelProps {
  vaultId?: string
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
  onRestoreComplete?: () => void
}

export function BackupRestorePanel({ vaultId, onSuccess, onError, onRestoreComplete }: BackupRestorePanelProps) {
  const { t } = useT()
  const [createPassword, setCreatePassword] = useState('')
  const [createConfirm, setCreateConfirm] = useState('')
  const [createData, setCreateData] = useState<Record<DataKey, boolean>>({
    hosts: true, snippets: true, vault: true, sync: true, history: false,
  })

  const [restorePassword, setRestorePassword] = useState('')
  const [restoreData, setRestoreData] = useState<Record<DataKey, boolean>>({
    hosts: true, snippets: true, vault: true, sync: true, history: false,
  })

  const [busy, setBusy] = useState(false)
  const [createExpanded, setCreateExpanded] = useState(false)
  const [restoreExpanded, setRestoreExpanded] = useState(false)

  const strength = useMemo(() => getPasswordStrength(createPassword), [createPassword])
  const passwordsMatch = createPassword.length > 0 && createConfirm.length > 0 && createPassword === createConfirm
  const passwordsMismatch = createConfirm.length > 0 && createPassword !== createConfirm

  const selectedCreateCount = Object.values(createData).filter(Boolean).length
  const selectedRestoreCount = Object.values(restoreData).filter(Boolean).length

  async function handleCreate() {
    if (createPassword.length < 8) {
      onError?.('Backup password must be at least 8 characters')
      return
    }
    if (createPassword !== createConfirm) {
      onError?.('Passwords do not match')
      return
    }
    setBusy(true)
    try {
      const result = await backupCreate(createPassword, {
        vaultId: vaultId ?? undefined,
        includeHosts: createData.hosts,
        includeSnippets: createData.snippets,
        includeVault: createData.vault,
        includeSync: createData.sync,
        includeHistory: createData.history,
      })
      setCreateExpanded(false)
      setCreatePassword('')
      setCreateConfirm('')
      onSuccess?.(`Backup created: ${result.path} (${(result.sizeBytes / 1024).toFixed(1)} KB)`)
    } catch (e) {
      onError?.(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore() {
    if (!restorePassword.trim()) {
      onError?.('Backup password is required')
      return
    }
    setBusy(true)
    try {
      const result = await backupRestore(restorePassword, {
        vaultId: vaultId ?? undefined,
        overwriteHosts: restoreData.hosts,
        overwriteSnippets: restoreData.snippets,
        overwriteVault: restoreData.vault,
        overwriteSync: restoreData.sync,
        overwriteHistory: restoreData.history,
      })
      setRestoreExpanded(false)
      setRestorePassword('')
      const parts: string[] = []
      if (result.hostsRestored) parts.push(`${result.hostsRestored} hosts`)
      if (result.snippetsRestored) parts.push(`${result.snippetsRestored} snippets`)
      if (result.vaultRestored) parts.push('vault')
      if (result.syncRestored) parts.push('sync')
      if (result.historyRestored) parts.push(`${result.historyRestored} history`)
      onSuccess?.(`Restore completed: ${parts.join(', ') || 'nothing'}`)
      onRestoreComplete?.()
    } catch (e) {
      onError?.(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Shield className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('backup.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('backup.desc')}
          </p>
        </div>
        <Badge variant="outline" className="ml-auto gap-1.5 shrink-0">
          <Lock className="h-3 w-3" />
          AES-256
        </Badge>
      </div>

      {/* ── Create Backup ── */}
      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setCreateExpanded(!createExpanded)}
          disabled={busy}
          className="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-muted/30"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
            <CloudUpload className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold">{t('backup.createBackup')}</div>
            <p className="text-sm text-muted-foreground">
              {t('backup.createDesc')}
            </p>
          </div>
          <ChevronDown className={cn(
            'h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200',
            createExpanded && 'rotate-180',
          )} />
        </button>

        {createExpanded && (
          <CardContent className="border-t px-5 pb-5 pt-4 space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{t('backup.dataToInclude')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('backup.dataSelected', { x: selectedCreateCount, y: DATA_ITEMS.length })}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {DATA_ITEMS.map((item) => (
                  <DataToggle
                    key={item.key}
                    item={item}
                    checked={createData[item.key]}
                    onChange={(v) => setCreateData((d) => ({ ...d, [item.key]: v }))}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">{t('backup.encPassword')}</span>
                <PasswordInput
                  value={createPassword}
                  onChange={setCreatePassword}
                  placeholder={t('backup.minChars')}
                  disabled={busy}
                />
                {createPassword.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={cn(
                            'h-1 flex-1 rounded-full transition-colors',
                            i <= strength.level ? strength.color : 'bg-muted',
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{strength.label && t(strength.label)}</p>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <span className="text-sm font-medium">{t('backup.confirmPassword')}</span>
                <PasswordInput
                  value={createConfirm}
                  onChange={setCreateConfirm}
                  placeholder={t('backup.repeatPassword')}
                  disabled={busy}
                />
                {passwordsMatch && (
                  <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" /> {t('backup.passwordsMatch')}
                  </p>
                )}
                {passwordsMismatch && (
                  <p className="flex items-center gap-1 text-xs text-red-500">
                    <X className="h-3 w-3" /> {t('backup.passwordsNoMatch')}
                  </p>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              Your backup is encrypted with AES-256-GCM. You will need this password to restore on another device. It cannot be recovered if lost.
            </p>

            <Button
              onClick={() => void handleCreate()}
              disabled={busy || !passwordsMatch || selectedCreateCount === 0}
              className="w-full gap-2"
            >
              {busy ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {t('backup.creatingBackup')}</>
              ) : (
                <><CloudUpload className="h-4 w-4" /> {t('backup.createBtn')}</>
              )}
            </Button>
          </CardContent>
        )}
      </Card>

      {/* ── Restore from Backup ── */}
      <Card className="overflow-hidden border-amber-500/20">
        <button
          type="button"
          onClick={() => setRestoreExpanded(!restoreExpanded)}
          disabled={busy}
          className="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-amber-500/5"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
            <ArchiveRestore className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold">{t('backup.restoreBackup')}</div>
            <p className="text-sm text-muted-foreground">
              {t('backup.restoreDesc')}
            </p>
          </div>
          <ChevronDown className={cn(
            'h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200',
            restoreExpanded && 'rotate-180',
          )} />
        </button>

        {restoreExpanded && (
          <CardContent className="border-t border-amber-500/20 px-5 pb-5 pt-4 space-y-5">
            <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t('backup.caution')}
                </p>
                <p className="text-xs text-amber-600/80 dark:text-amber-400/80 leading-relaxed">
                  {t('backup.cautionDesc')}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">{t('backup.backupPassword')}</span>
              <PasswordInput
                value={restorePassword}
                onChange={setRestorePassword}
                placeholder={t('backup.passwordPlaceholder')}
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{t('backup.dataToRestore')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('backup.dataSelected', { x: selectedRestoreCount, y: DATA_ITEMS.length })}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {DATA_ITEMS.map((item) => (
                  <DataToggle
                    key={item.key}
                    item={item}
                    checked={restoreData[item.key]}
                    onChange={(v) => setRestoreData((d) => ({ ...d, [item.key]: v }))}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>

            <Button
              onClick={() => void handleRestore()}
              disabled={busy || !restorePassword.trim() || selectedRestoreCount === 0}
              variant="outline"
              className="w-full gap-2 border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
            >
              {busy ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {t('backup.restoring')}</>
              ) : (
                <><ArchiveRestore className="h-4 w-4" /> {t('backup.chooseRestore')}</>
              )}
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
