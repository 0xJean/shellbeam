import { AlertTriangle, RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { listOperationAudit, type OperationAuditEntry, type OperationJobStatus } from '@/lib/operation-job'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const RECOVERABLE: OperationJobStatus[] = ['unknown', 'queued', 'running']

/**
 * Shows durable jobs which may have outlived the terminal or Workspace window.
 * It only reads the local audit journal; the operator still decides whether a
 * follow-up check is safe. This keeps MCP and UI jobs visible after a restart
 * without replaying a remote command automatically.
 */
export function WorkspaceOperationRecoveryNotice({ host }: { host: HostProfile }) {
  const { t } = useT()
  const [audits, setAudits] = useState<OperationAuditEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await listOperationAudit({ hostId: host.id, limit: 20 })
      setAudits(entries.filter((entry) => RECOVERABLE.includes(entry.status)).slice(0, 5))
    } catch {
      setAudits([])
    } finally {
      setLoading(false)
    }
  }, [host.id])

  useEffect(() => { void load() }, [load])
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
