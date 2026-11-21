import { cn } from '@/lib/utils'
import type { KeyboardEventHandler, PointerEventHandler } from 'react'

export interface PanelResizeHandleProps {
  label: string
  dragging?: boolean
  testId?: string
  className?: string
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onDoubleClick?: () => void
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  'aria-valuemin'?: number
  'aria-valuemax'?: number
  'aria-valuenow'?: number
}

/**
 * Interactive vertical divider between desktop panels.
 * Uses a wider invisible hit zone (`w-2`) over a crisp 1px visual rule so it is effortless
 * to grab, highlights on hover/drag, supports keyboard arrows, and resets on double-click.
 */
export function PanelResizeHandle({
  label,
  dragging = false,
  testId,
  className,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
  'aria-valuemin': ariaValueMin,
  'aria-valuemax': ariaValueMax,
  'aria-valuenow': ariaValueNow,
}: PanelResizeHandleProps) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      aria-valuenow={ariaValueNow}
      data-testid={testId}
      data-dragging={dragging ? 'true' : 'false'}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative z-20 flex w-1.5 shrink-0 cursor-col-resize select-none items-center justify-center touch-none focus-visible:outline-none',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none h-full w-px transition-all duration-150',
          dragging
            ? 'w-[2px] bg-[var(--workspace-primary-500)]'
            : 'bg-[color:var(--workspace-border-soft)] group-hover:w-[2px] group-hover:bg-[var(--workspace-primary-500)] group-focus-visible:w-[2px] group-focus-visible:bg-[var(--workspace-primary-500)]',
        )}
      />
    </div>
  )
}
