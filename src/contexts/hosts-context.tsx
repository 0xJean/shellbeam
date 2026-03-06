import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { type HostProfile, type HostProfileDraft, createHost, updateHost, deleteHost, listHosts } from '@/lib/hosts'
import { testSshConnection } from '@/lib/sessions'
import { vaultSetSecret } from '@/lib/vault'
import type { AuthType } from '@/lib/ssh'
import { useVault } from './vault-context'

interface HostsContextValue {
  hosts: HostProfile[]
  selectedHostId: string | null
  setSelectedHostId: (id: string | null) => void
  selectedHost: HostProfile | null
  loadingHosts: boolean
  defaultUsername: string
  savingHost: boolean
  testing: boolean
  pcOpenAddHost: boolean
  setPcOpenAddHost: (v: boolean) => void
  pcTopBarSearch: string
  setPcTopBarSearch: (v: string) => void
  refreshHosts: () => Promise<void>
  handleCreateHost: (payload: Parameters<typeof createHost>[0]) => Promise<void>
  handleUpdateHost: (host: HostProfile, draft: HostProfileDraft) => Promise<void>
  handleDeleteHost: (hostId: string) => Promise<void>
  handleSaveToVault: (key: string, value: string) => Promise<void>
  handleCheckHostStatus: (host: HostProfile) => Promise<'online' | 'offline'>
  handleDefaultUsernameChange: (value: string) => void
  keepAliveIntervalSecs: number
  handleKeepAliveIntervalSecsChange: (value: number) => void
}

const HostsContext = createContext<HostsContextValue | null>(null)

export function useHosts() {
  const ctx = useContext(HostsContext)
  if (!ctx) throw new Error('useHosts must be used within HostsProvider')
  return ctx
}

const DEFAULT_USERNAME_KEY = 'shellbeam.defaultUsername'
const KEEP_ALIVE_INTERVAL_SECS_KEY = 'shellbeam.keepAliveIntervalSecs'

export function HostsProvider({ children }: { children: ReactNode }) {
  const { activeVaultId, resolveAuthSecret, refreshVault } = useVault()

  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [loadingHosts, setLoadingHosts] = useState(false)
  const [defaultUsername, setDefaultUsername] = useState('root')
  const [keepAliveIntervalSecs, setKeepAliveIntervalSecs] = useState(30)
  const [savingHost] = useState(false)
  const [testing] = useState(false)
  const [pcOpenAddHost, setPcOpenAddHost] = useState(false)
  const [pcTopBarSearch, setPcTopBarSearch] = useState('')

  const selectedHost = useMemo(
    () => hosts.find((h) => h.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )

  async function refreshHosts() {
    setLoadingHosts(true)
    try {
      const items = await listHosts(activeVaultId)
      setHosts(items)
      setSelectedHostId((cur) => {
        if (cur && items.some((i) => i.id === cur)) return cur
        return items[0]?.id ?? null
      })
    } finally {
      setLoadingHosts(false)
    }
  }

  useEffect(() => { void refreshHosts() }, [activeVaultId])

  useEffect(() => {
    localStorage.setItem(DEFAULT_USERNAME_KEY, defaultUsername)
  }, [defaultUsername])

  useEffect(() => {
    localStorage.setItem(KEEP_ALIVE_INTERVAL_SECS_KEY, String(keepAliveIntervalSecs))
  }, [keepAliveIntervalSecs])

  useEffect(() => {
    const persisted = localStorage.getItem(DEFAULT_USERNAME_KEY)
    if (persisted?.trim()) setDefaultUsername(persisted.trim())
    const persistedKA = localStorage.getItem(KEEP_ALIVE_INTERVAL_SECS_KEY)
    const parsed = persistedKA ? Number(persistedKA) : NaN
    if (Number.isFinite(parsed)) setKeepAliveIntervalSecs(Math.max(10, Math.min(300, Math.floor(parsed))))
  }, [])

  async function handleCreateHost(payload: Parameters<typeof createHost>[0]) {
    await createHost(payload, activeVaultId)
    await refreshHosts()
  }

  async function handleUpdateHost(host: HostProfile, draft: HostProfileDraft) {
    const updated: HostProfile = {
      ...host,
      ...draft,
      group: draft.group ?? host.group,
      tags: draft.tags ?? host.tags,
      updatedAt: Date.now(),
    }
    await updateHost(updated, activeVaultId)
    await refreshHosts()
  }

  async function handleDeleteHost(hostId: string) {
    await deleteHost(hostId, activeVaultId)
    await refreshHosts()
  }

  async function handleSaveToVault(key: string, value: string) {
    await vaultSetSecret(key, value, activeVaultId)
    await refreshVault()
  }

  async function handleCheckHostStatus(host: HostProfile): Promise<'online' | 'offline'> {
    try {
      const authType = host.authType as AuthType
      const resolvedSecret = await resolveAuthSecret({
        authType,
        explicitSecret: '',
        hostForRef: host,
        inputMode: 'vault',
      })
      const result = await testSshConnection({
        hostId: host.id,
        host: host.address,
        port: host.port,
        username: host.username,
        authType,
        password: authType === 'password' ? resolvedSecret : undefined,
        privateKey: authType === 'privateKey' ? resolvedSecret : undefined,
        command: '',
      })
      return result.connected ? 'online' : 'offline'
    } catch {
      return 'offline'
    }
  }

  function handleDefaultUsernameChange(value: string) {
    setDefaultUsername(value.trim() || 'root')
  }

  function handleKeepAliveIntervalSecsChange(value: number) {
    if (Number.isNaN(value)) return
    setKeepAliveIntervalSecs(Math.max(10, Math.min(300, Math.floor(value))))
  }

  return (
    <HostsContext.Provider value={{
      hosts, selectedHostId, setSelectedHostId, selectedHost, loadingHosts,
      defaultUsername, savingHost, testing, pcOpenAddHost, setPcOpenAddHost,
      pcTopBarSearch, setPcTopBarSearch,
      refreshHosts, handleCreateHost, handleUpdateHost, handleDeleteHost, handleSaveToVault,
      handleCheckHostStatus, handleDefaultUsernameChange,
      keepAliveIntervalSecs, handleKeepAliveIntervalSecsChange,
    }}>
      {children}
    </HostsContext.Provider>
  )
}
