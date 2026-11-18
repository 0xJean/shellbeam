import { useState } from 'react'
import { CheckCircle2, CircleAlert, Radar, Wrench } from 'lucide-react'
import { HostProbeManageDialog } from '@/components/host-probe-manage-dialog'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { Button } from '@/components/ui/button'
import { useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import { isProbeInstalled, offersProbeInstall } from '@/lib/probe-install'
import { cn } from '@/lib/utils'

interface WorkspaceProbeCardProps {
  host: HostProfile | null
  variant?: 'panel' | 'card'
  className?: string
}

/**
 * Unified monitoring tier & probe card inside Host Workspace:
 * replaces the legacy standalone local Rust agent panel so Workspace and Host
 * views share one consistent two-tier mental model (Native SSH → Server Probe).
 */
export function WorkspaceProbeCard({ host, variant = 'panel', className }: WorkspaceProbeCardProps) {
  const { locale } = useT()
  const u = unifiedProbeCopy[locale]
  const [installOpen, setInstallOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

  const dummyHost = {
    id: '__none__',
    vaultId: '',
    name: '',
    address: '',
    port: 22,
    username: 'root',
    group: 'Custom',
    authType: 'password',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as HostProfile

  const { readiness, record } = useProbeInstallReadiness(host ?? dummyHost, Boolean(host?.vaultId))

  if (!host || !hasSshConnection(host)) return null

  const installed = readiness?.stage === 'installed' || isProbeInstalled(record)
  const unsettled = readiness?.stage === 'unsettled'
  const canInstall = readiness ? offersProbeInstall(readiness) : true
  const version = record?.current?.manifest.version
  const healthy = installed && (!record || record.status === 'active')

  return (
    <>
      <section
        data-testid="workspace-probe-card"
        data-variant={variant}
        data-stage={readiness?.stage ?? 'loading'}
        className={cn(
          variant === 'card'
            ? 'sb-card flex min-w-0 flex-col justify-between p-4'
            : 'rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-4 py-3.5',
          className,
        )}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--workspace-text-strong)]">
              {healthy ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[color:var(--workspace-status-good)]" />
              ) : installed || unsettled ? (
                <CircleAlert className="h-4 w-4 shrink-0 text-[color:var(--workspace-status-warn)]" />
              ) : (
                <Radar className="h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" />
              )}
              <span>{u.wsCardTitle}</span>
            </span>
            {version && (
              <span className="rounded-full bg-[var(--workspace-surface-800)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--workspace-text-strong)]">
                v{version}
              </span>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold text-[var(--workspace-text-strong)]">
              {installed || unsettled ? u.wsEnhancedTitle : u.wsNativeTitle}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--workspace-text-muted)]">
              {installed || unsettled ? u.wsEnhancedDesc : u.wsNativeDesc}
            </p>
          </div>

          {record?.endpoint && (
            <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]" title={record.endpoint}>
              {record.endpoint}
            </p>
          )}
        </div>

        <div className={cn('flex flex-wrap items-center gap-2', variant === 'card' ? 'mt-4 pt-2 border-t border-[color:var(--workspace-border-soft)]' : 'mt-3')}>
          {installed || unsettled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="workspace-probe-manage"
              onClick={() => setManageOpen(true)}
              className="h-8 gap-1.5 text-xs"
            >
              <Wrench className="h-3.5 w-3.5" />
              {u.formManageProbe}
            </Button>
          ) : canInstall ? (
            <Button
              type="button"
              size="sm"
              data-testid="workspace-probe-install"
              onClick={() => setInstallOpen(true)}
              className="h-8 gap-1.5 text-xs"
            >
              <Radar className="h-3.5 w-3.5" />
              {u.actionInstall}
            </Button>
          ) : null}
        </div>
      </section>

      {installOpen && <ProbeInstallDialog host={host} open={installOpen} onOpenChange={setInstallOpen} />}
      {manageOpen && <HostProbeManageDialog host={host} open={manageOpen} onOpenChange={setManageOpen} />}
    </>
  )
}
