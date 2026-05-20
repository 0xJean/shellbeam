import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WorkspacePanelHeaderProps {
  preheader?: ReactNode
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  toolbar?: ReactNode
  children?: ReactNode
  className?: string
  preheaderClassName?: string
  headerClassName?: string
  eyebrowClassName?: string
  titleClassName?: string
  descriptionClassName?: string
  noteClassName?: string
  actionsClassName?: string
  toolbarClassName?: string
  contentClassName?: string
}

export function WorkspacePanelHeader({
  preheader,
  eyebrow,
  title,
  description,
  note,
  actions,
  toolbar,
  children,
  className,
  preheaderClassName,
  headerClassName,
  eyebrowClassName,
  titleClassName,
  descriptionClassName,
  noteClassName,
  actionsClassName,
  toolbarClassName,
  contentClassName,
}: WorkspacePanelHeaderProps) {
  const hasActions = Boolean(actions)

  return (
    <section className={cn('border-b border-border pb-4', className)}>
      {preheader && (
        <div className={cn('mb-4', preheaderClassName)}>
          {preheader}
        </div>
      )}
      <div className={cn('flex flex-col gap-4', hasActions && 'lg:flex-row lg:items-start lg:justify-between', headerClassName)}>
        <div className="min-w-0">
          {eyebrow && (
            <div className={cn('flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground', eyebrowClassName)}>
              {eyebrow}
            </div>
          )}
          <h2 className={cn('mt-2 text-2xl font-semibold tracking-tight text-foreground', titleClassName)}>
            {title}
          </h2>
          {description && (
            <div className={cn('mt-1 max-w-3xl text-sm text-muted-foreground', descriptionClassName)}>
              {description}
            </div>
          )}
          {note && (
            <div className={cn('mt-2 text-xs text-muted-foreground', noteClassName)}>
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
      {toolbar && (
        <div className={cn('mt-4', toolbarClassName)}>
          {toolbar}
        </div>
      )}
      {children && (
        <div className={cn('mt-4', contentClassName)}>
          {children}
        </div>
      )}
    </section>
  )
}
