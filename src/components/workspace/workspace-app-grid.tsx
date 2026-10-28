import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  ActivitySquare,
  AppWindow,
  ChartSpline,
  Container,
  Cpu,
  LayoutDashboard,
  LockKeyhole,
  Wrench,
  Boxes,
  Box,
  CalendarClock,
  Files,
  FolderTree,
  FolderKanban,
  Globe,
  LayoutGrid,
  Network,
  ChartLine,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react'

const APPS: Array<{ id: WorkspaceAppId; labelKey: string; icon: typeof LayoutGrid; accent: string; glow: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview', icon: LayoutGrid, accent: 'from-[var(--workspace-primary-300)] via-[var(--workspace-primary-500)] to-[var(--workspace-accent-text)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-cpu-glow)]' },
  { id: 'assetInventory', labelKey: 'workspace.app.assetInventory', icon: Network, accent: 'from-[var(--workspace-primary-300)] via-[var(--workspace-primary-500)] to-[var(--workspace-accent-text)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-network-glow)]' },
  { id: 'fileTransfer', labelKey: 'workspace.app.fileTransfer', icon: FolderKanban, accent: 'from-[var(--workspace-primary-300)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-network-glow)]' },
  { id: 'fileSystem', labelKey: 'workspace.app.fileSystem', icon: FolderTree, accent: 'from-[var(--workspace-metric-memory-from)] via-[var(--workspace-status-good)] to-[var(--workspace-metric-memory-to)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-memory-glow)]' },
  { id: 'charts', labelKey: 'workspace.app.charts', icon: ChartLine, accent: 'from-[var(--workspace-metric-memory-from)] via-[var(--workspace-status-good)] to-[var(--workspace-metric-memory-to)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-memory-glow)]' },
  { id: 'processes', labelKey: 'workspace.app.processes', icon: ActivitySquare, accent: 'from-[var(--workspace-metric-memory-from)] via-[var(--workspace-status-good)] to-[var(--workspace-metric-memory-to)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-memory-glow)]' },
  { id: 'services', labelKey: 'workspace.app.services', icon: Files, accent: 'from-[var(--workspace-primary-300)] via-[var(--workspace-primary-500)] to-[var(--workspace-accent-text)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-cpu-glow)]' },
  { id: 'network', labelKey: 'workspace.network.title', icon: Network, accent: 'from-[var(--workspace-status-info)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[var(--workspace-metric-network-glow)]' },
  { id: 'toolManager', labelKey: 'workspace.app.toolManager', icon: Boxes, accent: 'from-[var(--workspace-status-info)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-network-glow)]' },
  { id: 'logs', labelKey: 'workspace.app.logs', icon: ScrollText, accent: 'from-[var(--workspace-primary-300)] via-[var(--workspace-primary-500)] to-[var(--workspace-accent-text)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-cpu-glow)]' },
  { id: 'browser', labelKey: 'workspace.app.browser', icon: Globe, accent: 'from-[var(--workspace-metric-disk-from)] via-[var(--workspace-status-warn)] to-[var(--workspace-metric-disk-to)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[0_18px_34px_var(--workspace-metric-disk-glow)]' },
  { id: 'terminal', labelKey: 'workspace.app.terminal', icon: SquareTerminal, accent: 'from-[var(--workspace-text-muted)] via-[var(--workspace-text)] to-[var(--workspace-text-strong)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[var(--workspace-shadow-overlay)]' },
  { id: 'docker', labelKey: 'workspace.app.docker', icon: Box, accent: 'from-[var(--workspace-status-info)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[var(--workspace-metric-network-glow)]' },
  { id: 'sitesSsl', labelKey: 'workspace.app.sitesSsl', icon: ShieldCheck, accent: 'from-[var(--workspace-status-good)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[var(--workspace-metric-memory-glow)]' },
  { id: 'scheduledTasks', labelKey: 'workspace.app.scheduledTasks', icon: CalendarClock, accent: 'from-[var(--workspace-status-warn)] via-[var(--workspace-primary-400)] to-[var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]', glow: 'shadow-[var(--workspace-metric-cpu-glow)]' },
]

interface WorkspaceAppGridProps {
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  variant?: 'panel' | 'desktop' | 'mobile' | 'ios-grid' | 'ios-dock'
  apps?: WorkspaceAppId[]
}

export function WorkspaceAppGrid({ activeApp, onSelectApp, variant = 'panel', apps }: WorkspaceAppGridProps) {
  const visibleApps = apps ? APPS.filter((app) => apps.includes(app.id)) : APPS

  return (
    <div
      className={cn(
        'grid gap-x-2 gap-y-4',
        variant === 'ios-grid'
          ? 'grid-cols-4 px-2'
          : variant === 'ios-dock'
            ? 'grid-cols-4 px-1 gap-2'
            : variant === 'mobile'
              ? 'grid-cols-4'
              : variant === 'desktop'
                ? 'grid-cols-1 justify-items-start'
                : 'sm:grid-cols-2 xl:grid-cols-3',
      )}
    >
      {visibleApps.map((app) => {
        const label = t(app.labelKey)
        const Icon = app.icon
        return (
        <button
          key={app.id}
          type="button"
          onClick={() => onSelectApp(app.id)}
          className={cn(
            'relative z-10 text-left transition-all',
            variant === 'ios-grid'
              ? 'flex flex-col items-center gap-1.5 active:scale-90 active:opacity-75'
              : variant === 'ios-dock'
                ? 'flex flex-col items-center active:scale-90 active:opacity-75'
                : variant === 'mobile'
                  ? 'flex flex-col items-center gap-2 rounded-[26px] px-2 py-2'
                  : variant === 'desktop'
                    ? 'group flex w-20 flex-col items-center gap-1 px-2 py-2'
                    : 'rounded-2xl border px-4 py-4',
            activeApp === app.id
              ? variant === 'panel'
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : variant === 'desktop'
                  ? 'text-[var(--workspace-text-strong)]'
                  : variant === 'ios-grid' || variant === 'ios-dock'
                    ? ''
                    : 'scale-[1.02] text-[var(--workspace-text-strong)]'
              : variant === 'panel'
                ? 'border-border/60 bg-card/70 hover:bg-muted/50'
                : variant === 'ios-grid' || variant === 'ios-dock'
                  ? ''
                  : 'text-[var(--workspace-text)] hover:text-[var(--workspace-text-strong)]',
          )}
          aria-label={label}
        >
          <div
            className={cn(
              'flex items-center justify-center transition-all',
              variant === 'ios-grid'
                ? 'h-[60px] w-[60px] rounded-[14px] shadow-md bg-gradient-to-br ring-1 ring-[var(--workspace-border-soft)]'
                : variant === 'ios-dock'
                  ? 'h-[52px] w-[52px] rounded-[12px] shadow-sm bg-gradient-to-br ring-1 ring-[var(--workspace-border-soft)]'
                  : variant === 'mobile'
                    ? 'relative h-14 w-14 overflow-hidden rounded-[18px] shadow-lg'
                    : variant === 'desktop'
                      ? 'h-12 w-12 rounded-lg border border-primary/20 bg-primary/10 group-hover:border-primary/50 group-hover:bg-primary/25'
                      : 'h-12 w-12 rounded-2xl bg-muted',
              (variant === 'mobile' || variant === 'ios-grid' || variant === 'ios-dock') && `${app.accent} ${app.glow}`,
              activeApp === app.id && variant === 'desktop' && 'border-primary/50 bg-primary/25',
              activeApp === app.id && variant === 'mobile' && 'ring-2 ring-[color:var(--workspace-border-glow)]',
            )}
          >
            {variant === 'mobile' && (
              <div className="absolute inset-x-2 top-1 h-4 rounded-full bg-[var(--workspace-surface-950)] opacity-25 blur-sm" />
            )}
            <Icon
              className={cn(
                variant === 'ios-grid' ? 'h-8 w-8 text-[var(--workspace-primary-foreground)] drop-shadow-sm' :
                variant === 'ios-dock' ? 'h-7 w-7 text-[var(--workspace-primary-foreground)] drop-shadow-sm' :
                variant === 'mobile' ? 'h-7 w-7' : 'h-6 w-6',
                variant === 'desktop' ? 'text-[color:var(--workspace-primary-400)]' : '',
              )}
            />
          </div>
          {variant !== 'ios-dock' && (
            <div className={cn(variant === 'panel' ? 'mt-3' : 'text-center w-full')}>
              <div 
                className={cn(
                  'font-semibold truncate w-full px-1', 
                  variant === 'ios-grid' ? 'text-[11px] text-[var(--workspace-primary-foreground)] drop-shadow-md tracking-wide' : 
                  variant === 'mobile' ? 'text-[11px] text-[var(--workspace-text-strong)]' : 
                  variant === 'desktop' ? 'text-[12px] leading-4 text-[var(--workspace-text-strong)] [text-shadow:0_1px_2px_var(--workspace-elevated-ring)]' : 'text-sm'
                )}
              >
                {label}
              </div>
              {variant === 'panel' && (
                <div className="mt-1 text-xs text-muted-foreground">{t('workspace.action.openApp', { app: label.toLowerCase() })}</div>
              )}
            </div>
          )}
        </button>
        )
      })}
    </div>
  )
}

/** v3 springboard tile: the app's gradient icon with an optional count badge. */
export function WorkspaceAppIcon({ app, size = 'lg', badge }: { app: WorkspaceAppId; size?: 'lg' | 'md' | 'sm'; badge?: number }) {
  const meta = APPS.find((entry) => entry.id === app)
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span
      data-testid={`workspace-app-icon-${app}`}
      className={cn(
        'relative flex shrink-0 items-center justify-center bg-gradient-to-br ring-1 ring-[var(--workspace-border-soft)]',
        size === 'lg' ? 'h-[60px] w-[60px] rounded-[14px] shadow-md' : size === 'md' ? 'h-[52px] w-[52px] rounded-[12px] shadow-sm' : 'h-[34px] w-[34px] rounded-[8px]',
        meta.accent,
      )}
    >
      <Icon aria-hidden="true" className={cn('text-[var(--workspace-primary-foreground)] drop-shadow-sm', size === 'lg' ? 'h-[30px] w-[30px]' : size === 'md' ? 'h-7 w-7' : 'h-[18px] w-[18px]')} />
      {badge ? (
        <em aria-hidden="true" className="absolute -right-[7px] -top-[6px] flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[var(--workspace-status-bad)] px-1.5 text-[13px] font-semibold not-italic text-[var(--workspace-primary-foreground)] shadow-sm">
          {badge > 99 ? '99+' : badge}
        </em>
      ) : null}
    </span>
  )
}

const LIST_ICONS: Partial<Record<WorkspaceAppId, typeof LayoutGrid>> = {
  terminal: SquareTerminal, browser: AppWindow, charts: ChartSpline, overview: LayoutDashboard, processes: Cpu, services: Boxes,
  network: Globe, logs: ScrollText, fileSystem: FolderTree, fileTransfer: FolderKanban, docker: Container, scheduledTasks: CalendarClock,
  sitesSsl: LockKeyhole, toolManager: Wrench, assetInventory: Network,
}

/** v3 list-layout groups: sessions, observation, then management tools. */
const LIST_GROUPS: Array<{ labelKey: string; apps: WorkspaceAppId[] }> = [
  { labelKey: 'workspace.nav.sessions', apps: ['terminal', 'browser'] },
  { labelKey: 'workspace.nav.observe', apps: ['charts', 'overview', 'processes', 'services', 'network', 'logs'] },
  { labelKey: 'workspace.nav.manage', apps: ['fileSystem', 'fileTransfer', 'docker', 'scheduledTasks', 'sitesSsl', 'toolManager', 'assetInventory'] },
]

/** Vertical app navigation for the workspace's list layout. */
export function WorkspaceAppList({ activeApp, onSelectApp }: { activeApp: WorkspaceAppId; onSelectApp: (app: WorkspaceAppId) => void }) {
  return (
    <nav data-testid="workspace-app-list" aria-label={t('workspace.layout.apps')} className="flex flex-col">
      {LIST_GROUPS.map((group) => (
        <div key={group.labelKey} className="flex flex-col gap-px">
          <div className="px-2.5 pb-1.5 pt-4 text-[11.5px] font-medium text-[var(--workspace-text-subtle)]">{t(group.labelKey)}</div>
          {group.apps.map((id) => {
            const app = APPS.find((entry) => entry.id === id)
            if (!app) return null
            const Icon = LIST_ICONS[id] ?? app.icon
            const active = activeApp === id
            return (
              <button key={id} type="button" aria-current={active ? 'page' : undefined} data-testid={`workspace-app-list-${id}`} onClick={() => onSelectApp(id)}
                className={cn('flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors',
                  active ? 'bg-[var(--workspace-nav-active-bg)] font-medium text-[var(--workspace-nav-active-text)]' : 'text-[var(--workspace-text)] hover:bg-[var(--workspace-nav-hover-bg)] hover:text-[var(--workspace-text-strong)]')}>
                <Icon className={cn('h-4 w-4 shrink-0', active ? '' : 'text-[var(--workspace-text-muted)]')} aria-hidden="true" />
                <span className="truncate">{t(app.labelKey)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
