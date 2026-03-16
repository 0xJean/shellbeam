import type { WorkspaceAppId } from '@/lib/workspace'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const APPS: Array<{ id: WorkspaceAppId; labelKey: string }> = [
  { id: 'overview', labelKey: 'workspace.app.overview' },
  { id: 'files', labelKey: 'workspace.app.files' },
  { id: 'processes', labelKey: 'workspace.app.processes' },
  { id: 'services', labelKey: 'workspace.app.services' },
  { id: 'logs', labelKey: 'workspace.app.logs' },
  { id: 'terminal', labelKey: 'workspace.app.terminal' },
]

interface WorkspaceAppGridProps {
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceAppGrid({ activeApp, onSelectApp }: WorkspaceAppGridProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {APPS.map((app) => {
        const label = t(app.labelKey)
        return (
        <button
          key={app.id}
          type="button"
          onClick={() => onSelectApp(app.id)}
          className={cn(
            'rounded-2xl border px-4 py-4 text-left transition-colors',
            activeApp === app.id
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border/60 bg-card/70 hover:bg-muted/50',
          )}
          aria-label={label}
        >
          <div className="text-sm font-semibold">{label}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t('workspace.action.openApp', { app: label.toLowerCase() })}</div>
        </button>
        )
      })}
    </div>
  )
}
