import {
  ChartArea,
  Server,
  KeyRound,
  Code2,
  ArrowLeftRight,
  Shield,
  FolderOpen,
  RefreshCw,
  Archive,
  Settings,
  LayoutGrid,
  Check,
  ChevronsUpDown,
  Lock,
  LockOpen,
  Search,
  Clock,
  Network,
  SquareTerminal,
  BookOpen,
  Smartphone,
  Laptop,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
} from 'lucide-react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { AppUpdateReminder } from '@/components/app-update'
import { useAppUpdateReminderVersion } from '@/lib/app-update'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { isToolPage } from '@/lib/mobile-navigation'
import { isMobileDevice } from '@/lib/mobile-back'
import { useViewportTier } from '@/lib/viewport'
import { useBarLayout } from '@/lib/bar-layout'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { companionCopy } from '@/lib/locales/companion'
import {
  EMPTY_COMPANION_SERVER,
  EMPTY_COMPANION_STATUS,
  EMPTY_COMPANION_WORKSPACE,
  getCompanionServerSnapshot,
  getCompanionStatusSnapshot,
  getCompanionWorkspaceSnapshot,
  subscribeCompanionServer,
  subscribeCompanionStatus,
  subscribeCompanionWorkspace,
} from '@/lib/companion'
import { PanelResizeHandle } from '@/components/ui/panel-resize-handle'
import { useResizablePanel } from '@/hooks/use-resizable-panel'
import logoSrc from '@/assets/logo.png'

export type SidebarNavId =
  | 'dashboard'
  | 'hosts'
  | 'asset-inventory'
  | 'keychain'
  | 'snippets'
  | 'port-forwarding'
  | 'known-hosts'
  | 'sftp'
  | 'activity'
  | 'sync'
  | 'companion'
  | 'backup'
  | 'settings'
  | 'terminal'
  | 'guide'
  /** Mobile-only hub that replaces the old "More" menu. */
  | 'tools'

interface NavItem {
  id: SidebarNavId
  labelKey: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: <ChartArea className="h-4 w-4" /> },
  { id: 'hosts', labelKey: 'nav.hosts', icon: <Server className="h-4 w-4" /> },
  { id: 'asset-inventory', labelKey: 'nav.assetInventory', icon: <Network className="h-4 w-4" /> },
  { id: 'keychain', labelKey: 'nav.keychain', icon: <KeyRound className="h-4 w-4" /> },
  { id: 'port-forwarding', labelKey: 'nav.portForward', icon: <ArrowLeftRight className="h-4 w-4" /> },
  { id: 'snippets', labelKey: 'nav.snippets', icon: <Code2 className="h-4 w-4" /> },
  { id: 'known-hosts', labelKey: 'nav.knownHosts', icon: <Shield className="h-4 w-4" /> },
  { id: 'sftp', labelKey: 'nav.sftp', icon: <FolderOpen className="h-4 w-4" /> },
  { id: 'activity', labelKey: 'nav.activity', icon: <Clock className="h-4 w-4" /> },
]

const SYSTEM_ITEMS: NavItem[] = [
  { id: 'guide', labelKey: 'guide.title', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'sync', labelKey: 'nav.sync', icon: <RefreshCw className="h-4 w-4" /> },
  { id: 'companion', labelKey: 'companion.navLabel', icon: <Smartphone className="h-4 w-4" /> },
  { id: 'backup', labelKey: 'nav.backup', icon: <Archive className="h-4 w-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="h-4 w-4" /> },
]


// Five fixed tabs, no "More": Desktop Companion sits at slot 3 alongside Hosts & Sessions; SFTP lives in Tools & Host actions.
const MOBILE_TABS: NavItem[] = [
  { id: 'hosts', labelKey: 'nav.hosts', icon: <Server className="h-5 w-5" /> },
  { id: 'terminal', labelKey: 'nav.sessions', icon: <SquareTerminal className="h-5 w-5" /> },
  { id: 'companion', labelKey: 'nav.desktop', icon: <Laptop className="h-5 w-5" /> },
  { id: 'tools', labelKey: 'nav.tools', icon: <LayoutGrid className="h-5 w-5" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="h-5 w-5" /> },
]

export interface PcNavSidebarVault {
  name: string
  vaults: Array<{ id: string; name: string }>
  activeVaultId: string
  unlocked: boolean
  autoLockMinutes: number
  onSwitch: (vaultId: string) => void
  onManage: () => void
  onLock: () => void
}

interface PcNavSidebarProps {
  activeNav: SidebarNavId
  onNavChange: (nav: SidebarNavId) => void
  /** Optional context; the sidebar still renders without it (tests, first launch). */
  vault?: PcNavSidebarVault
  counts?: { hosts?: number; forwardsRunning?: number; snippets?: number }
  onOpenSearch?: () => void
}

const WORKSPACE_IDS: SidebarNavId[] = ['dashboard', 'hosts', 'asset-inventory', 'sftp', 'port-forwarding']
const LIBRARY_IDS: SidebarNavId[] = ['keychain', 'snippets', 'known-hosts', 'activity']
const FOOTER_IDS: SidebarNavId[] = ['sync', 'companion', 'guide', 'settings']
const itemById = (id: SidebarNavId) => [...NAV_ITEMS, ...SYSTEM_ITEMS].find((item) => item.id === id)!

const NAV_COLLAPSED_STORAGE_KEY = 'shellbeam.navCollapsed'

function readStoredNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function PcNavSidebar({ activeNav, onNavChange, vault, counts, onOpenSearch }: PcNavSidebarProps) {
  const { t, locale } = useT()
  const { verticalBarEdge } = useBarLayout()
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false)
  const mobileClient = isMobileDevice()
  const viewportTier = useViewportTier()
  const isMedium = viewportTier === 'medium'
  const [desktopCollapsed, setDesktopCollapsed] = useState<boolean>(readStoredNavCollapsed)
  const [mediumDrawerOpen, setMediumDrawerOpen] = useState(false)
  const updateReminder = useAppUpdateReminderVersion()
  const isRail = isMedium || desktopCollapsed
  const collapseLabel = locale === 'zh-CN' ? '收起侧边栏' : 'Collapse sidebar'
  const expandLabel = locale === 'zh-CN' ? '展开侧边栏' : 'Expand sidebar'

  const toggleDesktopCollapse = () => {
    setDesktopCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const companionServer = useSyncExternalStore(
    subscribeCompanionServer,
    getCompanionServerSnapshot,
    () => EMPTY_COMPANION_SERVER,
  )
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
  const navResize = useResizablePanel({
    storageKey: 'pcNavSidebar',
    defaultSize: 224,
    minSize: 172,
    maxSize: 340,
    edge: 'right',
  })
  const hasCompanionLive = mobileClient
    ? companionStatus.state === 'connected'
    : companionServer.clients.length > 0

  const meta = (id: SidebarNavId): ReactNode => {
    if (id === 'hosts' && counts?.hosts) return <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{counts.hosts}</span>
    if (id === 'snippets' && counts?.snippets) return <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{counts.snippets}</span>
    if (id === 'port-forwarding' && counts?.forwardsRunning) return <span className="text-[11px] text-[color:var(--workspace-status-good-text)]">{t('nav.forwardsRunning', { count: counts.forwardsRunning })}</span>
    if (id === 'companion') {
      if (mobileClient && companionStatus.state === 'connected') {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {companionWorkspace.sessions.length > 0 ? companionWorkspace.sessions.length : ''}
          </span>
        )
      }
      if (!mobileClient && companionServer.clients.length > 0) {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {companionServer.clients.length}
          </span>
        )
      }
    }
    return null
  }
  const resolveNavMeta = (id: SidebarNavId) => {
    const nav = itemById(id)
    const active = activeNav === id || (id === 'sync' && activeNav === 'backup')
    const compCopy = companionCopy[locale] ?? companionCopy['zh-CN']
    const label = id === 'sync'
      ? (syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']).navLabel
      : id === 'companion'
        ? (mobileClient ? compCopy.myDesktop : compCopy.navLabel)
        : t(nav.labelKey)
    const icon = id === 'companion' && mobileClient
      ? <Laptop className="h-4 w-4" />
      : nav.icon
    return { active, label, icon }
  }

  const handleSelectNav = (id: SidebarNavId, closeOverlay = false) => {
    if (closeOverlay) setMediumDrawerOpen(false)
    onNavChange(id)
  }

  const renderExpandedItem = (id: SidebarNavId, closeOverlay = false) => {
    const { active, label, icon } = resolveNavMeta(id)
    return (
      <button key={id} data-testid={closeOverlay ? `pc-nav-drawer-${id}` : `pc-nav-${id}`} type="button" aria-current={active ? 'page' : undefined} onClick={() => handleSelectNav(id, closeOverlay)}
        className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
          active ? 'bg-[var(--workspace-nav-active-bg)] font-medium text-workspace-nav-active shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]' : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]')}>
        <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {meta(id)}
      </button>
    )
  }

  const railButtonBase =
    'relative mx-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors [@media(max-height:740px)]:h-8 [@media(max-height:740px)]:w-8 [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:shrink-0 [@media(max-height:740px)]:[&_svg]:h-4 [@media(max-height:740px)]:[&_svg]:w-4'

  const renderRailItem = (id: SidebarNavId) => {
    const { active, label, icon } = resolveNavMeta(id)
    const showLiveDot = (id === 'companion' && hasCompanionLive) || (id === 'port-forwarding' && !!counts?.forwardsRunning)
    const showUpdateDot = id === 'settings' && !!updateReminder
    return (
      <button key={id} data-testid={`pc-nav-${id}`} type="button" aria-current={active ? 'page' : undefined} aria-label={label} title={label} onClick={() => handleSelectNav(id)}
        className={cn(railButtonBase,
          active ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]' : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]')}>
        {icon}
        {showLiveDot && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[var(--workspace-surface-950)]" />}
        {showUpdateDot && <span data-testid="pc-nav-rail-update-dot" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--workspace-accent-text)] ring-2 ring-[var(--workspace-surface-950)]" />}
      </button>
    )
  }

  const group = (titleKey: string, ids: SidebarNavId[], closeOverlay = false) => (
    <div className="space-y-0.5">
      <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{t(titleKey)}</div>
      {ids.map((id) => renderExpandedItem(id, closeOverlay))}
    </div>
  )

  const renderFullSidebarBody = (inOverlay: boolean) => (
    <>
      <div className="relative px-3 pb-2 pt-3">
        <div className="flex items-center gap-1">
          <button type="button" data-testid={inOverlay ? 'pc-nav-drawer-vault' : 'pc-nav-vault'} aria-haspopup="menu" aria-expanded={vaultMenuOpen} disabled={!vault} onClick={() => setVaultMenuOpen((open) => !open)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors enabled:hover:bg-[var(--workspace-nav-hover-bg)]">
            <img src={logoSrc} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold leading-tight tracking-tight text-[var(--workspace-text-strong)]">ShellBeam</span>
              {vault && <span className="block truncate text-[11px] text-[var(--workspace-text-muted)]">{vault.name}</span>}
            </span>
            {vault && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />}
          </button>
          <button
            type="button"
            data-testid={inOverlay ? 'pc-nav-drawer-close' : 'pc-nav-collapse-toggle'}
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={() => (inOverlay ? setMediumDrawerOpen(false) : toggleDesktopCollapse())}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
        {vault && vaultMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setVaultMenuOpen(false)} />
            <div role="menu" className="absolute inset-x-3 top-full z-50 mt-1 overflow-hidden rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-[var(--workspace-shadow-overlay)]">
              {vault.vaults.map((entry) => (
                <button key={entry.id} type="button" role="menuitemradio" aria-checked={entry.id === vault.activeVaultId} onClick={() => { setVaultMenuOpen(false); if (entry.id !== vault.activeVaultId) vault.onSwitch(entry.id) }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--workspace-text)] hover:bg-[var(--workspace-nav-hover-bg)]">
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.id === vault.activeVaultId && <Check className="h-3.5 w-3.5 text-[var(--workspace-accent-text)]" />}
                </button>
              ))}
              <div className="my-1 h-px bg-[var(--workspace-border-soft)]" />
              <button type="button" role="menuitem" onClick={() => { setVaultMenuOpen(false); if (inOverlay) setMediumDrawerOpen(false); vault.onManage() }} className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]">{t('nav.manageVaults')}</button>
            </div>
          </>
        )}
        {onOpenSearch && (
          <button type="button" data-testid={inOverlay ? 'pc-nav-drawer-search' : 'pc-nav-search'} onClick={() => { if (inOverlay) setMediumDrawerOpen(false); onOpenSearch() }}
            className="mt-2 flex h-8 w-full items-center gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] px-2.5 text-[12px] text-[var(--workspace-text-subtle)] transition-colors hover:border-[color:var(--workspace-border-strong)]">
            <Search className="h-3.5 w-3.5 shrink-0" /><span className="flex-1 truncate text-left">{t('nav.search')}</span>
            {!mobileClient && <kbd className="rounded border border-[color:var(--workspace-border-soft)] px-1 font-sans text-[10px]">⌘K</kbd>}
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {group('nav.groupWorkspace', WORKSPACE_IDS, inOverlay)}
        {group('nav.groupLibrary', LIBRARY_IDS, inOverlay)}
      </nav>

      <div className="space-y-0.5 border-t border-[color:var(--workspace-border-soft)] px-2 py-2">{FOOTER_IDS.map((id) => renderExpandedItem(id, inOverlay))}</div>
      <AppUpdateReminder className="mx-3 mb-2" />
      {vault && (
        <div data-testid={inOverlay ? 'pc-nav-drawer-vault-status' : 'pc-nav-vault-status'} className="mx-3 mb-3 flex items-center gap-2.5 rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2">
          {vault.unlocked ? <LockOpen className="h-4 w-4 shrink-0 text-[color:var(--workspace-status-good)]" /> : <Lock className="h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />}
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-[var(--workspace-text-strong)]">{vault.unlocked ? t('nav.vaultUnlocked') : t('nav.vaultLocked')}</span>
            {vault.unlocked && <span className="block truncate text-[11px] text-[var(--workspace-text-muted)]">{t('nav.autoLockHint', { minutes: vault.autoLockMinutes })}</span>}
          </span>
          {vault.unlocked && <button type="button" data-testid={inOverlay ? 'pc-nav-drawer-lock' : 'pc-nav-lock'} aria-label={t('nav.lockNow')} title={t('nav.lockNow')} onClick={vault.onLock} className="rounded-md p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]"><Lock className="h-3.5 w-3.5" /></button>}
        </div>
      )}
    </>
  )

  // On iPhone Duo (outer display & inner landscape), iOS places app bars in a trailing/leading vertical strip;
  // MobileBottomNav owns that edge bar, so don't render a competing left sidebar.
  if (verticalBarEdge !== 'none') return null

  return (
    <>
    {isRail ? (
      <aside data-testid="pc-nav-sidebar" data-compact="true" className="hidden w-[56px] shrink-0 flex-col items-center border-r border-[color:var(--workspace-border-soft)] bg-[var(--workspace-nav-translucent)] py-2 md:flex">
        <div className="flex w-full shrink-0 flex-col items-center gap-1 border-b border-[color:var(--workspace-border-soft)] px-1 pb-2 [@media(max-height:740px)]:gap-0.5 [@media(max-height:740px)]:pb-1.5">
          <button
            type="button"
            data-testid="pc-nav-expand-toggle"
            aria-label={expandLabel}
            title={expandLabel}
            onClick={() => (isMedium ? setMediumDrawerOpen(true) : toggleDesktopCollapse())}
            className={cn(railButtonBase, 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]')}
          >
            <PanelLeftOpen />
          </button>
          {onOpenSearch && (
            <button
              type="button"
              data-testid="pc-nav-search"
              aria-label={t('nav.search')}
              title={t('nav.search')}
              onClick={onOpenSearch}
              className={cn(railButtonBase, 'border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] text-[var(--workspace-text-subtle)] hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]')}
            >
              <Search />
            </button>
          )}
        </div>
        <nav className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-2 [scrollbar-width:none] [@media(max-height:740px)]:gap-0.5 [@media(max-height:740px)]:py-1.5">
          {WORKSPACE_IDS.map(renderRailItem)}
          <div className="my-1 h-px w-6 shrink-0 bg-[var(--workspace-border-soft)]" />
          {LIBRARY_IDS.map(renderRailItem)}
        </nav>
        <div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-[color:var(--workspace-border-soft)] px-1 pt-2 [@media(max-height:740px)]:gap-0.5 [@media(max-height:740px)]:pt-1.5">
          {FOOTER_IDS.map(renderRailItem)}
          {vault && (
            <button
              type="button"
              data-testid="pc-nav-vault-status"
              aria-label={vault.unlocked ? t('nav.lockNow') : t('nav.vaultLocked')}
              title={vault.unlocked ? `${vault.name} · ${t('nav.lockNow')}` : `${vault.name} · ${t('nav.vaultLocked')}`}
              onClick={() => (vault.unlocked ? vault.onLock() : vault.onManage())}
              className={cn(railButtonBase, 'mt-0.5 bg-[var(--workspace-surface-800)] hover:bg-[var(--workspace-nav-hover-bg)]')}
            >
              {vault.unlocked
                ? <LockOpen className="text-[color:var(--workspace-status-good)]" />
                : <Lock className="text-[var(--workspace-text-muted)]" />}
            </button>
          )}
        </div>
      </aside>
    ) : (
      <>
        <aside data-testid="pc-nav-sidebar" data-compact="false" style={{ width: `${navResize.size}px` }} className="hidden shrink-0 flex-col bg-[var(--workspace-nav-translucent)] md:flex">
          {renderFullSidebarBody(false)}
        </aside>
        <PanelResizeHandle
          testId="pc-nav-resize-handle"
          label={t('panel.resizeHint')}
          dragging={navResize.dragging}
          className="hidden md:flex"
          {...navResize.handleProps}
        />
      </>
    )}
    {isMedium && mediumDrawerOpen && (
      <div className="fixed inset-0 z-50 hidden md:flex" role="dialog" aria-modal="true" aria-label={expandLabel}>
        <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px]" onClick={() => setMediumDrawerOpen(false)} />
        <aside data-testid="pc-nav-drawer" className="relative z-10 flex h-full w-[248px] max-w-[78vw] flex-col border-r border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] shadow-2xl">
          {renderFullSidebarBody(true)}
        </aside>
      </div>
    )}
    </>
  )
}

interface MobileBottomNavProps {
  activeNav: SidebarNavId
  onNavChange: (nav: SidebarNavId) => void
  sessionCount?: number
  onOpenSearch?: () => void
  theme?: string
  onToggleTheme?: () => void
}

export function MobileBottomNav({ activeNav, onNavChange, sessionCount = 0, onOpenSearch, theme, onToggleTheme }: MobileBottomNavProps) {
  const { t } = useT()
  const updateReminder = useAppUpdateReminderVersion()
  const companionStatus = useSyncExternalStore(
    subscribeCompanionStatus,
    getCompanionStatusSnapshot,
    () => EMPTY_COMPANION_STATUS,
  )
  const companionConnected = companionStatus.state === 'connected'
  const { verticalBarEdge } = useBarLayout()
  // iPhone Duo puts bars in a vertical strip on the outer display and in inner landscape (>= 768px too).
  // Render inside that exact trailing/leading strip below the system status cluster, with top quick actions and bottom thumb-reachable tabs.
  if (verticalBarEdge !== 'none') {
    const hasTopUtilities = Boolean(onOpenSearch || onToggleTheme)
    return (
      <nav
        data-testid="mobile-bottom-nav"
        data-axis="vertical"
        className={cn(
          'fixed bottom-0 top-0 z-50 flex w-[var(--vertical-bar-width)] flex-col items-center px-1.5 pt-[clamp(4.5rem,20vh,10.5rem)]',
          verticalBarEdge === 'trailing' ? 'right-0' : 'left-0',
        )}
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
      >
        <div
          className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto rounded-2xl border border-[color:var(--workspace-border-soft)]/70 bg-[var(--workspace-surface-900)]/85 px-1 py-2.5 backdrop-blur-xl [scrollbar-width:none]"
        >
          {hasTopUtilities && (
            <div className="flex shrink-0 flex-col items-center gap-2">
              {onOpenSearch && (
                <button
                  type="button"
                  data-testid="vertical-bar-search"
                  aria-label={t('nav.search')}
                  title={t('nav.search')}
                  onClick={onOpenSearch}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--workspace-surface-800)]/90 text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)] [&_svg]:h-5 [&_svg]:w-5"
                >
                  <Search />
                </button>
              )}
              {onToggleTheme && (
                <button
                  type="button"
                  data-testid="vertical-bar-theme"
                  aria-label={theme === 'dark' ? t('settings.light') : t('settings.dark')}
                  title={theme === 'dark' ? t('settings.light') : t('settings.dark')}
                  onClick={onToggleTheme}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--workspace-surface-800)]/90 text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)] [&_svg]:h-5 [&_svg]:w-5"
                >
                  {theme === 'dark' ? <Sun /> : <Moon />}
                </button>
              )}
            </div>
          )}
          <div className="mt-auto flex shrink-0 flex-col items-center gap-1.5">
            {MOBILE_TABS.map((item) => {
              const isActive = item.id === 'tools' ? isToolPage(activeNav) : activeNav === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={t(item.labelKey)}
                  onClick={() => onNavChange(item.id)}
                  className={cn(
                    'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:h-5 [&_svg]:w-5',
                    isActive
                      ? 'bg-[var(--workspace-nav-active-bg)] text-workspace-nav-active shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]'
                      : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]',
                  )}
                >
                  {item.icon}
                  {item.id === 'companion' && companionConnected && <span data-testid="mobile-companion-connected-dot" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400" />}
                  {item.id === 'settings' && updateReminder && <span data-testid="mobile-settings-update-dot" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--workspace-accent-text)]" />}
                  {item.id === 'terminal' && sessionCount > 0 && (
                    <span className="absolute -right-0.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--workspace-status-bad)] px-1 text-[9px] font-bold text-white">{sessionCount}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </nav>
    )
  }
  return (
    <nav data-testid="mobile-bottom-nav" className="fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] backdrop-blur-xl supports-[backdrop-filter]:bg-[var(--workspace-nav-translucent)] md:hidden">
      <div className="mx-auto grid max-w-xl grid-cols-5 px-1" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {MOBILE_TABS.map((item) => {
          const isActive = item.id === 'tools' ? isToolPage(activeNav) : activeNav === item.id
          return (
            <button key={item.id} type="button" aria-current={isActive ? 'page' : undefined} onClick={() => onNavChange(item.id)}
              className={cn('relative flex flex-col items-center gap-1 pb-1.5 pt-2 text-[10px] font-medium transition-colors', isActive ? 'text-workspace-nav-active' : 'text-workspace-nav')}>
              <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-[var(--workspace-nav-active-bg)]')}>{item.icon}</span>
              <span>{t(item.labelKey)}</span>
              {item.id === 'companion' && companionConnected && <span data-testid="mobile-companion-connected-dot" className="absolute right-[calc(50%-1.1rem)] top-2 h-2 w-2 rounded-full bg-emerald-400" />}
              {item.id === 'settings' && updateReminder && <span data-testid="mobile-settings-update-dot" className="absolute right-[calc(50%-1.1rem)] top-2 h-2 w-2 rounded-full bg-[var(--workspace-accent-text)]" />}
              {item.id === 'terminal' && sessionCount > 0 && (
                <span className="absolute right-[calc(50%-1.4rem)] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--workspace-status-bad)] px-1 text-[9px] font-bold text-white">{sessionCount}</span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
