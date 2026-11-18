import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpCircle,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Radar,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { CompatibleAgentPanel } from '@/components/compatible-agent-panel'
import { ProbeInstallDialog } from '@/components/probe-install-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useHosts } from '@/contexts/hosts-context'
import { useVault } from '@/contexts/vault-context'
import {
  invalidateProbeInstallSources,
  PROBE_DEPLOYMENT_CHANGED_EVENT,
  useProbeInstallReadiness,
} from '@/hooks/use-probe-install-readiness'
import {
  cancelCompatibleAgent,
  operateCompatibleAgent,
  prepareCompatibleAgent,
  readCompatibleAgent,
  type CompatibleAgentAction,
  type CompatibleAgentRecord,
} from '@/lib/compatible-agent'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { listKomariIntegrations, type KomariIntegration } from '@/lib/komari-config'
import { compatibleAgentCopy } from '@/lib/locales/compatible-agent'
import { fill } from '@/lib/locales/probe-install'
import { unifiedProbeCopy } from '@/lib/locales/unified-probe'
import { isProbeInstalled } from '@/lib/probe-install'
import { requestUserDecision } from '@/lib/user-confirmation'
import { cn } from '@/lib/utils'

interface HostProbeManageDialogProps {
  host: HostProfile
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function HostProbeManageDialog({ host, open, onOpenChange }: HostProbeManageDialogProps) {
  const { locale } = useT()
  const u = unifiedProbeCopy[locale]
  const c = compatibleAgentCopy[locale]
  const { handleUpdateHost } = useHosts()
  const { activeVaultId, captureVaultScope } = useVault()
  const vaultId = host.vaultId ?? activeVaultId
  const { readiness, record: hookRecord, reload } = useProbeInstallReadiness(host, open)

  const [localRecord, setLocalRecord] = useState<CompatibleAgentRecord | null>(null)
  const [servers, setServers] = useState<KomariIntegration[]>([])
  const [busyAction, setBusyAction] = useState<CompatibleAgentAction | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [installOpen, setInstallOpen] = useState(false)
  const live = useRef(true)
  const plans = useRef(new Set<string>())

  useEffect(() => {
    live.current = true
    const ids = plans.current
    return () => {
      live.current = false
      for (const id of ids) void cancelCompatibleAgent(id).catch(() => {})
      ids.clear()
    }
  }, [])

  const loadRecordAndServers = useCallback(async () => {
    if (!vaultId) return
    const [rec, list] = await Promise.all([
      readCompatibleAgent(vaultId, host.id).catch(() => null),
      listKomariIntegrations(vaultId).catch(() => [] as KomariIntegration[]),
    ])
    if (!live.current) return
    setLocalRecord(rec)
    setServers(list.filter((item) => item.vaultId === vaultId))
  }, [vaultId, host.id])

  useEffect(() => {
    if (open) {
      setNotice('')
      setError('')
      void loadRecordAndServers()
    }
  }, [open, loadRecordAndServers])

  const record = localRecord ?? hookRecord
  const installed = isProbeInstalled(record)
  const integrationId = record?.integrationId ?? readiness?.integrationId ?? servers.find((s) => s.enabled)?.id
  const linkedServer = servers.find((s) => s.id === integrationId)
  const canSsh = hasSshConnection(host)
  const version = record?.current?.manifest.version ?? null
  const unsettled = !!record && ['prepared', 'dispatched', 'unknown', 'migrated'].includes(record.status)

  const explainError = (cause: unknown) => {
    const raw = String(cause).match(/(?:KOMARI_AGENT|MONITORING)_[A-Z_]+/)?.[0] ?? ''
    if (/NO_UPGRADE/.test(raw)) return c.noUpgrade
    if (/READBACK/.test(raw)) return c.readback
    if (/SSH/.test(raw)) return c.connection
    if (/RELEASE|CATALOG|SIGNATURE|ARTIFACT/.test(raw)) return c.releaseError
    return raw ? `${c.generic} (${raw})` : (cause instanceof Error ? cause.message : String(cause))
  }

  const runAction = async (action: 'inspect' | 'upgrade' | 'rollback' | 'uninstall') => {
    if (busyAction || !vaultId || !integrationId) return
    const valid = captureVaultScope()
    const current = () => live.current && valid()

    if (action === 'uninstall') {
      const answer = await requestUserDecision({
        vaultId,
        risk: 'high',
        isCurrent: current,
        message: fill(u.uninstallConfirm, { host: host.name }),
      })
      if (!answer.accepted || answer.isCurrent?.() === false || !current()) return
    }

    setBusyAction(action)
    setError('')
    setNotice('')
    let planId: string | undefined
    try {
      const preview = await prepareCompatibleAgent({
        vaultId,
        hostId: host.id,
        integrationId,
        action,
      })
      planId = preview.planId
      plans.current.add(planId)
      if (!current()) return

      const next = await operateCompatibleAgent(planId, action !== 'inspect')
      if (!current()) return
      setLocalRecord(next)
      invalidateProbeInstallSources(vaultId)
      window.dispatchEvent(new CustomEvent(PROBE_DEPLOYMENT_CHANGED_EVENT, { detail: { vaultId, hostIds: [host.id] } }))
      window.dispatchEvent(new Event('shellbeam:host-ops-refresh'))

      if (next.errorCode) {
        setError(explainError(next.errorCode))
      } else if (action === 'uninstall') {
        if (host.monitoringMode === 'server') {
          await handleUpdateHost(host, { ...host, monitoringMode: 'ssh' }).catch(() => {})
        }
        setNotice(u.uninstallSuccess)
        reload()
      } else if (action === 'upgrade') {
        setNotice(u.upgradeSuccess)
        reload()
      } else if (action === 'inspect') {
        setNotice(u.inspectSuccess)
        reload()
      }
    } catch (cause) {
      if (current()) setError(explainError(cause))
    } finally {
      if (planId) {
        plans.current.delete(planId)
        void cancelCompatibleAgent(planId).catch(() => {})
      }
      if (live.current) setBusyAction(null)
    }
  }

  if (installOpen) {
    return (
      <ProbeInstallDialog
        host={host}
        open={installOpen}
        onOpenChange={(nextOpen) => {
          setInstallOpen(nextOpen)
          if (!nextOpen) {
            reload()
            void loadRecordAndServers()
          }
        }}
      />
    )
  }

  const statusText = record
    ? (typeof c[record.status as keyof typeof c] === 'string' ? (c[record.status as keyof typeof c] as string) : c.unknown)
    : u.tierNative

  const healthy = installed && record?.status === 'active'

  return (
    <Dialog open={open} onOpenChange={onOpenChange} labelledBy="host-probe-manage-title">
      <DialogContent className="flex max-h-[86vh] flex-col overflow-hidden p-0 md:w-[620px] md:max-w-[95vw]">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="host-probe-manage-title" className="truncate text-base font-semibold">
              {fill(u.manageTitle, { host: host.name })}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{u.manageSubtitle}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div data-testid="host-probe-manage-dialog" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* Status Summary Banner */}
          <div
            className={cn(
              'flex items-start gap-3.5 rounded-xl border p-4',
              healthy
                ? 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)]'
                : installed || unsettled
                  ? 'border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)]'
                  : 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]',
            )}
          >
            <span
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white',
                healthy
                  ? 'bg-[var(--workspace-status-good)]'
                  : installed || unsettled
                    ? 'bg-[var(--workspace-status-warn)]'
                    : 'bg-primary',
              )}
            >
              {healthy ? <CheckCircle2 className="h-5 w-5" /> : installed || unsettled ? <CircleAlert className="h-5 w-5" /> : <Radar className="h-5 w-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[var(--workspace-text-strong)]">
                  {healthy ? u.tierEnhanced : installed || unsettled ? u.tierAttention : u.tierNative}
                </h3>
                {version && (
                  <span className="rounded-full bg-background/80 px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--workspace-text-strong)]">
                    v{version}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{statusText}</p>
            </div>
          </div>

          {/* Key Metadata */}
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)]/50 p-3.5 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">{u.fieldVersion}</dt>
              <dd className="mt-0.5 font-mono font-semibold text-[var(--workspace-text-strong)]">{version ? `v${version}` : '—'}</dd>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <dt className="text-muted-foreground">{u.fieldServer}</dt>
              <dd className="mt-0.5 flex items-center gap-1 truncate font-medium text-[var(--workspace-text-strong)]" title={record?.endpoint || linkedServer?.endpoint}>
                <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{linkedServer?.name || record?.endpoint || '—'}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{u.fieldVerifiedAt}</dt>
              <dd className="mt-0.5 truncate text-[var(--workspace-text-strong)]">
                {record?.observedAt ? new Date(record.observedAt).toLocaleTimeString(locale) : c.idle}
              </dd>
            </div>
          </dl>

          {/* Primary One-Click Actions */}
          {canSsh ? (
            <div className="flex flex-wrap items-center gap-2">
              {!installed && !unsettled ? (
                <Button
                  size="sm"
                  data-testid="probe-manage-install"
                  onClick={() => setInstallOpen(true)}
                  className="gap-1.5"
                >
                  <Radar className="h-3.5 w-3.5" />
                  {u.actionInstall}
                </Button>
              ) : (
                <>
                  {integrationId && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="probe-manage-inspect"
                      disabled={!!busyAction}
                      onClick={() => void runAction('inspect')}
                      className="gap-1.5"
                    >
                      {busyAction === 'inspect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {u.actionInspect}
                    </Button>
                  )}
                  {installed && integrationId && (
                    <Button
                      size="sm"
                      data-testid="probe-manage-upgrade"
                      disabled={!!busyAction || unsettled}
                      onClick={() => void runAction('upgrade')}
                      className="gap-1.5"
                    >
                      {busyAction === 'upgrade' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                      {u.actionUpgrade}
                    </Button>
                  )}
                  {installed && record?.previous && integrationId && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="probe-manage-rollback"
                      disabled={!!busyAction || unsettled}
                      onClick={() => void runAction('rollback')}
                      className="gap-1.5"
                    >
                      {busyAction === 'rollback' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {u.actionRollback} ({record.previous.manifest.version})
                    </Button>
                  )}
                  {(installed || record?.requested) && integrationId && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="probe-manage-uninstall"
                      disabled={!!busyAction}
                      onClick={() => void runAction('uninstall')}
                      className="ml-auto gap-1.5 border-[color:var(--workspace-status-bad-border)] text-[color:var(--workspace-status-bad-text)] hover:bg-[var(--workspace-status-bad-bg)]"
                    >
                      {busyAction === 'uninstall' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      {u.actionUninstall}
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{c.ssh}</p>
          )}

          {notice && (
            <p role="status" className="rounded-lg bg-[var(--workspace-status-good-bg)] px-3 py-2 text-xs text-[color:var(--workspace-status-good-text)]">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Advanced Handoff / Migration / Transfer */}
          {canSsh && integrationId && (
            <details className="rounded-xl border border-[color:var(--workspace-border-soft)] px-3.5 py-2.5">
              <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <Wrench className="h-3.5 w-3.5" />
                <span>{u.advancedOpsTitle}</span>
              </summary>
              <div className="mt-2 border-t border-border/50 pt-1">
                <CompatibleAgentPanel host={host} integrationId={integrationId} />
              </div>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
