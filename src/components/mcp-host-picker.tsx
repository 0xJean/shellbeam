import { useId, useState } from 'react'
import { Search, Server, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect } from '@/components/ui/select'
import { hostConnections, type HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { mcpAccessCopy } from '@/lib/locales/mcp-access'
import { cn } from '@/lib/utils'

export type McpHostSelection = { hostIds: string[]; connectionIds: Record<string, string[]> }

/** Only a stored default may be preselected. A missing default never grants another account. */
function defaultMcpConnections(host: HostProfile): string[] {
  const id = host.defaultConnectionId ?? (host.connections == null ? host.id : null)
  return hostConnections(host).some(connection => connection.id === id) ? [id!] : []
}

export function McpHostPicker({ hosts, selection, onChange, disabled, loading }: {
  hosts: HostProfile[]; selection: McpHostSelection; onChange: (next: McpHostSelection) => void
  disabled: boolean; loading: boolean
}) {
  const { locale, t } = useT(); const c = mcpAccessCopy[locale]
  const resultsId = useId()
  const [query, setQuery] = useState(''); const [group, setGroup] = useState(''); const [selectedOnly, setSelectedOnly] = useState(false)
  const groups = Array.from(new Set(hosts.map(host => host.group).filter(Boolean))).sort()
  const groupName = (value: string) => { const key = `group.${value}`; const translated = t(key); return translated === key ? value : translated }
  const filtered = hosts.filter(host => (!group || host.group === group) && (!selectedOnly || selection.hostIds.includes(host.id)) &&
    [host.name, host.group, groupName(host.group ?? ''), ...(host.tags ?? []), ...hostConnections(host).flatMap(conn => [conn.label, conn.address, conn.username]), host.address].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const missing = filtered.filter(host => !selection.hostIds.includes(host.id))
  const allSelected = filtered.length > 0 && missing.length === 0
  const partiallySelected = missing.length > 0 && missing.length < filtered.length
  const exceedsLimit = selection.hostIds.length + missing.length > 100
  function select(hostsToAdd: HostProfile[]) {
    const additions = hostsToAdd.filter(host => !selection.hostIds.includes(host.id))
    if (disabled || selection.hostIds.length + additions.length > 100) return
    onChange({ hostIds: [...selection.hostIds, ...additions.map(host => host.id)],
      connectionIds: { ...selection.connectionIds, ...Object.fromEntries(additions.map(host => [host.id, defaultMcpConnections(host)])) } })
  }
  function remove(ids: string[]) {
    if (disabled) return
    const removing = new Set(ids)
    const remaining = { ...selection.connectionIds }; ids.forEach(id => { delete remaining[id] })
    onChange({ hostIds: selection.hostIds.filter(value => !removing.has(value)), connectionIds: remaining })
  }
  return <fieldset disabled={disabled} data-tour="mcp-hosts" className="min-w-0 space-y-3">
    <legend className="mb-1 text-sm font-medium">{c.hosts}</legend>
    <div className="flex flex-wrap gap-2">
      <div className="relative min-w-0 flex-[1_1_240px]"><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={event => setQuery(event.target.value)} className="pl-9" /></div>
      <NativeSelect aria-label={c.group} className="h-9 w-40 max-w-full rounded-md border bg-background px-3 text-sm" value={group} onChange={event => setGroup(event.target.value)}><option value="">{c.allGroups}</option>{groups.map(value => <option key={value} value={value}>{groupName(value)}</option>)}</NativeSelect>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium">
          <Checkbox aria-label={c.selectAll} aria-describedby={resultsId} className="h-[18px] w-[18px]" checked={allSelected} indeterminate={partiallySelected} disabled={disabled || loading || !filtered.length || (!allSelected && exceedsLimit)} onChange={event => event.target.checked ? select(filtered) : remove(filtered.map(host => host.id))} />
          {c.selectAll}
        </label>
        <span id={resultsId} className="text-muted-foreground">{c.results} {filtered.length}</span>
        <span aria-live="polite" className="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">{c.selected} {selection.hostIds.length}/100</span>
      </div>
      <div className="flex flex-wrap items-center gap-1"><Button type="button" size="sm" variant={selectedOnly ? 'secondary' : 'ghost'} aria-pressed={selectedOnly} onClick={() => setSelectedOnly(!selectedOnly)}>{c.selectedOnly}</Button><Button type="button" size="sm" variant="ghost" disabled={!selection.hostIds.length} onClick={() => onChange({ hostIds: [], connectionIds: {} })}>{c.clear}</Button></div>
    </div>
    {exceedsLimit && <p className="text-xs text-amber-600 dark:text-amber-400">{c.limit}</p>}
    <div className="max-h-80 overflow-y-auto rounded-xl border divide-y" data-testid="mcp-host-options">
      {loading ? <p className="p-6 text-center text-sm text-muted-foreground">{c.loading}</p> : filtered.map(host => {
        const checked = selection.hostIds.includes(host.id); const connections = hostConnections(host); const chosen = selection.connectionIds[host.id] ?? []
        return <div key={host.id} className={cn('p-3', checked && 'bg-primary/5')}>
          <label className="flex cursor-pointer items-center gap-3">
            <Checkbox  aria-label={host.name} checked={checked} disabled={disabled || (!checked && selection.hostIds.length >= 100)} onChange={event => event.target.checked ? select([host]) : remove([host.id])} />
            <Server aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{host.name}</span><span className="block break-all text-xs text-muted-foreground">{connections.length ? `${host.username}@${host.address}:${host.port}` : c.monitoringOnly}</span></span>
            {host.group && <span className="max-w-24 truncate rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground" title={groupName(host.group)}>{groupName(host.group)}</span>}
          </label>
          {checked && connections.length > 0 && <div className="ml-7 mt-3 space-y-2 border-t pt-2">
            <p className="text-[11px] text-muted-foreground">{c.connections}</p>
            {connections.map(connection => <label key={connection.id} className="flex cursor-pointer items-start gap-2 text-xs">
              <Checkbox  aria-label={`${host.name} · ${connection.label} · ${connection.username}@${connection.address}:${connection.port}`} checked={chosen.includes(connection.id)} onChange={event => onChange({ ...selection, connectionIds: { ...selection.connectionIds, [host.id]: event.target.checked ? [...chosen, connection.id] : chosen.filter(id => id !== connection.id) } })} />
              <span className="min-w-0 break-all">{connection.label} · {connection.username}@{connection.address}:{connection.port}{defaultMcpConnections(host).includes(connection.id) && <span className="ml-2 text-muted-foreground">{c.default}</span>}</span>
            </label>)}
            {!chosen.length && <p className="text-xs text-muted-foreground">{c.noConnection} · {c.cacheOnly}</p>}
          </div>}
          {checked && !connections.length && <p className="ml-7 mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Check aria-hidden className="h-3 w-3" />{c.cacheOnly}</p>}
        </div>
      })}
      {!loading && !filtered.length && <p className="p-6 text-center text-sm text-muted-foreground">{hosts.length ? c.noMatches : t('mcp.noServers')}</p>}
    </div>
    <p className="text-xs text-muted-foreground">{c.hostHint} {c.connectionHint}</p>
  </fieldset>
}
