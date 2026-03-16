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

const APPS: Array<{ id: WorkspaceAppId; labelKey: string; icon: typeof LayoutGrid; accent: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview', icon: LayoutGrid, accent: 'bg-sky-500/15 text-sky-600' },
  { id: 'files', labelKey: 'workspace.app.files', icon: FolderKanban, accent: 'bg-amber-500/15 text-amber-600' },
  { id: 'processes', labelKey: 'workspace.app.processes', icon: ActivitySquare, accent: 'bg-emerald-500/15 text-emerald-600' },
  { id: 'services', labelKey: 'workspace.app.services', icon: Files, accent: 'bg-indigo-500/15 text-indigo-600' },
  { id: 'logs', labelKey: 'workspace.app.logs', icon: ScrollText, accent: 'bg-rose-500/15 text-rose-600' },
  { id: 'terminal', labelKey: 'workspace.app.terminal', icon: SquareTerminal, accent: 'bg-slate-500/15 text-slate-700' },
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
        variant === 'mobile' ? 'grid-cols-4' : 'sm:grid-cols-2 xl:grid-cols-3',
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
            'text-left transition-colors',
            variant === 'mobile'
              ? 'flex flex-col items-center gap-2 rounded-[26px] px-2 py-2'
              : variant === 'desktop'
                ? 'flex flex-col items-center gap-3 rounded-2xl px-3 py-3'
                : 'rounded-2xl border px-4 py-4',
            activeApp === app.id
              ? variant === 'panel'
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'text-foreground'
              : variant === 'panel'
                ? 'border-border/60 bg-card/70 hover:bg-muted/50'
                : 'text-foreground/90 hover:text-foreground',
          )}
          aria-label={label}
        >
          <div
            className={cn(
              'flex items-center justify-center shadow-sm',
              variant === 'mobile'
                ? 'h-14 w-14 rounded-[18px]'
                : variant === 'desktop'
                  ? 'h-16 w-16 rounded-2xl border border-white/30 bg-white/75 backdrop-blur'
                  : 'h-12 w-12 rounded-2xl',
              app.accent,
              activeApp === app.id && variant !== 'panel' && 'ring-2 ring-primary/30',
            )}
          >
            <Icon className={cn(variant === 'mobile' ? 'h-7 w-7' : 'h-6 w-6')} />
          </div>
          <div className={cn(variant === 'panel' ? 'mt-3' : 'text-center')}>
            <div className={cn('font-semibold', variant === 'mobile' ? 'text-[11px]' : 'text-sm')}>{label}</div>
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
