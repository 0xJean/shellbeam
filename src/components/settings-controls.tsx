import { cn } from '@/lib/utils'
import { Info, Minus, Plus, type LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

export function SettingsHead({ title, description }: { title: string; description: string }) {
  return <div className="mb-1">
    <h2 className="text-xl font-semibold text-[var(--workspace-text-strong)]">{title}</h2>
    <p className="mt-0.5 text-sm text-[var(--workspace-text-subtle)]">{description}</p>
  </div>
}

export function SettingsGroup({ title, extra, children, className, cardClassName, testId }: {
  title: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; cardClassName?: string; testId?: string
}) {
  return <section className={cn('min-w-0', className)} data-testid={testId}>
    <h3 className="mb-2 ml-1 flex items-center justify-between gap-2 text-sm font-semibold text-[var(--workspace-text)]">
      <span className="flex items-center gap-2">{title}</span>{extra}
    </h3>
    <div className={cn('sb-card divide-y divide-[color:var(--workspace-border-soft)] overflow-hidden', cardClassName)}>{children}</div>
  </section>
}

export function SettingRow({ label, description, children, htmlFor, className }: {
  label: ReactNode; description?: ReactNode; children?: ReactNode; htmlFor?: string; className?: string
}) {
  const Label = htmlFor ? 'label' : 'div'
  return <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', className)}>
    <div className="min-w-0 flex-1 basis-48">
      <Label htmlFor={htmlFor} className="flex items-center gap-2 text-sm font-semibold text-[var(--workspace-text-strong)]">{label}</Label>
      {description && <p className="mt-0.5 text-xs text-[var(--workspace-text-subtle)]">{description}</p>}
    </div>
    {children !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
  </div>
}

export function SettingStepper({ value, onChange, min, max, step = 1, unit, id, label, decreaseLabel, increaseLabel, width = 'w-12' }: {
  value: number; onChange: (value: number) => void; min: number; max: number; step?: number; unit?: string
  id?: string; label?: string; decreaseLabel: string; increaseLabel: string; width?: string
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  return <div className="inline-flex h-8 items-center rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)]">
    <button type="button" aria-label={decreaseLabel} disabled={value <= min} onClick={() => onChange(clamp(value - step))}
      className="flex h-full w-8 items-center justify-center text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)] disabled:opacity-40"><Minus className="h-3 w-3" /></button>
    <input id={id} aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
      className={cn('h-full bg-transparent text-center font-mono text-sm text-[var(--workspace-text-strong)] outline-none [appearance:textfield] focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none', width)} />
    {unit && <span className="pr-1 text-xs text-[var(--workspace-text-muted)]">{unit}</span>}
    <button type="button" aria-label={increaseLabel} disabled={value >= max} onClick={() => onChange(clamp(value + step))}
      className="flex h-full w-8 items-center justify-center text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)] disabled:opacity-40"><Plus className="h-3 w-3" /></button>
  </div>
}

export function SettingSwitch({ className, ...props }: Omit<ComponentProps<'input'>, 'type' | 'role'>) {
  return <span className={cn('relative inline-flex h-5 w-9 shrink-0', className)}>
    <input {...props} type="checkbox" role="switch" className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    <span aria-hidden="true" className="h-5 w-9 rounded-full bg-[var(--workspace-surface-700)] transition-colors peer-checked:bg-[color:var(--workspace-primary-500)] peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50" />
    <span aria-hidden="true" className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4 peer-disabled:opacity-70" />
  </span>
}

export function SettingsNote({ children, icon: Icon = Info, className }: { children: ReactNode; icon?: LucideIcon; className?: string }) {
  return <p className={cn('flex items-start gap-2 px-1 text-xs leading-relaxed text-[var(--workspace-text-subtle)]', className)}>
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{children}</span>
  </p>
}

export function SegmentedChoice<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; onChange: (value: T) => void; label: string
}) {
  return <div role="group" aria-label={label} className="inline-flex rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] p-0.5">
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} disabled={option.disabled} onClick={() => onChange(option.value)}
      className={cn('inline-flex h-7 items-center rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        value === option.value ? 'bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-sm ring-1 ring-[color:var(--workspace-border-soft)]' : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
      {option.label}
    </button>)}
  </div>
}
