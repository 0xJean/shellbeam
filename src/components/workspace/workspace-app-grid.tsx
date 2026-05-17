import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  ActivitySquare,
  Boxes,
  Files,
  FolderKanban,
  LayoutGrid,
  Network,
  ScrollText,
  SquareTerminal,
} from 'lucide-react'

const APPS: Array<{ id: WorkspaceAppId; labelKey: string; icon: typeof LayoutGrid; accent: string; glow: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview', icon: LayoutGrid, accent: 'from-[#55adff] via-[var(--workspace-primary-500)] to-[#0c4578] text-white', glow: 'shadow-[0_18px_34px_rgba(19,127,236,0.35)]' },
  { id: 'assetInventory', labelKey: 'workspace.app.assetInventory', icon: Network, accent: 'from-[#7dd3fc] via-[#2563eb] to-[#0f172a] text-white', glow: 'shadow-[0_18px_34px_rgba(37,99,235,0.28)]' },
  { id: 'files', labelKey: 'workspace.app.files', icon: FolderKanban, accent: 'from-[#7cbcff] via-[#2f8cf0] to-[#173755] text-white', glow: 'shadow-[0_18px_34px_rgba(52,123,196,0.28)]' },
  { id: 'processes', labelKey: 'workspace.app.processes', icon: ActivitySquare, accent: 'from-[#4ecf89] via-[#1a8e5a] to-[#103d31] text-white', glow: 'shadow-[0_18px_34px_rgba(34,197,94,0.22)]' },
  { id: 'services', labelKey: 'workspace.app.services', icon: Files, accent: 'from-[#62b5ff] via-[#2563eb] to-[#172554] text-white', glow: 'shadow-[0_18px_34px_rgba(37,99,235,0.26)]' },
  { id: 'toolManager', labelKey: 'workspace.app.toolManager', icon: Boxes, accent: 'from-[#73d7f7] via-[#0891b2] to-[#164e63] text-white', glow: 'shadow-[0_18px_34px_rgba(14,165,233,0.24)]' },
  { id: 'logs', labelKey: 'workspace.app.logs', icon: ScrollText, accent: 'from-[#93c5fd] via-[#2563eb] to-[#111827] text-white', glow: 'shadow-[0_18px_34px_rgba(59,130,246,0.2)]' },
  { id: 'terminal', labelKey: 'workspace.app.terminal', icon: SquareTerminal, accent: 'from-[#526579] via-[#1f2d3a] to-[#0c1117] text-white', glow: 'shadow-[0_18px_34px_rgba(15,23,42,0.3)]' },
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
                ? 'h-[60px] w-[60px] rounded-[14px] shadow-md bg-gradient-to-br ring-1 ring-white/10 inset-0'
                : variant === 'ios-dock'
                  ? 'h-[52px] w-[52px] rounded-[12px] shadow-sm bg-gradient-to-br ring-1 ring-white/10'
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
              <div className="absolute inset-x-2 top-1 h-4 rounded-full bg-white/24 blur-sm" />
            )}
            <Icon
              className={cn(
                variant === 'ios-grid' ? 'h-8 w-8 text-white drop-shadow-sm' :
                variant === 'ios-dock' ? 'h-7 w-7 text-white drop-shadow-sm' :
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
                  variant === 'ios-grid' ? 'text-[11px] text-white drop-shadow-md tracking-wide' : 
                  variant === 'mobile' ? 'text-[11px] text-slate-900' : 
                  variant === 'desktop' ? 'text-[12px] leading-4 text-[var(--workspace-text-strong)] [text-shadow:0_1px_2px_rgba(15,23,42,0.55)]' : 'text-sm'
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
