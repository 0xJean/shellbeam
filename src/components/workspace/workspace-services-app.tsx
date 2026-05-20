import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { resolveWorkspaceHost, runWorkspaceRemoteCommand } from '@/lib/workspace-remote'
import { WorkspaceEmptyState } from './workspace-empty-state'

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

export function WorkspaceServicesApp({
  selectedHostId = null,
  hostAddress = null,
  hosts,
  resolveAuthSecret,
}: WorkspaceServicesAppProps) {
  const { t } = useT()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [rows, setRows] = useState<ServiceRow[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | 'restart' | 'status' | null>(null)

  const host = useMemo(
    () => resolveWorkspaceHost(hosts, { selectedHostId, hostAddress }),
    [hosts, selectedHostId, hostAddress],
  )

  const selectedService = useMemo(
    () => rows.find((row) => row.name === selectedServiceName) ?? rows[0] ?? null,
    [rows, selectedServiceName],
  )

  async function runRemoteCommand(command: string) {
    if (!host) throw new Error(t('workspace.services.noHostSelected'))
    return runWorkspaceRemoteCommand({
      host,
      resolveAuthSecret,
      command,
    })
  }

  async function loadServices() {
    if (!host) return

    setLoading(true)
    setError('')
    setUnsupported(false)

    try {
      const result = await runRemoteCommand(SERVICES_COMMAND)
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      const parsed = parseServices(combined)
      setRows(parsed)
      setSelectedServiceName((current) => current ?? parsed[0]?.name ?? null)
      if (parsed.length === 0 && combined) {
        setActionOutput(combined)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/systemd|not been booted/i.test(message)) {
        setUnsupported(true)
        setActionOutput('')
      } else {
        setError(message)
      }
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  async function runServiceAction(action: 'start' | 'stop' | 'restart' | 'status') {
    if (!selectedService) return

    setActionLoading(action)
    setError('')

    try {
      const command = action === 'status'
        ? `systemctl status ${selectedService.name} --no-pager`
        : `systemctl ${action} ${selectedService.name} && systemctl status ${selectedService.name} --no-pager`
      const result = await runRemoteCommand(command)
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      setActionOutput(combined || t('workspace.services.actionCompleted', { action: t(`workspace.services.action.${action}`) }))
      await loadServices()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    if (!host) return
    void loadServices()
  }, [host?.id])

  if (!host) {
    return (
      <WorkspaceEmptyState
        title={t('workspace.app.services')}
        description={t('workspace.services.emptyDescription')}
      />
    )
  }

  return (
    <div data-testid="workspace-services-app" className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-card px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">{t('workspace.app.services')}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t('workspace.services.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('workspace.services.description')}
        </p>
      </div>

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
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <div className="grid grid-cols-[minmax(0,1.4fr)_100px_100px_100px] gap-3 border-b border-border/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <div>{t('workspace.services.column.service')}</div>
              <div>{t('workspace.services.column.load')}</div>
              <div>{t('workspace.services.column.active')}</div>
              <div>{t('workspace.services.column.sub')}</div>
            </div>
            <div data-testid="workspace-services-list" className="max-h-[28rem] overflow-auto">
              {loading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.services.loadingServices')}</div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">{t('workspace.services.emptyList')}</div>
              ) : (
                rows.map((row) => {
                  const isSelected = row.name === selectedService?.name
                  return (
                    <button
                      key={row.name}
                      type="button"
                      onClick={() => setSelectedServiceName(row.name)}
                      className={`grid w-full grid-cols-[minmax(0,1.4fr)_100px_100px_100px] gap-3 border-b border-border/40 px-4 py-3 text-left text-sm transition-colors last:border-b-0 ${
                        isSelected ? 'bg-primary/10' : 'hover:bg-muted/40'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{row.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{row.description || t('workspace.services.noDescription')}</div>
                      </div>
                      <div>{row.load}</div>
                      <div>
                        <span className={`rounded-full border px-2 py-1 text-[11px] font-medium ${getBadgeClass(row.active)}`}>
                          {row.active}
                        </span>
                      </div>
                      <div>{row.sub}</div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('workspace.services.selectedService')}</div>
              <div className="mt-2 text-xl font-semibold">{selectedService?.name ?? t('workspace.services.chooseService')}</div>
              <div className="mt-1 text-sm text-muted-foreground">{selectedService?.description || t('workspace.services.selectHint')}</div>
            </div>

            {selectedService && (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void runServiceAction('status')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'status' ? t('workspace.services.running') : t('workspace.services.actionLabel.status', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('restart')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'restart' ? t('workspace.services.running') : t('workspace.services.actionLabel.restart', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('start')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'start' ? t('workspace.services.running') : t('workspace.services.actionLabel.start', { service: selectedService.name })}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('stop')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'stop' ? t('workspace.services.running') : t('workspace.services.actionLabel.stop', { service: selectedService.name })}
                </button>
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
