import { VaultGateDialog } from '@/components/vault-gate-dialog'
import type { HostProfile } from '@/lib/hosts'
import type { AuthType } from '@/lib/ssh'
import type { SecurityEvent } from '@/lib/types'
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
import { DEFAULT_VAULT_ID, listVaults, type VaultMeta } from '@/lib/vaults'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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
  /** In-memory only — the master password from the current unlocked session */
  sessionPassword: string
  refreshVault: () => Promise<void>
  refreshVaults: () => Promise<void>
  handleInitialize: (masterPassword: string) => Promise<void>
  handleUnlock: (masterPassword: string) => Promise<void>
  handleLock: () => Promise<void>
  handleSaveSecret: (key: string, value: string) => Promise<void>
  handleLoadSecret: (key: string) => Promise<void>
  handleRevealSecret: (key: string) => Promise<string | null>
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
  const [activeVaultId, setActiveVaultIdState] = useState<string>(DEFAULT_VAULT_ID)
  const activeVaultScope = useRef({ id: DEFAULT_VAULT_ID })
  const setActiveVaultId = useCallback((id: string) => {
    if (activeVaultScope.current.id !== id) activeVaultScope.current = { id }
    setActiveVaultIdState(id)
  }, [])
  const [vaults, setVaults] = useState<VaultMeta[]>([])
  const [vaultStatusState, setVaultStatusState] = useState<VaultStatus | null>(null)
  const [vaultKeys, setVaultKeys] = useState<string[]>([])
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultAutoLockMinutes, setVaultAutoLockMinutes] = useState(10)
  const [vaultLastActivityAt, setVaultLastActivityAt] = useState(Date.now())
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([])
  const vaultAutoLockingRef = useRef(false)

  const [showBiometricOptIn, setShowBiometricOptIn] = useState(false)
  const biometricOptInPasswordRef = useRef('')
  const sessionPasswordRef = useRef('')

  const gateOpen = !!vaultStatusState && !vaultStatusState.unlocked

  const appendSecurityEvent = useCallback((level: SecurityEvent['level'], message: string) => {
    const entry: SecurityEvent = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp: Date.now(),
      level,
      message,
    }
    setSecurityEvents((prev) => [...prev, entry].slice(-120))
  }, [])

  const touchVaultActivity = useCallback((reason: string) => {
    setVaultLastActivityAt(Date.now())
    appendSecurityEvent('info', reason)
  }, [appendSecurityEvent])

  const refreshVault = useCallback(async () => {
    const scope = activeVaultScope.current
    if (scope.id !== activeVaultId) return
    const st = await vaultStatus(activeVaultId)
    if (activeVaultScope.current !== scope) return
    setVaultStatusState(st)
    if (st.initialized) {
      const keys = await vaultListSecretKeys(activeVaultId)
      if (activeVaultScope.current !== scope) return
      setVaultKeys(keys)
    } else {
      setVaultKeys([])
    }
  }, [activeVaultId])

  const refreshVaults = useCallback(async () => {
    const items = await listVaults()
    setVaults(items)
  }, [])

  const handleGateSubmit = useCallback(async (password: string) => {
    const wasInitialized = vaultStatusState?.initialized
    if (wasInitialized) {
      await vaultUnlock(password, activeVaultId)
    } else {
      await vaultInitialize(password, activeVaultId)
    }
    await refreshVault()
    sessionPasswordRef.current = password
    touchVaultActivity(wasInitialized ? 'Vault unlocked.' : 'Vault initialized and unlocked.')
    return !wasInitialized
  }, [activeVaultId, refreshVault, touchVaultActivity, vaultStatusState?.initialized])

  const handleGateSubmitWithOptIn = useCallback(async (password: string) => {
    const wasFirstInit = await handleGateSubmit(password)
    if (wasFirstInit) {
      // Store password temporarily for potential biometric enrollment
      biometricOptInPasswordRef.current = password
      setShowBiometricOptIn(true)
    }
  }, [handleGateSubmit])

  const handleBiometricOptInDone = useCallback(() => {
    biometricOptInPasswordRef.current = ''
    setShowBiometricOptIn(false)
  }, [])

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
          sessionPasswordRef.current = ''
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

  const handleInitialize = useCallback(async (masterPassword: string) => {
    setVaultBusy(true)
    try {
      await vaultInitialize(masterPassword, activeVaultId)
      await refreshVault()
      touchVaultActivity('Vault initialized and unlocked.')
      setOutput('Vault initialized and unlocked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }, [activeVaultId, refreshVault, setOutput, touchVaultActivity])

  const handleUnlock = useCallback(async (masterPassword: string) => {
    setVaultBusy(true)
    try {
      await vaultUnlock(masterPassword, activeVaultId)
      await refreshVault()
      touchVaultActivity('Vault unlocked.')
      setOutput('Vault unlocked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }, [activeVaultId, refreshVault, setOutput, touchVaultActivity])

  const handleLock = useCallback(async () => {
    setVaultBusy(true)
    try {
      await vaultLock(activeVaultId)
      await refreshVault()
      sessionPasswordRef.current = ''
      appendSecurityEvent('info', 'Vault locked manually.')
      setOutput('Vault locked.')
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }, [activeVaultId, appendSecurityEvent, refreshVault, setOutput])

  const handleSaveSecret = useCallback(async (key: string, value: string) => {
    setVaultBusy(true)
    try {
      await vaultSetSecret(key, value, activeVaultId)
      await refreshVault()
      touchVaultActivity(`Vault secret saved: ${key}`)
      setOutput(`Saved vault key: ${key}`)
    } catch (error) {
      setOutput('Failed to save vault key.')
      throw error
    } finally { setVaultBusy(false) }
  }, [activeVaultId, refreshVault, setOutput, touchVaultActivity])

  const handleLoadSecret = useCallback(async (key: string) => {
    setVaultBusy(true)
    try {
      const value = await vaultGetSecret(key, activeVaultId)
      touchVaultActivity(`Vault secret loaded: ${key}`)
      if (value === null) { setOutput(`Vault key not found: ${key}`); return }
      setOutput(`Vault key is available at runtime: ${key}.`)
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }, [activeVaultId, setOutput, touchVaultActivity])

  const handleRevealSecret = useCallback(async (key: string) => {
    if (!vaultStatusState?.initialized) {
      throw new Error('Vault 尚未初始化。')
    }
    if (!vaultStatusState.unlocked) {
      throw new Error('Vault 已锁定。')
    }
    const value = await vaultGetSecret(key, activeVaultId)
    touchVaultActivity(`Vault secret revealed: ${key}`)
    return value
  }, [activeVaultId, touchVaultActivity, vaultStatusState?.initialized, vaultStatusState?.unlocked])

  const handleDeleteSecret = useCallback(async (key: string) => {
    setVaultBusy(true)
    try {
      await vaultDeleteSecret(key, activeVaultId)
      await refreshVault()
      touchVaultActivity(`Vault secret deleted: ${key}`)
      setOutput(`Deleted vault key: ${key}`)
    } catch (error) { setOutput(String(error)) } finally { setVaultBusy(false) }
  }, [activeVaultId, refreshVault, setOutput, touchVaultActivity])

  const handleAutoLockMinutesChange = useCallback((value: number) => {
    if (Number.isNaN(value)) return
    setVaultAutoLockMinutes(Math.max(1, Math.min(120, Math.floor(value))))
  }, [])

  const handleClearSecurityEvents = useCallback(() => { setSecurityEvents([]) }, [])

  const resolveAuthSecret = useCallback(async (options: {
    authType: AuthType
    explicitSecret: string
    hostForRef?: HostProfile | null
    inputMode?: 'vault' | 'manual'
  }): Promise<string | undefined> => {
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
  }, [activeVaultId, appendSecurityEvent, touchVaultActivity, vaultStatusState?.initialized, vaultStatusState?.unlocked])

  const value = useMemo(() => ({
    activeVaultId, setActiveVaultId, vaults, vaultStatusState, vaultKeys, vaultBusy,
    vaultAutoLockMinutes, vaultLastActivityAt, securityEvents,
    sessionPassword: sessionPasswordRef.current,
    refreshVault, refreshVaults,
    handleInitialize, handleUnlock, handleLock,
    handleSaveSecret, handleLoadSecret, handleRevealSecret, handleDeleteSecret,
    handleAutoLockMinutesChange, handleClearSecurityEvents,
    touchVaultActivity, appendSecurityEvent, resolveAuthSecret,
  }), [
    activeVaultId,
    appendSecurityEvent,
    handleAutoLockMinutesChange,
    handleClearSecurityEvents,
    handleDeleteSecret,
    handleInitialize,
    handleLoadSecret,
    handleLock,
    handleRevealSecret,
    handleSaveSecret,
    handleUnlock,
    refreshVault,
    refreshVaults,
    resolveAuthSecret,
    securityEvents,
    setActiveVaultId,
    touchVaultActivity,
    vaultAutoLockMinutes,
    vaultBusy,
    vaultKeys,
    vaultLastActivityAt,
    vaultStatusState,
    vaults,
  ])

  return (
    <VaultContext.Provider value={value}>
      {children}

      <VaultGateDialog
        open={gateOpen}
        vaultStatus={vaultStatusState}
        onSubmit={handleGateSubmitWithOptIn}
      />

      <VaultGateDialog
        open={showBiometricOptIn}
        vaultStatus={vaultStatusState}
        onSubmit={async () => {}}
        biometricOptIn={{
          password: biometricOptInPasswordRef.current,
          onDone: handleBiometricOptInDone,
        }}
      />
    </VaultContext.Provider>
  )
}
