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
  Ellipsis,
  Clock,
  Network,
  SquareTerminal,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
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
  { id: 'sync', labelKey: 'nav.sync', icon: <RefreshCw className="h-4 w-4" /> },
  { id: 'backup', labelKey: 'nav.backup', icon: <Archive className="h-4 w-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="h-4 w-4" /> },
]

const ALL_ITEMS = [...NAV_ITEMS, ...SYSTEM_ITEMS]

const MOBILE_PRIMARY: SidebarNavId[] = ['hosts', 'terminal', 'sftp', 'settings']

const MOBILE_TERMINAL_ITEM: NavItem = {
  id: 'terminal',
  labelKey: 'nav.terminal',
  icon: <SquareTerminal className="h-4 w-4" />,
}

interface PcNavSidebarProps {
  activeNav: SidebarNavId
  onNavChange: (nav: SidebarNavId) => void
}

export function PcNavSidebar({ activeNav, onNavChange }: PcNavSidebarProps) {
  const { t } = useT()

  return (
    <aside className="hidden w-44 shrink-0 flex-col border-r border-border/50 bg-muted/20 md:flex">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <img src={logoSrc} alt="ShellBeam" className="h-7 w-7 rounded-md" />
        <span className="text-sm font-semibold tracking-tight">ShellBeam</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pt-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavChange(item.id)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeNav === item.id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            {item.icon}
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      <div className="space-y-0.5 border-t border-border/50 px-2 py-2">
        {SYSTEM_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavChange(item.id)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
              activeNav === item.id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
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
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
      <div className="mx-auto flex items-center justify-around px-1" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {MOBILE_PRIMARY.map((id) => {
          const item = id === 'terminal' ? MOBILE_TERMINAL_ITEM : ALL_ITEMS.find((i) => i.id === id)!
          const isActive = activeNav === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => { onNavChange(id); setMoreOpen(false) }}
              className={cn(
                'relative flex flex-col items-center gap-0.5 px-3 py-2.5 text-[10px] transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {item.icon}
              <span>{t(item.labelKey)}</span>
              {id === 'terminal' && sessionCount > 0 && (
                <span className="absolute -top-0.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                  {sessionCount}
                </span>
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-2.5 text-[10px] transition-colors',
            moreOpen || !MOBILE_PRIMARY.includes(activeNav)
              ? 'text-primary'
              : 'text-muted-foreground',
          )}
        >
          <Ellipsis className="h-4 w-4" />
          <span>{t('nav.more')}</span>
        </button>
      </div>

      {/* More panel */}
      {moreOpen && (
        <>
          <div className="fixed inset-0 z-[-1]" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-full border-t border-border bg-background p-2 shadow-lg">
            <div className="mx-auto grid max-w-md grid-cols-4 gap-1">
              {ALL_ITEMS.filter((i) => !MOBILE_PRIMARY.includes(i.id) && i.id !== 'terminal').map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { onNavChange(item.id); setMoreOpen(false) }}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-[11px] transition-colors',
                    activeNav === item.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {item.icon}
                  <span className="truncate">{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </nav>
  )
}
