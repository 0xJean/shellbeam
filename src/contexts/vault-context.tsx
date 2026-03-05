import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthType } from '@/lib/ssh'
import type { HostProfile } from '@/lib/hosts'
import { DEFAULT_VAULT_ID, listVaults, type VaultMeta } from '@/lib/vaults'
import {
  vaultDeleteSecret,
  vaultGetSecret,
  vaultInitialize,
  vaultListSecretKeys,
  vaultLock,
  vaultSetSecret,
  vaultStatus,
  vaultUnlock,
  type VaultStatus,
} from '@/lib/vault'
import type { SecurityEvent } from '@/lib/types'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Lock, Loader2, ShieldAlert } from 'lucide-react'
import { useT } from '@/lib/i18n'

const VAULT_AUTO_LOCK_MINUTES_KEY = 'shellbeam.vaultAutoLockMinutes'
const SECURITY_EVENTS_KEY = 'shellbeam.securityEvents'

interface VaultContextValue {
  activeVaultId: string
  setActiveVaultId: (id: string) => void
  vaults: VaultMeta[]
  vaultStatusState: VaultStatus | null
  vaultKeys: string[]
  vaultBusy: boolean
  vaultAutoLockMinutes: number
  vaultLastActivityAt: number
  securityEvents: SecurityEvent[]
  refreshVault: () => Promise<void>
  refreshVaults: () => Promise<void>
  handleInitialize: (masterPassword: string) => Promise<void>
  handleUnlock: (masterPassword: string) => Promise<void>
  handleLock: () => Promise<void>
  handleSaveSecret: (key: string, value: string) => Promise<void>
  handleLoadSecret: (key: string) => Promise<void>
  handleDeleteSecret: (key: string) => Promise<void>
  handleAutoLockMinutesChange: (value: number) => void
  handleClearSecurityEvents: () => void
  touchVaultActivity: (reason: string) => void
  appendSecurityEvent: (level: SecurityEvent['level'], message: string) => void
  resolveAuthSecret: (options: {
    authType: AuthType
    explicitSecret: string
    hostForRef?: HostProfile | null
    inputMode?: 'vault' | 'manual'
  }) => Promise<string | undefined>
}

const VaultContext = createContext<VaultContextValue | null>(null)

export function useVault() {
  const ctx = useContext(VaultContext)
  if (!ctx) throw new Error('useVault must be used within VaultProvider')
  return ctx
}

export function VaultProvider({ children, setOutput }: { children: ReactNode; setOutput: (msg: string) => void }) {
  const { t } = useT()
  const [activeVaultId, setActiveVaultId] = useState<string>(DEFAULT_VAULT_ID)
  const [vaults, setVaults] = useState<VaultMeta[]>([])
  const [vaultStatusState, setVaultStatusState] = useState<VaultStatus | null>(null)
  const [vaultKeys, setVaultKeys] = useState<string[]>([])
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState(10)
  const [vaultLastActivityAt, setVaultLastActivityAt] = useState(Date.now())
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([])
  const vaultAutoLockingRef = useRef(false)

  const [gatePassword, setGatePassword] = useState('')
  const [gateError, setGateError] = useState('')
  const [gateBusy, setGateBusy] = useState(false)

  const gateOpen = !!vaultStatusState && !vaultStatusState.unlocked
  useEffect(() => {
    if (gateOpen) { setGatePassword(''); setGateError('') }
  }, [gateOpen])

  function appendSecurityEvent(level: SecurityEvent['level'], message: string) {
    const entry: SecurityEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp: Date.now(),
      level,
      message,
    }
    setSecurityEvents((prev) => [...prev, entry].slice(-120))
  }

  function touchVaultActivity(reason: string) {
    setVaultLastActivityAt(Date.now())
    appendSecurityEvent('info', reason)
  }

  async function handleGateSubmit(password: string) {
    setGateBusy(true)
    setGateError('')
    try {
      if (vaultStatusState?.initialized) {
        await vaultUnlock(password, activeVaultId)
      } else {
        await vaultInitialize(password, activeVaultId)
      }
      await refreshVault()
      touchVaultActivity(vaultStatusState?.initialized ? 'Vault unlocked.' : 'Vault initialized and unlocked.')
      setGatePassword('')
      setGateError('')
    } catch (error) {
      setGateError(String(error instanceof Error ? error.message : error))
    } finally {
      setGateBusy(false)
    }
  }

  async function refreshVault() {
    const st = await vaultStatus(activeVaultId)
    setVaultStatusState(st)
    if (st.initialized) {
      const keys = await vaultListSecretKeys(activeVaultId)
      setVaultKeys(keys)
    } else {
      setVaultKeys([])
    }
  }

  async function refreshVaults() {
    const items = await listVaults()
    setVaults(items)
  }

  useEffect(() => { void refreshVaults() }, [])
  useEffect(() => { void refreshVault() }, [activeVaultId])

  useEffect(() => {
    localStorage.setItem(VAULT_AUTO_LOCK_MINUTES_KEY, String(vaultAutoLockMinutes))
  }, [vaultAutoLockMinutes])

  useEffect(() => {
    localStorage.setItem(SECURITY_EVENTS_KEY, JSON.stringify(securityEvents.slice(-120)))
  }, [securityEvents])

  useEffect(() => {
    const persistedMinutes = localStorage.getItem(VAULT_AUTO_LOCK_MINUTES_KEY)
    const parsed = persistedMinutes ? Number(persistedMinutes) : NaN
    if (Number.isFinite(parsed)) setVaultAutoLockMinutes(Math.max(1, Math.min(120, Math.floor(parsed))))

    const persistedEvents = localStorage.getItem(SECURITY_EVENTS_KEY)
    if (persistedEvents) {
      try {
        const arr = JSON.parse(persistedEvents) as SecurityEvent[]
        if (Array.isArray(arr)) {
          setSecurityEvents(arr.filter((i) => i && typeof i.id === 'string' && typeof i.message === 'string').slice(-120))
        }
      } catch { /* ignore */ }
    }
  }, [])

  useEffect(() => {
    if (!vaultStatusState?.unlocked) return
    const timer = window.setInterval(() => {
      const idleMs = Date.now() - vaultLastActivityAt
      const limitMs = vaultAutoLockMinutes * 60 * 1000
      if (idleMs < limitMs || vaultAutoLockingRef.current) return
      vaultAutoLockingRef.current = true
      void (async () => {
        try {
          await vaultLock(activeVaultId)
          await refreshVault()
          appendSecurityEvent('warn', `Vault auto-locked after ${vaultAutoLockMinutes} minute(s) of inactivity.`)
          setOutput('Vault auto-locked due to inactivity.')
        } catch (error) {
          appendSecurityEvent('error', `Vault auto-lock failed: ${String(error)}`)
        } finally {
          vaultAutoLockingRef.current = false
        }
      })()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [vaultStatusState?.unlocked, vaultLastActivityAt, vaultAutoLockMinutes, activeVaultId])

  async function handleInitialize(masterPassword: string) {
    setVaultBusy(true)
    try {
      await vaultInitialize(masterPassword, activeVaultId)
      await refreshVault()
      touchVaultActivity('Vault initialized and unlocked.')
      setOutput('Vault initialized and unlocked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  async function handleUnlock(masterPassword: string) {
    setVaultBusy(true)
    try {
      await vaultUnlock(masterPassword, activeVaultId)
      await refreshVault()
      touchVaultActivity('Vault unlocked.')
      setOutput('Vault unlocked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  async function handleLock() {
    setVaultBusy(true)
    try {
      await vaultLock(activeVaultId)
      await refreshVault()
      appendSecurityEvent('info', 'Vault locked manually.')
      setOutput('Vault locked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  async function handleSaveSecret(key: string, value: string) {
    setVaultBusy(true)
    try {
      await vaultSetSecret(key, value, activeVaultId)
      await refreshVault()
      touchVaultActivity(`Vault secret saved: ${key}`)
      setOutput(`Saved vault key: ${key}`)
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  async function handleLoadSecret(key: string) {
    setVaultBusy(true)
    try {
      const value = await vaultGetSecret(key, activeVaultId)
      touchVaultActivity(`Vault secret loaded: ${key}`)
      if (value === null) { setOutput(`Vault key not found: ${key}`); return }
      setOutput(`Vault key is available at runtime: ${key}.`)
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  async function handleDeleteSecret(key: string) {
    setVaultBusy(true)
    try {
      await vaultDeleteSecret(key, activeVaultId)
      await refreshVault()
      touchVaultActivity(`Vault secret deleted: ${key}`)
      setOutput(`Deleted vault key: ${key}`)
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }

  function handleAutoLockMinutesChange(value: number) {
    if (Number.isNaN(value)) return
    setVaultAutoLockMinutes(Math.max(1, Math.min(120, Math.floor(value))))
  }

  function handleClearSecurityEvents() { setSecurityEvents([]) }

  async function resolveAuthSecret(options: {
    authType: AuthType
    explicitSecret: string
    hostForRef?: HostProfile | null
    inputMode?: 'vault' | 'manual'
  }): Promise<string | undefined> {
    const { authType: targetAuthType, explicitSecret, hostForRef, inputMode } = options
    const mode = inputMode ?? 'vault'
    if (mode === 'manual') {
      if (!explicitSecret.trim()) return undefined
      appendSecurityEvent('warn', 'Manual override secret used for authentication.')
      return explicitSecret
    }
    const secretKeyRef =
      targetAuthType === 'password'
        ? (hostForRef?.passwordKeyRef?.trim() || hostForRef?.secretKeyRef?.trim() || '')
        : (hostForRef?.privateKeyRef?.trim() || hostForRef?.secretKeyRef?.trim() || '')
    if (!secretKeyRef) return undefined
    if (!vaultStatusState?.initialized) {
      throw new Error('Vault 尚未初始化。')
    }
    if (!vaultStatusState.unlocked) {
      throw new Error('Vault 已锁定。')
    }
    const value = await vaultGetSecret(secretKeyRef, activeVaultId)
    touchVaultActivity(`Resolved secret from vault key: ${secretKeyRef}`)
    if (!value) throw new Error(`Vault 中未找到密钥: ${secretKeyRef}`)
    if (targetAuthType === 'password' || targetAuthType === 'privateKey') return value
    return undefined
  }

  return (
    <VaultContext.Provider value={{
      activeVaultId, setActiveVaultId, vaults, vaultStatusState, vaultKeys, vaultBusy,
      vaultAutoLockMinutes, vaultLastActivityAt, securityEvents,
      refreshVault, refreshVaults,
      handleInitialize, handleUnlock, handleLock,
      handleSaveSecret, handleLoadSecret, handleDeleteSecret,
      handleAutoLockMinutesChange, handleClearSecurityEvents,
      touchVaultActivity, appendSecurityEvent, resolveAuthSecret,
    }}>
      {children}

      <Dialog open={gateOpen} onOpenChange={() => {}}>
        <DialogContent className="flex h-auto max-h-dvh items-center justify-center border-0 bg-transparent p-4 md:max-w-sm md:p-0">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border bg-card p-0 shadow-lg">
            <div className="bg-gradient-to-b from-muted/30 to-transparent px-6 pt-7 pb-4 sm:px-8 sm:pt-8 sm:pb-5">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Lock className="h-6 w-6" strokeWidth={2} />
              </div>
              <h3 className="text-center text-lg font-semibold tracking-tight text-foreground">
                {vaultStatusState?.initialized ? t('vault.unlock') : t('vault.initialize')}
              </h3>
              <p className="mt-1.5 text-center text-sm leading-relaxed text-muted-foreground">
                {vaultStatusState?.initialized ? t('vault.unlockDesc') : t('vault.initializeDesc')}
              </p>
            </div>
            <form className="space-y-3 px-6 pb-6 pt-2 sm:px-8 sm:pb-8" onSubmit={(e) => {
              e.preventDefault()
              if (gateBusy || !gatePassword.trim()) return
              void handleGateSubmit(gatePassword)
            }}>
              <div>
                <Input
                  type="password"
                  value={gatePassword}
                  onChange={(e) => setGatePassword(e.target.value)}
                  placeholder={vaultStatusState?.initialized ? t('vault.enterPassword') : t('vault.setPassword')}
                  className="h-11 rounded-lg border border-input bg-background text-foreground text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
                  autoFocus
                  autoComplete={vaultStatusState?.initialized ? 'current-password' : 'new-password'}
                  disabled={gateBusy}
                />
                {gateError && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    <span>{gateError}</span>
                  </div>
                )}
              </div>
              <Button
                type="submit"
                className="h-11 w-full rounded-lg font-medium"
                disabled={gateBusy || !gatePassword.trim()}
              >
                {gateBusy ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{vaultStatusState?.initialized ? t('vault.unlocking') : t('vault.initializing')}</>
                ) : (
                  vaultStatusState?.initialized ? t('vault.unlockBtn') : t('vault.initializeBtn')
                )}
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>
    </VaultContext.Provider>
  )
}
