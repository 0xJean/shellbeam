import { useState } from 'react'
import { Radar } from 'lucide-react'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { probeInstallCopy } from '@/lib/locales/probe-install'
import { offersProbeInstall } from '@/lib/probe-install'

/** Host card entry: shown only while the host can still get a managed probe. */
export function ProbeInstallEntry({ host, os, enabled = true, onOpenDetails }: { host: HostProfile; os?: string | null; enabled?: boolean; onOpenDetails?: () => void }) {
  const { locale } = useT()
  const c = probeInstallCopy[locale]
  const { readiness } = useProbeInstallReadiness(host, enabled)
  const [open, setOpen] = useState(false)
  if (!enabled || !readiness || (!offersProbeInstall(readiness, os) && !open)) return null
  return (
    <>
      <button type="button" data-testid="probe-install-entry" data-stage={readiness.stage} title={c.entryHint}
        onClick={(event) => { event.stopPropagation(); setOpen(true) }}
        onDoubleClick={(event) => event.stopPropagation()}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-primary/50 px-2.5 text-xs font-medium text-[var(--workspace-accent-text)] transition-colors hover:border-solid hover:bg-primary/10">
        <Radar className="h-3.5 w-3.5" aria-hidden="true" />{c.entry}
      </button>
      {open && <ProbeInstallDialog host={host} open={open} onOpenChange={setOpen} onOpenDetails={onOpenDetails} />}
    </>
  )
}
