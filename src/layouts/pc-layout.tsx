import { usePortForwardSummary } from '@/hooks/use-port-forward-summary'
import { MobileTerminalDrawer } from '@/components/mobile/mobile-terminal-drawer'
import { MobileHostsPage } from '@/components/mobile/mobile-hosts-page'
import { FleetDashboard } from '@/components/dashboard/fleet-dashboard'
import { requestSettingsCategory } from '@/lib/settings-request'
import { MobileToolsPage } from '@/components/mobile-tools-page'
import { isToolPage } from '@/lib/mobile-navigation'
import { requestTerminalAiToggle, requestTerminalSearchToggle, TERMINAL_SEARCH_STATE_EVENT } from '@/lib/terminal-events'
import { CLOSE_SESSION_REQUEST_EVENT, OPEN_KNOWN_HOSTS_REQUEST_EVENT, OPEN_SFTP_REQUEST_EVENT, OPEN_TERMINAL_REQUEST_EVENT, type HostDirectoryRequest } from '@/lib/navigation-request'
import { HostKeyConfirmDialog } from '@/components/host-key-confirm-dialog'
import { InteractiveTour } from '@/components/interactive-tour'
import { getBrowserTabRouteIndicator } from '@/components/browser/browser-view-state'
import { BrowserOverviewDialog } from '@/components/browser/browser-overview-dialog'
import { BrowserSwitcherDialog } from '@/components/browser/browser-switcher-dialog'
import { MobileSessionHeader } from '@/components/mobile-session-header'
import { MobileBottomNav, PcNavSidebar } from '@/components/pc-nav-sidebar'
import { PcSessionTabBar, type SessionBrowserTabMeta } from '@/components/pc-tab-bar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { SessionConnectPlaceholder } from '@/components/session-connect-placeholder'
import { SessionTerminalView } from '@/components/session-terminal-view'
import { TerminalRightSidebar } from '@/components/terminal-right-sidebar'
import { WorkspaceAssetInventoryApp } from '@/components/workspace/workspace-asset-inventory-app'
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
import { TOUR_ROUTES, type InteractiveTourId, type TourOutcome } from '@/lib/interactive-tour'
import { cn } from '@/lib/utils'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
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
  const workspaceAuthResolvers = useMemo(() => {
    const resolvers: Record<string, (host: (typeof hostsCtx.hosts)[number]) => Promise<string>> = {}

    for (const tab of sessions.pcSessionTabs) {
      const sessionId = tab.sessionId
      resolvers[sessionId] = async (host) => {
        const cachedSecret = sessions.workspaceAuthBySession[sessionId]
        if (cachedSecret) return cachedSecret
        return resolveWorkspaceAuthSecret(host)
      }
    }

    return resolvers
  }, [resolveWorkspaceAuthSecret, sessions.pcSessionTabs, sessions.workspaceAuthBySession])
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
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    try { return localStorage.getItem('shellbeam.rightSidebar') === 'true' } catch { return false }
  })
  const [lastDashboardNav, setLastDashboardNav] = useState(() => app.pcSidebarNav === 'terminal' ? 'hosts' : app.pcSidebarNav)
  const browserSwitcherInputRef = useRef<HTMLInputElement | null>(null)
  const observedActiveBrowserTabIdsRef = useRef<string[] | null>(null)

  useEffect(() => {
    if (app.pcSidebarNav !== 'terminal') setLastDashboardNav(app.pcSidebarNav)
  }, [app.pcSidebarNav])

  // Auto-switch to terminal tab on mobile when a new session is created
  const prevTabCountRef = useRef(sessions.pcSessionTabs.length)
  useEffect(() => {
    const newCount = sessions.pcSessionTabs.length
    if (newCount > prevTabCountRef.current) {
      // A new session was added — switch mobile to terminal tab and select it
      const newest = sessions.pcSessionTabs[sessions.pcSessionTabs.length - 1]
      if (newest) {
        setMobileActiveSessionId(newest.sessionId)
        app.setPcSidebarNav('terminal')
        setShowQuickConnect(false)
      }
    }
    // If the active mobile session was closed, pick another
    if (mobileActiveSessionId && !sessions.pcSessionTabs.find((t) => t.sessionId === mobileActiveSessionId)) {
      setMobileActiveSessionId(sessions.pcSessionTabs[0]?.sessionId ?? null)
    }
    prevTabCountRef.current = newCount
  }, [app.setPcSidebarNav, mobileActiveSessionId, sessions.pcSessionTabs])

  useEffect(() => {
    if (sessions.pcSessionTabs.length === 0 && !sessions.pcActiveSessionId && app.pcSidebarNav === 'terminal' && !showQuickConnect) {
      app.setPcSidebarNav('hosts')
    }
  }, [app.pcSidebarNav, app.setPcSidebarNav, sessions.pcActiveSessionId, sessions.pcSessionTabs.length, showQuickConnect])

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen((v) => {
      const next = !v
      try { localStorage.setItem('shellbeam.rightSidebar', String(next)) } catch {}
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
    const latestHost = hostsCtx.hosts.find((entry) => entry.id === host.id) ?? host
    hostsCtx.setSelectedHostId(latestHost.id)
    setAssetEditingHost(latestHost)
  }, [hostsCtx.hosts, hostsCtx.setSelectedHostId])

  const allExistingGroups = useMemo(() => {
    const set = new Set<string>([...DEFAULT_GROUPS])
    hostsCtx.hosts.forEach((host) => { if (host.group) set.add(host.group) })
    return Array.from(set)
  }, [hostsCtx.hosts])

  const allExistingTags = useMemo(() => {
    const set = new Set<string>()
    hostsCtx.hosts.forEach((host) => host.tags?.forEach((tag) => set.add(tag)))
    return Array.from(set).sort()
  }, [hostsCtx.hosts])

  const handleSubmitAssetHostEdit = useCallback(async (...args: Parameters<typeof hostsCtx.handleUpdateHost>) => {
    await hostsCtx.handleUpdateHost(...args)
    setAssetEditingHost(null)
  }, [hostsCtx.handleUpdateHost])

  const handleSubmitAssetHostCreate = useCallback(async (...args: Parameters<typeof hostsCtx.handleCreateHost>) => {
    await hostsCtx.handleCreateHost(...args)
    setAssetCreateHostOpen(false)
  }, [hostsCtx.handleCreateHost])

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

  const handleGoToDashboard = () => {
    sessions.setPcActiveSessionId(null)
    setShowQuickConnect(false)
    app.setPcSidebarNav(lastDashboardNav)
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
      sessions.setRightPaneSessionId(null)
    } else {
      const other = sessions.pcSessionTabs.find((t) => (
        t.sessionId !== sessions.pcActiveSessionId
        && getWorkspaceMode(t.sessionId) === 'terminal'
      ))
      if (other) sessions.setRightPaneSessionId(other.sessionId)
    }
  }, [getWorkspaceMode, isSplit, sessions.pcActiveSessionId, sessions.pcSessionTabs, sessions.setRightPaneSessionId])

  const handleInitialChunksConsumed = useCallback((sessionId: string) => {
    sessions.setInteractiveChunksBySession((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [sessions.setInteractiveChunksBySession])

  useEffect(() => {
    void snippets.refresh()
    void sync.refresh()
  }, [])

  const isMd = useSyncExternalStore(subscribeMediaQuery, getIsMd, () => true)
  const SettingsScreen = isMd ? SettingsPanel : MobileSettingsPage
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

  useEffect(() => {
    if (!browserSwitcherOpen) return
    setBrowserSwitcherQuery('')
    setBrowserSwitcherActiveIndex(0)
    const frame = window.requestAnimationFrame(() => {
      browserSwitcherInputRef.current?.focus()
      browserSwitcherInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [browserSwitcherOpen])

  useEffect(() => {
    setBrowserSwitcherActiveIndex(0)
  }, [browserSwitcherQuery])

  useEffect(() => {
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
  }, [sessions.browserBySession, sessions.pcSessionTabs])

  useEffect(() => {
    const validIds = new Set(browserSwitcherEntries.map((entry) => entry.id))
    setBrowserSwitcherRecentTabIds((current) => {
      const next = current.filter((id) => validIds.has(id))
      if (next.length === current.length) return current
      return next
    })
  }, [browserSwitcherEntries])

  useEffect(() => {
    if (browserSwitcherOpen && browserSwitcherEntries.length === 0) {
      setBrowserSwitcherOpen(false)
    }
  }, [browserSwitcherEntries.length, browserSwitcherOpen])

  useEffect(() => {
    try {
      localStorage.setItem(BROWSER_SWITCHER_RECENTS_KEY, JSON.stringify(browserSwitcherRecentTabIds))
    } catch {}
  }, [browserSwitcherRecentTabIds])

  useEffect(() => {
    if (!browserSwitcherOpen && browserSwitcherActiveIndex > 0) {
      setBrowserSwitcherActiveIndex(0)
    }
  }, [browserSwitcherActiveIndex, browserSwitcherOpen])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'b') return
      if (browserSwitcherEntries.length === 0) return
      event.preventDefault()
      setBrowserSwitcherOpen(true)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [browserSwitcherEntries.length])

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
      <Dialog open={!!pendingCloseSession} onOpenChange={(open) => { if (!open) setPendingCloseSessionId(null) }}>
        <DialogContent className="md:max-w-md">
          <div className="space-y-4">
            <div className="space-y-2 text-center">
              <div className="text-lg font-semibold text-foreground">{t('browser.sessionClose.title')}</div>
              <div className="text-sm text-muted-foreground">
                {pendingCloseSession
                  ? t('browser.sessionClose.description', {
                      host: pendingCloseSession.hostName || pendingCloseSession.hostAddress,
                    })
                  : ''}
              </div>
            </div>
            {pendingCloseSession && browserMetaBySession[pendingCloseSession.sessionId] && (
              <div className="rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-700)] px-4 py-3 text-sm text-[var(--workspace-text-muted)]">
                <div className="font-medium text-[var(--workspace-text-strong)]">
                  {t('browser.sessionClose.tabCount', { count: browserMetaBySession[pendingCloseSession.sessionId]!.tabCount })}
                </div>
                <div className="mt-1">{browserMetaBySession[pendingCloseSession.sessionId]!.detail}</div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setPendingCloseSessionId(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                className="flex-1"
                onClick={() => {
                  if (pendingCloseSessionId) closeSessionWithGuards(pendingCloseSessionId)
                  setPendingCloseSessionId(null)
                }}
              >
                {t('browser.sessionClose.confirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BrowserSwitcherDialog
        open={browserSwitcherOpen}
        onOpenChange={setBrowserSwitcherOpen}
        inputRef={browserSwitcherInputRef}
        query={browserSwitcherQuery}
        onQueryChange={setBrowserSwitcherQuery}
        entries={filteredBrowserSwitcherEntries}
        activeIndex={browserSwitcherActiveIndex}
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
          onOpenLocalTerminal={() => sessions.handleOpenLocalTerminal()}
          onNewConnection={handlePcNewConnection}
          onToggleSplit={canToggleSplit ? handleToggleSplit : undefined}
          hosts={hostsCtx.hosts}
          onToggleAi={() => { if (sessions.pcActiveSessionId) requestTerminalAiToggle(sessions.pcActiveSessionId) }}
          theme={app.theme}
          onToggleTheme={app.toggleTheme}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {/* PC Terminal layer - all sessions stay mounted, only active is visible (hidden on mobile) */}
        {sessions.pcSessionTabs.length > 0 && (
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
                      <div className={cn(showTerminalChrome ? 'absolute inset-x-0 top-0 z-10' : 'absolute inset-0')}>
                        <SessionTerminalView
                          sessionId={tab.sessionId}
                          session={sessionInfo}
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          network={displayNetwork}
                          resource={displayResource}
                          chunkEmitterRef={sessions.pcChunkEmitterRef}
                          onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                          terminalPrefs={app.terminalPrefs}
                          isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                          onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                          visible={isVisible && !!sessions.pcActiveSessionId}
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
                    <div className={cn('absolute inset-0 flex', !showTerminalChrome && 'pointer-events-none invisible', showTerminalChrome && 'top-9')}>
                      {browserPageMode && terminalSurfaceVisible ? (
                        <div className="h-full min-h-0 w-full bg-[var(--workspace-surface-950)] p-3">
                          <Suspense fallback={<SessionSurfaceFallback />}>
                            <BrowserView sessionId={tab.sessionId} visible onCloseRequest={() => handleCloseBrowserContext(tab.sessionId)} />
                          </Suspense>
                        </div>
                      ) : browserPageMode ? null : (
                        <Suspense fallback={<SessionSurfaceFallback />}>
                          <WorkspaceShell
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
                      )}
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
        <div className={cn('absolute inset-0 flex flex-col md:hidden pb-14', app.pcSidebarNav === 'terminal' ? 'z-10' : 'pointer-events-none invisible')}>
          <MobileSessionHeader
            onOpenDrawer={toggleRightSidebar}
            onBack={() => app.setPcSidebarNav('hosts')}
            sessionTabs={sessions.pcSessionTabs}
            activeSessionId={mobileActiveSessionId}
            onSelectSession={setMobileActiveSessionId}
            onCloseSession={handleMobileCloseSession}
            onNewConnection={handleMobileNewConnection}
            onOpenLocalTerminal={() => sessions.handleOpenLocalTerminal()}
            hosts={hostsCtx.hosts}
            onConnectHost={(hostId) => void sessions.handleConnectHost(hostId)}
          />
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
                      <div className={cn(showTerminalChrome ? 'absolute inset-x-0 top-0 z-10' : 'absolute inset-0')}>
                        <SessionTerminalView
                          sessionId={tab.sessionId}
                          session={sessionInfo}
                          hostName={tab.hostName}
                          hostAddress={tab.hostAddress}
                          network={displayNetwork}
                          resource={displayResource}
                          chunkEmitterRef={sessions.pcChunkEmitterRef}
                          onSendRaw={(data: string) => sessions.sendRaw(tab.sessionId, data)}
                          terminalPrefs={app.terminalPrefs}
                          isReconnecting={sessions.reconnectingSessionIds.has(tab.sessionId)}
                          onReconnect={() => sessions.manualReconnect(tab.sessionId)}
                          visible={isActive && app.pcSidebarNav === 'terminal'}
                          workspaceMode={mobileMode}
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
                          initialChunks={sessions.interactiveChunksBySession[tab.sessionId]}
                          onInitialChunksConsumed={handleInitialChunksConsumed}
                          onToggleRightSidebar={isActive ? toggleRightSidebar : undefined}
                          rightSidebarOpen={isActive ? rightSidebarOpen : undefined}
                        />
                      </div>
                    )}
                    <div className={cn('absolute inset-0', !showTerminalChrome && 'pointer-events-none invisible', showTerminalChrome && 'top-9')}>
                      {browserPageMode && terminalSurfaceVisible ? (
                        <div className="h-full min-h-0 w-full bg-[var(--workspace-surface-950)] p-3">
                          <Suspense fallback={<SessionSurfaceFallback />}>
                            <BrowserView sessionId={tab.sessionId} visible onCloseRequest={() => handleCloseBrowserContext(tab.sessionId)} />
                          </Suspense>
                        </div>
                      ) : browserPageMode ? null : (
                        <Suspense fallback={<SessionSurfaceFallback />}>
                          <WorkspaceShell
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
                      )}
                    </div>
                  </div>
                )
              })}
              </div>
              {mobileActiveSessionId && mobileWorkspaceMode === 'terminal' && (
                <MobileTerminalDrawer
                  visible={rightSidebarOpen}
                  onClose={toggleRightSidebar}
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
                  onSearchToggle={() => { if (sessions.pcActiveSessionId) requestTerminalSearchToggle(sessions.pcActiveSessionId) }}
                  searchVisible={!!sessions.pcActiveSessionId && terminalSearchOpen[sessions.pcActiveSessionId] === true}
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

        {/* Dashboard layer */}
        {!sessions.pcActiveSessionId && (
          <div className={cn(
            'flex h-full',
            app.pcSidebarNav === 'terminal' && 'hidden',
          )}>
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
                <button type="button" data-testid="mobile-tools-back" onClick={() => app.setPcSidebarNav('tools')}
                  className="flex items-center gap-1 px-3 pt-3 text-[15px] text-[var(--workspace-accent-text)] md:hidden">
                  <ChevronLeft className="h-5 w-5" />{t('nav.tools')}
                </button>
              )}
              {app.pcSidebarNav === 'tools' && <MobileToolsPage vaultId={vault.activeVaultId} onNavigate={app.setPcSidebarNav} />}
              {app.pcSidebarNav === 'guide' && (
                <Suspense fallback={<DashboardSectionFallback />}>
                  <UserGuide onStartTour={(id) => {
                    setTourOutcome(null)
                    setShowQuickConnect(false)
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
                  <FleetDashboard hosts={hostsCtx.hosts} vaultId={vault.activeVaultId} unlocked={vault.vaultStatusState?.unlocked ?? false}
                    onOpenHost={(hostId) => { void sessions.openHostWorkspace(hostId, 'charts'); app.setPcSidebarNav('terminal') }}
                    onOpenAlerts={() => app.setPcSidebarNav('hosts')} />
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
                      headerExtraAction={browserOverviewEntry}
                    />
                  </div>
                </Suspense>
              ) : (
                <MobileHostsPage
                  hosts={hostsCtx.hosts}
                  activeVaultId={vault.activeVaultId}
                  vaultUnlocked={vault.vaultStatusState?.unlocked ?? false}
                  vaultKeys={vault.vaultKeys}
                  vaultName={vault.vaults.find((v) => v.id === vault.activeVaultId)?.name ?? 'Vault'}
                  defaultUsername={hostsCtx.defaultUsername}
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
                  <div className="absolute inset-0">
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
      <MobileBottomNav
        activeNav={app.pcSidebarNav}
        sessionCount={sessions.pcSessionTabs.length}
        onNavChange={(nav) => {
          if (nav !== 'terminal') {
            sessions.setPcActiveSessionId(null)
          }
          app.setPcSidebarNav(nav)
        }}
      />
    </div>
  )
}
