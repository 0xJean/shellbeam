import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  ActivitySquare,
  Files,
  FolderKanban,
  LayoutGrid,
  ScrollText,
  SquareTerminal,
} from 'lucide-react'

const APPS: Array<{ id: WorkspaceAppId; labelKey: string; icon: typeof LayoutGrid; accent: string; glow: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview', icon: LayoutGrid, accent: 'from-sky-400 to-blue-600 text-white', glow: 'shadow-sky-500/30' },
  { id: 'files', labelKey: 'workspace.app.files', icon: FolderKanban, accent: 'from-amber-300 to-orange-500 text-white', glow: 'shadow-amber-500/30' },
  { id: 'processes', labelKey: 'workspace.app.processes', icon: ActivitySquare, accent: 'from-emerald-400 to-green-600 text-white', glow: 'shadow-emerald-500/30' },
  { id: 'services', labelKey: 'workspace.app.services', icon: Files, accent: 'from-indigo-400 to-violet-600 text-white', glow: 'shadow-indigo-500/30' },
  { id: 'logs', labelKey: 'workspace.app.logs', icon: ScrollText, accent: 'from-rose-400 to-pink-600 text-white', glow: 'shadow-rose-500/30' },
  { id: 'terminal', labelKey: 'workspace.app.terminal', icon: SquareTerminal, accent: 'from-slate-500 to-slate-800 text-white', glow: 'shadow-slate-500/30' },
]

interface WorkspaceAppGridProps {
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
  variant?: 'panel' | 'desktop' | 'mobile'
  apps?: WorkspaceAppId[]
}

export function WorkspaceAppGrid({ activeApp, onSelectApp, variant = 'panel', apps }: WorkspaceAppGridProps) {
  const visibleApps = apps ? APPS.filter((app) => apps.includes(app.id)) : APPS

  return (
    <div
      className={cn(
        'grid gap-3',
        variant === 'mobile'
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
            variant === 'mobile'
              ? 'flex flex-col items-center gap-2 rounded-[26px] px-2 py-2'
              : variant === 'desktop'
                ? 'flex w-24 flex-col items-center gap-2 rounded-2xl px-2 py-2 hover:bg-white/20'
                : 'rounded-2xl border px-4 py-4',
            activeApp === app.id
              ? variant === 'panel'
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'text-foreground scale-[1.02]'
              : variant === 'panel'
                ? 'border-border/60 bg-card/70 hover:bg-muted/50'
                : 'text-foreground/90 hover:text-foreground',
          )}
          aria-label={label}
        >
          <div
            className={cn(
              'relative flex items-center justify-center overflow-hidden shadow-lg',
              variant === 'mobile'
                ? 'h-14 w-14 rounded-[18px]'
                : variant === 'desktop'
                  ? 'h-16 w-16 rounded-[18px]'
                  : 'h-12 w-12 rounded-2xl',
              variant === 'panel'
                ? 'bg-muted'
                : `bg-gradient-to-br ${app.accent} ${app.glow}`,
              activeApp === app.id && variant !== 'panel' && 'ring-2 ring-white/80',
            )}
          >
            {variant !== 'panel' && (
              <div className="absolute inset-x-2 top-1 h-4 rounded-full bg-white/20 blur-sm" />
            )}
            <Icon className={cn(variant === 'mobile' ? 'h-7 w-7' : 'h-6 w-6')} />
          </div>
          <div className={cn(variant === 'panel' ? 'mt-3' : 'text-center')}>
            <div className={cn('font-semibold', variant === 'mobile' ? 'text-[11px] text-slate-900' : variant === 'desktop' ? 'text-[12px] leading-4 text-white [text-shadow:0_1px_2px_rgba(15,23,42,0.45)]' : 'text-sm')}>{label}</div>
            {variant === 'panel' && (
              <div className="mt-1 text-xs text-muted-foreground">{t('workspace.action.openApp', { app: label.toLowerCase() })}</div>
            )}
          </div>
        </button>
        )
      })}
    </div>
  )
}
