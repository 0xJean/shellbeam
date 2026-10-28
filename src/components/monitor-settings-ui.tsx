import type { InputHTMLAttributes, ReactNode } from 'react'
import { Info, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export const mutedText = 'text-[color:var(--workspace-text-muted)]'
export const subtleText = 'text-[color:var(--workspace-text-subtle)]'
export const softBorder = 'border-[color:var(--workspace-border-soft)]'
export const primaryButton = 'bg-[color:var(--workspace-primary-500)] text-white hover:bg-[color:var(--workspace-primary-500)] hover:opacity-90'
export const dangerButton = 'bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)] hover:bg-[color:var(--workspace-status-bad-bg)] hover:opacity-90'

export function CardHead({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5', softBorder, className)}>
    <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-[color:var(--workspace-text-strong)]">{title}{hint && <small className={cn('truncate text-xs font-normal', mutedText)}>{hint}</small>}</h3>
    {children}
  </div>
}

export function SettingRow({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0', softBorder, className)}>
    <div className="min-w-0 max-w-md flex-1"><div className="text-sm font-medium text-[color:var(--workspace-text-strong)]">{title}</div>{hint && <p className={cn('mt-0.5 text-xs', mutedText)}>{hint}</p>}</div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
  </div>
}

export function Note({ icon: Icon = Info, tone, children, className }: { icon?: LucideIcon; tone?: 'warn' | 'good' | 'bad'; children: ReactNode; className?: string }) {
  return <div className={cn('flex items-start gap-2 text-xs', tone === 'warn' ? 'text-[color:var(--workspace-status-warn-text)]' : tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : tone === 'good' ? 'text-[color:var(--workspace-status-good-text)]' : mutedText, className)}>
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{children}</span>
  </div>
}

export function Banner({ icon: Icon = Info, tone, children, className }: { icon?: LucideIcon; tone?: 'warn' | 'good' | 'bad'; children: ReactNode; className?: string }) {
  return <div className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-xs', tone === 'warn' ? 'bg-[color:var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' : tone === 'bad' ? 'bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]' : tone === 'good' ? 'bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : 'bg-[color:var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]', className)}>
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><div className="min-w-0 flex-1 break-words">{children}</div>
  </div>
}

export function Chip({ tone, children, className }: { tone?: 'warn' | 'good' | 'bad' | 'accent'; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tone === 'good' ? 'bg-[color:var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]' : tone === 'warn' ? 'bg-[color:var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]' : tone === 'bad' ? 'bg-[color:var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]' : tone === 'accent' ? 'bg-[color:var(--workspace-accent-subtle)] text-[color:var(--workspace-accent-text)]' : 'bg-[color:var(--workspace-surface-700)] text-[color:var(--workspace-text-muted)]', className)}>{children}</span>
}

export function StatusDot({ tone, children }: { tone?: 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-medium', tone === 'good' ? 'text-[color:var(--workspace-status-good-text)]' : tone === 'warn' ? 'text-[color:var(--workspace-status-warn-text)]' : tone === 'bad' ? 'text-[color:var(--workspace-status-bad-text)]' : mutedText)}>
    <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', tone === 'good' ? 'bg-[color:var(--workspace-status-good)]' : tone === 'warn' ? 'bg-[color:var(--workspace-status-warn)]' : tone === 'bad' ? 'bg-[color:var(--workspace-status-bad)]' : 'bg-[color:var(--workspace-text-subtle)]')} />{children}
  </span>
}

/** A real checkbox drawn as a switch; label it with aria-label or a wrapping label. */
export function SwitchInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <span className={cn('relative inline-flex h-5 w-9 shrink-0 items-center', className)}>
    <input type="checkbox" className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" {...props} />
    <span aria-hidden="true" className="pointer-events-none h-5 w-9 rounded-full bg-[color:var(--workspace-surface-700)] ring-1 ring-[color:var(--workspace-border-strong)] transition-colors peer-checked:bg-[color:var(--workspace-primary-500)] peer-checked:ring-transparent peer-focus-visible:ring-2 peer-focus-visible:ring-[hsl(var(--primary))] peer-disabled:opacity-50" />
    <span aria-hidden="true" className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
  </span>
}

export const checkboxClass = 'h-4 w-4 rounded accent-[color:var(--workspace-primary-500)]'
export const fieldLabel = 'block text-xs font-medium text-[color:var(--workspace-text-muted)]'
