import { useEffect, useMemo, useState } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { runSshCommand } from '@/lib/sessions'
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
  hosts,
  resolveAuthSecret,
}: WorkspaceServicesAppProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [rows, setRows] = useState<ServiceRow[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [actionOutput, setActionOutput] = useState('')
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | 'restart' | 'status' | null>(null)

  const host = useMemo(
    () => hosts.find((entry) => entry.id === selectedHostId) ?? null,
    [hosts, selectedHostId],
  )

  const selectedService = useMemo(
    () => rows.find((row) => row.name === selectedServiceName) ?? rows[0] ?? null,
    [rows, selectedServiceName],
  )

  async function runRemoteCommand(command: string) {
    if (!host) throw new Error('No host selected')
    const secret = await resolveAuthSecret(host)
    return runSshCommand({
      hostId: host.id,
      host: host.address,
      port: host.port || 22,
      username: host.username || 'root',
      authType: host.authType,
      password: host.authType === 'password' ? secret : undefined,
      privateKey: host.authType === 'privateKey' ? secret : undefined,
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
      setActionOutput(combined || `${action} completed`)
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
        title="Services"
        description="Connect a remote host to inspect service health here."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-border/60 bg-card/80 px-6 py-5">
        <div className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Services</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Service Control</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspect systemd service health, then run restart or status checks without leaving the workspace.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/70 px-4 py-3">
        <div className="text-xs text-muted-foreground">{SERVICES_COMMAND}</div>
        <button
          type="button"
          onClick={() => void loadServices()}
          className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          {loading ? 'Loading…' : 'Reload Services'}
        </button>
      </div>

      {unsupported ? (
        <WorkspaceEmptyState
          title="Systemd Not Available"
          description="Systemd services are not available on this host. Open the terminal to inspect init scripts or container-managed processes."
        />
      ) : error ? (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
          <div className="overflow-hidden rounded-[28px] border border-border/60 bg-card/80">
            <div className="grid grid-cols-[minmax(0,1.4fr)_100px_100px_100px] gap-3 border-b border-border/60 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <div>Service</div>
              <div>Load</div>
              <div>Active</div>
              <div>Sub</div>
            </div>
            <div className="max-h-[28rem] overflow-auto">
              {loading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">Loading services…</div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">No systemd services found.</div>
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
                        <div className="truncate text-xs text-muted-foreground">{row.description || 'No description'}</div>
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

          <div className="space-y-4 rounded-[28px] border border-border/60 bg-card/80 p-5">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Selected Service</div>
              <div className="mt-2 text-xl font-semibold">{selectedService?.name ?? 'Choose a service'}</div>
              <div className="mt-1 text-sm text-muted-foreground">{selectedService?.description || 'Use the list to inspect and operate on services.'}</div>
            </div>

            {selectedService && (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void runServiceAction('status')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'status' ? 'Running…' : `Status ${selectedService.name}`}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('restart')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'restart' ? 'Running…' : `Restart ${selectedService.name}`}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('start')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'start' ? 'Running…' : `Start ${selectedService.name}`}
                </button>
                <button
                  type="button"
                  onClick={() => void runServiceAction('stop')}
                  className="rounded-2xl border border-border/60 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                >
                  {actionLoading === 'stop' ? 'Running…' : `Stop ${selectedService.name}`}
                </button>
              </div>
            )}

            <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Terminal Output</div>
              <pre className="mt-3 max-h-[20rem] overflow-auto whitespace-pre-wrap text-xs leading-6 text-slate-200">
                {actionOutput || 'Choose a service action to inspect status output.'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
