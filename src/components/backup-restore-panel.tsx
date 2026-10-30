import { useId, useState, useMemo } from 'react'
import { useT } from '@/lib/i18n'
import {
  Archive, ArchiveRestore, AlertTriangle, Eye, EyeOff,
  Check, X, Lock, Loader2, RotateCcw, ShieldCheck, CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { backupCreate, backupRestore, type BackupRestoreResult } from '@/lib/backup'
import { fill } from '@/lib/locales/probe-install'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'

const DATA_ITEMS = [
  { key: 'hosts', label: 'backup.hosts' },
  { key: 'snippets', label: 'backup.snippetsData' },
  { key: 'vault', label: 'backup.vaultData' },
  { key: 'sync', label: 'backup.syncData' },
  { key: 'history', label: 'backup.historyData' },
] as const

type DataKey = (typeof DATA_ITEMS)[number]['key']

const STRENGTH_COLOR = ['', 'var(--workspace-status-bad)', 'var(--workspace-status-warn)', 'var(--workspace-primary-500)', 'var(--workspace-status-good)']

function getPasswordStrength(pw: string) {
  if (pw.length === 0) return { level: 0, label: '' }
  if (pw.length < 8) return { level: 1, label: 'backup.tooShort' }
  let score = 0
  if (/[a-z]/.test(pw)) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^a-zA-Z0-9]/.test(pw)) score++
  if (pw.length >= 12) score++
  if (score <= 2) return { level: 2, label: 'backup.weak' }
  if (score <= 3) return { level: 3, label: 'backup.good' }
  return { level: 4, label: 'backup.strong' }
}

function DataChecklist({ value, onChange, disabled }: {
  value: Record<DataKey, boolean>
  onChange: (key: DataKey, checked: boolean) => void
  disabled?: boolean
}) {
  const { t } = useT()
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {DATA_ITEMS.map((item) => (
        <label key={item.key} className="flex cursor-pointer items-center gap-2.5 text-[13px] text-[var(--workspace-text)]">
          <Checkbox checked={value[item.key]} disabled={disabled} onChange={(e) => onChange(item.key, e.target.checked)} />
          {t(item.label)}
        </label>
      ))}
    </div>
  )
}

function PasswordInput({ value, onChange, placeholder, disabled, label }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  label: string
}) {
  const { locale } = useT()
  const copy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Lock className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
      <input
        type={show ? 'text' : 'password'}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-9 w-full rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-9 pr-9 font-mono text-[13px] text-[var(--workspace-text-strong)] outline-none placeholder:font-sans placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)] disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? copy.hidePassword : copy.showPassword}
        onClick={() => setShow(!show)}
        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[var(--workspace-text-subtle)] transition-colors hover:text-[var(--workspace-text-strong)]"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

const sectionLabel = 'text-[13px] font-medium text-[var(--workspace-text-strong)]'

interface BackupRestorePanelProps {
  vaultId?: string
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
  onRestoreComplete?: () => void
}

export function BackupRestorePanel({ vaultId, onSuccess, onError, onRestoreComplete }: BackupRestorePanelProps) {
  const { t, locale } = useT()
  const copy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const restoreTitleId = useId()
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
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null)
  const [lastBackup, setLastBackup] = useState<{ path: string; size: string; at: string } | null>(null)

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
      setCreatePassword('')
      setCreateConfirm('')
      setLastBackup({ path: result.path, size: `${(result.sizeBytes / 1024).toFixed(1)} KB`, at: new Date().toLocaleString() })
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
      setRestorePassword('')
      setRestoreResult(result)
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

  function closeRestore() {
    if (busy) return
    setRestoreOpen(false)
    setRestoreResult(null)
  }

  const restoreStats = restoreResult ? [
    [copy.statHosts, restoreData.hosts ? String(restoreResult.hostsRestored) : copy.skipped],
    [copy.statSnippets, restoreData.snippets ? String(restoreResult.snippetsRestored) : copy.skipped],
    [copy.statVault, restoreResult.vaultRestored ? copy.restored : copy.skipped],
    [copy.statSync, restoreResult.syncRestored ? copy.restored : copy.skipped],
    [copy.statHistory, restoreData.history ? String(restoreResult.historyRestored) : copy.skipped],
  ] : []

  return (
    <section className="sb-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-5 py-3.5">
        <Archive className="h-4 w-4 text-[var(--workspace-text-muted)]" />
        <h2 className="text-[14px] font-semibold text-[var(--workspace-text-strong)]">{copy.encBackup}</h2>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--workspace-text-muted)]">
          <Lock className="h-3 w-3" />
          AES-256
        </span>
      </div>

      <div className="space-y-5 p-5">
        {lastBackup && (
          <div className="flex items-center gap-3 rounded-xl bg-[var(--workspace-surface-800)] p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className={sectionLabel}>{copy.lastBackup}</p>
              <p className="break-all text-[11px] text-[var(--workspace-text-muted)]">{fill(copy.lastBackupSub, lastBackup)}</p>
            </div>
          </div>
        )}

        <div data-tour="backup-data" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className={sectionLabel}>{t('backup.dataToInclude')}</span>
            <span className="text-[11px] text-[var(--workspace-text-subtle)]">
              {t('backup.dataSelected', { x: selectedCreateCount, y: DATA_ITEMS.length })}
            </span>
          </div>
          <DataChecklist value={createData} disabled={busy} onChange={(key, v) => setCreateData((d) => ({ ...d, [key]: v }))} />
        </div>

        <div data-tour="backup-password" className="space-y-2">
          <span className={sectionLabel}>{copy.backupPassword}</span>
          <PasswordInput label={copy.backupPassword} value={createPassword} onChange={setCreatePassword} placeholder={t('backup.minChars')} disabled={busy} />
          {createPassword.length > 0 && (
            <div className="flex items-center gap-2" aria-label={`${copy.strength}: ${strength.label ? t(strength.label) : ''}`}>
              <div className="grid flex-1 grid-cols-4 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-1 rounded-full" style={{ background: i <= strength.level ? STRENGTH_COLOR[strength.level] : 'var(--workspace-surface-700)' }} />
                ))}
              </div>
              <span className="text-[11px]" style={{ color: STRENGTH_COLOR[strength.level] }}>{strength.label && t(strength.label)}</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <span className={sectionLabel}>{copy.confirmPassword}</span>
          <PasswordInput label={copy.confirmPassword} value={createConfirm} onChange={setCreateConfirm} placeholder={t('backup.repeatPassword')} disabled={busy} />
          {passwordsMatch && (
            <p className="flex items-center gap-1 text-[11px] text-[color:var(--workspace-status-good-text)]">
              <Check className="h-3 w-3" /> {t('backup.passwordsMatch')}
            </p>
          )}
          {passwordsMismatch && (
            <p className="flex items-center gap-1 text-[11px] text-[color:var(--workspace-status-bad-text)]">
              <X className="h-3 w-3" /> {t('backup.passwordsNoMatch')}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-[var(--workspace-text-muted)]">{copy.passwordHint}</p>
          <p className="text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{copy.aesNote}</p>
        </div>

        <Button
          data-tour="backup-create"
          onClick={() => void handleCreate()}
          disabled={busy || !passwordsMatch || selectedCreateCount === 0}
          className="h-10 w-full gap-2"
        >
          {busy && !restoreOpen ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> {t('backup.creatingBackup')}</>
          ) : (
            <><Archive className="h-4 w-4" /> {copy.createBackup}</>
          )}
        </Button>

        <div data-tour="backup-restore" className="flex items-center gap-3 rounded-xl border border-dashed p-4" style={{ borderColor: 'color-mix(in srgb, var(--workspace-status-bad) 45%, transparent)' }}>
          <RotateCcw className="h-4 w-4 shrink-0 text-[color:var(--workspace-status-bad-text)]" />
          <div className="min-w-0 flex-1">
            <p className={sectionLabel}>{copy.restoreTitle}</p>
            <p className="text-[11px] text-[var(--workspace-text-muted)]">{copy.restoreDesc}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => { setRestoreResult(null); setRestoreOpen(true) }}
            className="shrink-0 bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
          >
            {copy.chooseFile}
          </Button>
        </div>
      </div>

      <Dialog open={restoreOpen} onOpenChange={(open) => { if (!open) closeRestore() }} labelledBy={restoreTitleId}>
        <DialogContent className="sb-card md:w-[560px] md:max-w-[560px]">
          <div className="flex items-start justify-between gap-3 px-5 pt-5">
            <div>
              <h2 id={restoreTitleId} className="text-[17px] font-semibold text-[var(--workspace-text-strong)]">{t('backup.restoreBackup')}</h2>
              <p className="mt-0.5 text-[12px] text-[var(--workspace-text-muted)]">{t('backup.restoreDesc')}</p>
            </div>
            <button type="button" aria-label={t('sync.cancel')} disabled={busy} onClick={closeRestore} className="rounded-md p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {restoreResult ? (
            <>
              <div className="space-y-4 p-5">
                <div className="flex flex-col items-center gap-2 text-center">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  <h3 className="text-[15px] font-semibold text-[var(--workspace-text-strong)]">{copy.restoreDone}</h3>
                  <p className="text-[12px] text-[var(--workspace-text-muted)]">{copy.restoreDoneDesc}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {restoreStats.map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-[var(--workspace-surface-800)] p-3">
                      <p className="text-[11px] text-[var(--workspace-text-muted)]">{label}</p>
                      <p className="mt-1 text-[17px] font-semibold text-[var(--workspace-text-strong)]">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
                <Button size="sm" onClick={closeRestore}>{copy.done}</Button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-4 p-5">
                <div role="alert" className="flex gap-2.5 rounded-lg bg-[var(--workspace-status-bad-bg)] p-3 text-[12px] leading-relaxed text-[color:var(--workspace-status-bad-text)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">{t('backup.caution')}</p>
                    <p>{copy.restoreWarn}</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <span className={sectionLabel}>{t('backup.backupPassword')}</span>
                  <PasswordInput label={t('backup.backupPassword')} value={restorePassword} onChange={setRestorePassword} placeholder={t('backup.passwordPlaceholder')} disabled={busy} />
                  <p className="text-[11px] text-[var(--workspace-text-muted)]">{copy.restorePwHint}</p>
                </div>
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className={sectionLabel}>{copy.restoreData}</span>
                    <span className="text-[11px] text-[var(--workspace-text-subtle)]">
                      {t('backup.dataSelected', { x: selectedRestoreCount, y: DATA_ITEMS.length })}
                    </span>
                  </div>
                  <DataChecklist value={restoreData} disabled={busy} onChange={(key, v) => setRestoreData((d) => ({ ...d, [key]: v }))} />
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[color:var(--workspace-border-soft)] px-5 py-3">
                <Button variant="outline" size="sm" disabled={busy} onClick={closeRestore}>{t('sync.cancel')}</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRestore()}
                  disabled={busy || !restorePassword.trim() || selectedRestoreCount === 0}
                  className="gap-1.5 bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)] hover:text-[color:var(--workspace-status-bad-text)]"
                >
                  {busy ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('backup.restoring')}</>
                  ) : (
                    <><ArchiveRestore className="h-3.5 w-3.5" /> {copy.chooseAndRestore}</>
                  )}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
