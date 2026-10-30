import type { ReactNode } from 'react'

export function BrowserKbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-1.5 py-px font-sans text-[10px] leading-4 text-[var(--workspace-text-subtle)]">
      {children}
    </kbd>
  )
}
