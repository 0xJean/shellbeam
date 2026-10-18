import { useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '@/lib/i18n'
import { getShellbeamAgentHistoryCursor, getShellbeamAgentHistorySummary, subscribeShellbeamAgentHistorySummary, SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, type ShellbeamAgentHistoryCursor, type ShellbeamAgentHistorySyncSummary } from '@/lib/shellbeam-agent-history'

/** Historical import diagnostics are separate from the current heartbeat. A
 * persisted cursor describes previous progress, never a current import count. */
export function ShellbeamAgentHistoryView({ vaultId, hostId, nodeId }: { vaultId: string; hostId: string; nodeId?: string }) {
  const { t } = useT()
  const key = JSON.stringify([vaultId, hostId, nodeId ?? ''])
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; cursor: ShellbeamAgentHistoryCursor | null; failed: boolean } | null>(null)
  const active = loaded?.key === key ? loaded : null
  const currentSession = useSyncExternalStore(subscribeShellbeamAgentHistorySummary, () => nodeId ? getShellbeamAgentHistorySummary(vaultId, hostId, nodeId) : null, () => null)

  useEffect(() => {
    let cancelled = false
    if (!nodeId) return
    void getShellbeamAgentHistoryCursor(vaultId, hostId, nodeId).then((cursor) => {
      if (!cancelled) setLoaded({ key, cursor, failed: false })
    }).catch(() => { if (!cancelled) setLoaded({ key, cursor: null, failed: true }) })
    return () => { cancelled = true }
  }, [vaultId, hostId, nodeId, key, revision])

  useEffect(() => {
    const onHistory = (event: Event) => {
      const summary = (event as CustomEvent<ShellbeamAgentHistorySyncSummary>).detail
      if (summary?.vaultId !== vaultId || summary.hostId !== hostId || summary.nodeId !== nodeId) return
      setRevision((value) => value + 1)
    }
    window.addEventListener(SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, onHistory)
    return () => window.removeEventListener(SHELLBEAM_AGENT_HISTORY_CHANGED_EVENT, onHistory)
  }, [vaultId, hostId, nodeId])

  return <div data-testid="shellbeam-agent-history" className="mt-3 rounded-lg border border-border/50 bg-muted/10 p-3 text-xs">
    <div className="font-medium">{t('workspace.agentProbe.history.title')}</div>
    <p className="mt-1 text-muted-foreground">{t('workspace.agentProbe.history.description')}</p>
    <p className="mt-2" role="status">{t('workspace.agentProbe.history.session')}: {t(`workspace.agentProbe.history.status.${currentSession?.status ?? 'not-started'}`)}</p>
    {currentSession && <>
      <p className="mt-1">{t('workspace.agentProbe.history.counts', { imported: currentSession.imported, pages: currentSession.pages })}</p>
      <p className="mt-1 text-muted-foreground">{t(`workspace.agentProbe.history.reason.${currentSession.reason}`)}</p>
      {currentSession.hasMore === true && <p className="mt-1 text-muted-foreground">{t('workspace.agentProbe.history.continues')}</p>}
    </>}
    <p className="mt-2 text-muted-foreground">{t('workspace.agentProbe.history.persisted')}: {!nodeId ? t('workspace.agentProbe.history.waitForProbe') : !active ? t('workspace.agentProbe.history.loading') : active.failed ? t('workspace.agentProbe.history.progressUnavailable') : active.cursor?.cursor ? new Date(Number(active.cursor.cursor)).toLocaleString() : t('workspace.agentProbe.history.none')}</p>
    <p className="mt-1 text-muted-foreground">{t('workspace.agentProbe.history.progressNote')}</p>
  </div>
}
