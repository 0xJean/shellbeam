import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WorkspacePanelHeaderProps {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  headerClassName?: string
  eyebrowClassName?: string
  titleClassName?: string
  descriptionClassName?: string
  noteClassName?: string
  actionsClassName?: string
  contentClassName?: string
}

export function WorkspacePanelHeader({
  eyebrow,
  title,
  description,
  note,
  actions,
  children,
  className,
  headerClassName,
  eyebrowClassName,
  titleClassName,
  descriptionClassName,
  noteClassName,
  actionsClassName,
  contentClassName,
}: WorkspacePanelHeaderProps) {
  const hasActions = Boolean(actions)

  return (
    <section className={cn('border-b border-[color:var(--workspace-border-strong)] pb-4', className)}>
      <div className={cn('flex flex-col gap-4', hasActions && 'lg:flex-row lg:items-start lg:justify-between', headerClassName)}>
        <div className="min-w-0">
          {eyebrow && (
            <div className={cn('flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-subtle)]', eyebrowClassName)}>
              {eyebrow}
            </div>
          )}
          <h2 className={cn('mt-2 text-2xl font-semibold tracking-tight text-[var(--workspace-text-strong)]', titleClassName)}>
            {title}
          </h2>
          {description && (
            <div className={cn('mt-1 max-w-3xl text-sm text-[var(--workspace-text-muted)]', descriptionClassName)}>
              {description}
            </div>
          )}
          {note && (
            <div className={cn('mt-2 text-xs text-[var(--workspace-text-subtle)]', noteClassName)}>
              {note}
            </div>
          )}
        </div>
        {actions && (
          <div className={cn('flex shrink-0 flex-wrap items-center gap-2', actionsClassName)}>
            {actions}
          </div>
        )}
      </div>
      {children && (
        <div className={cn('mt-4', contentClassName)}>
          {children}
        </div>
      )}
    </section>
  )
}
