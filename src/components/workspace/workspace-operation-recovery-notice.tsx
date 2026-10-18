import { AlertTriangle, RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { listOperationJobs, type OperationJob, type OperationJobStatus } from '@/lib/operation-job'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const RECOVERABLE: OperationJobStatus[] = ['unknown', 'queued', 'running']

/**
 * Shows durable jobs which may have outlived the terminal or Workspace window.
 * It only reads the local job journal; the operator still decides whether a
 * follow-up check is safe. This keeps MCP and UI jobs visible after a restart
 * without replaying a remote command automatically.
 */
export function WorkspaceOperationRecoveryNotice({ host, vaultId }: { host: HostProfile; vaultId?: string }) {
  const { t } = useT()
  const scopedVaultId = vaultId ?? host.vaultId
  const scope = JSON.stringify([scopedVaultId, host.id])
  const [state, setState] = useState<{ scope: string; audits: OperationJob[]; loading: boolean } | null>(null)
  const generation = useRef(0)
  const audits = state?.scope === scope ? state.audits : []
  const loading = state?.scope === scope && state.loading

  const load = useCallback(async () => {
    // A host id is only meaningful within its Vault. Never query the global
    // journal when a legacy/unsaved host has no scope.
    if (!scopedVaultId?.trim() || !host.id.trim()) return
    const request = ++generation.current
    setState({ scope, audits: [], loading: true })
    try {
      // Audit events retain queued/running history even after a job finishes.
      // Read canonical current statuses, so old events cannot suggest a replay.
      const entries = (await Promise.all(RECOVERABLE.map((status) =>
        listOperationJobs({ vaultId: scopedVaultId, hostId: host.id, status, limit: 5 }),
      ))).flat()
      if (request !== generation.current) return
      setState({ scope, loading: false, audits: entries.filter((entry) =>
        entry.vaultId === scopedVaultId && entry.hostId === host.id && RECOVERABLE.includes(entry.status),
      ).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5) })
    } catch {
      if (request === generation.current) setState({ scope, audits: [], loading: false })
    }
  }, [host.id, scopedVaultId, scope])

  useEffect(() => {
    const requests = generation
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false; requests.current++ }
  }, [load])
  if (audits.length === 0 && !loading) return null

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
        <button type="button" onClick={() => void load()} disabled={loading} className="shrink-0 rounded-md border border-current/20 p-1.5 transition-colors hover:bg-black/5 disabled:cursor-wait disabled:opacity-60" title={t('workspace.operation.recovery.refresh')}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
    </section>
  )
}
