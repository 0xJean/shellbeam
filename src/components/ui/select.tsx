import * as React from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  icon?: React.ReactNode
  description?: React.ReactNode
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

export function Select({ value, onChange, options, placeholder, className, disabled }: SelectProps) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number; direction: 'down' | 'up' }>({ top: 0, left: 0, width: 0, direction: 'down' })

  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  React.useEffect(() => {
    if (!open || !triggerRef.current) return
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const listHeight = Math.min(options.length * 34 + 8, 240)
      const goUp = spaceBelow < listHeight && spaceAbove > spaceBelow
      setPos({
        top: goUp ? rect.top - listHeight - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        direction: goUp ? 'up' : 'down',
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, options.length])

  const selected = options.find((o) => o.value === value)

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors',
          'hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'ring-2 ring-ring',
        )}
      >
        <span className={cn('min-w-0 truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder ?? t('common.select')}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          className="fixed z-[9999] max-h-60 overflow-auto rounded-md border bg-card p-1 shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                opt.value === value && 'bg-accent/50 font-medium',
              )}
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', opt.value === value ? 'opacity-100' : 'opacity-0')} />
              {opt.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{opt.label}</span>
                {opt.description && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{opt.description}</span>}
              </span>
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">{t('common.noOptions')}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
