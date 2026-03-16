import type { SessionWorkspaceMode } from '@/lib/workspace'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface WorkspaceModeToggleProps {
  mode: SessionWorkspaceMode
  onChange: (mode: SessionWorkspaceMode) => void
  compact?: boolean
}

export function WorkspaceModeToggle({ mode, onChange, compact = false }: WorkspaceModeToggleProps) {
  return (
    <div className={cn('inline-flex rounded-lg border border-border/60 bg-muted/30 p-1', compact && 'rounded-md p-0.5')}>
      <button
        type="button"
        onClick={() => onChange('terminal')}
        className={cn(
          'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
          compact && 'px-2.5 py-1 text-[11px]',
          mode === 'terminal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {t('workspace.mode.terminal')}
      </button>
      <button
        type="button"
        onClick={() => onChange('workspace')}
        className={cn(
          'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
          compact && 'px-2.5 py-1 text-[11px]',
          mode === 'workspace' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {t('workspace.mode.workspace')}
      </button>
    </div>
  )
}
