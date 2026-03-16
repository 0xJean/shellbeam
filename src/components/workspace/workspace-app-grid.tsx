import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'

const APPS: Array<{ id: WorkspaceAppId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'processes', label: 'Processes' },
  { id: 'services', label: 'Services' },
  { id: 'logs', label: 'Logs' },
  { id: 'terminal', label: 'Terminal' },
]

interface WorkspaceAppGridProps {
  activeApp: WorkspaceAppId
  onSelectApp: (app: WorkspaceAppId) => void
}

export function WorkspaceAppGrid({ activeApp, onSelectApp }: WorkspaceAppGridProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {APPS.map((app) => (
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
          aria-label={app.label}
        >
          <div className="text-sm font-semibold">{app.label}</div>
          <div className="mt-1 text-xs text-muted-foreground">Open {app.label.toLowerCase()}</div>
        </button>
      ))}
    </div>
  )
}
