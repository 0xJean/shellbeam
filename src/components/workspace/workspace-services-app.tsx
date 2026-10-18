import { useEffect, useMemo, useRef, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { runConfirmedOperation, type OperationJob } from '@/lib/operation-job'
import { WorkspaceEmptyState } from './workspace-empty-state'
import { WorkspaceOperationRecoveryNotice } from './workspace-operation-recovery-notice'
import { executeVerifiedServiceAction, safeDiagnosticService, type DiagnosticServiceAction } from '@/lib/workspace-diagnostics'

const SERVICES_COMMAND = 'systemctl list-units --type=service --all --no-pager --plain --no-legend | head -n 40'

interface ServiceRow {
  name: string
  load: string
  active: string
  sub: string
  description: string
}

interface WorkspaceServicesAppProps {
  selectedHostId?: string | null
  hostAddress?: string | null
  hosts: HostProfile[]
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  vaultId?: string
  onOpenLogs?: (service: string) => void
}

function parseServices(output: string): ServiceRow[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', load = '', active = '', sub = '', ...rest] = line.split(/\s+/)
      return {
        name,
        load,
        active,
        sub,
        description: rest.join(' '),
      }
    })
    .filter((row) => row.name.endsWith('.service'))
}

function getBadgeClass(active: string) {
  if (active === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
  if (active === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-300'
  return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
}

function isSafeServiceName(name: string) {
  return safeDiagnosticService(name)
}

function operationOutput(job: OperationJob, output: string) {
  const summary = `job=${job.jobId} audit=${job.auditId} status=${job.status}`
  return output ? `${summary}\n\n${output}` : summary
}

export function WorkspaceServicesApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
  vaultId,
  onOpenLogs,
}: WorkspaceServicesAppProps) {
  const { t } = useT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [rows, setRows] = useState<ServiceRow[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [actionLoading, setActionLoading] = useState<DiagnosticServiceAction | 'status' | null>(null)
  const [snapshotScope, setSnapshotScope] = useState('')
  const loadGeneration = useRef(0)

  const host = useMemo(
    () => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )
  const scope = `${vaultId ?? ''}:${host?.id ?? ''}`

  const selectedService = useMemo(
    () => snapshotScope === scope ? rows.find((row) => row.name === selectedServiceName) ?? rows[0] ?? null : null,
    [rows, selectedServiceName, snapshotScope, scope],
  )

  async function runRemoteCommand(command: string, audit?: { action: string; target: string }) {
    if (!host) throw new Error(t('workspace.services.noHostSelected'))
    return runWorkspaceRemoteCommand({
      host,
      resolveAuthSecret,
      vaultId,
      command,
      audit,
    })
  }

  async function loadServices() {
    if (!host) return
    const generation = ++loadGeneration.current

    setLoading(true)
    setError('')
    setUnsupported(false)

    try {
      const result = await runRemoteCommand(SERVICES_COMMAND, { action: 'service.list', target: 'bounded systemd service list' })
      if (generation !== loadGeneration.current) return
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (result.exitCode !== 0 && /systemd|not been booted|command not found/i.test(combined)) throw new Error(combined)
      const parsed = parseServices(combined)
      setRows(parsed)
      setSnapshotScope(scope)
      setSelectedServiceName((current) => current ?? parsed[0]?.name ?? null)
      if (parsed.length === 0 && combined) {
        setActionOutput(combined)
      }
    } catch (caught) {
      if (generation !== loadGeneration.current) return
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/systemd|not been booted/i.test(message)) {
        setUnsupported(true)
        setActionOutput('')
      } else {
        setError(message)
      }
      setRows([])
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  async function runServiceAction(action: DiagnosticServiceAction | 'status') {
    if (!host || !selectedService || actionLoading) return

    if (!isSafeServiceName(selectedService.name)) {
      setError(t('workspace.services.invalidService'))
      return
    }

    setActionLoading(action)
    setError('')

    try {
      const command = `systemctl status --no-pager -- ${selectedService.name}`

      if (action === 'status') {
        const result = await runRemoteCommand(command, { action: 'service.status', target: selectedService.name })
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
        setActionOutput(combined || t('workspace.services.actionCompleted', { action: t('workspace.services.action.status') }))
      } else {
        const confirmation = t('workspace.operation.confirm', {
          action: t(action === 'enable' || action === 'disable' ? `workspace.diagnostics.action.${action}` : `workspace.services.action.${action}`),
          target: selectedService.name,
        })
        const execution = await runConfirmedOperation({
          host,
          vaultId,
          action: `service.${action}`,
          target: selectedService.name,
          risk: action === 'start' || action === 'enable' ? 'low' : 'high',
          paramsSummary: `systemctl ${action} ${selectedService.name}`,
          confirmMessage: confirmation,
          execute: () => executeVerifiedServiceAction(runRemoteCommand, selectedService.name, action),
          getResult: (result) => result,
        })
        if (!execution) {
          setActionOutput(t('workspace.operation.cancelled'))
          return
        }
        const result = execution.value
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
        setActionOutput(operationOutput(execution.job, `${result.resultSummary}\n${combined}`))
        await loadServices()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    if (!host) return
    const generation = loadGeneration
    void loadServices()
    return () => { generation.current++ }
    // Host/vault changes reload; refresh and action callbacks request other reads explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, vaultId])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.app.services')}
        description={t('workspace.services.emptyDescription')}
      />
    )
  }

  return (
    <div data-testid="workspace-services-app" data-host-id={host.id} data-vault-id={vaultId ?? host.vaultId} data-selected-service={selectedService?.name} className="min-w-0 space-y-4">
      <div className="rounded-xl border border-border/60 bg-card px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">{t('workspace.app.services')}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.services.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('workspace.services.description')}
        </p>
      </div>

      <WorkspaceOperationRecoveryNotice host={host} vaultId={vaultId} />

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground">{SERVICES_COMMAND}</div>
        <button
          type="button"
          onClick={() => void loadServices()}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? t('workspace.services.loading') : t('workspace.services.reload')}
        </button>
      </div>

      {unsupported ? (
        <WorkspaceEmptyState
          title={t('workspace.services.unsupportedTitle')}
          description={t('workspace.services.unsupportedDescription')}
        />
      ) : error ? (
        <div role="alert" data-testid="workspace-services-error" className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
          <div className="min-w-0 rounded-xl border border-border/60 bg-card">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 rounded-t-xl border-b border-border/60 px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:grid-cols-[minmax(0,1.4fr)_100px_100px_100px] sm:gap-3 sm:px-4">
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.service')}</div>
              <div className="hidden sm:block">{t('workspace.services.column.load')}</div>
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.active')}</div>
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.sub')}</div>
            </div>
            {/* Desktop and mobile window bodies already scroll. A nested list
                scrollport can extend beyond a short window and clip its rows. */}
            <div data-testid="workspace-services-list">
              {loading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.services.loadingServices')}</div>
              ) : rows.length === 0 || snapshotScope !== scope ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.services.emptyList')}</div>
              ) : (
                rows.map((row) => {
                  const isSelected = row.name === selectedService?.name
                  return (
                    <button
                      key={row.name}
                      data-testid="workspace-service-row"
                      data-service-unit={row.name} data-active-state={row.active} aria-pressed={isSelected}
                      type="button"
                      onClick={() => setSelectedServiceName(row.name)}
                      className={`grid w-full min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border/40 px-3 py-3 text-left text-sm transition-colors last:rounded-b-xl last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_100px_100px_100px] sm:gap-3 sm:px-4 ${
                        isSelected ? 'bg-primary/10' : 'hover:bg-muted/40'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="break-all font-medium sm:truncate sm:break-normal">{row.name}</div>
                        <div className="break-words text-xs text-muted-foreground sm:truncate sm:break-normal">{row.description || t('workspace.services.noDescription')}</div>
                        <div className="break-words text-xs text-muted-foreground sm:hidden">{t('workspace.services.column.load')}: {row.load}</div>
                      </div>
                      <div className="hidden sm:block">{row.load}</div>
                      <div className="min-w-0">
                        <span className={`inline-block max-w-full break-all rounded-full border px-2 py-1 text-[11px] font-medium sm:inline sm:max-w-none sm:break-normal ${getBadgeClass(row.active)}`}>
                          {row.active}
                        </span>
                      </div>
                      <div className="min-w-0 break-all sm:break-normal">{row.sub}</div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="min-w-0 space-y-4 rounded-xl border border-border/60 bg-card p-5">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.services.selectedService')}</div>
              <div className="mt-2 break-all text-xl font-semibold sm:break-words">{selectedService?.name ?? t('workspace.services.chooseService')}</div>
              <div className="mt-1 break-words text-sm text-muted-foreground">{selectedService?.description || t('workspace.services.selectHint')}</div>
            </div>

            {selectedService && (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={actionLoading !== null}
                  data-testid="workspace-service-status" onClick={() => void runServiceAction('status')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'status' ? t('workspace.services.running') : t('workspace.services.actionLabel.status', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  disabled={actionLoading !== null}
                  data-testid="workspace-service-restart" onClick={() => void runServiceAction('restart')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'restart' ? t('workspace.services.running') : t('workspace.services.actionLabel.restart', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  disabled={actionLoading !== null}
                  onClick={() => void runServiceAction('start')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'start' ? t('workspace.services.running') : t('workspace.services.actionLabel.start', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  disabled={actionLoading !== null}
                  onClick={() => void runServiceAction('stop')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'stop' ? t('workspace.services.running') : t('workspace.services.actionLabel.stop', { service: selectedService.name })}
                </button>
                {(['enable', 'disable'] as const).map((action) => <button key={action} type="button" disabled={actionLoading !== null} onClick={() => void runServiceAction(action)} className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40">
                  {t(`workspace.diagnostics.${action}`, { service: selectedService.name })}
                </button>)}
                {onOpenLogs && <button type="button" disabled={actionLoading !== null} onClick={() => onOpenLogs(selectedService.name)} className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40">{t('workspace.diagnostics.serviceLogs', { service: selectedService.name })}</button>}
              </div>
            )}

            <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.services.terminalOutput')}</div>
              <pre data-testid="workspace-services-output" className="mt-3 max-h-[20rem] overflow-auto whitespace-pre-wrap text-xs leading-6 text-[var(--workspace-text)]">
                {actionOutput || t('workspace.services.outputHint')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
