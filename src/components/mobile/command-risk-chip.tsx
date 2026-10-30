import { classifyCommandRisk, type CommandRisk } from '@/lib/command-risk'
import { useT } from '@/lib/i18n'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { cn } from '@/lib/utils'
import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'

const TONE: Record<CommandRisk, string> = {
  'read-only': 'text-[var(--workspace-status-good-text)] bg-[var(--workspace-status-good-bg)]',
  'changes-state': 'text-[var(--workspace-status-warn-text)] bg-[var(--workspace-status-warn-bg)]',
  destructive: 'text-[var(--workspace-status-bad-text)] bg-[var(--workspace-status-bad-bg)]',
}
const ICON = { 'read-only': ShieldCheck, 'changes-state': ShieldAlert, destructive: TriangleAlert } as const

export function CommandRiskChip({ command, compact = false, className }: { command: string; compact?: boolean; className?: string }) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const risk = classifyCommandRisk(command)
  const Icon = ICON[risk]
  return (
    <span data-testid="command-risk" data-risk={risk} title={copy.risk[risk]}
      className={cn('inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 font-medium', compact ? 'text-[10px]' : 'text-xs', TONE[risk], className)}>
      <Icon className={cn('shrink-0', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden="true" />
      <span className="truncate">{compact ? copy.riskShort[risk] : copy.risk[risk]}</span>
    </span>
  )
}
