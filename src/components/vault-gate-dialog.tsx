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
import { useT } from '@/lib/i18n'
import type { VaultStatus } from '@/lib/vault'
import { Fingerprint, Loader2, Lock, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'biometric' | 'password' | 'biometric-opt-in'

interface BiometricOptInProps {
  password: string
  onDone: () => void
}

interface VaultGateDialogProps {
  open: boolean
  vaultStatus: VaultStatus | null
  onSubmit: (password: string) => Promise<void>
  biometricOptIn?: BiometricOptInProps
}

export function VaultGateDialog({ open, vaultStatus, onSubmit, biometricOptIn }: VaultGateDialogProps) {
  const { t } = useT()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [bioStatus, setBioStatus] = useState<BiometricStatus | null>(null)
  const [bioError, setBioError] = useState('')
  const [phase, setPhase] = useState<Phase>('password')
  const bioTriggeredRef = useRef(false)

  const isOptInMode = !!biometricOptIn
  const isInitialized = vaultStatus?.initialized ?? false
  const canUseBiometric = isInitialized && bioStatus?.available && isBiometricEnabled()
  const bioLabel = biometryLabel(bioStatus?.type ?? 'none')

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPassword('')
      setError('')
      setBioError('')
      bioTriggeredRef.current = false
      // If this is the opt-in dialog, go straight to opt-in phase
      setPhase(isOptInMode ? 'biometric-opt-in' : 'password')
    }
  }, [open, isOptInMode])

  // Check biometric availability
  useEffect(() => {
    if (!open) return
    void checkBiometricStatus().then((status) => {
      setBioStatus(status)
      // If vault is initialized and biometric is enabled, start with biometric phase
      // But not if we're in opt-in mode
      if (!isOptInMode && vaultStatus?.initialized && status.available && isBiometricEnabled()) {
        setPhase('biometric')
      }
      // If opt-in mode but biometric not available, close immediately
      if (isOptInMode && !status.available) {
        biometricOptIn?.onDone()
      }
    })
  }, [open, vaultStatus?.initialized, isOptInMode]) // eslint-disable-line react-hooks/exhaustive-deps

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
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="flex h-auto max-h-dvh items-center justify-center border-0 bg-transparent p-4 md:max-w-sm md:p-0">
        <div className="w-full max-w-sm overflow-hidden rounded-xl border bg-card p-0 shadow-lg">

          {/* ── Phase: Biometric auto-unlock ── */}
          {phase === 'biometric' && (
            <>
              <GateHeader icon={<Fingerprint className="h-6 w-6" />}
                title={t('vault.unlock')}
                desc={t('vault.biometricPrompt', { type: bioLabel })} />
              <div className="flex flex-col items-center gap-4 px-6 pb-6 sm:px-8 sm:pb-8">
                {busy ? (
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                ) : (
                  <button type="button"
                    onClick={() => { bioTriggeredRef.current = false; void attemptBiometricUnlock() }}
                    className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-colors active:bg-primary/20">
                    <Fingerprint className="h-8 w-8" />
                  </button>
                )}
                <button type="button" onClick={() => setPhase('password')}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                  {t('vault.usePassword')}
                </button>
              </div>
            </>
          )}

          {/* ── Phase: Password input ── */}
          {phase === 'password' && (
            <>
              <GateHeader icon={<Lock className="h-6 w-6" />}
                title={isInitialized ? t('vault.unlock') : t('vault.initialize')}
                desc={isInitialized ? t('vault.unlockDesc') : t('vault.initializeDesc')} />
              <form data-testid="vault-password-form" data-mode={isOptInMode ? 'biometric-opt-in' : isInitialized ? 'unlock' : 'initialize'} className="space-y-3 px-6 pb-6 pt-2 sm:px-8 sm:pb-8" onSubmit={(e) => {
                e.preventDefault()
                if (busy || !password.trim()) return
                void handlePasswordSubmit(password)
              }}>
                {bioError && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    <span>{bioError}</span>
                  </div>
                )}
                <div>
                  <Input data-testid="vault-master-password" aria-label={isInitialized ? t('vault.enterPassword') : t('vault.setPassword')} type="password" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isInitialized ? t('vault.enterPassword') : t('vault.setPassword')}
                    className="h-11 rounded-lg border border-input bg-background text-foreground text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                    autoFocus autoComplete={isInitialized ? 'current-password' : 'new-password'}
                    disabled={busy} />
                  {error && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}
                </div>
                <Button data-testid="vault-submit" type="submit" className="h-11 w-full rounded-lg font-medium"
                  disabled={busy || !password.trim()}>
                  {busy
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{isInitialized ? t('vault.unlocking') : t('vault.initializing')}</>
                    : isInitialized ? t('vault.unlockBtn') : t('vault.initializeBtn')
                  }
                </Button>
                {/* Switch back to biometric */}
                {canUseBiometric && (
                  <button type="button"
                    onClick={() => { setPhase('biometric'); bioTriggeredRef.current = false }}
                    className="flex w-full items-center justify-center gap-1.5 pt-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                    <Fingerprint className="h-3.5 w-3.5" />
                    {t('vault.retryBiometric', { type: bioLabel })}
                  </button>
                )}
              </form>
            </>
          )}

          {/* ── Phase: Biometric opt-in (after first initialization) ── */}
          {phase === 'biometric-opt-in' && (
            <>
              <GateHeader icon={<Fingerprint className="h-6 w-6" />}
                title={t('vault.biometricOptInTitle')}
                desc={t('vault.biometricOptInDesc', { type: bioLabel })} />
              <div className="flex flex-col gap-3 px-6 pb-6 sm:px-8 sm:pb-8">
                {optInError && (
                  <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    <span>{optInError}</span>
                  </div>
                )}
                <Button className="h-11 w-full gap-2 rounded-lg font-medium"
                  onClick={() => void handleEnableBiometric()} disabled={busy}>
                  {busy
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <><Fingerprint className="h-4 w-4" />{t('vault.biometricOptInEnable', { type: bioLabel })}</>
                  }
                </Button>
                <button data-testid="vault-biometric-skip" type="button" onClick={handleSkipBiometric}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground">
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
function GateHeader({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-gradient-to-b from-muted/30 to-transparent px-6 pt-7 pb-4 sm:px-8 sm:pt-8 sm:pb-5">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </div>
      <h3 className="text-center text-lg font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-1.5 text-center text-sm leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}
