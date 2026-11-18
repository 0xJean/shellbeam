import { useState } from 'react'
import { Radar } from 'lucide-react'
import { HostProbeManageDialog } from '@/components/host-probe-manage-dialog'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import { isProbeInstalled, offersProbeInstall } from '@/lib/probe-install'
import { cn } from '@/lib/utils'

/**
 * Persistent host monitoring & probe pill:
 * - Shows "+ Install probe" while using native SSH monitoring (opens automated installer)
 * - Stays visible once installed ("● Probe v1.5.12") or unsettled, opening HostProbeManageDialog on click!
 */
export function ProbeInstallEntry({
  host,
  os,
  enabled = true,
  onOpenDetails,
  className,
}: {
  host: HostProfile
  os?: string | null
  enabled?: boolean
  onOpenDetails?: () => void
  className?: string
}) {
  const { locale } = useT()
  const u = unifiedProbeCopy[locale]
  const { readiness, record } = useProbeInstallReadiness(host, enabled)
  const [installOpen, setInstallOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  if (!enabled || !readiness) return null

  const installed = readiness.stage === 'installed' || isProbeInstalled(record)
  const unsettled = readiness.stage === 'unsettled'
  const canInstall = offersProbeInstall(readiness, os)

  if (!installed && !unsettled && !canInstall && !installOpen && !manageOpen) return null

  const version = record?.current?.manifest.version
  const healthy = installed && (!record || record.status === 'active')

  if (installed || unsettled) {
    return (
      <>
        <button
          type="button"
          data-testid="probe-manage-entry"
          data-stage={readiness.stage}
          title={u.badgeManageHint}
          onClick={(event) => { event.stopPropagation(); setManageOpen(true) }}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
            healthy
              ? 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)] hover:opacity-90'
              : 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)] hover:opacity-90',
            className,
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              healthy ? 'bg-[var(--workspace-status-good)]' : 'bg-[var(--workspace-status-warn)]',
            )}
            aria-hidden="true"
          />
          <span>
            {healthy
              ? (version ? fill(u.badgeInstalled, { version: `v${version}` }) : u.badgeInstalledNoVer)
              : u.badgeAttention}
          </span>
        </button>
        {manageOpen && <HostProbeManageDialog host={host} open={manageOpen} onOpenChange={setManageOpen} />}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        data-testid="probe-install-entry"
        data-stage={readiness.stage}
        title={u.badgeInstallHint}
        onClick={(event) => { event.stopPropagation(); setInstallOpen(true) }}
        onDoubleClick={(event) => event.stopPropagation()}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2.5 text-xs font-medium text-[var(--workspace-accent-text)] transition-colors hover:border-solid hover:bg-primary/10',
          className,
        )}
      >
        <Radar className="h-3.5 w-3.5" aria-hidden="true" />
        {u.badgeInstall}
      </button>
      {installOpen && <ProbeInstallDialog host={host} open={installOpen} onOpenChange={setInstallOpen} onOpenDetails={onOpenDetails} />}
    </>
  )
}

export const HostProbeBadge = ProbeInstallEntry
