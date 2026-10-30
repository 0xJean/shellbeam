import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
    biometryLabel,
    checkBiometricStatus,
    hasMasterPassword,
    isBiometricEnabled,
    removeMasterPassword,
    retrieveMasterPassword,
    storeMasterPassword,
    type BiometricStatus,
} from '@/lib/biometric'
import logoUrl from '@/assets/logo.png'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { welcomeLockCopy } from '@/lib/locales/welcome-lock-v3'
import { fill } from '@/lib/locales/probe-install'
import { cn } from '@/lib/utils'
import type { VaultStatus } from '@/lib/vault'
import { offerVaultSetup, useWelcomeOwnsVaultSetup } from '@/lib/vault-setup-handoff'
import { CornerDownLeft, Fingerprint, Loader2, Lock, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'locked' | 'biometric' | 'password' | 'biometric-opt-in'

interface BiometricOptInProps {
  password: string
  onDone: () => void
}

interface VaultGateDialogProps {
  open: boolean
  vaultStatus: VaultStatus | null
  onSubmit: (password: string) => Promise<void>
  biometricOptIn?: BiometricOptInProps
  /** Locked during this session (auto-lock or Lock now): cover the app and wait for an explicit unlock. */
  held?: boolean
}

export function VaultGateDialog({ open, vaultStatus, onSubmit, biometricOptIn, held = false }: VaultGateDialogProps) {
  const { t, locale } = useT()
  const c = welcomeLockCopy[locale]
  const { vaults, activeVaultId, vaultAutoLockMinutes } = useVault()
  const welcomeOwnsSetup = useWelcomeOwnsVaultSetup()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [bioStatus, setBioStatus] = useState<BiometricStatus | null>(null)
  const [bioError, setBioError] = useState('')
  const [phase, setPhase] = useState<Phase>('password')
  const bioTriggeredRef = useRef(false)

  const isOptInMode = !!biometricOptIn
  const isInitialized = vaultStatus?.initialized ?? false
  const holding = held && !isOptInMode && isInitialized
  const canUseBiometric = isInitialized && bioStatus?.available && isBiometricEnabled()
  const bioLabel = biometryLabel(bioStatus?.type ?? 'none')
  // The first-run welcome creates the vault itself, through this gate's own submit handler.
  const deferToWelcome = welcomeOwnsSetup && !isOptInMode && vaultStatus?.initialized === false
  const vaultName = vaults.find((item) => item.id === activeVaultId)?.name ?? ''

  useEffect(() => (deferToWelcome ? offerVaultSetup(onSubmit) : undefined), [deferToWelcome, onSubmit])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword('')
      setError('')
      setBioError('')
      bioTriggeredRef.current = false
      // If this is the opt-in dialog, go straight to opt-in phase
      setPhase(isOptInMode ? 'biometric-opt-in' : holding ? 'locked' : 'password')
    }
  }, [open, isOptInMode, holding])

  // Check biometric availability
  useEffect(() => {
    if (!open) return
    void checkBiometricStatus().then((status) => {
      setBioStatus(status)
      // If vault is initialized and biometric is enabled, start with biometric phase
      // But not if we're in opt-in mode
      if (!isOptInMode && !holding && vaultStatus?.initialized && status.available && isBiometricEnabled()) {
        setPhase('biometric')
      }
      // If opt-in mode but biometric not available, close immediately
      if (isOptInMode && !status.available) {
        biometricOptIn?.onDone()
      }
    })
  }, [open, vaultStatus?.initialized, isOptInMode, holding]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-trigger biometric when entering biometric phase
  useEffect(() => {
    if (phase !== 'biometric' || bioTriggeredRef.current) return
    bioTriggeredRef.current = true
    void attemptBiometricUnlock()
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Biometric unlock ──────────────────────────────────────────────────
  const attemptBiometricUnlock = useCallback(async () => {
    setBioError('')
    setBusy(true)
    try {
      const hasStored = await hasMasterPassword()
      if (!hasStored) {
        setPhase('password')
        setBusy(false)
        return
      }
      const pw = await retrieveMasterPassword(t('vault.biometricReason'))
      await onSubmit(pw)
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e)
      if (msg.includes('userCancel') || msg.includes('userFallback') || msg.includes('cancel')) {
        setPhase('password')
      } else if (msg.includes('Lockout') || msg.includes('lockout')) {
        setBioError(t('vault.biometricLockout'))
        setPhase('password')
      } else if (msg.includes('itemNotFound')) {
        setPhase('password')
      } else {
        setBioError(msg)
        setPhase('password')
      }
    } finally {
      setBusy(false)
    }
  }, [onSubmit, t])

  // ── Password submit ───────────────────────────────────────────────────
  const handlePasswordSubmit = useCallback(async (pw: string) => {
    setBusy(true)
    setError('')
    try {
      await onSubmit(pw)
      // If biometric is already enabled, silently update stored password
      if (bioStatus?.available && isBiometricEnabled()) {
        try { await storeMasterPassword(pw) } catch { /* non-critical */ }
      }
      // Dialog closes via parent (vault becomes unlocked, or parent triggers opt-in)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }, [onSubmit, bioStatus])

  // ── Biometric opt-in handlers ─────────────────────────────────────────
  const [optInError, setOptInError] = useState('')

  const handleEnableBiometric = useCallback(async () => {
    if (!biometricOptIn) return
    setBusy(true)
    setOptInError('')
    try {
      // 1. Store the password in secure storage (may trigger biometric on some platforms)
      await storeMasterPassword(biometricOptIn.password)
      // 2. Immediately verify by reading it back — this triggers Touch ID / Face ID
      const verified = await retrieveMasterPassword(t('vault.biometricReason'))
      if (verified !== biometricOptIn.password) {
        // Data mismatch — something went wrong, roll back
        await removeMasterPassword()
        setOptInError(t('vault.biometricVerifyFailed'))
        setBusy(false)
        return
      }
      // Success — biometric is now fully configured
      biometricOptIn.onDone()
    } catch (e) {
      // Store or verify failed — roll back the flag
      await removeMasterPassword().catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      // macOS dev mode: unsigned binary can't access keychain
      if (msg.includes('-34018') || msg.includes('keychainError')) {
        setOptInError(t('vault.biometricKeychainError'))
      } else {
        setOptInError(`${t('vault.biometricSetupFailed')}\n${msg}`)
      }
    } finally {
      setBusy(false)
    }
  }, [biometricOptIn, t])

  const handleSkipBiometric = useCallback(() => {
    biometricOptIn?.onDone()
  }, [biometricOptIn])

  // ── Render ────────────────────────────────────────────────────────────
  const vaultInfo = isInitialized && vaultName
    ? fill(c.vaultInfo, { name: vaultName, count: vaultStatus?.secretCount ?? 0 })
    : ''
  const warnBox = 'flex items-start gap-1.5 rounded-lg bg-[color:var(--workspace-status-warn-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-warn-text)]'
  const quietBtn = 'text-xs text-[color:var(--workspace-text-muted)] transition-colors hover:text-[color:var(--workspace-text-strong)]'

  return (
    <Dialog open={open && !deferToWelcome} onOpenChange={() => {}} className={holding ? '[&::backdrop]:bg-background' : undefined}>
      <DialogContent className="flex h-auto max-h-dvh items-center justify-center border-0 bg-transparent p-4 md:max-w-sm md:p-0 max-md:min-h-dvh max-md:bg-[var(--workspace-surface-950)] max-md:px-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-[env(safe-area-inset-top)]">
        <div data-testid="vault-gate-card" className="sb-card w-full max-w-sm overflow-hidden px-8 pb-6 pt-8 shadow-2xl max-md:!border-0 max-md:!bg-transparent max-md:!shadow-none max-md:px-6">

          {/* ── Phase: Locked during the session, waiting for the user ── */}
          {phase === 'locked' && (
            <>
              <GateHeader title={c.locked} desc={vaultInfo || t('vault.unlockDesc')} />
              <Button data-testid="vault-held-unlock" type="button" autoFocus
                onClick={() => setPhase(canUseBiometric ? 'biometric' : 'password')}
                className="h-10 w-full gap-2 rounded-lg bg-[color:var(--workspace-primary-500)] font-semibold text-white hover:opacity-90 max-md:h-12 max-md:rounded-xl max-md:text-[15px]">
                {canUseBiometric ? <Fingerprint className="h-4 w-4" /> : <Lock className="h-4 w-4" />}{t('vault.unlockBtn')}
              </Button>
              <p className="pt-3 text-center text-xs text-[color:var(--workspace-text-subtle)]">{fill(c.autoLock, { minutes: vaultAutoLockMinutes })}</p>
            </>
          )}

          {/* ── Phase: Biometric auto-unlock ── */}
          {phase === 'biometric' && (
            <>
              <GateHeader title={isInitialized ? c.locked : t('vault.unlock')}
                desc={vaultInfo || t('vault.biometricPrompt', { type: bioLabel })} />
              <div className="flex flex-col items-center gap-4">
                {busy ? (
                  <Loader2 className="h-8 w-8 animate-spin text-[color:var(--workspace-primary-500)]" />
                ) : (
                  <button type="button" aria-label={t('vault.biometricPrompt', { type: bioLabel })}
                    onClick={() => { bioTriggeredRef.current = false; void attemptBiometricUnlock() }}
                    className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[color:var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)] transition-opacity active:opacity-80 max-md:h-12 max-md:w-full max-md:gap-2 max-md:rounded-xl max-md:bg-[color:var(--workspace-primary-500)] max-md:text-white">
                    <Fingerprint className="h-8 w-8 max-md:h-5 max-md:w-5" />
                    <span className="text-[15px] font-semibold md:hidden">{fill(c.useBiometric, { type: bioLabel })}</span>
                  </button>
                )}
                <button type="button" onClick={() => setPhase('password')} className={cn(quietBtn, 'max-md:min-h-[44px] max-md:px-3 max-md:text-[15px] max-md:text-[color:var(--workspace-accent-text)]')}>
                  {t('vault.usePassword')}
                </button>
              </div>
            </>
          )}

          {/* ── Phase: Password input ── */}
          {phase === 'password' && (
            <>
              <GateHeader title={isInitialized ? c.locked : t('vault.initialize')}
                desc={isInitialized ? (vaultInfo || t('vault.unlockDesc')) : t('vault.initializeDesc')} />
              <form data-testid="vault-password-form" data-mode={isOptInMode ? 'biometric-opt-in' : isInitialized ? 'unlock' : 'initialize'} className="space-y-3" onSubmit={(e) => {
                e.preventDefault()
                if (busy || !password.trim()) return
                void handlePasswordSubmit(password)
              }}>
                {bioError && (
                  <div className={warnBox}>
                    <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>{bioError}</span>
                  </div>
                )}
                <div>
                  <div className="flex h-10 items-center gap-2 rounded-lg border max-md:h-12 max-md:rounded-xl border-[color:var(--workspace-border-soft)] bg-[color:var(--workspace-surface-950)] px-3 focus-within:border-[color:var(--workspace-primary-500)] focus-within:ring-2 focus-within:ring-[color:var(--workspace-accent-subtle)]">
                    <Lock className="h-4 w-4 shrink-0 text-[color:var(--workspace-text-subtle)]" />
                    <Input data-testid="vault-master-password" aria-label={isInitialized ? t('vault.enterPassword') : t('vault.setPassword')} type="password" value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={isInitialized ? t('vault.enterPassword') : t('vault.setPassword')}
                      className="h-full flex-1 border-0 bg-transparent px-0 text-sm text-[color:var(--workspace-text-strong)] shadow-none placeholder:text-[color:var(--workspace-text-subtle)] focus-visible:ring-0"
                      autoFocus autoComplete={isInitialized ? 'current-password' : 'new-password'}
                      disabled={busy} />
                    <CornerDownLeft aria-hidden className="h-4 w-4 shrink-0 rounded border border-[color:var(--workspace-border-soft)] p-0.5 text-[color:var(--workspace-text-subtle)]" />
                  </div>
                  {error && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-[color:var(--workspace-status-bad-text)]">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}
                </div>
                <Button data-testid="vault-submit" type="submit" className="h-10 w-full rounded-lg bg-[color:var(--workspace-primary-500)] font-semibold text-white hover:opacity-90 max-md:h-12 max-md:rounded-xl max-md:text-[15px]"
                  disabled={busy || !password.trim()}>
                  {busy
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{isInitialized ? t('vault.unlocking') : t('vault.initializing')}</>
                    : isInitialized ? t('vault.unlockBtn') : t('vault.initializeBtn')
                  }
                </Button>
                {/* Switch back to biometric */}
                {canUseBiometric && (
                  <>
                    <div className="flex items-center gap-3 py-1 text-xs text-[color:var(--workspace-text-subtle)]">
                      <span className="h-px flex-1 bg-[color:var(--workspace-border-soft)]" />{c.or}<span className="h-px flex-1 bg-[color:var(--workspace-border-soft)]" />
                    </div>
                    <button type="button" aria-label={t('vault.retryBiometric', { type: bioLabel })}
                      onClick={() => { setPhase('biometric'); bioTriggeredRef.current = false }}
                      className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] max-md:h-12 max-md:rounded-xl text-sm font-medium text-[color:var(--workspace-text-strong)] transition-colors hover:border-[color:var(--workspace-border-strong)]">
                      <Fingerprint className="h-4 w-4" />
                      {fill(c.useBiometric, { type: bioLabel })}
                    </button>
                  </>
                )}
                {isInitialized && (
                  <p className="pt-1 text-xs text-[color:var(--workspace-text-subtle)]">{fill(c.autoLock, { minutes: vaultAutoLockMinutes })}</p>
                )}
              </form>
            </>
          )}

          {/* ── Phase: Biometric opt-in (after first initialization) ── */}
          {phase === 'biometric-opt-in' && (
            <>
              <GateHeader title={t('vault.biometricOptInTitle')}
                desc={t('vault.biometricOptInDesc', { type: bioLabel })} />
              <div className="flex flex-col gap-3">
                {optInError && (
                  <div className={warnBox}>
                    <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-pre-line">{optInError}</span>
                  </div>
                )}
                <Button className="h-10 w-full gap-2 rounded-lg bg-[color:var(--workspace-primary-500)] font-semibold text-white hover:opacity-90 max-md:h-12 max-md:rounded-xl"
                  onClick={() => void handleEnableBiometric()} disabled={busy}>
                  {busy
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <><Fingerprint className="h-4 w-4" />{t('vault.biometricOptInEnable', { type: bioLabel })}</>
                  }
                </Button>
                <button data-testid="vault-biometric-skip" type="button" onClick={handleSkipBiometric} className={cn(quietBtn, 'max-md:min-h-[44px] max-md:text-sm')}>
                  {t('vault.biometricOptInSkip')}
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Reusable header block for the gate dialog */
function GateHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-5 flex flex-col items-center text-center max-md:mb-10">
      <img src={logoUrl} alt="ShellBeam" className="mb-4 h-14 w-14 rounded-2xl max-md:h-[76px] max-md:w-[76px] max-md:rounded-[22px]" />
      <h3 className="text-lg font-semibold tracking-tight text-[color:var(--workspace-text-strong)] max-md:text-[22px]">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-[color:var(--workspace-text-muted)] max-md:text-[13px]">{desc}</p>
    </div>
  )
}
