import { AlertTriangle, RefreshCw, Route } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { listOperationJobs, type OperationJob } from '@/lib/operation-job'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Shows canonical jobs whose remote outcome is unknown. Startup recovery already
 * converts interrupted queued/running jobs to unknown; current activity is not a
 * recovery incident.
 * It only reads the local job journal; the operator still decides whether a
 * follow-up check is safe. This keeps MCP and UI jobs visible after a restart
 * without replaying a remote command automatically.
 */
export function WorkspaceOperationRecoveryNotice({ host, vaultId }: { host: HostProfile; vaultId?: string }) {
  const { t } = useT()
  const scopedVaultId = vaultId ?? host.vaultId
  const vaultMismatch = Boolean(vaultId && host.vaultId && vaultId !== host.vaultId)
  const scope = JSON.stringify([scopedVaultId, host.id])
  const [state, setState] = useState<{ scope: string; audits: OperationJob[]; loading: boolean } | null>(null)
  const reload = useRef<((showLoading?: boolean) => Promise<void>) | null>(null)
  const audits = !vaultMismatch && state?.scope === scope ? state.audits : []
  const loading = state?.scope === scope && state.loading

  useEffect(() => {
    // A host id is only meaningful within its Vault. Never query the global
    // journal when a legacy/unsaved host has no scope.
    if (vaultMismatch || !scopedVaultId?.trim() || !host.id.trim()) return
    let active = true
    let pending = false
    const load = async (showLoading = false) => {
      if (!active || pending) return
      pending = true
      if (showLoading) {
        setState((current) => ({ scope, audits: current?.scope === scope ? current.audits : [], loading: true }))
      }
      try {
        // Read current jobs, not historical audit events. Neither an active
        // queued/running read nor an old event proves an unknown remote outcome.
        const entries = await listOperationJobs({ vaultId: scopedVaultId, hostId: host.id, status: 'unknown', limit: 5 })
        if (!active) return
        setState({ scope, loading: false, audits: entries.filter((entry) =>
          entry.vaultId === scopedVaultId && entry.hostId === host.id && entry.status === 'unknown',
        ).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5) })
      } catch {
        // A failed journal read cannot prove that a previously unknown outcome
        // has been reconciled. Keep the last scoped result until a successful read.
        if (active) setState((current) => ({ scope, audits: current?.scope === scope ? current.audits : [], loading: false }))
      } finally {
        pending = false
      }
    }
    reload.current = load
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const timer = window.setInterval(onVisible, 15_000)
    queueMicrotask(() => { if (active) void load() })
    return () => {
      active = false
      if (reload.current === load) reload.current = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.clearInterval(timer)
    }
  }, [host.id, scopedVaultId, scope, vaultMismatch])
  if (audits.length === 0) return null

  return (
    <section data-testid="workspace-operation-recovery" className="rounded-xl border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] px-4 py-3 text-[color:var(--workspace-status-warn-text)]">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{t('workspace.operation.recovery.title')}</h3>
            <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[10px] font-medium">{audits.length}</span>
          </div>
          <p className="mt-1 text-xs opacity-90">{t('workspace.operation.recovery.description')}</p>
          <div className="mt-2 space-y-1.5">
            {audits.map((audit) => (
              <div key={audit.auditId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-current/15 bg-black/5 px-2 py-1.5 text-[11px]">
                <span className={cn('font-semibold', audit.status === 'unknown' && 'text-[color:var(--workspace-status-bad-text)]')}>{t(`workspace.operation.recovery.status.${audit.status}`)}</span>
                <span className="truncate font-medium">{audit.action}{audit.target ? ` · ${audit.target}` : ''}</span>
                <span className="font-mono opacity-80">job={audit.jobId}</span>
                <span className="opacity-80">{audit.source}</span>
                {audit.transport === 'proxy-jump' && <span className="inline-flex items-center gap-1"><Route className="h-3 w-3" />{t('hosts.opsProxyJump')}</span>}
              </div>
            ))}
          </div>
        </div>
        <button type="button" onClick={() => void reload.current?.(true)} disabled={loading} className="shrink-0 rounded-md border border-current/20 p-1.5 transition-colors hover:bg-black/5 disabled:cursor-wait disabled:opacity-60" title={t('workspace.operation.recovery.refresh')}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
    </section>
  )
}
