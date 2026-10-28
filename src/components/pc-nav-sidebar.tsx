import {
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
  Clock,
  Network,
  SquareTerminal,
  BookOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { isToolPage } from '@/lib/mobile-navigation'
import logoSrc from '@/assets/logo.png'

export type SidebarNavId =
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

interface PcNavSidebarProps {
  activeNav: SidebarNavId
  onNavChange: (nav: SidebarNavId) => void
}

export function PcNavSidebar({ activeNav, onNavChange }: PcNavSidebarProps) {
  const { t } = useT()

  return (
    <aside className="hidden w-44 shrink-0 flex-col border-r border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] md:flex">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <img src={logoSrc} alt="ShellBeam" className="h-7 w-7 rounded-md" />
        <span className="text-sm font-semibold tracking-tight text-[var(--workspace-text-strong)]">ShellBeam</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pt-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            data-testid={`pc-nav-${item.id}`}
            type="button"
            onClick={() => onNavChange(item.id)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeNav === item.id
                ? 'bg-[var(--workspace-nav-active-bg)] font-medium text-workspace-nav-active'
                : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
            )}
          >
            {item.icon}
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <div className="space-y-0.5 border-t border-[color:var(--workspace-border-soft)] px-2 py-2">
        {SYSTEM_ITEMS.map((item) => (
          <button
            key={item.id}
            data-testid={`pc-nav-${item.id}`}
            type="button"
            onClick={() => onNavChange(item.id)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeNav === item.id
                ? 'bg-[var(--workspace-nav-active-bg)] font-medium text-workspace-nav-active'
                : 'text-workspace-nav hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-nav-hover-text)]'
            )}
          >
            {item.icon}
            {t(item.labelKey)}
          </button>
        ))}
      </div>
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
