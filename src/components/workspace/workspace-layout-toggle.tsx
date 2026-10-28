import { AppWindow, List } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { WorkspaceLayout } from '@/lib/workspace-layout'

/** Switches the PC workspace between the list layout (default) and the windowed desktop. */
export function WorkspaceLayoutToggle({ layout, onChange }: { layout: WorkspaceLayout; onChange: (layout: WorkspaceLayout) => void }) {
  const { t } = useT()
  return (
    <div role="radiogroup" aria-label={t('workspace.layout.label')} className="inline-flex shrink-0 gap-0.5 rounded-lg bg-[var(--workspace-surface-800)] p-0.5 shadow-sm">
      {([['list', List], ['desktop', AppWindow]] as const).map(([key, Icon]) => (
        <button key={key} type="button" role="radio" aria-checked={layout === key} data-testid={`workspace-layout-${key}`} onClick={() => onChange(key)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
            layout === key ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />{t(`workspace.layout.${key}`)}
        </button>
      ))}
    </div>
  )
}
