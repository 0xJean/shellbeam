import type { ReactNode } from 'react'
import { SquareTerminal, Vault, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { connectionStatesCopy } from '@/lib/locales/connection-states'
import { requestCloseSession } from '@/lib/navigation-request'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'

const TONE = {
  warn: 'bg-[color:var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
  info: 'bg-[color:var(--workspace-status-info-bg)] text-[color:var(--workspace-status-info-text)]',
} as const

/** Centered card for workspace states that block host operations on the current session. */
export function SessionStateCard({ tone, icon, title, description, children, className }: {
  tone: keyof typeof TONE
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex w-full justify-center p-6', className)}>
      <div role="status" className="sb-card flex w-full max-w-[520px] flex-col items-center px-8 py-8 text-center">
        <span className={cn('flex h-[52px] w-[52px] items-center justify-center rounded-xl [&_svg]:h-6 [&_svg]:w-6', TONE[tone])}>{icon}</span>
        <h2 className="mt-4 text-lg font-semibold text-[color:var(--workspace-text-strong)]">{title}</h2>
        <p className="mb-5 mt-2 text-sm leading-6 text-[color:var(--workspace-text-muted)]">{description}</p>
        {children && <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>}
      </div>
    </div>
  )
}

/** The session was opened in another vault: workspace apps pause, the terminal keeps working. */
export function SessionVaultMismatchCard({ sessionId, onContinueInTerminal, className }: { sessionId?: string; onContinueInTerminal?: () => void; className?: string }) {
  const { t, locale } = useT()
  const copy = connectionStatesCopy[locale] ?? connectionStatesCopy.en
  return (
    <SessionStateCard tone="info" icon={<Vault />} title={copy.vaultMismatchTitle} description={t('workspace.sessionVaultMismatch')} className={className}>
      {onContinueInTerminal && (
        <Button type="button" size="sm" onClick={onContinueInTerminal} className="gap-1.5">
          <SquareTerminal className="h-3.5 w-3.5" />
          {copy.continueTerminal}
        </Button>
      )}
      {sessionId && (
        <Button type="button" variant="outline" size="sm" onClick={() => requestCloseSession(sessionId)} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          {copy.closeSession}
        </Button>
      )}
    </SessionStateCard>
  )
}
