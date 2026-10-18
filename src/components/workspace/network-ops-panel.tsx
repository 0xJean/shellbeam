import { useCallback, useEffect, useRef, useState } from 'react'
import { Network, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HealthChecksPanel } from '@/components/health-checks-panel'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { collectNetworkOps, networkPortCommand, networkProcessCommand, type NetworkOpsSnapshot, type NetworkSocket } from '@/lib/network-ops'

export interface NetworkOpsPanelProps {
  host: HostProfile
  vaultId?: string
  resolveAuthSecret: (host: HostProfile) => Promise<string>
  onOpenServices?: () => void
  onOpenLogs?: (service?: string) => void
  onOpenTerminal?: (command: string) => void
}

export function NetworkOpsPanel({ host, vaultId, resolveAuthSecret, onOpenServices, onOpenLogs, onOpenTerminal }: NetworkOpsPanelProps) {
  const { t } = useT()
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<{ scope: string; snapshot: NetworkOpsSnapshot } | null>(null)
  const [filter, setFilter] = useState('')
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
  function sockets(rows: NetworkSocket[]) {
    const visible = rows.filter((row) => !query || [row.protocol, row.state, row.localAddress, row.remoteAddress, row.pid, row.process].some((value) => value?.toLowerCase().includes(query)))
    return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b"><th className="p-2">{t('workspace.network.protocol')}</th><th className="p-2">{t('workspace.network.state')}</th><th className="p-2">{t('workspace.network.local')}</th><th className="p-2">{t('workspace.network.peer')}</th><th className="p-2">{t('workspace.network.process')}</th></tr></thead><tbody>{visible.map((row, index) => <tr key={`${row.protocol}:${row.localAddress}:${row.remoteAddress}:${index}`} className="border-b border-border/40">
      <td className="p-2">{row.protocol}</td><td className="p-2">{row.state}</td>
      <td className="p-2 font-mono">{row.localAddress}{row.port !== null && onOpenTerminal && <button type="button" className="ml-2 underline" onClick={() => onOpenTerminal(networkPortCommand(row.port!))}>{t('workspace.network.inspectPort', { port: row.port })}</button>}</td>
      <td className="p-2 font-mono">{row.remoteAddress}</td><td className="p-2">{row.process ?? t('workspace.network.processHidden')}{row.pid && onOpenTerminal && <button type="button" className="ml-2 underline" onClick={() => onOpenTerminal(networkProcessCommand(row.pid!))}>{t('workspace.network.inspectPid', { pid: row.pid })}</button>}</td>
    </tr>)}</tbody></table>{visible.length === 0 && <p className="p-3 text-xs text-muted-foreground">{t('workspace.network.empty')}</p>}</div>
  }
  return <div data-testid="network-ops-panel" className="space-y-4">
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Network className="h-5 w-5" />{t('workspace.network.title')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('workspace.network.description')}</p></div><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'} />{t('workspace.network.refresh')}</Button></div>
      <div className="flex flex-wrap items-center gap-3 text-xs"><span>{t('workspace.network.transport')}: {snapshot?.transport ?? (host.jumpHost?.trim() ? 'proxy-jump' : 'direct')}</span>{snapshot && <span>{t('workspace.network.sampledAt')}: {new Date(snapshot.sampledAt).toLocaleTimeString()}</span>}<span role="status">{loading ? t('workspace.network.loading') : t(`workspace.network.status.${snapshot?.status ?? 'unknown'}`)}</span></div>
      <div className="flex flex-wrap gap-2">{onOpenServices && <Button size="sm" variant="outline" onClick={onOpenServices}>{t('workspace.network.openServices')}</Button>}{onOpenLogs && <Button size="sm" variant="outline" onClick={() => onOpenLogs()}>{t('workspace.network.openLogs')}</Button>}{onOpenTerminal && <Button size="sm" variant="outline" onClick={() => onOpenTerminal('ss -lntup; ip address show; ip route show')}>{t('workspace.network.openTerminal')}</Button>}</div>
      {snapshot?.status === 'unsupported' ? <p className="rounded border border-dashed p-4 text-sm">{t('workspace.network.unsupported')}</p> : snapshot?.status === 'unknown' ? <p role="alert" className="rounded border border-amber-500/30 p-4 text-sm">{t('workspace.network.unknown')}</p> : snapshot && <>
        <input aria-label={t('workspace.network.filter')} placeholder={t('workspace.network.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} className="w-full rounded border bg-background p-2 text-sm" />
        <p className="text-xs text-muted-foreground">{t('workspace.network.processNote')}</p>
        <section aria-label={t('workspace.network.listeners')}><h3 className="font-medium">{t('workspace.network.listeners')}</h3>{snapshot.sections.LISTEN === 'ready' ? sockets(snapshot.listeners) : <p className="p-3 text-xs">{t(`workspace.network.section.${snapshot.sections.LISTEN}`)}</p>}</section>
        <section aria-label={t('workspace.network.connections')}><h3 className="font-medium">{t('workspace.network.connections')} ({snapshot.connections.length})</h3>{snapshot.sections.CONNECTIONS === 'ready' ? sockets(snapshot.connections) : <p className="p-3 text-xs">{t(`workspace.network.section.${snapshot.sections.CONNECTIONS}`)}</p>}</section>
        <section aria-label={t('workspace.network.interfaces')}><h3 className="font-medium">{t('workspace.network.interfaces')}</h3>{snapshot.sections.INTERFACES === 'ready' ? <ul className="mt-2 space-y-1 font-mono text-xs">{snapshot.interfaces.map((row, index) => <li key={`${row.name}:${row.address}:${index}`}>{row.name} · {row.family} · {row.address}</li>)}</ul> : <p className="p-3 text-xs">{t(`workspace.network.section.${snapshot.sections.INTERFACES}`)}</p>}</section>
        <section aria-label={t('workspace.network.routes')}><h3 className="font-medium">{t('workspace.network.routes')}</h3>{snapshot.sections.ROUTES === 'ready' ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{snapshot.routes.join('\n') || t('workspace.network.empty')}</pre> : <p className="p-3 text-xs">{t(`workspace.network.section.${snapshot.sections.ROUTES}`)}</p>}</section>
        {snapshot.sections.SUMMARY === 'ready' && <pre aria-label={t('workspace.network.summary')} className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">{snapshot.summary || t('workspace.network.empty')}</pre>}
        {snapshot.truncated.length > 0 && <p className="text-xs text-amber-600">{t('workspace.network.truncated')}</p>}
      </>}
    </section>
    <HealthChecksPanel activeVaultId={vaultId ?? host.vaultId} host={host} resolveAuthSecret={resolveAuthSecret} />
  </div>
}

export default NetworkOpsPanel
