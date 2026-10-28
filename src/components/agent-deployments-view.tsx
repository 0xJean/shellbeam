import { useMemo, useState, type ReactNode } from 'react'
import { Bot, Check, Copy, Cpu, FolderOpen, FolderTree, GitBranch, MessageSquareText, Package, ScanSearch, ShieldCheck, ShieldAlert, ShieldQuestion, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getAgentDeploymentVerification, getProjectDeploymentSignals } from '@/components/project-deployments-panel'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { agentDeploymentsCopy } from '@/lib/locales/agent-deployments'
import { fill } from '@/lib/locales/probe-install'
import type { McpDeploymentRecord } from '@/lib/mcp'
import { requestHostSftp, requestHostTerminal } from '@/lib/navigation-request'
import { cn } from '@/lib/utils'
import type { WorkspaceInventory } from '@/lib/workspace-inventory'

const STATUSES = ['deployed', 'deploying', 'planned', 'failed', 'retired', 'unknown'] as const
type Status = typeof STATUSES[number]
const statusOf = (value: string): Status => (STATUSES as readonly string[]).includes(value) ? value as Status : 'unknown'
const STATUS_TONE: Record<Status, string> = {
  deployed: 'text-[color:var(--workspace-status-good-text)]', deploying: 'text-[color:var(--workspace-status-warn-text)]', planned: 'text-[var(--workspace-text-muted)]',
  failed: 'text-[color:var(--workspace-status-bad-text)]', retired: 'text-[var(--workspace-text-subtle)]', unknown: 'text-[var(--workspace-text-muted)]',
}
const keyOf = (deployment: McpDeploymentRecord) => `${deployment.clientId}:${deployment.deploymentId}`
const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/'

type TFunction = ReturnType<typeof useT>['t']

function verificationOf(d: McpDeploymentRecord, t: TFunction, locale: string) {
  const state = getAgentDeploymentVerification(d)
  return state === 'verified'
    ? { tone: 'text-[color:var(--workspace-status-good-text)]', icon: ShieldCheck, label: t('workspace.agentDeployments.verifiedAt', { time: new Date(d.lastVerifiedAt ?? 0).toLocaleString(locale) }) }
    : state === 'stale'
      ? { tone: 'text-[color:var(--workspace-status-warn-text)]', icon: ShieldAlert, label: t('workspace.agentDeployments.verificationStale') }
      : { tone: 'text-[var(--workspace-text-subtle)]', icon: ShieldQuestion, label: t('workspace.agentDeployments.notVerified') }
}

export interface AgentDeploymentsViewProps {
  deployments: McpDeploymentRecord[]
  hosts: HostProfile[]
  inventoryFor: (host: HostProfile) => { inventory?: WorkspaceInventory; updatedAt?: number } | undefined
}

/** Agent-registered deployments: list grouped by host, detail led by the deploy directory. */
export function AgentDeploymentsView({ deployments, hosts, inventoryFor }: AgentDeploymentsViewProps) {
  const { t, locale } = useT()
  const c = agentDeploymentsCopy[locale]
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const hostOf = (id: string) => hosts.find((host) => host.id === id)

  const counts = useMemo(() => deployments.reduce<Record<string, number>>((acc, d) => { acc[statusOf(d.status)] = (acc[statusOf(d.status)] ?? 0) + 1; return acc }, {}), [deployments])
  const visible = deployments.filter((d) => filter === 'all' || statusOf(d.status) === filter)
  const groups = useMemo(() => {
    const byHost = new Map<string, McpDeploymentRecord[]>()
    for (const d of visible) byHost.set(d.hostId, [...(byHost.get(d.hostId) ?? []), d])
    return [...byHost.entries()]
  }, [visible])
  const current = visible.find((d) => keyOf(d) === selected) ?? visible[0] ?? null

  const verification = (d: McpDeploymentRecord) => verificationOf(d, t, locale)

  if (deployments.length === 0) {
    return <div className="rounded-xl border border-dashed border-[color:var(--workspace-border-strong)] px-4 py-5 text-sm text-[var(--workspace-text-muted)]">{t('workspace.agentDeployments.empty')}</div>
  }

  return (
    <div data-testid="agent-deployments-view" className="grid min-w-0 gap-4 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
      <div className="sb-card flex min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-[color:var(--workspace-border-soft)] p-2.5">
          {(['all', ...STATUSES] as const).filter((s) => s === 'all' || counts[s]).map((s) => (
            <button key={s} type="button" data-testid={`agent-filter-${s}`} aria-pressed={filter === s} onClick={() => setFilter(s)}
              className={cn('h-6 rounded-md px-2 text-[11px] font-medium', filter === s ? 'bg-primary/10 text-[var(--workspace-accent-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>
              {s === 'all' ? c.all : t(`workspace.agentDeployments.status.${s}`)} <span className="opacity-60">{s === 'all' ? deployments.length : counts[s]}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {groups.map(([hostId, rows]) => {
            const host = hostOf(hostId)
            return (
              <div key={hostId}>
                <div className="flex items-center gap-2 px-3.5 pb-1 pt-3 text-xs">
                  <b className="truncate font-semibold text-[var(--workspace-text-strong)]">{host?.name ?? hostId}</b>
                  {host && <span className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{host.address}</span>}
                  <span className="ml-auto text-[11px] text-[var(--workspace-text-subtle)]">{rows.length}</span>
                </div>
                {rows.map((d) => {
                  const on = current && keyOf(current) === keyOf(d)
                  const v = verification(d)
                  return (
                    <button key={keyOf(d)} type="button" data-testid="agent-deployment-row" aria-current={on ? 'true' : undefined} onClick={() => setSelected(keyOf(d))}
                      className={cn('mx-2 mb-1 grid w-[calc(100%-1rem)] gap-1 rounded-lg px-3 py-2 text-left transition-colors', on ? 'bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-[var(--workspace-surface-800)]')}>
                      <span className="flex min-w-0 items-center gap-2">
                        <b className="truncate text-[13px] font-semibold text-[var(--workspace-text-strong)]">{d.name || d.projectKind}</b>
                        {d.projectKind && <span className="truncate rounded bg-[var(--workspace-surface-700)] px-1.5 text-[10px] text-[var(--workspace-text-muted)]">{d.projectKind}</span>}
                        <span className={cn('ml-auto shrink-0 text-[11px] font-medium', STATUS_TONE[statusOf(d.status)])}>{t(`workspace.agentDeployments.status.${statusOf(d.status)}`)}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-[var(--workspace-text-strong)]"><FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" /><span className="truncate">{d.deploymentPath}</span></span>
                      <span className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--workspace-text-subtle)]">
                        <span className="inline-flex min-w-0 items-center gap-1 truncate"><Bot className="h-3 w-3 shrink-0" />{d.agentName || c.unknownAgent}</span>
                        <span className={cn('ml-auto inline-flex shrink-0 items-center gap-1', v.tone)}><v.icon className="h-3 w-3" />{getAgentDeploymentVerification(d) === 'verified' ? '✓' : v.label}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {current ? <DeploymentDetail key={keyOf(current)} deployment={current} host={hostOf(current.hostId)} scan={hostOf(current.hostId) ? inventoryFor(hostOf(current.hostId)!) : undefined} copied={copied} onCopied={() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }} />
        : <div className="sb-card p-6 text-sm text-[var(--workspace-text-muted)]">{c.select}</div>}
    </div>
  )
}

function DeploymentDetail({ deployment: d, host, scan, copied, onCopied }: { deployment: McpDeploymentRecord; host?: HostProfile; scan?: { inventory?: WorkspaceInventory; updatedAt?: number }; copied: boolean; onCopied: () => void }) {
  const { t, locale } = useT()
  const c = agentDeploymentsCopy[locale]
  const v = verificationOf(d, t, locale)
  const project = scan?.inventory?.projects.find((p) => normalizePath(p.path) === normalizePath(d.deploymentPath))
  const signals = project && scan?.inventory ? getProjectDeploymentSignals(project, scan.inventory, t) : []
  const canOpen = !!host && hasSshConnection(host)
  const kv = (rows: Array<[string, ReactNode | undefined]>) => {
    const shown = rows.filter(([, value]) => value)
    if (!shown.length) return <p className="text-xs text-[var(--workspace-text-subtle)]">—</p>
    return <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">{shown.map(([k, value]) => <div key={k} className="contents"><dt className="text-[var(--workspace-text-muted)]">{k}</dt><dd className="min-w-0 truncate text-[var(--workspace-text-strong)]">{value}</dd></div>)}</dl>
  }
  const mono = (value?: string) => value ? <code className="font-mono text-[11.5px]">{value}</code> : undefined
  const title = (icon: ReactNode, label: string, hint?: string) => <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[var(--workspace-text)]"><span className="inline-flex items-center gap-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-[var(--workspace-text-subtle)]">{icon}{label}</span>{hint && <small className="font-normal text-[var(--workspace-text-subtle)]">{hint}</small>}</div>
  return (
    <section data-testid="agent-deployment-detail" className="sb-card flex min-w-0 flex-col gap-4 p-5">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2.5 text-lg font-semibold text-[var(--workspace-text-strong)]">{d.name || d.projectKind}
            <span className={cn('text-xs font-medium', STATUS_TONE[statusOf(d.status)])}>{t(`workspace.agentDeployments.status.${statusOf(d.status)}`)}</span>
            <span className={cn('inline-flex items-center gap-1 text-xs font-medium', v.tone)}><v.icon className="h-3.5 w-3.5" />{v.label}</span></h3>
          <p className="mt-1 truncate text-xs text-[var(--workspace-text-muted)]">{fill(c.registered, { agent: d.agentName || c.unknownAgent, created: new Date(d.createdAt).toLocaleDateString(locale), updated: new Date(d.updatedAt).toLocaleString(locale) })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" aria-label={c.copyPath} title={c.copyPath} onClick={() => { void navigator.clipboard?.writeText(d.deploymentPath); onCopied() }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button>
          <Button size="sm" variant="outline" data-testid="agent-deployment-sftp" disabled={!canOpen} className="gap-1.5" onClick={() => requestHostSftp({ vaultId: host?.vaultId, hostId: d.hostId, path: d.deploymentPath })}><FolderOpen className="h-3.5 w-3.5" />{c.openSftp}</Button>
          <Button size="sm" data-testid="agent-deployment-terminal" disabled={!canOpen} className="gap-1.5" onClick={() => requestHostTerminal({ vaultId: host?.vaultId, hostId: d.hostId, path: d.deploymentPath })}><Terminal className="h-3.5 w-3.5" />{c.openTerminal}</Button>
        </div>
      </header>

      <div className="grid gap-2 rounded-xl p-4 ring-1 ring-primary/20 [background:linear-gradient(135deg,hsl(var(--primary)/0.10),transparent_60%)]">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="shrink-0 text-[11px] text-[var(--workspace-text-muted)]">{c.directory}</span>
          <code data-testid="agent-deployment-path" className="min-w-0 truncate font-mono text-lg font-semibold text-[var(--workspace-text-strong)]"><span className="text-sm font-normal text-[var(--workspace-text-subtle)]">{host ? `${host.username}@${host.name}:` : ''}</span>{d.deploymentPath}</code>
        </div>
        <div data-testid="agent-deployment-crosscheck" data-state={!scan?.inventory ? 'unscanned' : project ? 'found' : 'missing'} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5 text-[var(--workspace-text-muted)]"><ScanSearch className="h-3.5 w-3.5" />{c.crossCheck}</span>
          {!scan?.inventory ? <span className="text-[var(--workspace-text-subtle)]">{c.notScanned}</span>
            : project ? <><span className="text-[color:var(--workspace-status-good-text)]">● {c.dirFound}</span>{signals.map((signal) => <span key={signal} className="text-[color:var(--workspace-status-good-text)]">● {signal}</span>)}</>
              : <span className="text-[color:var(--workspace-status-warn-text)]">● {c.dirMissing}</span>}
          {scan?.updatedAt && <span className="ml-auto text-[11px] text-[var(--workspace-text-subtle)]">{fill(c.scannedAt, { time: new Date(scan.updatedAt).toLocaleString(locale) })}</span>}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <section>{title(<GitBranch />, c.source)}{kv([[c.repository, d.source?.repository], [c.ref, d.source?.ref], [c.commit, mono(d.source?.commit?.slice(0, 12))], [c.artifact, mono(d.source?.artifact)]])}</section>
        <section>{title(<Cpu />, c.runtime)}{kv([
          [c.language, [d.runtime?.language, d.runtime?.version].filter(Boolean).join(' ') + (d.runtime?.packageManager ? ` · ${d.runtime.packageManager}` : '') || undefined],
          [c.processManager, d.runtime?.processManager], [c.entrypoint, mono(d.runtime?.entrypoint)],
          [c.service, [d.runtime?.serviceName, d.runtime?.containerName].filter(Boolean).join(' · ') || undefined], [c.ports, d.runtime?.ports]])}</section>
      </div>

      {!!d.components?.length && <section>
        {title(<FolderTree />, c.components, fill(c.componentsHint, { count: d.components.length }))}
        <div className="overflow-hidden rounded-lg ring-1 ring-[color:var(--workspace-border-soft)]">
          {d.components.map((component, index) => (
            <div key={`${component.name}:${index}`} className="grid grid-cols-[5rem_minmax(6rem,9rem)_minmax(0,1fr)_auto] items-center gap-3 border-t border-[color:var(--workspace-border-soft)] px-3 py-1.5 text-xs first:border-t-0">
              <span className="truncate font-mono text-[10.5px] text-[var(--workspace-text-subtle)]">{component.type}</span>
              <b className="truncate font-semibold text-[var(--workspace-text-strong)]">{component.name}{component.version && <small className="ml-1.5 font-mono font-normal text-[var(--workspace-text-subtle)]">{component.version}</small>}</b>
              <code className="truncate font-mono text-[11px] text-[var(--workspace-text)]" title={component.path}>{component.path ?? '—'}</code>
              <span className="text-[11px] text-[var(--workspace-text-muted)]">{component.status ?? ''}</span>
            </div>
          ))}
        </div>
      </section>}

      {(!!d.dependencies?.length || d.notes) && <div className="grid gap-5 md:grid-cols-2">
        {!!d.dependencies?.length && <section>{title(<Package />, c.dependencies, String(d.dependencies.length))}
          <div className="flex flex-wrap gap-1.5">{d.dependencies.slice(0, 18).map((dep, index) => <span key={`${dep.name}:${index}`} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-[var(--workspace-surface-800)] px-2 font-mono text-[11px] text-[var(--workspace-text-subtle)]"><b className="font-medium text-[var(--workspace-text-strong)]">{dep.name}</b>{dep.version}</span>)}
            {d.dependencies.length > 18 && <span className="inline-flex h-6 items-center px-1 text-[11px] text-[var(--workspace-accent-text)]">+{d.dependencies.length - 18}</span>}</div></section>}
        {d.notes && <section className="flex gap-2.5 rounded-lg bg-[var(--workspace-surface-800)] p-3"><MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" /><div className="min-w-0"><b className="text-xs font-semibold text-[var(--workspace-text)]">{c.notes}</b><p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--workspace-text-muted)]">{d.notes}</p></div></section>}
      </div>}

      <p className="text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{c.footnote}</p>
    </section>
  )
}
