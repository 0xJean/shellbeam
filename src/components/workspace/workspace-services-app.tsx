import { Info, Play, Power, PowerOff, RotateCw, ScrollText, Square, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { workspaceProcSvcCopy } from '@/lib/locales/workspace-procsvc'
import { cn } from '@/lib/utils'
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

type ServiceFilter = 'all' | 'active' | 'failed' | 'inactive'

function serviceTone(active: string): Exclude<ServiceFilter, 'all'> {
  if (active === 'active') return 'active'
  if (active === 'failed') return 'failed'
  return 'inactive'
}

const TONE_DOT: Record<Exclude<ServiceFilter, 'all'>, string> = {
  active: 'bg-[var(--workspace-status-good)]',
  failed: 'bg-[var(--workspace-status-bad)]',
  inactive: 'bg-[var(--workspace-text-subtle)]',
}

const TONE_TEXT: Record<Exclude<ServiceFilter, 'all'>, string> = {
  active: 'text-[var(--workspace-status-good-text)]',
  failed: 'text-[var(--workspace-status-bad-text)]',
  inactive: 'text-[var(--workspace-text-muted)]',
}

const TONE_CHIP: Record<Exclude<ServiceFilter, 'all'>, string> = {
  active: 'border-[color:var(--workspace-status-good-border)] bg-[var(--workspace-status-good-bg)] text-[var(--workspace-status-good-text)]',
  failed: 'border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] text-[var(--workspace-status-bad-text)]',
  inactive: 'border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]',
}

const secondaryButton = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 text-[13px] font-medium text-[var(--workspace-text)] transition-colors hover:bg-[var(--workspace-surface-700)] disabled:cursor-not-allowed disabled:opacity-45'
const dangerButton = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-3 text-[13px] font-medium text-[var(--workspace-status-bad-text)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45'

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
  const { t, locale } = useT()
  const copy = workspaceProcSvcCopy[locale]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [rows, setRows] = useState<ServiceRow[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [actionLoading, setActionLoading] = useState<DiagnosticServiceAction | 'status' | null>(null)
  const [snapshotScope, setSnapshotScope] = useState('')
  const [statusFilter, setStatusFilter] = useState<ServiceFilter>('all')
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

  const scopedRows = snapshotScope === scope ? rows : []
  const filterCounts = { all: scopedRows.length, active: 0, failed: 0, inactive: 0 }
  for (const row of scopedRows) filterCounts[serviceTone(row.active)]++
  const visibleRows = statusFilter === 'all' ? scopedRows : scopedRows.filter((row) => serviceTone(row.active) === statusFilter)

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

  const filters: { key: ServiceFilter; label: string }[] = [
    { key: 'all', label: copy.filterAll },
    { key: 'active', label: copy.filterActive },
    { key: 'failed', label: copy.filterFailed },
    { key: 'inactive', label: copy.filterInactive },
  ]
  const selectedTone = selectedService ? serviceTone(selectedService.active) : null
  const actionButton = (action: DiagnosticServiceAction | 'status', label: string, fullLabel: string, icon: ReactNode, className: string, testId?: string) => (
    <button
      type="button"
      disabled={actionLoading !== null}
      data-testid={testId}
      aria-label={actionLoading === action ? undefined : fullLabel}
      onClick={() => void runServiceAction(action)}
      className={className}
    >
      {icon}
      {actionLoading === action ? t('workspace.services.running') : label}
    </button>
  )
  const riskGroup = (dot: string, label: string, children: ReactNode) => (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-muted)]"><span className={cn('h-1.5 w-1.5 rounded-full', dot)} />{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )

  return (
    <div data-testid="workspace-services-app" data-host-id={host.id} data-vault-id={vaultId ?? host.vaultId} data-selected-service={selectedService?.name} className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--workspace-text-strong)]">{t('workspace.app.services')}</h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">{copy.svcSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadServices()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-lg bg-[color:var(--workspace-primary-500)] px-3 text-[13px] font-semibold text-[var(--workspace-primary-foreground)] transition-colors hover:bg-[color:var(--workspace-primary-400)] md:self-auto"
        >
          <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {loading ? t('workspace.services.loading') : t('workspace.services.reload')}
        </button>
      </div>

      <WorkspaceOperationRecoveryNotice host={host} vaultId={vaultId} />

      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-3 py-2 text-xs text-[var(--workspace-text-muted)]">
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
        <span className="min-w-0 flex-1 truncate font-mono">{SERVICES_COMMAND}</span>
        <span className="hidden shrink-0 text-[var(--workspace-text-subtle)] sm:inline">{copy.maxUnits}</span>
      </div>

      {unsupported ? (
        <WorkspaceEmptyState
          title={t('workspace.services.unsupportedTitle')}
          description={t('workspace.services.unsupportedDescription')}
        />
      ) : error ? (
        <div role="alert" data-testid="workspace-services-error" className="rounded-xl border border-[color:var(--workspace-status-bad-border)] bg-[var(--workspace-status-bad-bg)] px-4 py-3 text-sm text-[var(--workspace-status-bad-text)]">
          {error}
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
          <div className="sb-card min-w-0 self-start bg-[var(--workspace-surface-panel)]">
            <div role="group" aria-label={copy.statusFilter} className="flex flex-wrap items-center gap-1.5 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5 sm:px-4">
              {filters.map((filter) => {
                const active = statusFilter === filter.key
                return (
                  <button
                    key={filter.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setStatusFilter(filter.key)}
                    className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                      active ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]')}
                  >
                    {filter.key !== 'all' && <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[filter.key])} />}
                    {filter.label}
                    <span className="font-mono text-[11px] opacity-70">{filterCounts[filter.key]}</span>
                  </button>
                )
              })}
            </div>
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5 text-xs font-medium text-[var(--workspace-text-subtle)] sm:grid-cols-[minmax(0,1.4fr)_88px_100px_100px] sm:gap-3 sm:px-4">
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.service')}</div>
              <div className="hidden sm:block">{t('workspace.services.column.load')}</div>
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.active')}</div>
              <div className="min-w-0 break-words sm:break-normal">{t('workspace.services.column.sub')}</div>
            </div>
            {/* Desktop and mobile window bodies already scroll. A nested list
                scrollport can extend beyond a short window and clip its rows. */}
            <div data-testid="workspace-services-list">
              {loading ? (
                <div className="px-4 py-6 text-sm text-[var(--workspace-text-muted)]">{t('workspace.services.loadingServices')}</div>
              ) : scopedRows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-[var(--workspace-text-muted)]">{t('workspace.services.emptyList')}</div>
              ) : visibleRows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-[var(--workspace-text-muted)]">{copy.filteredEmpty}</div>
              ) : (
                visibleRows.map((row) => {
                  const isSelected = row.name === selectedService?.name
                  const tone = serviceTone(row.active)
                  return (
                    <button
                      key={row.name}
                      data-testid="workspace-service-row"
                      data-service-unit={row.name} data-active-state={row.active} aria-pressed={isSelected}
                      type="button"
                      onClick={() => setSelectedServiceName(row.name)}
                      className={cn('grid w-full min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-b border-[color:var(--workspace-border-soft)] px-3 py-2.5 text-left text-sm transition-colors last:rounded-b-[inherit] last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_88px_100px_100px] sm:gap-3 sm:px-4',
                        isSelected ? 'bg-[var(--workspace-surface-row-selected)] shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[var(--workspace-surface-row)]')}
                    >
                      <div className="min-w-0">
                        <div className="break-all font-medium text-[var(--workspace-text-strong)] sm:truncate sm:break-normal">{row.name}</div>
                        <div className="break-words text-xs text-[var(--workspace-text-subtle)] sm:truncate sm:break-normal">{row.description || t('workspace.services.noDescription')}</div>
                        <div className="break-words text-xs text-[var(--workspace-text-subtle)] sm:hidden">{t('workspace.services.column.load')}: {row.load}</div>
                      </div>
                      <div className="hidden text-[13px] text-[var(--workspace-text-muted)] sm:block">{row.load}</div>
                      <div className="min-w-0">
                        <span className={cn('inline-flex max-w-full items-center gap-1.5 break-all text-[13px] font-medium sm:break-normal', TONE_TEXT[tone])}>
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
                          {row.active}
                        </span>
                      </div>
                      <div className="min-w-0 break-all font-mono text-xs text-[var(--workspace-text-muted)] sm:break-normal">{row.sub}</div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div className="sb-card min-w-0 bg-[var(--workspace-surface-panel)]">
              <div className="flex items-center justify-between gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  {selectedTone && <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[selectedTone])} />}
                  <h3 className="min-w-0 break-all text-sm font-semibold text-[var(--workspace-text-strong)] sm:break-words">{selectedService?.name ?? t('workspace.services.chooseService')}</h3>
                </div>
                {selectedService && selectedTone && (
                  <span className={cn('shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px]', TONE_CHIP[selectedTone])}>{selectedService.active} · {selectedService.sub}</span>
                )}
              </div>
              <div className="space-y-4 p-4">
                {selectedService ? (
                  <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
                    <dt className="text-[var(--workspace-text-subtle)]">{copy.descriptionLabel}</dt>
                    <dd className="break-words text-[var(--workspace-text)]">{selectedService.description || t('workspace.services.noDescription')}</dd>
                    <dt className="text-[var(--workspace-text-subtle)]">{copy.loadLabel}</dt>
                    <dd className="break-all font-mono text-xs leading-5 text-[var(--workspace-text)]">{selectedService.load}</dd>
                  </dl>
                ) : (
                  <p className="text-sm text-[var(--workspace-text-muted)]">{t('workspace.services.selectHint')}</p>
                )}

                {selectedService && (
                  <>
                    {riskGroup('bg-[var(--workspace-text-subtle)]', copy.readOnly, <>
                      {actionButton('status', copy.viewStatus, t('workspace.services.actionLabel.status', { service: selectedService.name }), <Info className="h-3.5 w-3.5" />, secondaryButton, 'workspace-service-status')}
                      {onOpenLogs && (
                        <button type="button" disabled={actionLoading !== null} aria-label={t('workspace.diagnostics.serviceLogs', { service: selectedService.name })} onClick={() => onOpenLogs(selectedService.name)} className={secondaryButton}>
                          <ScrollText className="h-3.5 w-3.5" />{copy.viewLogs}
                        </button>
                      )}
                    </>)}
                    {riskGroup('bg-[var(--workspace-status-good)]', copy.lowRisk, <>
                      {actionButton('start', t('workspace.services.action.start'), t('workspace.services.actionLabel.start', { service: selectedService.name }), <Play className="h-3.5 w-3.5" />, secondaryButton)}
                      {actionButton('enable', t('workspace.diagnostics.action.enable'), t('workspace.diagnostics.enable', { service: selectedService.name }), <Power className="h-3.5 w-3.5" />, secondaryButton)}
                    </>)}
                    {riskGroup('bg-[var(--workspace-status-bad)]', copy.highRisk, <>
                      {actionButton('restart', t('workspace.services.action.restart'), t('workspace.services.actionLabel.restart', { service: selectedService.name }), <RotateCw className="h-3.5 w-3.5" />, dangerButton, 'workspace-service-restart')}
                      {actionButton('stop', t('workspace.services.action.stop'), t('workspace.services.actionLabel.stop', { service: selectedService.name }), <Square className="h-3.5 w-3.5" />, dangerButton)}
                      {actionButton('disable', t('workspace.diagnostics.action.disable'), t('workspace.diagnostics.disable', { service: selectedService.name }), <PowerOff className="h-3.5 w-3.5" />, dangerButton)}
                    </>)}
                  </>
                )}
              </div>
            </div>

            <div className="sb-card min-w-0 bg-[var(--workspace-surface-panel)]">
              <div className="border-b border-[color:var(--workspace-border-soft)] px-4 py-3 text-sm font-semibold text-[var(--workspace-text-strong)]">{t('workspace.services.terminalOutput')}</div>
              <pre data-testid="workspace-services-output" className="max-h-[20rem] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-6 text-[var(--workspace-text)]">
                {actionOutput || t('workspace.services.outputHint')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
