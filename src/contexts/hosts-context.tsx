import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { type HostProfile, type HostProfileDraft, createHost, updateHost, deleteHost, listHosts } from '@/lib/hosts'
import { vaultSetSecret } from '@/lib/vault'
import { loadWorkspaceInventoryHostStateSnapshots, loadWorkspaceInventoryPersistedCache } from '@/lib/workspace-inventory'
import { createPersistedWorkspaceInventoryStates, createReadyWorkspaceInventoryStates, mergeWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { scanWorkspaceInventoryHosts } from '@/lib/workspace-inventory-scan'
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
  handleScanHosts: (hosts: HostProfile[]) => Promise<void>
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

  const refreshHosts = useCallback(async () => {
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
  }, [activeVaultId])

  useEffect(() => { void refreshHosts() }, [activeVaultId])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      loadWorkspaceInventoryPersistedCache(hosts),
      loadWorkspaceInventoryHostStateSnapshots(hosts),
    ]).then(([cache, persistedStates]) => {
      if (cancelled) return
      mergeWorkspaceInventoryStates({
        ...createReadyWorkspaceInventoryStates(cache),
        ...createPersistedWorkspaceInventoryStates(persistedStates, cache),
      })
    })
    return () => {
      cancelled = true
    }
  }, [hosts])

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

  const handleCreateHost = useCallback(async (payload: Parameters<typeof createHost>[0]) => {
    await createHost(payload, activeVaultId)
    await refreshHosts()
  }, [activeVaultId, refreshHosts])

  const handleUpdateHost = useCallback(async (host: HostProfile, draft: HostProfileDraft) => {
    const updated: HostProfile = {
      ...host,
      ...draft,
      group: draft.group ?? host.group,
      tags: draft.tags ?? host.tags,
      updatedAt: Date.now(),
    }
    await updateHost(updated, activeVaultId)
    await refreshHosts()
  }, [activeVaultId, refreshHosts])

  const handleDeleteHost = useCallback(async (hostId: string) => {
    await deleteHost(hostId, activeVaultId)
    await refreshHosts()
  }, [activeVaultId, refreshHosts])

  const handleSaveToVault = useCallback(async (key: string, value: string) => {
    await vaultSetSecret(key, value, activeVaultId)
    await refreshVault()
  }, [activeVaultId, refreshVault])

  const handleScanHosts = useCallback(async (hosts: HostProfile[]) => {
    await scanWorkspaceInventoryHosts({
      hosts,
      resolveAuthSecret: async (host) => (
        await resolveAuthSecret({
          authType: host.authType,
          explicitSecret: '',
          hostForRef: host,
          inputMode: 'vault',
        })
      ) ?? '',
      refreshIntervalMs: 0,
    })
  }, [resolveAuthSecret])

  const handleDefaultUsernameChange = useCallback((value: string) => {
    setDefaultUsername(value.trim() || 'root')
  }, [])

  const handleKeepAliveIntervalSecsChange = useCallback((value: number) => {
    if (Number.isNaN(value)) return
    setKeepAliveIntervalSecs(Math.max(10, Math.min(300, Math.floor(value))))
  }, [])

  const value = useMemo(() => ({
    hosts, selectedHostId, setSelectedHostId, selectedHost, loadingHosts,
    defaultUsername, savingHost, testing, pcOpenAddHost, setPcOpenAddHost,
    pcTopBarSearch, setPcTopBarSearch,
    refreshHosts, handleCreateHost, handleUpdateHost, handleDeleteHost, handleSaveToVault,
    handleScanHosts, handleDefaultUsernameChange,
    keepAliveIntervalSecs, handleKeepAliveIntervalSecsChange,
  }), [
    defaultUsername,
    handleCreateHost,
    handleDefaultUsernameChange,
    handleDeleteHost,
    handleKeepAliveIntervalSecsChange,
    handleSaveToVault,
    handleUpdateHost,
    handleScanHosts,
    hosts,
    keepAliveIntervalSecs,
    loadingHosts,
    pcOpenAddHost,
    pcTopBarSearch,
    refreshHosts,
    savingHost,
    selectedHost,
    selectedHostId,
    testing,
  ])

  return (
    <HostsContext.Provider value={value}>
      {children}
    </HostsContext.Provider>
  )
}
