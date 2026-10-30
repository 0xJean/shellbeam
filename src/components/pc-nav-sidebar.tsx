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
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { isToolPage } from '@/lib/mobile-navigation'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
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
  { id: 'backup', labelKey: 'nav.backup', icon: <Archive className="h-4 w-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="h-4 w-4" /> },
]


// Five fixed tabs, no "More": everything else is reached from Tools.
const MOBILE_TABS: NavItem[] = [
  { id: 'hosts', labelKey: 'nav.hosts', icon: <Server className="h-5 w-5" /> },
  { id: 'terminal', labelKey: 'nav.sessions', icon: <SquareTerminal className="h-5 w-5" /> },
  { id: 'sftp', labelKey: 'nav.files', icon: <FolderOpen className="h-5 w-5" /> },
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
const FOOTER_IDS: SidebarNavId[] = ['sync', 'guide', 'settings']
const itemById = (id: SidebarNavId) => [...NAV_ITEMS, ...SYSTEM_ITEMS].find((item) => item.id === id)!

export function PcNavSidebar({ activeNav, onNavChange, vault, counts, onOpenSearch }: PcNavSidebarProps) {
  const { t, locale } = useT()
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false)
  const meta = (id: SidebarNavId): ReactNode => {
    if (id === 'hosts' && counts?.hosts) return <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{counts.hosts}</span>
    if (id === 'snippets' && counts?.snippets) return <span className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{counts.snippets}</span>
    if (id === 'port-forwarding' && counts?.forwardsRunning) return <span className="text-[11px] text-[color:var(--workspace-status-good-text)]">{t('nav.forwardsRunning', { count: counts.forwardsRunning })}</span>
    return null
  }
  const item = (id: SidebarNavId) => {
    const nav = itemById(id)
    const active = activeNav === id || (id === 'sync' && activeNav === 'backup')
    return (
      <button key={id} data-testid={`pc-nav-${id}`} type="button" aria-current={active ? 'page' : undefined} onClick={() => onNavChange(id)}
        className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
          active ? 'bg-[var(--workspace-nav-active-bg)] font-medium text-workspace-nav-active shadow-[inset_0_0_0_1px_var(--workspace-border-soft)]' : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]')}>
        <span className="shrink-0 [&_svg]:h-4 [&_svg]:w-4">{nav.icon}</span>
        <span className="min-w-0 flex-1 truncate">{id === 'sync' ? (syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']).navLabel : t(nav.labelKey)}</span>
        {meta(id)}
      </button>
    )
  }
  const group = (titleKey: string, ids: SidebarNavId[]) => (
    <div className="space-y-0.5">
      <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{t(titleKey)}</div>
      {ids.map(item)}
    </div>
  )

  return (
    <aside data-testid="pc-nav-sidebar" className="hidden w-56 shrink-0 flex-col border-r border-[color:var(--workspace-border-soft)] bg-[var(--workspace-nav-translucent)] md:flex">
      <div className="relative px-3 pb-2 pt-3">
        <button type="button" data-testid="pc-nav-vault" aria-haspopup="menu" aria-expanded={vaultMenuOpen} disabled={!vault} onClick={() => setVaultMenuOpen((open) => !open)}
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors enabled:hover:bg-[var(--workspace-nav-hover-bg)]">
          <img src={logoSrc} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-tight tracking-tight text-[var(--workspace-text-strong)]">ShellBeam</span>
            {vault && <span className="block truncate text-[11px] text-[var(--workspace-text-muted)]">{vault.name}</span>}
          </span>
          {vault && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />}
        </button>
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
              <button type="button" role="menuitem" onClick={() => { setVaultMenuOpen(false); vault.onManage() }} className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]">{t('nav.manageVaults')}</button>
            </div>
          </>
        )}
        {onOpenSearch && (
          <button type="button" data-testid="pc-nav-search" onClick={onOpenSearch}
            className="mt-2 flex h-8 w-full items-center gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] px-2.5 text-[12px] text-[var(--workspace-text-subtle)] transition-colors hover:border-[color:var(--workspace-border-strong)]">
            <Search className="h-3.5 w-3.5" /><span className="flex-1 text-left">{t('nav.search')}</span>
            <kbd className="rounded border border-[color:var(--workspace-border-soft)] px-1 font-sans text-[10px]">⌘K</kbd>
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {group('nav.groupWorkspace', WORKSPACE_IDS)}
        {group('nav.groupLibrary', LIBRARY_IDS)}
      </nav>

      <div className="space-y-0.5 border-t border-[color:var(--workspace-border-soft)] px-2 py-2">{FOOTER_IDS.map(item)}</div>
      {vault && (
        <div data-testid="pc-nav-vault-status" className="mx-3 mb-3 flex items-center gap-2.5 rounded-lg bg-[var(--workspace-surface-800)] px-3 py-2">
          {vault.unlocked ? <LockOpen className="h-4 w-4 shrink-0 text-[color:var(--workspace-status-good)]" /> : <Lock className="h-4 w-4 shrink-0 text-[var(--workspace-text-muted)]" />}
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-[var(--workspace-text-strong)]">{vault.unlocked ? t('nav.vaultUnlocked') : t('nav.vaultLocked')}</span>
            {vault.unlocked && <span className="block truncate text-[11px] text-[var(--workspace-text-muted)]">{t('nav.autoLockHint', { minutes: vault.autoLockMinutes })}</span>}
          </span>
          {vault.unlocked && <button type="button" data-testid="pc-nav-lock" aria-label={t('nav.lockNow')} title={t('nav.lockNow')} onClick={vault.onLock} className="rounded-md p-1 text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]"><Lock className="h-3.5 w-3.5" /></button>}
        </div>
      )}
    </aside>
  )
}

interface MobileBottomNavProps {
  activeNav: SidebarNavId
  onNavChange: (nav: SidebarNavId) => void
  sessionCount?: number
}

export function MobileBottomNav({ activeNav, onNavChange, sessionCount = 0 }: MobileBottomNavProps) {
  const { t } = useT()
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
