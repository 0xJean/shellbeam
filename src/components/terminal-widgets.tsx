import { TERMINAL_THEMES } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'

export function FontSizeControl({ value, onChange }: {
  value: number
  onChange: (size: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(10, value - 1))}
        className="flex h-7 w-7 items-center justify-center rounded border text-sm hover:bg-muted"
      >−</button>
      <span className="w-8 text-center text-sm font-medium">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(24, value + 1))}
        className="flex h-7 w-7 items-center justify-center rounded border text-sm hover:bg-muted"
      >+</button>
    </div>
  )
}

export function TerminalThemeGrid({ currentThemeId, onSelect, columns }: {
  currentThemeId: string
  onSelect: (themeId: string) => void
  columns?: string
}) {
  return (
    <div className={columns ?? 'space-y-1.5'}>
      {TERMINAL_THEMES.map((thm) => (
        <button
          key={thm.id}
          type="button"
          onClick={() => onSelect(thm.id)}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-all',
            currentThemeId === thm.id
              ? 'border-primary ring-1 ring-primary'
              : 'border-border/50 hover:border-foreground/30',
          )}
        >
          <div
            className="flex h-8 w-14 shrink-0 items-center justify-center rounded"
            style={{ background: thm.theme.background }}
          >
            <span style={{ color: thm.theme.foreground, fontSize: 10, fontFamily: 'monospace' }}>Aa</span>
          </div>
          <span className="truncate text-xs font-medium">{thm.name}</span>
        </button>
      ))}
    </div>
  )
}
