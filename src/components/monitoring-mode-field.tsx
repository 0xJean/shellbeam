import { useEffect, useId, useRef, useState } from 'react'
import type { MonitoringMode } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { monitoringModeCopy } from '@/lib/locales/monitoring-mode'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'

/** Stages a choice only. Persisting the host, connecting a service and installing
 * an agent remain separate actions; cancelled/stale consent never changes it. */
export function MonitoringModeField({ value, onChange, disabled = false, scopeKey, vaultId, retainedServer = false }: {
  value: MonitoringMode; onChange: (value: MonitoringMode) => void; disabled?: boolean; scopeKey: string; vaultId?: string; retainedServer?: boolean
}) {
  const { locale } = useT(); const c = monitoringModeCopy[locale]
  const name = useId()
  const [busy, setBusy] = useState(false)
  const scope = useRef({ scopeKey, disabled, alive: true, epoch: 0 })
  if (scope.current.scopeKey !== scopeKey || scope.current.disabled !== disabled) scope.current = { scopeKey, disabled, alive: true, epoch: scope.current.epoch + 1 }
  useEffect(() => { scope.current.alive = true; return () => { scope.current.alive = false; scope.current.epoch++ } }, [])
  async function select(mode: MonitoringMode) {
    if (disabled || busy || value === mode) return
    const epoch = ++scope.current.epoch
    const current = () => scope.current.alive && scope.current.epoch === epoch && !scope.current.disabled
    setBusy(true)
    try {
      const answer = await requestUserDecision({ vaultId, risk: 'low', message: mode === 'server' ? c.confirmServer : c.confirmSsh, isCurrent: current })
      if (answer.accepted && answer.isCurrent?.() !== false && current()) onChange(mode)
    } finally { if (scope.current.alive) setBusy(false) }
  }
  return <fieldset disabled={disabled || busy} className="min-w-0 space-y-2" data-testid="monitoring-mode-field" data-vault-id={vaultId}>
    <legend className="mb-2 text-sm font-medium">{c.title}</legend>
    <div className="grid gap-2 sm:grid-cols-2">
      {(['ssh', 'server'] as const).map(mode => <label key={mode} className={cn('flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3', value === mode ? 'border-primary bg-primary/5' : 'border-border', (disabled || busy) && 'cursor-default opacity-60')}>
        <input data-testid={`monitoring-mode-${mode}`} className="mt-0.5 accent-[hsl(var(--primary))]" type="radio" name={name} value={mode} checked={value === mode} onChange={() => void select(mode)} aria-label={c[mode]} />
        <span className="min-w-0"><span className="block text-sm font-medium">{c[mode]}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{mode === 'ssh' ? c.sshHint : c.serverHint}</span></span>
      </label>)}
    </div>
    {(value === 'server' || retainedServer) && <p className="text-xs leading-relaxed text-muted-foreground">{value === 'server' ? c.next : c.retained}</p>}
  </fieldset>
}
