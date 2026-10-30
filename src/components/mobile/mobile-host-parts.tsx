import type { CSSProperties } from 'react'
import { Server } from 'lucide-react'
import { WorkspaceOsIcon } from '@/components/workspace/workspace-os-icon'
import { osBrandColor } from '@/lib/os-brand'
import { cn } from '@/lib/utils'

export function OsBadge({ os, size = 'md' }: { os: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-full'
  const icon = size === 'lg' ? 'h-6 w-6' : 'h-[18px] w-[18px]'
  return os
    ? <span data-testid="mobile-host-os" title={os} className={cn('sb-os-badge flex shrink-0 items-center justify-center', box)} style={{ '--os': osBrandColor(os) } as CSSProperties}><WorkspaceOsIcon os={os} className={icon} /></span>
    : <span className={cn('flex shrink-0 items-center justify-center bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]', box)}><Server className={icon} /></span>
}
