import { usePortForwardSummary } from '@/hooks/use-port-forward-summary'
import { MobileTerminalDrawer } from '@/components/mobile/mobile-terminal-drawer'
import { MobileHostsPage } from '@/components/mobile/mobile-hosts-page'
import { FleetDashboard } from '@/components/dashboard/fleet-dashboard'
import { requestSettingsCategory, SETTINGS_OPEN_EVENT } from '@/lib/settings-request'
import {
  closeRemoteDesktopSession,
  COMPANION_OPEN_EVENT,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  isTauriRuntime,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
} from '@/lib/companion'
import { syncAcceptPair } from '@/lib/sync'
import { listen } from '@tauri-apps/api/event'
import { IncomingPairView, PairDialog } from '@/components/sync-pairing-views'
import { MobileRemoteSessionSheet } from '@/components/mobile/mobile-remote-session-sheet'
import { MobileToolsPage } from '@/components/mobile-tools-page'
import { isMobileDevice, useMobileBackHandler } from '@/lib/mobile-back'
import { isToolPage } from '@/lib/mobile-navigation'
import { requestTerminalAiToggle, requestTerminalSearchToggle, TERMINAL_AI_STATE_EVENT, TERMINAL_SEARCH_STATE_EVENT, TERMINAL_SIDEBAR_TAB_EVENT } from '@/lib/terminal-events'
import { CLOSE_SESSION_REQUEST_EVENT, OPEN_KNOWN_HOSTS_REQUEST_EVENT, OPEN_SFTP_REQUEST_EVENT, OPEN_TERMINAL_REQUEST_EVENT, type HostDirectoryRequest } from '@/lib/navigation-request'
import { HostKeyConfirmDialog } from '@/components/host-key-confirm-dialog'
import { InteractiveTour } from '@/components/interactive-tour'
import { getBrowserTabRouteIndicator } from '@/components/browser/browser-view-state'
import { BrowserOverviewDialog } from '@/components/browser/browser-overview-dialog'
import { BrowserSwitcherDialog } from '@/components/browser/browser-switcher-dialog'
import { MobileSessionHeader } from '@/components/mobile-session-header'
import { MobileBottomNav, PcNavSidebar } from '@/components/pc-nav-sidebar'
import { PcSessionTabBar, type SessionBrowserTabMeta } from '@/components/pc-tab-bar'
import { SessionCloseDialog } from '@/components/browser/session-close-dialog'
import { SessionConnectPlaceholder } from '@/components/session-connect-placeholder'
import { SessionTerminalView } from '@/components/session-terminal-view'
import { TerminalRightSidebar } from '@/components/terminal-right-sidebar'
import { WorkspaceAssetInventoryApp } from '@/components/workspace/workspace-asset-inventory-app'
import { WorkspaceModeToggle } from '@/components/workspace/workspace-mode-toggle'
import { HostCreateDialog } from '@/components/host-create-dialog'
import { HostEditorDialog } from '@/components/host-editor-dialog'
import { SshImportDialog } from '@/components/ssh-import-dialog'
import { useApp } from '@/contexts/app-context'
import { useHosts } from '@/contexts/hosts-context'
import { getBrowserSourceTitle, resolveBrowserRouteMode } from '@/contexts/session-browser-state'
import { useSessions } from '@/contexts/sessions-context'
import { useVault } from '@/contexts/vault-context'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useSnippets } from '@/hooks/use-snippets'
import { useSync } from '@/hooks/use-sync'
import { getHostInventoryResource, resolveHostForDisplay } from '@/components/host-display-meta'
import type { HostProfile } from '@/lib/hosts'
import { DEFAULT_GROUPS } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { TOUR_ROUTES, TOUR_SETTINGS_CATEGORY, type InteractiveTourId, type TourOutcome } from '@/lib/interactive-tour'
import { cn } from '@/lib/utils'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getWorkspaceInventoryHostKey } from '@/lib/workspace-inventory'
import type { SessionWorkspaceMode } from '@/lib/workspace'
import { ChevronLeft, PanelTopOpen, X } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

type BrowserOverviewScope = 'all' | 'remote' | 'local' | 'pending'
type BrowserSwitcherEntry = {
  id: string
  sessionId: string
  tabId: string
  hostName: string
  hostAddress: string
  title: string
  url: string
  routeScope: 'local' | 'remote' | 'pending'
  routeLabel: string
  routeDetail: string
  isActive: boolean
}

const BROWSER_SWITCHER_RECENTS_KEY = 'shellbeam.browserSwitcherRecentTabIds'
const MAX_BROWSER_SWITCHER_RECENTS = 80

const HostsDashboard = lazy(async () => {
  const module = await import('@/components/hosts-dashboard')
  return { default: module.HostsDashboard }
})
const BrowserView = lazy(async () => {
  const module = await import('@/components/browser/browser-view')
  return { default: module.BrowserView }
})
const WorkspaceShell = lazy(async () => {
  const module = await import('@/components/workspace')
  return { default: module.WorkspaceShell }
})
const KeychainTab = lazy(async () => {
  const module = await import('@/components/keychain-tab')
  return { default: module.KeychainTab }
})
const SnippetPanel = lazy(async () => {
  const module = await import('@/components/snippet-panel')
  return { default: module.SnippetPanel }
})
const QuickConnectPanel = lazy(async () => {
  const module = await import('@/components/quick-connect-panel')
  return { default: module.QuickConnectPanel }
})
const PortForwardPanel = lazy(async () => {
  const module = await import('@/components/port-forward-panel')
  return { default: module.PortForwardPanel }
})
const KnownHostsPanel = lazy(async () => {
  const module = await import('@/components/known-hosts-panel')
  return { default: module.KnownHostsPanel }
})
const SftpDualPane = lazy(async () => {
  const module = await import('@/components/sftp-dual-pane')
  return { default: module.SftpDualPane }
})
const SyncCenterPanel = lazy(async () => {
  const module = await import('@/components/sync-center-panel')
  return { default: module.SyncCenterPanel }
})
const CompanionCenterPanel = lazy(async () => {
  const module = await import('@/components/companion-center-panel')
  return { default: module.CompanionCenterPanel }
})
const ActivityLogPanel = lazy(async () => {
  const module = await import('@/components/activity-log-panel')
  return { default: module.ActivityLogPanel }
})
const BackupRestorePanel = lazy(async () => {
  const module = await import('@/components/backup-restore-panel')
  return { default: module.BackupRestorePanel }
})
const SettingsPanel = lazy(async () => {
  const module = await import('@/components/settings-panel')
  return { default: module.SettingsPanel }
})
const MobileSettingsPage = lazy(async () => {
  const module = await import('@/components/mobile/mobile-settings-page')
  return { default: module.MobileSettingsPage }
})
const UserGuide = lazy(async () => {
  const module = await import('@/components/user-guide')
  return { default: module.UserGuide }
})

function readStoredBrowserSwitcherRecents() {
  try {
    const raw = localStorage.getItem(BROWSER_SWITCHER_RECENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

/** true when viewport width ≥ 768 px (Tailwind `md` breakpoint) */
function subscribeMediaQuery(cb: () => void) {
  const mql = window.matchMedia('(min-width: 768px)')
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}
function getIsMd() { return window.matchMedia('(min-width: 768px)').matches }

function DashboardSectionFallback({ fullHeight = false }: { fullHeight?: boolean }) {
  return (
    <div className={cn('p-6', fullHeight && 'absolute inset-0')}>
      <div className="h-full min-h-[12rem] rounded-3xl border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]/70" />
    </div>
  )
}

function SessionSurfaceFallback() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[var(--workspace-surface-950)] p-3">
      <div className="rounded-2xl border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-4 py-3 text-sm text-[var(--workspace-text-muted)]">
        Loading workspace...
      </div>
    </div>
  )
}

export function PcLayout() {
  const { t } = useT()
  const app = useApp()
  const vault = useVault()
  const hostsCtx = useHosts()
  const sessions = useSessions()
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hostsCtx.hosts.map((host) => host.address))
  const getBrowserScopeLabel = useCallback((scope: BrowserOverviewScope) => {
    if (scope === 'all') return t('workspace.common.all')
    if (scope === 'remote') return t('browser.route.server')
    if (scope === 'pending') return t('browser.route.pending')
    return t('browser.route.local')
  }, [t])
  const resolveVaultAuthSecret = vault.resolveAuthSecret
  const resolveWorkspaceAuthSecret = useCallback(async (host: HostProfile) => {
    return (
      await resolveVaultAuthSecret({
        authType: host.authType,
        explicitSecret: '',
        hostForRef: host,
        inputMode: 'vault',
      })
    ) ?? ''
  }, [resolveVaultAuthSecret])
  const {
    hosts: allHosts,
    setSelectedHostId,
    handleUpdateHost,
    handleCreateHost,
  } = hostsCtx
  const {
    pcActiveSessionId,
    pcSessionTabs,
    workspaceAuthBySession,
    setRightPaneSessionId,
    setInteractiveChunksBySession,
  } = sessions
  const { pcSidebarNav, setPcSidebarNav } = app
  const workspaceAuthResolvers = useMemo(() => {
    const resolvers: Record<string, (host: HostProfile) => Promise<string>> = {}

    for (const tab of pcSessionTabs) {
      const sessionId = tab.sessionId
      resolvers[sessionId] = async (host) => {
        const cachedSecret = workspaceAuthBySession[sessionId]
        if (cachedSecret) return cachedSecret
        return resolveWorkspaceAuthSecret(host)
      }
    }

    return resolvers
  }, [pcSessionTabs, resolveWorkspaceAuthSecret, workspaceAuthBySession])
  const snippets = useSnippets(vault.activeVaultId, app.setOutput)
  const forwardSummary = usePortForwardSummary(vault.activeVaultId, !!vault.vaultStatusState?.unlocked)
  const sync = useSync(app.setOutput, () => {
    void hostsCtx.refreshHosts()
    void snippets.refresh()
    void vault.refreshVault()
  }, vault.activeVaultId)

  const [, setVaultActiveTab] = useState<string>('hosts')
  const [mobileActiveSessionId, setMobileActiveSessionId] = useState<string | null>(null)
  const [showQuickConnect, setShowQuickConnect] = useState(false)
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string | null>(null)
  const [browserOverviewQuery, setBrowserOverviewQuery] = useState('')
  const [browserOverviewScope, setBrowserOverviewScope] = useState<BrowserOverviewScope>('all')
  const [browserOverviewOpen, setBrowserOverviewOpen] = useState(false)
  const [browserSwitcherOpen, setBrowserSwitcherOpen] = useState(false)
  const [browserSwitcherQuery, setBrowserSwitcherQuery] = useState('')
  const [browserSwitcherActiveIndex, setBrowserSwitcherActiveIndex] = useState(0)
  const [browserSwitcherRecentTabIds, setBrowserSwitcherRecentTabIds] = useState<string[]>(() => readStoredBrowserSwitcherRecents())
  const [assetCreateHostOpen, setAssetCreateHostOpen] = useState(false)
  const [tour, setTour] = useState<{ id: InteractiveTourId; vaultId: string } | null>(null)
  const [tourOutcome, setTourOutcome] = useState<TourOutcome | null>(null)
  const [assetEditingHost, setAssetEditingHost] = useState<HostProfile | null>(null)
  const [assetSshImportOpen, setAssetSshImportOpen] = useState(false)
  const [incomingPairRequest, setIncomingPairRequest] = useState<{
    sessionId: string
    peerDeviceId: string
    peerDeviceName: string
    peerHost: string
    verificationCode: string
  } | null>(null)
  const [incomingPairBusy, setIncomingPairBusy] = useState(false)
  const [incomingPairError, setIncomingPairError] = useState('')

  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | null = null
    void listen<{
      sessionId: string
      peerDeviceId: string
      peerDeviceName: string
      peerHost: string
      verificationCode: string
    }>('pair-request-received', (event) => {
      setIncomingPairError('')
      setIncomingPairRequest((current) => current ?? event.payload)
    }).then((fn) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  const handleAcceptGlobalIncomingPair = async () => {
    if (!incomingPairRequest) return
    setIncomingPairBusy(true)
    setIncomingPairError('')
    try {
      await syncAcceptPair({
        sessionId: incomingPairRequest.sessionId,
        peerHost: incomingPairRequest.peerHost || '127.0.0.1',
        peerPort: 9123,
      })
      setIncomingPairRequest(null)
      await sync.refresh()
    } catch (err) {
      setIncomingPairError(err instanceof Error ? err.message : String(err))
    } finally {
      setIncomingPairBusy(false)
    }
  }
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    // Open by default; closing it is remembered.
    try { return localStorage.getItem('shellbeam.rightSidebar') !== 'false' } catch { return true }
  })
  // On phones the same tools are a sheet over the terminal, so it starts closed and is not remembered.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const toggleMobileDrawer = useCallback(() => setMobileDrawerOpen((open) => !open), [])
  const lastDashboardNavRef = useRef(pcSidebarNav === 'terminal' ? 'hosts' : pcSidebarNav)
  const browserSwitcherInputRef = useRef<HTMLInputElement | null>(null)
  const observedActiveBrowserTabIdsRef = useRef<string[] | null>(null)

  useEffect(() => {
    if (pcSidebarNav !== 'terminal') lastDashboardNavRef.current = pcSidebarNav
  }, [pcSidebarNav])

  // Auto-switch to terminal tab on mobile when a new session is created
  const [prevTabCount, setPrevTabCount] = useState(pcSessionTabs.length)
  if (pcSessionTabs.length !== prevTabCount) {
    const grew = pcSessionTabs.length > prevTabCount
    setPrevTabCount(pcSessionTabs.length)
    if (grew) {
      const newest = pcSessionTabs[pcSessionTabs.length - 1]
      if (newest) {
        setMobileActiveSessionId(newest.sessionId)
        setShowQuickConnect(false)
      }
    } else if (mobileActiveSessionId && !pcSessionTabs.find((t) => t.sessionId === mobileActiveSessionId)) {
      setMobileActiveSessionId(pcSessionTabs[0]?.sessionId ?? null)
    }
  }
  const prevNavTabCountRef = useRef(pcSessionTabs.length)
  useEffect(() => {
    const newCount = pcSessionTabs.length
    if (newCount > prevNavTabCountRef.current && pcSessionTabs.length > 0) {
      setPcSidebarNav('terminal')
    }
    prevNavTabCountRef.current = newCount
  }, [pcSessionTabs.length, setPcSidebarNav])

  const isMd = useSyncExternalStore(subscribeMediaQuery, getIsMd, () => true)
  const { setPcActiveSessionId } = sessions

  useEffect(() => {
    // When unfolding (or on desktop) while on 'terminal' with no active PC session,
    // either promote the mobile active session or return to the Hosts dashboard.
    if (isMd && pcSidebarNav === 'terminal' && !pcActiveSessionId) {
      const target = mobileActiveSessionId && pcSessionTabs.some((tab) => tab.sessionId === mobileActiveSessionId)
        ? mobileActiveSessionId
        : pcSessionTabs[0]?.sessionId ?? null
      if (target) {
        setPcActiveSessionId(target)
      } else if (!showQuickConnect) {
        setPcSidebarNav('hosts')
      }
    }
  }, [isMd, mobileActiveSessionId, pcActiveSessionId, pcSessionTabs, pcSidebarNav, setPcActiveSessionId, setPcSidebarNav, showQuickConnect])

  useEffect(() => {
    // When folding from desktop with an active session, keep viewing that session on mobile.
    if (!isMd && pcActiveSessionId && pcSessionTabs.some((tab) => tab.sessionId === pcActiveSessionId)) {
      setMobileActiveSessionId(pcActiveSessionId)
      setPcSidebarNav('terminal')
    }
  }, [isMd, pcActiveSessionId, pcSessionTabs, setPcSidebarNav])

  useEffect(() => {
    const open = () => {
      if (!getIsMd()) setMobileDrawerOpen(true)
      setRightSidebarOpen(true)
      try { localStorage.setItem('shellbeam.rightSidebar', 'true') } catch { /* ignore */ }
    }
    window.addEventListener(TERMINAL_SIDEBAR_TAB_EVENT, open)
    return () => window.removeEventListener(TERMINAL_SIDEBAR_TAB_EVENT, open)
  }, [])

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen((v) => {
      const next = !v
      try { localStorage.setItem('shellbeam.rightSidebar', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const handlePcNewConnection = () => {
    sessions.setPcActiveSessionId(null)
    setShowQuickConnect(true)
  }

  const handleQuickConnectHost = (hostId: string) => {
    setShowQuickConnect(false)
    void sessions.handleConnectHost(hostId)
  }

  const handleOpenHostTerminal = (host: HostProfile) => {
    app.setPcSidebarNav('terminal')
    void sessions.handleConnectHost(host.id)
  }

  const [terminalSearchOpen, setTerminalSearchOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; open: boolean }>).detail
      if (detail) setTerminalSearchOpen((current) => current[detail.sessionId] === detail.open ? current : { ...current, [detail.sessionId]: detail.open })
    }
    window.addEventListener(TERMINAL_SEARCH_STATE_EVENT, onState)
    return () => window.removeEventListener(TERMINAL_SEARCH_STATE_EVENT, onState)
  }, [])
  const [terminalAiOpen, setTerminalAiOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; open: boolean }>).detail
      if (detail) setTerminalAiOpen((current) => current[detail.sessionId] === detail.open ? current : { ...current, [detail.sessionId]: detail.open })
    }
    window.addEventListener(TERMINAL_AI_STATE_EVENT, onState)
    return () => window.removeEventListener(TERMINAL_AI_STATE_EVENT, onState)
  }, [])

  // Deep panels (deployment directories) ask for a terminal or SFTP at a path.
  useEffect(() => {
    const scoped = (detail: HostDirectoryRequest | undefined) => !!detail && (!detail.vaultId || detail.vaultId === vault.activeVaultId)
    const onTerminal = (event: Event) => {
      const detail = (event as CustomEvent<HostDirectoryRequest>).detail
      if (!scoped(detail)) return
      app.setPcSidebarNav('terminal')
      void sessions.handleConnectHost(detail.hostId, { cwd: detail.path })
    }
    const onSftp = (event: Event) => {
      const detail = (event as CustomEvent<HostDirectoryRequest>).detail
      if (!scoped(detail)) return
      hostsCtx.setSelectedHostId(detail.hostId)
      app.setPcSidebarNav('sftp')
    }
    window.addEventListener(OPEN_TERMINAL_REQUEST_EVENT, onTerminal)
    window.addEventListener(OPEN_SFTP_REQUEST_EVENT, onSftp)
    return () => {
      window.removeEventListener(OPEN_TERMINAL_REQUEST_EVENT, onTerminal)
      window.removeEventListener(OPEN_SFTP_REQUEST_EVENT, onSftp)
    }
  }, [app, hostsCtx, sessions, vault.activeVaultId])

  const handleOpenProviderConsole = (url: string, host: HostProfile, sessionId?: string) => {
    if (sessionId) {
      sessions.openSessionBrowserUrl(sessionId, url, 'embedded')
      sessions.setSessionWorkspaceApp(sessionId, 'browser')
      return
    }

    const targetSessionId = sessions.pcSessionTabs.find((tab) => tab.hostId === host.id)?.sessionId ?? sessions.pcActiveSessionId
    if (!targetSessionId) return

    app.setPcSidebarNav('terminal')
    sessions.openSessionBrowserUrl(targetSessionId, url, 'embedded')
    sessions.setSessionWorkspaceApp(targetSessionId, 'browser')
  }

  const handleEditHostFromAssetInventory = useCallback((host: HostProfile) => {
    const latestHost = allHosts.find((entry) => entry.id === host.id) ?? host
    setSelectedHostId(latestHost.id)
    setAssetEditingHost(latestHost)
  }, [allHosts, setSelectedHostId])

  const allExistingGroups = useMemo(() => {
    const set = new Set<string>([...DEFAULT_GROUPS])
    allHosts.forEach((host) => { if (host.group) set.add(host.group) })
    return Array.from(set)
  }, [allHosts])

  const allExistingTags = useMemo(() => {
    const set = new Set<string>()
    allHosts.forEach((host) => host.tags?.forEach((tag) => set.add(tag)))
    return Array.from(set).sort()
  }, [allHosts])

  const handleSubmitAssetHostEdit = useCallback(async (...args: Parameters<typeof handleUpdateHost>) => {
    await handleUpdateHost(...args)
    setAssetEditingHost(null)
  }, [handleUpdateHost])

  const handleSubmitAssetHostCreate = useCallback(async (...args: Parameters<typeof handleCreateHost>) => {
    await handleCreateHost(...args)
    setAssetCreateHostOpen(false)
  }, [handleCreateHost])

  const handleQuickConnectNewHost = () => {
    setShowQuickConnect(false)
    app.setPcSidebarNav('hosts')
    setVaultActiveTab('hosts')
    hostsCtx.setPcOpenAddHost(true)
  }

  const handleMobileNewConnection = () => {
    setShowQuickConnect(true)
  }

  const handleMobileCloseSession = (sessionId: string) => {
    requestCloseSession(sessionId)
  }

  const handleMobileModeChange = (sessionId: string, nextMode: SessionWorkspaceMode) => {
    sessions.setSessionMode(sessionId, nextMode)
    if (nextMode === 'browser') sessions.setSessionBrowserPresentation(sessionId, 'embedded')
  }

  const handleGoToDashboard = () => {
    sessions.setPcActiveSessionId(null)
    setShowQuickConnect(false)
    setPcSidebarNav(lastDashboardNavRef.current)
  }

  const validRightPaneSessionId =
    sessions.rightPaneSessionId
    && sessions.rightPaneSessionId !== sessions.pcActiveSessionId
    && sessions.pcSessionTabs.some((tab) => tab.sessionId === sessions.rightPaneSessionId)
      ? sessions.rightPaneSessionId
      : null
  const getWorkspaceMode = useCallback((sessionId: string | null | undefined) => sessionId
    ? sessions.workspaceBySession[sessionId]?.mode ?? 'terminal'
    : 'terminal', [sessions.workspaceBySession])
  const activeWorkspaceMode = getWorkspaceMode(sessions.pcActiveSessionId)
  const rightPaneWorkspaceMode = getWorkspaceMode(validRightPaneSessionId)
  const isSplit = !!validRightPaneSessionId
    && activeWorkspaceMode === 'terminal'
    && rightPaneWorkspaceMode === 'terminal'
  const hasTerminalSplitPartner = sessions.pcSessionTabs.some((tab) => (
    tab.sessionId !== sessions.pcActiveSessionId
    && getWorkspaceMode(tab.sessionId) === 'terminal'
  ))
  const canToggleSplit = !!sessions.pcActiveSessionId
    && activeWorkspaceMode === 'terminal'
    && (isSplit || hasTerminalSplitPartner)
  const mobileWorkspaceMode = mobileActiveSessionId
    ? sessions.workspaceBySession[mobileActiveSessionId]?.mode ?? 'terminal'
    : 'terminal'

  const handleToggleSplit = useCallback(() => {
    if (isSplit) {
      setRightPaneSessionId(null)
    } else {
      const other = pcSessionTabs.find((t) => (
        t.sessionId !== pcActiveSessionId
        && getWorkspaceMode(t.sessionId) === 'terminal'
      ))
      if (other) setRightPaneSessionId(other.sessionId)
    }
  }, [getWorkspaceMode, isSplit, pcActiveSessionId, pcSessionTabs, setRightPaneSessionId])

  const handleInitialChunksConsumed = useCallback((sessionId: string) => {
    setInteractiveChunksBySession((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [setInteractiveChunksBySession])

  const { refresh: refreshSnippets } = snippets
  const { refresh: refreshSync } = sync
  useEffect(() => {
    void refreshSnippets()
    void refreshSync()
  }, [refreshSnippets, refreshSync])

  useEffect(() => {
    const onOpenSettings = () => {
      sessions.setPcActiveSessionId(null)
      setShowQuickConnect(false)
      app.setPcSidebarNav('settings')
    }
    const onOpenCompanion = () => {
      sessions.setPcActiveSessionId(null)
      setShowQuickConnect(false)
      app.setPcSidebarNav('companion')
    }
    window.addEventListener(SETTINGS_OPEN_EVENT, onOpenSettings)
    window.addEventListener(COMPANION_OPEN_EVENT, onOpenCompanion)
    return () => {
      window.removeEventListener(SETTINGS_OPEN_EVENT, onOpenSettings)
      window.removeEventListener(COMPANION_OPEN_EVENT, onOpenCompanion)
    }
  }, [app, sessions])

  // `isMd` is declared above so mobile Sessions tab effect stays in sync with viewport changes.
  const companionStatus = useSyncExternalStore(
    subscribeCompanionStatus,
    getCompanionStatusSnapshot,
    () => EMPTY_COMPANION_STATUS,
  )
  const companionWorkspace = useSyncExternalStore(
    subscribeCompanionWorkspace,
    getCompanionWorkspaceSnapshot,
    () => EMPTY_COMPANION_WORKSPACE,
  )
  const activeRemoteDesktopSession = companionStatus.state === 'connected' && companionWorkspace.activeSessionId
    ? companionWorkspace.sessions.find((s) => s.sessionId === companionWorkspace.activeSessionId) ?? null
    : null
  const SettingsScreen = isMd ? SettingsPanel : MobileSettingsPage
  const mobileDevice = isMobileDevice()
  const inActiveMobileTerminal = !isMd && app.pcSidebarNav === 'terminal' && sessions.pcSessionTabs.length > 0 && !showQuickConnect
  const showDashboardLayer = isMd ? !sessions.pcActiveSessionId : app.pcSidebarNav !== 'terminal'
  useMobileBackHandler(!isMd && showQuickConnect, () => setShowQuickConnect(false))
  useMobileBackHandler(inActiveMobileTerminal && !mobileDrawerOpen, () => {
    sessions.setPcActiveSessionId(null)
    app.setPcSidebarNav('hosts')
  })
  useMobileBackHandler(!isMd && isToolPage(app.pcSidebarNav) && app.pcSidebarNav !== 'tools', () => app.setPcSidebarNav('tools'))
  const browserMetaBySession = useMemo(() => {
    return sessions.pcSessionTabs.reduce<Record<string, SessionBrowserTabMeta>>((acc, tab) => {
      const browserState = sessions.browserBySession[tab.sessionId]
      if (!browserState) return acc

      const tabs = browserState.tabs ?? []
      const usefulTabs = tabs.filter((item) => item.source || item.addressInput?.trim())
      const fallbackUseful = browserState.source || browserState.addressInput?.trim()
      const totalTabs = usefulTabs.length || (fallbackUseful ? 1 : 0)
      if (totalTabs === 0) return acc

      const activeTab = tabs.find((item) => item.id === browserState.activeTabId) ?? tabs[0] ?? null
      const hasRemoteSession = Boolean(
        sessions.interactiveSessions.find((session) => session.sessionId === tab.sessionId)?.hostId,
      )
      const routeIndicator = getBrowserTabRouteIndicator({
        source: activeTab?.source ?? browserState.source ?? null,
        requestedRouteMode: browserState.routeMode ?? 'auto',
        effectiveRouteMode: resolveBrowserRouteMode(browserState.routeMode ?? 'auto', hasRemoteSession),
        hasRemoteSession,
        isActiveTab: true,
        resolvedUrl: activeTab?.resolvedUrl ?? browserState.resolvedUrl,
        proxyUrl: activeTab?.proxyUrl ?? browserState.proxyUrl,
      })
      if (!routeIndicator) return acc
      const localizedRouteIndicator = {
        ...routeIndicator,
        label: t(routeIndicator.labelKey),
        detail: t(routeIndicator.detailKey),
      }

      acc[tab.sessionId] = {
        tabCount: totalTabs,
        routeScope: localizedRouteIndicator.scope,
        routeLabel: localizedRouteIndicator.label,
        detail: localizedRouteIndicator.detail,
      }
      return acc
    }, {})
  }, [sessions.browserBySession, sessions.interactiveSessions, sessions.pcSessionTabs, t])
  const resumableBrowserSessions = useMemo(() => {
    return sessions.pcSessionTabs.flatMap((tab) => {
      const browserState = sessions.browserBySession[tab.sessionId]
      if (!browserState) return []

      const tabs = browserState.tabs ?? []
      const activeTab = tabs.find((item) => item.id === browserState.activeTabId) ?? tabs[0] ?? null
      const hasRemoteSession = Boolean(
        sessions.interactiveSessions.find((session) => session.sessionId === tab.sessionId)?.hostId,
      )
      const browserTabs = tabs
        .filter((item) => item.source || item.addressInput?.trim())
        .map((item) => {
          const routeIndicator = getBrowserTabRouteIndicator({
            source: item.source,
            requestedRouteMode: browserState.routeMode ?? 'auto',
            effectiveRouteMode: resolveBrowserRouteMode(browserState.routeMode ?? 'auto', hasRemoteSession),
            hasRemoteSession,
            isActiveTab: item.id === browserState.activeTabId,
            resolvedUrl: item.resolvedUrl,
            proxyUrl: item.proxyUrl,
          })
          return {
            id: item.id,
            title: item.title || (item.source ? getBrowserSourceTitle(item.source) : item.addressInput || t('browser.tab.newTitle')),
            url: item.currentUrl || (item.source?.kind === 'url' ? item.source.url : item.addressInput || ''),
            isActive: item.id === browserState.activeTabId,
            routeIndicator: routeIndicator
              ? {
                  ...routeIndicator,
                  label: t(routeIndicator.labelKey),
                  detail: t(routeIndicator.detailKey),
                }
              : null,
          }
        })
      const hasUsefulTabs = tabs.some((item) => item.source || item.addressInput?.trim())
      const hasLegacyState = Boolean(browserState.source || browserState.addressInput?.trim())
      if (!hasUsefulTabs && !hasLegacyState) return []

      const previewTitle = activeTab?.title || activeTab?.currentUrl || activeTab?.addressInput || browserState.title || browserState.currentUrl || browserState.addressInput || t('browser.resume.fallbackTitle')
      const activeUrl = activeTab?.currentUrl || (activeTab?.source?.kind === 'url' ? activeTab.source.url : '') || browserState.currentUrl || ''
      return [{
        sessionId: tab.sessionId,
        hostName: tab.hostName || tab.hostAddress,
        hostAddress: tab.hostAddress,
        browserTabs: browserTabs.length || 1,
        previewTitle,
        activeUrl,
        tabs: browserTabs,
      }]
    })
  }, [sessions.browserBySession, sessions.interactiveSessions, sessions.pcSessionTabs, t])
  const browserOverviewCounts = useMemo(() => {
    const counts: Record<BrowserOverviewScope, { sessions: number; tabs: number }> = {
      all: { sessions: resumableBrowserSessions.length, tabs: 0 },
      remote: { sessions: 0, tabs: 0 },
      local: { sessions: 0, tabs: 0 },
      pending: { sessions: 0, tabs: 0 },
    }

    for (const item of resumableBrowserSessions) {
      counts.all.tabs += item.tabs.length
      const scopes = new Set<Exclude<BrowserOverviewScope, 'all'>>()
      for (const tab of item.tabs) {
        const scope = tab.routeIndicator?.scope ?? 'local'
        counts[scope].tabs += 1
        scopes.add(scope)
      }
      for (const scope of scopes) {
        counts[scope].sessions += 1
      }
    }

    return counts
  }, [resumableBrowserSessions])
  const filteredResumableBrowserSessions = useMemo(() => {
    const normalizedQuery = browserOverviewQuery.trim().toLowerCase()

    return resumableBrowserSessions.flatMap((item) => {
      const scopeTabs = browserOverviewScope === 'all'
        ? item.tabs
        : item.tabs.filter((tab) => (tab.routeIndicator?.scope ?? 'local') === browserOverviewScope)
      if (scopeTabs.length === 0) return []

      if (!normalizedQuery) {
        return [{ ...item, visibleTabs: scopeTabs }]
      }

      const sessionText = [item.hostName, item.hostAddress, item.previewTitle, item.activeUrl]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      const sessionMatches = sessionText.includes(normalizedQuery)
      const matchedTabs = scopeTabs.filter((tab) => (
        [tab.title, tab.url, tab.routeIndicator?.label, tab.routeIndicator?.detail]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)
      ))

      if (matchedTabs.length > 0) {
        return [{ ...item, visibleTabs: matchedTabs }]
      }
      if (sessionMatches) {
        return [{ ...item, visibleTabs: scopeTabs }]
      }
      return []
    })
  }, [browserOverviewQuery, browserOverviewScope, resumableBrowserSessions])
  const filteredBrowserOverviewTabCount = useMemo(() => {
    return filteredResumableBrowserSessions.reduce((total, item) => total + item.visibleTabs.length, 0)
  }, [filteredResumableBrowserSessions])
  const browserSwitcherEntries = useMemo<BrowserSwitcherEntry[]>(() => {
    const entries = resumableBrowserSessions.flatMap((item) => item.tabs.map((tab) => ({
      id: `${item.sessionId}:${tab.id}`,
      sessionId: item.sessionId,
      tabId: tab.id,
      hostName: item.hostName,
      hostAddress: item.hostAddress,
      title: tab.title,
      url: tab.url,
      routeScope: tab.routeIndicator?.scope ?? 'local',
      routeLabel: tab.routeIndicator?.label ?? t('browser.route.local'),
      routeDetail: tab.routeIndicator?.detail ?? t('browser.route.localOrigin'),
      isActive: tab.isActive,
    })))
    const recentRank = new Map(browserSwitcherRecentTabIds.map((id, index) => [id, index]))

    return entries.sort((left, right) => {
      const leftRank = recentRank.get(left.id)
      const rightRank = recentRank.get(right.id)
      if (leftRank != null || rightRank != null) {
        if (leftRank == null) return 1
        if (rightRank == null) return -1
        if (leftRank !== rightRank) return leftRank - rightRank
      }
      if (left.isActive !== right.isActive) return left.isActive ? -1 : 1
      return left.hostName.localeCompare(right.hostName) || left.title.localeCompare(right.title)
    })
  }, [browserSwitcherRecentTabIds, resumableBrowserSessions, t])
  const filteredBrowserSwitcherEntries = useMemo(() => {
    const normalizedQuery = browserSwitcherQuery.trim().toLowerCase()
    if (!normalizedQuery) return browserSwitcherEntries

    return browserSwitcherEntries.filter((entry) => (
      [
        entry.hostName,
        entry.hostAddress,
        entry.title,
        entry.url,
        entry.routeLabel,
        entry.routeDetail,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    ))
  }, [browserSwitcherEntries, browserSwitcherQuery])

  const handleResumeBrowserSession = useCallback((sessionId: string) => {
    setBrowserOverviewOpen(false)
    sessions.setPcActiveSessionId(sessionId)
    sessions.setSessionBrowserPresentation(sessionId, 'embedded')
    sessions.setSessionMode(sessionId, 'browser')
    app.setPcSidebarNav('terminal')
    setShowQuickConnect(false)
  }, [app, sessions])
  const handleResumeBrowserTab = useCallback((sessionId: string, tabId: string) => {
    sessions.activateSessionBrowserTab(sessionId, tabId)
    handleResumeBrowserSession(sessionId)
  }, [handleResumeBrowserSession, sessions])
  const handleCloseBrowserContext = useCallback((sessionId: string) => {
    sessions.closeSessionBrowser(sessionId)

    const hostLabel = sessions.pcSessionTabs.find((tab) => tab.sessionId === sessionId)?.hostName
      || sessions.pcSessionTabs.find((tab) => tab.sessionId === sessionId)?.hostAddress
      || sessionId
    const workspaceState = sessions.workspaceBySession[sessionId]
    if (workspaceState?.mode === 'browser') {
      sessions.setSessionMode(sessionId, 'terminal')
      app.setOutput(t('browser.feedback.contextClosed', { host: hostLabel }))
      return
    }
    if (workspaceState?.mode === 'workspace' && workspaceState.activeApp === 'browser') {
      sessions.setSessionWorkspaceApp(sessionId, 'overview')
      app.setOutput(t('browser.feedback.workspaceClosed', { host: hostLabel }))
      return
    }
    app.setOutput(t('browser.feedback.sessionCleared', { host: hostLabel }))
  }, [app, sessions, t])
  const handleCommitBrowserSwitcherEntry = useCallback((entry: BrowserSwitcherEntry) => {
    handleResumeBrowserTab(entry.sessionId, entry.tabId)
    setBrowserSwitcherOpen(false)
    app.setOutput(t('browser.feedback.tabOpened', { title: entry.title, host: entry.hostName }))
  }, [app, handleResumeBrowserTab, t])
  const handleCloseBrowserSwitcherTab = useCallback((entry: BrowserSwitcherEntry) => {
    sessions.closeSessionBrowserTab(entry.sessionId, entry.tabId)
    app.setOutput(t('browser.feedback.tabClosed', { title: entry.title, host: entry.hostName }))
  }, [app, sessions, t])
  const handleClearBrowserSwitcherSession = useCallback((sessionId: string) => {
    handleCloseBrowserContext(sessionId)
  }, [handleCloseBrowserContext])
  const pendingCloseSession = pendingCloseSessionId
    ? sessions.pcSessionTabs.find((tab) => tab.sessionId === pendingCloseSessionId) ?? null
    : null

  const closeSessionWithGuards = useCallback((sessionId: string) => {
    const isClosingActiveSession = sessions.pcActiveSessionId === sessionId
    const fallbackBrowserEntry = browserSwitcherEntries.find((entry) => entry.sessionId !== sessionId) ?? null
    const fallbackSessionId = sessions.pcSessionTabs.find((tab) => tab.sessionId !== sessionId)?.sessionId ?? null

    sessions.handleCloseSessionTab(sessionId)

    if (!isClosingActiveSession) return

    if (fallbackBrowserEntry) {
      sessions.activateSessionBrowserTab(fallbackBrowserEntry.sessionId, fallbackBrowserEntry.tabId)
      sessions.setPcActiveSessionId(fallbackBrowserEntry.sessionId)
      sessions.setSessionBrowserPresentation(fallbackBrowserEntry.sessionId, 'embedded')
      sessions.setSessionMode(fallbackBrowserEntry.sessionId, 'browser')
      app.setPcSidebarNav('terminal')
      setShowQuickConnect(false)
      return
    }

    if (fallbackSessionId) {
      sessions.setPcActiveSessionId(fallbackSessionId)
      app.setPcSidebarNav('terminal')
      setShowQuickConnect(false)
      return
    }

    sessions.setPcActiveSessionId(null)
    app.setPcSidebarNav('hosts')
    setShowQuickConnect(false)
  }, [app, browserSwitcherEntries, sessions])

  const requestCloseSession = useCallback((sessionId: string) => {
    if (browserMetaBySession[sessionId]) {
      setPendingCloseSessionId(sessionId)
      return
    }
    closeSessionWithGuards(sessionId)
  }, [browserMetaBySession, closeSessionWithGuards])
  // Connection overlays and host key dialogs ask to close a tab or open Known Hosts.
  useEffect(() => {
    const onClose = (event: Event) => { const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId; if (id) requestCloseSession(id) }
    const onKnownHosts = () => { app.setPcSidebarNav('known-hosts'); setShowQuickConnect(false) }
    window.addEventListener(CLOSE_SESSION_REQUEST_EVENT, onClose)
    window.addEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, onKnownHosts)
    return () => {
      window.removeEventListener(CLOSE_SESSION_REQUEST_EVENT, onClose)
      window.removeEventListener(OPEN_KNOWN_HOSTS_REQUEST_EVENT, onKnownHosts)
    }
  }, [app, requestCloseSession])
  const browserOverviewEntry = resumableBrowserSessions.length > 0 ? (
    <button
      type="button"
      onClick={() => setBrowserOverviewOpen(true)}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2.5 text-xs font-medium text-[var(--workspace-text-muted)] transition-colors hover:border-[color:var(--workspace-border-glow)] hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-text-strong)]"
      aria-label={t('browser.overview.title')}
    >
      <PanelTopOpen className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{t('browser.overview.title')}</span>
      <span className="rounded-full bg-[var(--workspace-accent-muted)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--workspace-text-strong)]">
        {browserOverviewCounts.all.tabs}
      </span>
    </button>
  ) : null

  const handleBrowserSwitcherOpenChange = useCallback((open: boolean) => {
    setBrowserSwitcherOpen(open)
    if (open) {
      setBrowserSwitcherQuery('')
      setBrowserSwitcherActiveIndex(0)
    } else {
      setBrowserSwitcherActiveIndex(0)
    }
  }, [])

  const handleBrowserSwitcherQueryChange = useCallback((value: string) => {
    setBrowserSwitcherQuery(value)
    setBrowserSwitcherActiveIndex(0)
  }, [])

  const effectiveBrowserSwitcherOpen = browserSwitcherOpen && browserSwitcherEntries.length > 0
  const effectiveBrowserSwitcherActiveIndex = effectiveBrowserSwitcherOpen ? browserSwitcherActiveIndex : 0

  useEffect(() => {
    if (!effectiveBrowserSwitcherOpen) return
    const frame = window.requestAnimationFrame(() => {
      browserSwitcherInputRef.current?.focus()
      browserSwitcherInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [effectiveBrowserSwitcherOpen])

  useEffect(() => {
    let cancelled = false
    const activeBrowserTabIds = sessions.pcSessionTabs.flatMap((tab) => {
      const browserState = sessions.browserBySession[tab.sessionId]
      if (!browserState) return []
      const activeTab = browserState.tabs?.find((item) => item.id === browserState.activeTabId) ?? browserState.tabs?.[0] ?? null
      if (!activeTab) return []
      if (!activeTab.source && !activeTab.addressInput?.trim()) return []
      return [`${tab.sessionId}:${activeTab.id}`]
    })
    const previousActiveBrowserTabIds = observedActiveBrowserTabIdsRef.current
    observedActiveBrowserTabIdsRef.current = activeBrowserTabIds
    if (activeBrowserTabIds.length === 0) return

    Promise.resolve().then(() => {
      if (cancelled) return
      setBrowserSwitcherRecentTabIds((current) => {
        const changedActiveBrowserTabIds = previousActiveBrowserTabIds == null
          ? (current.length === 0 ? activeBrowserTabIds : [])
          : activeBrowserTabIds.filter((id) => !previousActiveBrowserTabIds.includes(id))
        if (changedActiveBrowserTabIds.length === 0) return current

        const next = [
          ...changedActiveBrowserTabIds,
          ...current.filter((id) => !changedActiveBrowserTabIds.includes(id)),
        ].slice(0, MAX_BROWSER_SWITCHER_RECENTS)

        if (next.length === current.length && next.every((value, index) => value === current[index])) {
          return current
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [sessions.browserBySession, sessions.pcSessionTabs])

  useEffect(() => {
    let cancelled = false
    const validIds = new Set(browserSwitcherEntries.map((entry) => entry.id))
    Promise.resolve().then(() => {
      if (cancelled) return
      setBrowserSwitcherRecentTabIds((current) => {
        const next = current.filter((id) => validIds.has(id))
        if (next.length === current.length) return current
        return next
      })
    })
    return () => { cancelled = true }
  }, [browserSwitcherEntries])

  useEffect(() => {
    try {
      localStorage.setItem(BROWSER_SWITCHER_RECENTS_KEY, JSON.stringify(browserSwitcherRecentTabIds))
    } catch { /* ignore */ }
  }, [browserSwitcherRecentTabIds])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'b') return
      if (browserSwitcherEntries.length === 0) return
      event.preventDefault()
      handleBrowserSwitcherOpenChange(true)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [browserSwitcherEntries.length, handleBrowserSwitcherOpenChange])

  return (
    <div className="flex h-full flex-col">
      {tour && (
        <InteractiveTour id={tour.id}
          valid={app.pcSidebarNav === TOUR_ROUTES[tour.id] && vault.activeVaultId === tour.vaultId && !sessions.pcActiveSessionId && !showQuickConnect}
          setHostFormOpen={setAssetCreateHostOpen}
          onFinish={(outcome) => { setTour(null); setTourOutcome(outcome) }} />
      )}
      {tourOutcome && (
        <div role="status" className="absolute right-3 top-12 z-40 flex max-w-[calc(100%-24px)] items-start gap-3 rounded-xl border bg-card p-3 text-xs text-card-foreground shadow-lg md:max-w-md">
          <p className="leading-5">{t(`tour.outcome.${tourOutcome}`)}</p>
          <button type="button" aria-label={t('tour.dismiss')} onClick={() => setTourOutcome(null)}><X className="h-4 w-4" /></button>
        </div>
      )}
      <HostKeyConfirmDialog
        info={sessions.pendingHostKey}
        onAccept={sessions.acceptPendingHostKey}
        onReject={sessions.rejectPendingHostKey}
      />
      <PairDialog
        open={incomingPairRequest != null}
        step="incoming"
        onClose={() => {
          setIncomingPairRequest(null)
          setIncomingPairError('')
        }}
      >
        {incomingPairRequest && (
          <IncomingPairView
            request={incomingPairRequest}
            pairingBusy={incomingPairBusy}
            pairingError={incomingPairError}
            onAccept={() => void handleAcceptGlobalIncomingPair()}
            onCancel={() => {
              setIncomingPairRequest(null)
              setIncomingPairError('')
            }}
          />
        )}
      </PairDialog>
      <HostEditorDialog
        host={assetEditingHost}
        defaultUsername={hostsCtx.defaultUsername}
        vaultKeys={vault.vaultKeys}
        vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
        onSaveToVault={hostsCtx.handleSaveToVault}
        onLoadVaultSecret={vault.handleRevealSecret}
        vaultName={vault.vaults.find((item) => item.id === vault.activeVaultId)?.name ?? 'Vault'}
        existingGroups={allExistingGroups}
        existingTags={allExistingTags}
        onSubmit={handleSubmitAssetHostEdit}
        onCancel={() => setAssetEditingHost(null)}
      />
      <HostCreateDialog
        vaultId={vault.activeVaultId}
        open={assetCreateHostOpen}
        defaultUsername={hostsCtx.defaultUsername}
        vaultKeys={vault.vaultKeys}
        vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
        onSaveToVault={hostsCtx.handleSaveToVault}
        onLoadVaultSecret={vault.handleRevealSecret}
        vaultName={vault.vaults.find((item) => item.id === vault.activeVaultId)?.name ?? 'Vault'}
        existingGroups={allExistingGroups}
        existingTags={allExistingTags}
        onSubmit={handleSubmitAssetHostCreate}
        onCancel={() => setAssetCreateHostOpen(false)}
      />
      {assetSshImportOpen && (
        <SshImportDialog
          vaultId={vault.activeVaultId}
          onClose={() => setAssetSshImportOpen(false)}
          onImported={() => { setAssetSshImportOpen(false); void hostsCtx.refreshHosts() }}
        />
      )}
      <SessionCloseDialog
        open={!!pendingCloseSession}
        hostName={pendingCloseSession ? pendingCloseSession.hostName || pendingCloseSession.hostAddress : ''}
        tabs={resumableBrowserSessions.find((item) => item.sessionId === pendingCloseSession?.sessionId)?.tabs ?? []}
        onCancel={() => setPendingCloseSessionId(null)}
        onConfirm={() => {
          if (pendingCloseSessionId) closeSessionWithGuards(pendingCloseSessionId)
          setPendingCloseSessionId(null)
        }}
      />
      <BrowserSwitcherDialog
        open={effectiveBrowserSwitcherOpen}
        onOpenChange={handleBrowserSwitcherOpenChange}
        inputRef={browserSwitcherInputRef}
        query={browserSwitcherQuery}
        onQueryChange={handleBrowserSwitcherQueryChange}
        entries={filteredBrowserSwitcherEntries}
        activeIndex={effectiveBrowserSwitcherActiveIndex}
        onActiveIndexChange={setBrowserSwitcherActiveIndex}
        onCommit={handleCommitBrowserSwitcherEntry}
        onCloseTab={handleCloseBrowserSwitcherTab}
        onClearSession={handleClearBrowserSwitcherSession}
      />
      <BrowserOverviewDialog
        open={browserOverviewOpen}
        onOpenChange={setBrowserOverviewOpen}
        scope={browserOverviewScope}
        onScopeChange={setBrowserOverviewScope}
        getScopeLabel={getBrowserScopeLabel}
        scopeCounts={browserOverviewCounts}
        query={browserOverviewQuery}
        onQueryChange={setBrowserOverviewQuery}
        sessions={filteredResumableBrowserSessions}
        visibleTabCount={filteredBrowserOverviewTabCount}
        onResumeSession={handleResumeBrowserSession}
        onResumeTab={handleResumeBrowserTab}
      />
      <div className="hidden shrink-0 md:block">
        <PcSessionTabBar
          sessionTabs={sessions.pcSessionTabs}
          activeSessionId={sessions.pcActiveSessionId}
          isDashboard={!sessions.pcActiveSessionId}
          isSplit={isSplit}
          onSelectSession={(sid) => { sessions.setPcActiveSessionId(sid); setShowQuickConnect(false) }}
          onCloseSession={requestCloseSession}
          onGoToDashboard={handleGoToDashboard}
          onOpenLocalTerminal={mobileDevice ? undefined : () => sessions.handleOpenLocalTerminal()}
          onNewConnection={handlePcNewConnection}
          onToggleSplit={canToggleSplit ? handleToggleSplit : undefined}
          hosts={hostsCtx.hosts}
          onToggleAi={() => { if (sessions.pcActiveSessionId) requestTerminalAiToggle(sessions.pcActiveSessionId) }}
          aiOpen={!!sessions.pcActiveSessionId && terminalAiOpen[sessions.pcActiveSessionId] === true}
          theme={app.theme}
          onToggleTheme={app.toggleTheme}
          companionInfo={{
            deviceName: sync.localDevice?.deviceName,
            serverRunning: sync.serverRunning,
            serverPort: sync.serverPort,
            onStartServer: () => sync.handleStartServer(),
            trustedPeers: sync.trustedPeers,
            hosts: hostsCtx.hosts,
          }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {/* PC Terminal layer - all sessions stay mounted, only active is visible. Phones get the mobile layer below instead,
            so each session has one terminal, workspace and browser. */}
        {isMd && sessions.pcSessionTabs.length > 0 && (
          <div className={cn('absolute inset-0 flex', sessions.pcActiveSessionId ? 'z-10' : 'pointer-events-none invisible')}>
            <div className="relative min-w-0 flex-1">
              {sessions.pcSessionTabs.map((tab) => {
                const sessionInfo = sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId) ?? null
                const isActive = tab.sessionId === sessions.pcActiveSessionId
                const isRightPane = isSplit && tab.sessionId === validRightPaneSessionId
                const isVisible = isActive || isRightPane
                const terminalSurfaceVisible = isVisible && !!sessions.pcActiveSessionId && app.pcSidebarNav === 'terminal'
                const mode = sessions.workspaceBySession[tab.sessionId]?.mode ?? 'terminal'
                const workspaceMode = mode === 'workspace'
                const browserPageMode = mode === 'browser'
                const showTerminalChrome = workspaceMode || browserPageMode
                const showConnectionPlaceholder = !sessionInfo && (tab.status === 'connecting' || tab.status === 'error')
                const displayHost = resolveHostForDisplay(hostsCtx.hosts, sessionInfo?.hostId ?? tab.hostId, tab.hostAddress)
                const displayNetwork = displayHost ? networkByAddress[displayHost.address] : undefined
                const displayResource = getHostInventoryResource(displayHost, inventoryStates)
                const displayInventory = displayHost ? inventoryStates[getWorkspaceInventoryHostKey(displayHost)]?.inventory : undefined
                return (
                  <div
                    key={tab.sessionId}
                    className={cn(
                      'absolute top-0 bottom-0',
                      !isVisible && 'pointer-events-none invisible',
                      isSplit && isActive && 'left-0 w-1/2 border-r border-border/50',
                      isSplit && isRightPane && 'right-0 w-1/2',
                      !(isSplit && (isActive || isRightPane)) && 'inset-x-0',
                    )}
                  >
                    {showConnectionPlaceholder ? (
                      <div className="absolute inset-0 bg-workspace-desktop-wallpaper">
                        <div className="pointer-events-none absolute inset-0 bg-workspace-desktop-overlay" />
                        <SessionConnectPlaceholder
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          connectionKind={tab.connectionKind}
                          status={tab.status === 'error' ? 'error' : 'connecting'}
                          stage={tab.connectionStage}
                          errorMessage={tab.errorMessage}
                          network={displayNetwork}
                          resource={displayResource}
                          onRetry={tab.status === 'error' ? () => sessions.retrySessionConnection(tab.sessionId) : undefined}
                          onCancel={tab.status === 'error' ? undefined : () => sessions.cancelSessionConnection(tab.sessionId)}
                        />
                      </div>
                    ) : (
                      <div className={cn('absolute inset-0', showTerminalChrome && 'pointer-events-none z-10')}>
                        <SessionTerminalView
                          sessionId={tab.sessionId}
                          session={sessionInfo}
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          network={displayNetwork}
                          resource={displayResource}
                          inventory={displayInventory}
                          host={displayHost ?? undefined}
                          chunkEmitterRef={sessions.pcChunkEmitterRef}
                          outputReplayRef={sessions.pcOutputReplayRef}
                          onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                          terminalPrefs={app.terminalPrefs}
                          isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                          onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                          visible={isVisible && !!sessions.pcActiveSessionId}
                          shortcutActive={isActive && !!sessions.pcActiveSessionId}
                          workspaceMode={mode}
                          onWorkspaceModeChange={(nextMode) => {
                            sessions.setSessionMode(tab.sessionId, nextMode)
                            if (nextMode === 'browser') {
                              sessions.setSessionBrowserPresentation(tab.sessionId, 'embedded')
                            }
                          }}
                          onOpenBrowser={!browserPageMode ? () => {
                            sessions.setSessionBrowserPresentation(tab.sessionId, 'embedded')
                            sessions.setSessionMode(tab.sessionId, 'browser')
                          } : undefined}
                          onOpenLinkInBrowser={(url) => {
                            sessions.openSessionBrowserUrl(tab.sessionId, url, 'embedded')
                            sessions.setSessionMode(tab.sessionId, 'browser')
                          }}
                          chromeOnly={showTerminalChrome}
                          onToggleRightSidebar={isActive ? toggleRightSidebar : undefined}
                          rightSidebarOpen={isActive ? rightSidebarOpen : undefined}
                          initialChunks={sessions.interactiveChunksBySession[tab.sessionId]}
                          onInitialChunksConsumed={handleInitialChunksConsumed}
                        />
                      </div>
                    )}
                    <div className={cn('absolute inset-x-0 bottom-0 top-9', !showTerminalChrome && 'pointer-events-none invisible')}>
                      {/* Both stay mounted once opened, so moving between modes keeps pages and windows as they were. */}
                      {(browserPageMode || (sessions.browserBySession[tab.sessionId]?.presentation ?? 'closed') !== 'closed') && (
                        <div className={cn('absolute inset-0 min-h-0 bg-[var(--workspace-surface-950)] p-3', !browserPageMode && 'pointer-events-none invisible')}>
                          <Suspense fallback={<SessionSurfaceFallback />}>
                            <BrowserView sessionId={tab.sessionId} visible={browserPageMode && terminalSurfaceVisible} onCloseRequest={() => handleCloseBrowserContext(tab.sessionId)} />
                          </Suspense>
                        </div>
                      )}
                      <div className={cn('absolute inset-0 flex', browserPageMode && 'pointer-events-none invisible')}>
                        <Suspense fallback={<SessionSurfaceFallback />}>
                          <WorkspaceShell
                            surfaceVisible={workspaceMode && terminalSurfaceVisible}
                            onBackToHosts={() => app.setPcSidebarNav('hosts')}
                            sessionConnectionKey={sessionInfo?.connectionKey}
                            sessionVaultId={sessionInfo?.vaultId}
                            activeVaultId={vault.activeVaultId}
                            sessionId={tab.sessionId}
                            mobile={false}
                            hostName={tab.hostName}
                            hostAddress={tab.hostAddress}
                            hostId={sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId)?.hostId ?? null}
                            hosts={hostsCtx.hosts}
                            resolveAuthSecret={workspaceAuthResolvers[tab.sessionId]}
                            activeApp={sessions.workspaceBySession[tab.sessionId]?.activeApp ?? 'overview'}
                            onSelectApp={(workspaceApp) => sessions.setSessionWorkspaceApp(tab.sessionId, workspaceApp)}
                            onOpenTerminal={handleOpenHostTerminal}
                            onOpenProviderConsole={(url, host) => handleOpenProviderConsole(url, host, tab.sessionId)}
                            onEditHost={handleEditHostFromAssetInventory}
                            onBrowserCloseRequest={() => handleCloseBrowserContext(tab.sessionId)}
                          />
                        </Suspense>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {sessions.pcActiveSessionId && activeWorkspaceMode === 'terminal' && (
              <TerminalRightSidebar
                visible={rightSidebarOpen}
                onClose={toggleRightSidebar}
                hostAddress={sessions.pcSessionTabs.find((t) => t.sessionId === sessions.pcActiveSessionId)?.hostAddress ?? ''}
                snippets={snippets.snippets}
                onApplySnippet={(cmd) => {
                  const sid = sessions.pcActiveSessionId
                  if (sid) {
                    sessions.sendRaw(sid, cmd)
                    app.setOutput(t('terminal.snippetPasted'))
                  }
                }}
                onRunSnippet={(cmd) => {
                  const sid = sessions.pcActiveSessionId
                  if (sid) {
                    sessions.sendRaw(sid, cmd + '\n')
                    app.setOutput(t('terminal.snippetPasted'))
                  }
                }}
                terminalPrefs={app.terminalPrefs}
                onTerminalPrefsChange={app.updateTerminalPrefs}
                onSearchToggle={() => { if (sessions.pcActiveSessionId) requestTerminalSearchToggle(sessions.pcActiveSessionId) }}
                searchVisible={!!sessions.pcActiveSessionId && terminalSearchOpen[sessions.pcActiveSessionId] === true}
                hosts={hostsCtx.hosts}
                vaultId={vault.activeVaultId}
              />
            )}
          </div>
        )}

        {/* Mobile Terminal layer - shown when nav is 'terminal' on small screens */}
        {!isMd && (
        <div className={cn(
          'absolute inset-0 flex flex-col md:hidden',
          !inActiveMobileTerminal && 'mobile-safe-pb',
          app.pcSidebarNav === 'terminal' ? 'z-10' : 'pointer-events-none invisible',
        )}>
          <MobileSessionHeader
            onOpenDrawer={toggleMobileDrawer}
            onBack={() => {
              sessions.setPcActiveSessionId(null)
              app.setPcSidebarNav('hosts')
            }}
            sessionTabs={sessions.pcSessionTabs}
            activeSessionId={mobileActiveSessionId}
            onSelectSession={setMobileActiveSessionId}
            onCloseSession={handleMobileCloseSession}
            onNewConnection={handleMobileNewConnection}
            onOpenLocalTerminal={mobileDevice ? undefined : () => sessions.handleOpenLocalTerminal()}
            hosts={hostsCtx.hosts}
            trustedPeers={sync.trustedPeers}
            onOpenCompanion={() => app.setPcSidebarNav('companion')}
            onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
          />
          {mobileActiveSessionId && sessions.interactiveSessions.some((s) => s.sessionId === mobileActiveSessionId) && (
            <div data-testid="mobile-mode-switch" className="flex shrink-0 justify-center bg-[var(--workspace-surface-950)] pb-1.5">
              <WorkspaceModeToggle mode={mobileWorkspaceMode} onChange={(nextMode) => handleMobileModeChange(mobileActiveSessionId, nextMode)} hideBrowser={mobileDevice} />
            </div>
          )}
          {sessions.pcSessionTabs.length > 0 && (
            <div className="relative min-h-0 flex-1 flex">
              <div className="relative min-w-0 flex-1">
              {sessions.pcSessionTabs.map((tab) => {
                const sessionInfo = sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId) ?? null
                const isActive = tab.sessionId === mobileActiveSessionId
                const mobileMode = sessions.workspaceBySession[tab.sessionId]?.mode ?? 'terminal'
                const workspaceMode = mobileMode === 'workspace'
                const browserPageMode = mobileMode === 'browser'
                const showTerminalChrome = workspaceMode || browserPageMode
                const terminalSurfaceVisible = isActive && app.pcSidebarNav === 'terminal'
                const showConnectionPlaceholder = !sessionInfo && (tab.status === 'connecting' || tab.status === 'error')
                const displayHost = resolveHostForDisplay(hostsCtx.hosts, sessionInfo?.hostId ?? tab.hostId, tab.hostAddress)
                const displayNetwork = displayHost ? networkByAddress[displayHost.address] : undefined
                const displayResource = getHostInventoryResource(displayHost, inventoryStates)
                const displayInventory = displayHost ? inventoryStates[getWorkspaceInventoryHostKey(displayHost)]?.inventory : undefined
                return (
                  <div
                    key={tab.sessionId}
                    className={cn('absolute inset-0', !isActive && 'pointer-events-none invisible')}
                  >
                    {showConnectionPlaceholder ? (
                      <div className="absolute inset-0 bg-workspace-desktop-wallpaper">
                        <div className="pointer-events-none absolute inset-0 bg-workspace-desktop-overlay" />
                        <SessionConnectPlaceholder
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          connectionKind={tab.connectionKind}
                          status={tab.status === 'error' ? 'error' : 'connecting'}
                          stage={tab.connectionStage}
                          errorMessage={tab.errorMessage}
                          network={displayNetwork}
                          resource={displayResource}
                          onRetry={tab.status === 'error' ? () => sessions.retrySessionConnection(tab.sessionId) : undefined}
                          onCancel={tab.status === 'error' ? undefined : () => sessions.cancelSessionConnection(tab.sessionId)}
                        />
                      </div>
                    ) : (
                      <div className={cn('absolute inset-0', showTerminalChrome && 'pointer-events-none z-10')}>
                        <SessionTerminalView
                          sessionId={tab.sessionId}
                          session={sessionInfo}
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          network={displayNetwork}
                          resource={displayResource}
                          inventory={displayInventory}
                          host={displayHost ?? undefined}
                          chunkEmitterRef={sessions.pcChunkEmitterRef}
                          outputReplayRef={sessions.pcOutputReplayRef}
                          onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                          terminalPrefs={app.terminalPrefs}
                          isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                          onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                          visible={isActive && app.pcSidebarNav === 'terminal'}
                          workspaceMode={mobileMode}
                          onWorkspaceModeChange={(nextMode) => handleMobileModeChange(tab.sessionId, nextMode)}
                          onOpenBrowser={!browserPageMode ? () => {
                            sessions.setSessionBrowserPresentation(tab.sessionId, 'embedded')
                            sessions.setSessionMode(tab.sessionId, 'browser')
                          } : undefined}
                          onOpenLinkInBrowser={(url) => {
                            sessions.openSessionBrowserUrl(tab.sessionId, url, 'embedded')
                            sessions.setSessionMode(tab.sessionId, 'browser')
                          }}
                          chromeOnly={showTerminalChrome}
                          initialChunks={sessions.interactiveChunksBySession[tab.sessionId]}
                          onInitialChunksConsumed={handleInitialChunksConsumed}
                          onToggleRightSidebar={isActive ? toggleMobileDrawer : undefined}
                          rightSidebarOpen={isActive ? mobileDrawerOpen : undefined}
                        />
                      </div>
                    )}
                    {/* Phones have no terminal header row, so this layer fills the session area; the mode switch sits above it. */}
                    <div className={cn('absolute inset-0', !showTerminalChrome && 'pointer-events-none invisible')}>
                      {/* Both stay mounted once opened, so moving between modes keeps pages and windows as they were. */}
                      {(browserPageMode || (sessions.browserBySession[tab.sessionId]?.presentation ?? 'closed') !== 'closed') && (
                        <div className={cn('absolute inset-0 min-h-0 bg-[var(--workspace-surface-950)] p-3', !browserPageMode && 'pointer-events-none invisible')}>
                          <Suspense fallback={<SessionSurfaceFallback />}>
                            <BrowserView sessionId={tab.sessionId} visible={browserPageMode && terminalSurfaceVisible} onCloseRequest={() => handleCloseBrowserContext(tab.sessionId)} />
                          </Suspense>
                        </div>
                      )}
                      <div className={cn('absolute inset-0', browserPageMode && 'pointer-events-none invisible')}>
                        <Suspense fallback={<SessionSurfaceFallback />}>
                          <WorkspaceShell
                            surfaceVisible={workspaceMode && terminalSurfaceVisible}
                            sessionConnectionKey={sessionInfo?.connectionKey}
                            sessionVaultId={sessionInfo?.vaultId}
                            activeVaultId={vault.activeVaultId}
                            sessionId={tab.sessionId}
                            mobile
                            hostName={tab.hostName}
                            hostAddress={tab.hostAddress}
                            hostId={sessions.interactiveSessions.find((s) => s.sessionId === tab.sessionId)?.hostId ?? null}
                            hosts={hostsCtx.hosts}
                            resolveAuthSecret={workspaceAuthResolvers[tab.sessionId]}
                            activeApp={sessions.workspaceBySession[tab.sessionId]?.activeApp ?? 'overview'}
                            onSelectApp={(workspaceApp) => sessions.setSessionWorkspaceApp(tab.sessionId, workspaceApp)}
                            onOpenTerminal={handleOpenHostTerminal}
                            onOpenProviderConsole={(url, host) => handleOpenProviderConsole(url, host, tab.sessionId)}
                            onEditHost={handleEditHostFromAssetInventory}
                            onBrowserCloseRequest={() => handleCloseBrowserContext(tab.sessionId)}
                          />
                        </Suspense>
                      </div>
                    </div>
                  </div>
                )
              })}
              </div>
              {mobileActiveSessionId && mobileWorkspaceMode === 'terminal' && (
                <MobileTerminalDrawer
                  visible={mobileDrawerOpen}
                  onClose={toggleMobileDrawer}
                  hostAddress={sessions.pcSessionTabs.find((t) => t.sessionId === mobileActiveSessionId)?.hostAddress ?? ''}
                  snippets={snippets.snippets}
                  onApplySnippet={(cmd) => {
                    if (mobileActiveSessionId) {
                      sessions.sendRaw(mobileActiveSessionId, cmd)
                      app.setOutput(t('terminal.snippetPasted'))
                    }
                  }}
                  onRunSnippet={(cmd) => {
                    if (mobileActiveSessionId) {
                      sessions.sendRaw(mobileActiveSessionId, cmd + '\n')
                      app.setOutput(t('terminal.snippetPasted'))
                    }
                  }}
                  terminalPrefs={app.terminalPrefs}
                  onTerminalPrefsChange={app.updateTerminalPrefs}
                  onSearchToggle={() => { if (mobileActiveSessionId) requestTerminalSearchToggle(mobileActiveSessionId) }}
                  searchVisible={!!mobileActiveSessionId && terminalSearchOpen[mobileActiveSessionId] === true}
                  hosts={hostsCtx.hosts}
                  vaultId={vault.activeVaultId}
                />
              )}
            </div>
          )}
          {/* Mobile QuickConnect overlay */}
          {showQuickConnect && (
            <div className="absolute inset-0 z-20 bg-[var(--workspace-surface-950)]">
              <QuickConnectPanel
                hosts={hostsCtx.hosts}
                onConnectHost={(hostId) => { setShowQuickConnect(false); void sessions.handleConnectHost(hostId) }}
                onNewHost={() => { setShowQuickConnect(false); app.setPcSidebarNav('hosts'); hostsCtx.setPcOpenAddHost(true) }}
                onClose={() => setShowQuickConnect(false)}
              />
            </div>
          )}
        </div>
        )}

        {/* Dashboard layer: always shown on mobile when not on 'terminal', and on desktop when no session tab is active. */}
        {showDashboardLayer && (
          <div className="flex h-full">
            <PcNavSidebar activeNav={app.pcSidebarNav} onNavChange={(nav) => { app.setPcSidebarNav(nav); setShowQuickConnect(false) }}
              onOpenSearch={() => app.setCommandPaletteOpen(true)}
              counts={{ hosts: hostsCtx.hosts.filter((host) => !host.vaultId || host.vaultId === vault.activeVaultId).length, snippets: snippets.snippets.length, forwardsRunning: forwardSummary.running.size }}
              vault={{
                name: vault.vaults.find((entry) => entry.id === vault.activeVaultId)?.name ?? '',
                vaults: vault.vaults,
                activeVaultId: vault.activeVaultId,
                unlocked: !!vault.vaultStatusState?.unlocked,
                autoLockMinutes: vault.vaultAutoLockMinutes,
                onSwitch: vault.setActiveVaultId,
                onManage: () => { requestSettingsCategory('security'); app.setPcSidebarNav('settings'); setShowQuickConnect(false) },
                onLock: () => void vault.handleLock(),
              }} />
            <div className="mobile-safe-pb relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-workspace-content" style={{ WebkitOverflowScrolling: 'touch' }}>
              {showQuickConnect ? (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <QuickConnectPanel
                    hosts={hostsCtx.hosts}
                    onConnectHost={handleQuickConnectHost}
                    onNewHost={handleQuickConnectNewHost}
                  />
                </Suspense>
              ) : (
              <>
              {app.pcSidebarNav !== 'tools' && isToolPage(app.pcSidebarNav) && (
                <button
                  type="button"
                  data-testid="mobile-tools-back"
                  onClick={() => app.setPcSidebarNav('tools')}
                  style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
                  className="flex items-center gap-1 px-3 text-[15px] text-[var(--workspace-accent-text)] md:hidden"
                >
                  <ChevronLeft className="h-5 w-5" />{t('nav.tools')}
                </button>
              )}
              {app.pcSidebarNav === 'tools' && <MobileToolsPage vaultId={vault.activeVaultId} onNavigate={app.setPcSidebarNav} />}
              {app.pcSidebarNav === 'guide' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <UserGuide onStartTour={(id) => {
                    setTourOutcome(null)
                    setShowQuickConnect(false)
                    const category = TOUR_SETTINGS_CATEGORY[id]
                    if (category) requestSettingsCategory(category)
                    app.setPcSidebarNav(TOUR_ROUTES[id])
                    setTour({ id, vaultId: vault.activeVaultId })
                  }} onNavigate={(destination) => {
                    setShowQuickConnect(false)
                    app.setPcSidebarNav(destination === 'add-host' ? 'hosts' : destination)
                    if (destination === 'add-host') hostsCtx.setPcOpenAddHost(true)
                  }} />
                </Suspense>
              )}
              {app.pcSidebarNav === 'dashboard' && (
                <div className="min-h-full p-4 md:p-6">
                  <FleetDashboard
                    hosts={hostsCtx.hosts}
                    vaultId={vault.activeVaultId}
                    unlocked={vault.vaultStatusState?.unlocked ?? false}
                    onSaveToVault={vault.handleSaveSecret}
                    onLoadVaultSecret={vault.handleRevealSecret}
                    onOpenHost={(hostId) => { void sessions.openHostWorkspace(hostId, 'charts'); app.setPcSidebarNav('terminal') }}
                    onOpenAlerts={() => app.setPcSidebarNav('hosts')}
                  />
                </div>
              )}
              {app.pcSidebarNav === 'hosts' && (isMd ? (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <div className="min-h-full p-4 md:p-6">
                    <HostsDashboard
                      activeVaultId={vault.activeVaultId}
                      hosts={hostsCtx.hosts}
                      selectedHostId={hostsCtx.selectedHostId}
                      loading={hostsCtx.loadingHosts}
                      defaultUsername={hostsCtx.defaultUsername}
                      onSelectHost={hostsCtx.setSelectedHostId}
                      onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
                      onOpenWorkspace={(hostId, workspaceApp) => {
                        void sessions.openHostWorkspace(hostId, workspaceApp)
                        app.setPcSidebarNav('terminal')
                      }}
                      onCreateHost={hostsCtx.handleCreateHost}
                      onUpdateHost={hostsCtx.handleUpdateHost}
                      onDeleteHost={hostsCtx.handleDeleteHost}
                      openAddForm={hostsCtx.pcOpenAddHost}
                      onAddFormClose={() => hostsCtx.setPcOpenAddHost(false)}
                      externalSearch={hostsCtx.pcTopBarSearch}
                      onExternalSearchChange={hostsCtx.setPcTopBarSearch}
                      onScanHosts={hostsCtx.handleScanHosts}
                      onRefreshHosts={hostsCtx.refreshHosts}
                      vaultKeys={vault.vaultKeys}
                      vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                      onSaveToVault={hostsCtx.handleSaveToVault}
                      onLoadVaultSecret={vault.handleRevealSecret}
                      vaultName={vault.vaults.find((v) => v.id === vault.activeVaultId)?.name ?? 'Vault'}
                      vaults={vault.vaults}
                      headerExtraAction={browserOverviewEntry}
                    />
                  </div>
                </Suspense>
              ) : (
                <MobileHostsPage
                  hosts={hostsCtx.hosts}
                  trustedPeers={sync.trustedPeers}
                  activeVaultId={vault.activeVaultId}
                  vaults={vault.vaults}
                  vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                  vaultKeys={vault.vaultKeys}
                  vaultName={vault.vaults.find((v) => v.id === vault.activeVaultId)?.name ?? 'Vault'}
                  defaultUsername={hostsCtx.defaultUsername}
                  onSwitchVault={vault.setActiveVaultId}
                  onLockVault={() => void vault.handleLock()}
                  onSaveToVault={hostsCtx.handleSaveToVault}
                  onLoadVaultSecret={vault.handleRevealSecret}
                  onCreateHost={hostsCtx.handleCreateHost}
                  onUpdateHost={hostsCtx.handleUpdateHost}
                  onDeleteHost={hostsCtx.handleDeleteHost}
                  onRefreshHosts={hostsCtx.refreshHosts}
                  onSelectHost={hostsCtx.setSelectedHostId}
                  onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
                  onOpenWorkspace={(hostId, workspaceApp) => { void sessions.openHostWorkspace(hostId, workspaceApp); app.setPcSidebarNav('terminal') }}
                  onOpenPortForwarding={() => app.setPcSidebarNav('port-forwarding')}
                  onOpenSync={() => app.setPcSidebarNav('sync')}
                  openAddForm={hostsCtx.pcOpenAddHost}
                  onAddFormClose={() => hostsCtx.setPcOpenAddHost(false)}
                />
              ))}
              {app.pcSidebarNav === 'asset-inventory' && (
                <div className="h-full min-h-0 p-4 md:p-6">
                  <WorkspaceAssetInventoryApp
                    activeVaultId={vault.activeVaultId}
                    selectedHostId={hostsCtx.selectedHostId}
                    hosts={hostsCtx.hosts}
                    resolveAuthSecret={resolveWorkspaceAuthSecret}
                    onOpenTerminal={handleOpenHostTerminal}
                    onOpenProviderConsole={handleOpenProviderConsole}
                    onEditHost={handleEditHostFromAssetInventory}
                    onImportSsh={() => setAssetSshImportOpen(true)}
                    onCreateHost={() => setAssetCreateHostOpen(true)}
                    headerExtraAction={browserOverviewEntry}
                  />
                </div>
              )}
              {app.pcSidebarNav === 'keychain' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <KeychainTab
                    vaultKeys={vault.vaultKeys}
                    vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                    vaultBusy={vault.vaultBusy}
                    activeVaultId={vault.activeVaultId}
                    onRefresh={vault.refreshVault}
                    onLoadSecret={vault.handleRevealSecret}
                    onDeleteSecret={vault.handleDeleteSecret}
                    onOutput={app.setOutput}
                    onError={app.setOutput}
                  />
                </Suspense>
              )}
              {app.pcSidebarNav === 'snippets' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <SnippetPanel
                    snippets={snippets.snippets}
                    selectedSnippetId={snippets.selectedSnippetId}
                    saving={snippets.saving}
                    running={snippets.running}
                    onSelectSnippet={snippets.setSelectedSnippetId}
                    onCreateSnippet={snippets.handleCreate}
                    onUpdateSnippet={snippets.handleUpdate}
                    onDeleteSnippet={snippets.handleDelete}
                    onApplySnippetCommand={(cmd) => {
                      const sid = sessions.pcActiveSessionId
                      if (sid) {
                        sessions.sendRaw(sid, cmd + '\n')
                        app.setOutput(t('terminal.snippetPasted'))
                      } else {
                        app.setCommand(cmd)
                        app.setOutput(t('terminal.snippetCopied'))
                      }
                    }}
                    onRunSnippet={async (id) => {
                      const snippet = snippets.snippets.find((s) => s.id === id)
                      if (!snippet) return
                      const sid = sessions.pcActiveSessionId
                      if (sid) {
                        sessions.sendRaw(sid, snippet.command + '\n')
                        app.setOutput(t('terminal.runningSnippet', { name: snippet.name }))
                      }
                    }}
                  />
                </Suspense>
              )}
              {app.pcSidebarNav === 'port-forwarding' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <PortForwardPanel
                    hosts={hostsCtx.hosts}
                    vaultId={vault.activeVaultId}
                    onOutput={app.setOutput}
                    onError={app.setOutput}
                    resolvePrivateKey={async (hostId) => {
                      const host = hostsCtx.hosts.find((h) => h.id === hostId)
                      if (!host || host.authType !== 'privateKey') return undefined
                      try {
                        return await vault.resolveAuthSecret({
                          authType: 'privateKey', explicitSecret: '', hostForRef: host, inputMode: 'vault',
                        })
                      } catch { return undefined }
                    }}
                  />
                </Suspense>
              )}
              {app.pcSidebarNav === 'known-hosts' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <KnownHostsPanel hosts={hostsCtx.hosts} onOutput={app.setOutput} onError={app.setOutput} />
                </Suspense>
              )}
              {app.pcSidebarNav === 'sftp' && (
                <Suspense fallback={<DashboardSectionFallback fullHeight />}>
                  {/* On mobile SFTP sits below the "< Tools" back button; on md+ it fills the viewport. */}
                  <div className="mobile-safe-pb h-[calc(100%-2.75rem)] md:absolute md:inset-0 md:h-auto">
                    <SftpDualPane
                      vaultId={vault.activeVaultId}
                      hosts={hostsCtx.hosts}
                      selectedHostId={hostsCtx.selectedHostId}
                      resolveAuthSecret={async (host) => {
                        const secret = await vault.resolveAuthSecret({
                          authType: host.authType, explicitSecret: '', hostForRef: host, inputMode: 'vault',
                        })
                        return secret ?? ''
                      }}
                    />
                  </div>
                </Suspense>
              )}
              {(app.pcSidebarNav === 'sync' || app.pcSidebarNav === 'backup') && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <div className="p-4 md:p-6">
                    <SyncCenterPanel
                      focusSection={app.pcSidebarNav === 'backup' ? 'backup' : 'sync'}
                      backupPanel={
                        <BackupRestorePanel
                          vaultId={vault.activeVaultId}
                          onSuccess={app.setOutput}
                          onError={app.setOutput}
                          onRestoreComplete={() => {
                            void hostsCtx.refreshHosts()
                            void snippets.refresh()
                            void vault.refreshVault()
                            void sync.refresh()
                          }}
                        />
                      }
                      localDevice={sync.localDevice}
                      changes={sync.changes}
                      cursors={sync.cursors}
                      trustedPeers={sync.trustedPeers}
                      loading={sync.loading}
                      serverRunning={sync.serverRunning}
                      serverPort={sync.serverPort}
                      onRefresh={sync.refresh}
                      onInitDevice={sync.handleInitDevice}
                      onStartServer={sync.handleStartServer}
                      onPullFromPeer={sync.handlePullFromPeer}
                      onPushToPeer={sync.handlePushToPeer}
                      syncVaultName={vault.vaults.find((v) => v.id === vault.activeVaultId)?.name}
                      onRemoveTrustedPeer={sync.handleRemoveTrustedPeer}
                    />
                  </div>
                </Suspense>
              )}
              {app.pcSidebarNav === 'companion' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <CompanionCenterPanel
                    localDevice={sync.localDevice}
                    trustedPeers={sync.trustedPeers}
                    hosts={hostsCtx.hosts}
                    loading={sync.loading}
                    serverRunning={sync.serverRunning}
                    serverPort={sync.serverPort}
                    interactiveSessions={sessions.interactiveSessions}
                    onRefresh={sync.refresh}
                    onInitDevice={sync.handleInitDevice}
                    onStartServer={sync.handleStartServer}
                    onRemoveTrustedPeer={sync.handleRemoveTrustedPeer}
                    onSelectSession={(sid) => {
                      sessions.setPcActiveSessionId(sid)
                      app.setPcSidebarNav('terminal')
                      setShowQuickConnect(false)
                    }}
                  />
                </Suspense>
              )}
              {app.pcSidebarNav === 'activity' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <ActivityLogPanel hosts={hostsCtx.hosts} />
                </Suspense>
              )}
              {app.pcSidebarNav === 'settings' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <SettingsScreen
                    onOpenGuide={() => app.setPcSidebarNav('guide')}
                    vaultAutoLockMinutes={vault.vaultAutoLockMinutes}
                    reconnectSettings={sessions.reconnectSettings}
                    defaultUsername={hostsCtx.defaultUsername}
                    keepAliveIntervalSecs={hostsCtx.keepAliveIntervalSecs}
                    theme={app.theme}
                    onToggleTheme={app.toggleTheme}
                    terminalPrefs={app.terminalPrefs}
                    onTerminalPrefsChange={app.updateTerminalPrefs}
                    onVaultAutoLockMinutesChange={vault.handleAutoLockMinutesChange}
                    onReconnectSettingsChange={(next) => {
                      sessions.setReconnectSettings((prev) => ({
                        enabled: next.enabled ?? prev.enabled,
                        maxRetries: next.maxRetries !== undefined && !Number.isNaN(next.maxRetries)
                          ? Math.max(0, Math.min(10, Math.floor(next.maxRetries))) : prev.maxRetries,
                        intervalMs: next.intervalMs !== undefined && !Number.isNaN(next.intervalMs)
                          ? Math.max(500, Math.min(15000, Math.floor(next.intervalMs))) : prev.intervalMs,
                      }))
                    }}
                    onDefaultUsernameChange={hostsCtx.handleDefaultUsernameChange}
                    onKeepAliveIntervalSecsChange={hostsCtx.handleKeepAliveIntervalSecsChange}
                  />
                </Suspense>
              )}
              </>
              )}
            </div>
          </div>
        )}
      </div>
      {!inActiveMobileTerminal && (
        <MobileBottomNav
          activeNav={app.pcSidebarNav}
          sessionCount={sessions.pcSessionTabs.length + (companionStatus.state === 'connected' ? companionWorkspace.sessions.length : 0)}
          onNavChange={(nav) => {
            if (nav !== 'terminal') {
              sessions.setPcActiveSessionId(null)
            } else {
              const target = mobileActiveSessionId && sessions.pcSessionTabs.some((t) => t.sessionId === mobileActiveSessionId)
                ? mobileActiveSessionId
                : sessions.pcSessionTabs[0]?.sessionId ?? null
              if (target) {
                setMobileActiveSessionId(target)
                sessions.setPcActiveSessionId(target)
              }
            }
            app.setPcSidebarNav(nav)
          }}
        />
      )}
      {activeRemoteDesktopSession && (
        <MobileRemoteSessionSheet
          session={activeRemoteDesktopSession}
          desktopName={companionStatus.peerDeviceName || 'Desktop'}
          canControl={companionStatus.permissions?.allowTerminalControl !== false}
          aiSnapshot={companionWorkspace.aiBySession[activeRemoteDesktopSession.sessionId] ?? null}
          hosts={hostsCtx.hosts}
          onClose={closeRemoteDesktopSession}
        />
      )}
    </div>
  )
}
