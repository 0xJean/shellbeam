import type { SessionTab } from '@/lib/types'

export function sessionStatusDot(status: SessionTab['status']) {
  return status === 'connected' ? 'bg-[var(--workspace-status-good)]' : status === 'error' || status === 'closed' ? 'bg-[var(--workspace-status-bad)]' : 'bg-[var(--workspace-status-warn)]'
}

export const sheetPrimaryButton = 'flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-[color:var(--workspace-primary-500)] text-[15px] font-medium text-[var(--workspace-primary-foreground)] active:opacity-80'
export const sheetTintedButton = 'flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-[var(--workspace-accent-subtle)] text-[15px] font-medium text-[var(--workspace-accent-text)] active:opacity-80'
