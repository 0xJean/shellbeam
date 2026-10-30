import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Boxes, Cpu, Info, Radar, RefreshCw, ScrollText, Search, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HealthChecksPanel } from '@/components/health-checks-panel'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceNetLogsCopy } from '@/lib/locales/workspace-netlogs'
import { collectNetworkOps, networkPortCommand, networkProcessCommand, type NetworkOpsSnapshot, type NetworkSocket } from '@/lib/network-ops'
import { cn } from '@/lib/utils'

export interface NetworkOpsPanelProps {
  host: HostProfile
  vaultId?: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenServices?: () => void
  onOpenLogs?: (service?: string) => void
  onOpenTerminal?: (command: string) => void
}

type NetworkTab = 'ports' | 'iface' | 'health'
const chip = 'inline-flex h-[22px] items-center rounded-md px-2 text-[11px] font-medium'
const neutralChip = `${chip} bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]`
const th = 'px-3 py-2 text-xs font-medium text-[var(--workspace-text-subtle)]'
const quietAction = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-[var(--workspace-text-muted)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]'

function CardHead({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
    <h3 className="flex items-baseline gap-2 text-[13px] font-semibold text-[var(--workspace-text-strong)]">{title}{meta != null && <small className="text-xs font-normal text-[var(--workspace-text-subtle)]">{meta}</small>}</h3>
    {children}
  </div>
}

export function NetworkOpsPanel({ host, vaultId, resolveAuthSecret, onOpenServices, onOpenLogs, onOpenTerminal }: NetworkOpsPanelProps) {
  const { t, locale } = useT()
  const c = workspaceNetLogsCopy[locale]
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<{ scope: string; snapshot: NetworkOpsSnapshot } | null>(null)
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<NetworkTab>('ports')
  const scope = `${vaultId ?? host.vaultId ?? ''}:${host.id}`
  const generation = useRef(0)
  const snapshot = state?.scope === scope ? state.snapshot : null
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    const snapshot = await collectNetworkOps({ host, vaultId, resolveAuthSecret })
    if (request !== generation.current) return
    setState({ scope, snapshot })
    setLoading(false)
  }, [host, vaultId, resolveAuthSecret, scope])
  useEffect(() => {
    const requests = generation
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false; requests.current++ }
  }, [load])
  const query = filter.trim().toLowerCase()
  const transport = snapshot?.transport ?? (host.jumpHost?.trim() ? 'proxy-jump' : 'direct')
  const status = snapshot?.status ?? 'unknown'
  const statusTone = loading ? neutralChip : status === 'ready' ? `${chip} bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]` : status === 'partial' ? `${chip} bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]` : `${chip} bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]`
  const filtered = (rows: NetworkSocket[]) => rows.filter((row) => !query || [row.protocol, row.state, row.localAddress, row.remoteAddress, row.pid, row.process].some((value) => value?.toLowerCase().includes(query)))
  function sockets(visible: NetworkSocket[]) {
    return <div className="overflow-x-auto"><table className="w-full text-left text-[13px]"><thead><tr className="border-b border-[color:var(--workspace-border-soft)]"><th className={th}>{t('workspace.network.protocol')}</th><th className={th}>{t('workspace.network.state')}</th><th className={th}>{t('workspace.network.local')}</th><th className={th}>{t('workspace.network.peer')}</th><th className={th}>{t('workspace.network.process')}</th>{onOpenTerminal && <th className={th} />}</tr></thead><tbody>{visible.map((row, index) => <tr key={`${row.protocol}:${row.localAddress}:${row.remoteAddress}:${index}`} className="border-b border-[color:var(--workspace-border-soft)] last:border-0 hover:bg-[var(--workspace-surface-row)]">
      <td className="px-3 py-2 font-mono text-xs text-[var(--workspace-text-strong)]">{row.protocol}</td>
      <td className="px-3 py-2"><span className={cn(neutralChip, 'font-mono')}>{row.state}</span></td>
      <td className="px-3 py-2 font-mono text-xs text-[var(--workspace-text-strong)]">{row.localAddress}</td>
      <td className="px-3 py-2 font-mono text-xs text-[var(--workspace-text-subtle)]">{row.remoteAddress}</td>
      <td className="px-3 py-2 text-[var(--workspace-text)]">{row.process ?? <span className="text-[var(--workspace-text-subtle)]">{t('workspace.network.processHidden')}</span>}{row.pid && <span className="ml-1.5 font-mono text-[11px] text-[var(--workspace-text-subtle)]">PID {row.pid}</span>}</td>
      {onOpenTerminal && <td className="px-3 py-1.5"><div className="flex justify-end gap-1 whitespace-nowrap">
        {row.port !== null && <button type="button" className={quietAction} onClick={() => onOpenTerminal(networkPortCommand(row.port!))}><Radar aria-hidden="true" className="h-3.5 w-3.5" />{t('workspace.network.inspectPort', { port: row.port })}</button>}
        {row.pid && <button type="button" className={quietAction} onClick={() => onOpenTerminal(networkProcessCommand(row.pid!))}><Cpu aria-hidden="true" className="h-3.5 w-3.5" />{t('workspace.network.inspectPid', { pid: row.pid })}</button>}
      </div></td>}
    </tr>)}</tbody></table>{visible.length === 0 && <p className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{t('workspace.network.empty')}</p>}</div>
  }
  const sectionNote = (value: string) => <p className="px-4 py-3 text-xs text-[var(--workspace-text-muted)]">{t(`workspace.network.section.${value}`)}</p>
  const listeners = snapshot ? filtered(snapshot.listeners) : []
  const connections = snapshot ? filtered(snapshot.connections) : []
  const blocked = snapshot?.status === 'unsupported' ? <p className="sb-card border-dashed p-4 text-sm text-[var(--workspace-text-muted)]">{t('workspace.network.unsupported')}</p> : snapshot?.status === 'unknown' ? <p role="alert" className="rounded-xl border border-[color:var(--workspace-status-warn-border)] bg-[var(--workspace-status-warn-bg)] p-4 text-sm text-[color:var(--workspace-status-warn-text)]">{t('workspace.network.unknown')}</p> : null
  const tabs: Array<[NetworkTab, string]> = [['ports', c.tabPorts], ['iface', c.tabIface], ['health', c.tabHealth]]
  return <div data-testid="network-ops-panel" data-host-id={host.id} className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-[var(--workspace-text-strong)]">{t('workspace.network.title')}</h2><p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{c.netSubtitle}</p></div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap gap-1.5">
          <span className={neutralChip} title={`${t('workspace.network.transport')}: ${transport}`}>{transport === 'proxy-jump' ? c.proxyJump : c.direct}</span>
          {snapshot && <span className={neutralChip} title={t('workspace.network.sampledAt')}>{fill(c.sampled, { time: new Date(snapshot.sampledAt).toLocaleTimeString() })}</span>}
          <span role="status" className={statusTone}>{loading ? t('workspace.network.loading') : t(`workspace.network.status.${status}`)}</span>
        </div>
        {onOpenServices && <Button size="sm" variant="ghost" onClick={onOpenServices}><Boxes className="mr-1 h-4 w-4" />{t('workspace.network.openServices')}</Button>}
        {onOpenLogs && <Button size="sm" variant="ghost" onClick={() => onOpenLogs()}><ScrollText className="mr-1 h-4 w-4" />{t('workspace.network.openLogs')}</Button>}
        {onOpenTerminal && <Button size="sm" variant="outline" onClick={() => onOpenTerminal('ss -lntup; ip address show; ip route show')}><SquareTerminal className="mr-1 h-4 w-4" />{t('workspace.network.openTerminal')}</Button>}
        <Button type="button" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'} />{t('workspace.network.refresh')}</Button>
      </div>
    </div>
    <div role="tablist" aria-label={c.netTabs} className="flex gap-5 border-b border-[color:var(--workspace-border-soft)]">
      {tabs.map(([key, label]) => <button key={key} data-testid={`network-tab-${key}`} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
        className={cn('-mb-px border-b-2 pb-2.5 text-[13px] font-medium transition-colors', tab === key ? 'border-primary text-[var(--workspace-text-strong)]' : 'border-transparent text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text-strong)]')}>{label}</button>)}
    </div>
    <div role="tabpanel" aria-label={c.tabPorts} hidden={tab !== 'ports'} className="space-y-3">
      {blocked ?? (snapshot && <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex h-8 w-full max-w-sm items-center gap-2 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-input)] px-2.5 text-[var(--workspace-text-subtle)] focus-within:ring-1 focus-within:ring-primary">
            <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <input aria-label={t('workspace.network.filter')} placeholder={t('workspace.network.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
          </label>
          {onOpenTerminal && <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-subtle)]"><Info aria-hidden="true" className="h-3.5 w-3.5" />{c.terminalNote}</span>}
        </div>
        <section aria-label={t('workspace.network.listeners')} className="sb-card overflow-hidden"><CardHead title={t('workspace.network.listeners')} meta={snapshot.sections.LISTEN === 'ready' ? (query ? fill(c.shownRows, { total: snapshot.listeners.length, shown: listeners.length }) : snapshot.listeners.length) : undefined} />{snapshot.sections.LISTEN === 'ready' ? sockets(listeners) : sectionNote(snapshot.sections.LISTEN)}</section>
        <section aria-label={t('workspace.network.connections')} className="sb-card overflow-hidden"><CardHead title={t('workspace.network.connections')} meta={snapshot.sections.CONNECTIONS === 'ready' ? (query ? fill(c.shownRows, { total: snapshot.connections.length, shown: connections.length }) : snapshot.connections.length) : undefined} />{snapshot.sections.CONNECTIONS === 'ready' ? sockets(connections) : sectionNote(snapshot.sections.CONNECTIONS)}</section>
        <p className="text-xs text-[var(--workspace-text-subtle)]">{t('workspace.network.processNote')}</p>
        {snapshot.truncated.length > 0 && <p className="text-xs text-[color:var(--workspace-status-warn-text)]">{t('workspace.network.truncated')}</p>}
      </>)}
    </div>
    <div role="tabpanel" aria-label={c.tabIface} hidden={tab !== 'iface'}>
      {blocked ?? (snapshot && <div className="grid gap-3 lg:grid-cols-2">
        <section aria-label={t('workspace.network.interfaces')} className="sb-card overflow-hidden"><CardHead title={t('workspace.network.interfaces')} />{snapshot.sections.INTERFACES === 'ready' ? <ul className="divide-y divide-[color:var(--workspace-border-soft)] font-mono text-xs">{snapshot.interfaces.map((row, index) => <li key={`${row.name}:${row.address}:${index}`} className="flex items-center gap-3 px-4 py-2.5">
          <b className="w-20 shrink-0 truncate font-semibold text-[var(--workspace-text-strong)]">{row.name}</b><span className={neutralChip}>{row.family}</span><span className="min-w-0 break-all text-[var(--workspace-text)]">{row.address}</span>
        </li>)}</ul> : sectionNote(snapshot.sections.INTERFACES)}</section>
        <div className="space-y-3">
          <section aria-label={t('workspace.network.routes')} className="sb-card overflow-hidden"><CardHead title={t('workspace.network.routes')}><code className="text-[11px] text-[var(--workspace-text-subtle)]">ip route show</code></CardHead>{snapshot.sections.ROUTES === 'ready' ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-[var(--workspace-text)]">{snapshot.routes.join('\n') || t('workspace.network.empty')}</pre> : sectionNote(snapshot.sections.ROUTES)}</section>
          {snapshot.sections.SUMMARY === 'ready' && <section className="sb-card overflow-hidden"><CardHead title={t('workspace.network.summary')}><code className="text-[11px] text-[var(--workspace-text-subtle)]">ss -s</code></CardHead><pre aria-label={t('workspace.network.summary')} className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-[var(--workspace-text)]">{snapshot.summary || t('workspace.network.empty')}</pre></section>}
        </div>
      </div>)}
    </div>
    <div role="tabpanel" aria-label={c.tabHealth} hidden={tab !== 'health'}>
      <HealthChecksPanel activeVaultId={vaultId ?? host.vaultId} host={host} resolveAuthSecret={resolveAuthSecret} />
    </div>
  </div>
}

export default NetworkOpsPanel
