import { useEffect, useMemo, useRef, useState } from 'react'
import { useVault } from '@/contexts/vault-context'
import { Trash2, RefreshCw, Fingerprint, ShieldAlert, Search, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedTabs } from '@/components/charts/chart-primitives'
import {
  listKnownHosts,
  removeKnownHost,
  type KnownHostEntry,
} from '@/lib/known-hosts'
import type { HostProfile } from '@/lib/hosts'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { knownHostsV3Copy } from '@/lib/locales/known-history-v3'
import { fill } from '@/lib/locales/probe-install'

type KnownHostFilter = 'all' | 'associated' | 'unassociated'

interface KnownHostsPanelProps {
  onOutput?: (message: string) => void
  onError?: (message: string) => void
  /** Saved hosts; when given, records are matched by address and port to show the host name. */
  hosts?: HostProfile[]
}

export function KnownHostsPanel({ onOutput, onError, hosts }: KnownHostsPanelProps) {
  const { t, locale } = useT()
  const c = knownHostsV3Copy[locale]
  const [entries, setEntries] = useState<KnownHostEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<KnownHostFilter>('all')
  // Known hosts are per vault; a late reply for a previous vault is dropped.
  const { activeVaultId } = useVault()
  const requestRef = useRef(0)

  async function refresh() {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const items = await listKnownHosts(activeVaultId)
      if (request === requestRef.current) setEntries(items)
    } catch (e) {
      if (request === requestRef.current) onError?.(String(e))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh reads only activeVaultId
  useEffect(() => { void refresh() }, [activeVaultId])

  const hostNameByEndpoint = useMemo(() => {
    const map = new Map<string, string>()
    for (const host of hosts ?? []) map.set(`${host.address.toLowerCase()}:${host.port}`, host.name)
    return map
  }, [hosts])
  const hostNameOf = (entry: KnownHostEntry) => hostNameByEndpoint.get(`${entry.host.toLowerCase()}:${entry.port}`)
  const associatedCount = hosts ? entries.filter((entry) => hostNameOf(entry)).length : entries.length

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      const name = hostNameByEndpoint.get(`${e.host.toLowerCase()}:${e.port}`)
      if (hosts && filter === 'associated' && !name) return false
      if (hosts && filter === 'unassociated' && name) return false
      if (!q) return true
      return e.host.toLowerCase().includes(q) ||
        e.keyType.toLowerCase().includes(q) ||
        e.fingerprintSha256.toLowerCase().includes(q) ||
        Boolean(name?.toLowerCase().includes(q))
    })
  }, [entries, search, filter, hosts, hostNameByEndpoint])

  async function handleRemove(entry: KnownHostEntry) {
    try {
      await removeKnownHost(activeVaultId, entry.host, entry.port)
      await refresh()
      onOutput?.(`Removed known host: ${entry.host}:${entry.port}`)
    } catch (e) {
      onError?.(String(e))
    }
  }

  async function handleCopy(entry: KnownHostEntry) {
    try {
      await navigator.clipboard.writeText(entry.fingerprintSha256)
      onOutput?.(c.copied)
    } catch (e) {
      onError?.(String(e))
    }
  }

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
  const formatDateTime = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const th = 'px-4 py-2.5 text-xs font-medium text-[var(--workspace-text-subtle)]'

  return (
    <div data-tour="known-hosts-page" className="flex w-full flex-col gap-4 px-6 py-6 text-[var(--workspace-text)]">
      <header data-tour="known-hosts-header" className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[26px] font-bold tracking-tight text-[var(--workspace-text-strong)]">{t('knownHosts.title')}</h2>
          <p className="mt-1 text-[13px] text-[var(--workspace-text-muted)]">
            {entries.length > 0 ? fill(c.summary, { n: entries.length }) : t('knownHosts.desc')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {loading ? '' : t('knownHosts.refresh')}
        </Button>
      </header>

      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={c.search} className="h-9 pl-9 text-sm" />
          </div>
          {hosts && (
            <SegmentedTabs<KnownHostFilter>
              label={c.filterLabel}
              size="md"
              value={filter}
              onChange={setFilter}
              options={([
                ['all', c.all, entries.length],
                ['associated', c.associated, associatedCount],
                ['unassociated', c.unassociated, entries.length - associatedCount],
              ] as const).map(([value, label, n]) => ({
                value,
                label: <>{label} <span className="ml-0.5 font-mono text-[10px] text-[var(--workspace-text-subtle)]">{n}</span></>,
              }))}
            />
          )}
        </div>
      )}

      {filteredEntries.length === 0 ? (
        <div data-tour="known-hosts-list" className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[color:var(--workspace-border-soft)] py-16">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]">
            <Fingerprint className="h-7 w-7" />
          </div>
          <div className="text-center">
            <p className="font-medium text-[var(--workspace-text-strong)]">
              {entries.length === 0 ? t('knownHosts.empty') : t('hosts.noMatch')}
            </p>
            <p className="mt-1 max-w-xs text-sm text-[var(--workspace-text-muted)]">
              {entries.length === 0 ? t('knownHosts.emptyHint') : t('hosts.noMatchHint')}
            </p>
          </div>
        </div>
      ) : (
        <div data-tour="known-hosts-list" className="sb-card overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-[color:var(--workspace-border-soft)]">
                <th className={th}>{c.colHost}</th>
                <th className={th}>{c.colKeyType}</th>
                <th className={th}>{c.colFingerprint}</th>
                <th className={th}>{c.colAdded}</th>
                <th className={th}>{c.colStatus}</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry) => {
                const name = hostNameOf(entry)
                const unassociated = Boolean(hosts) && !name
                return (
                  <tr
                    key={`${entry.host}:${entry.port}`}
                    className="group border-b border-[color:var(--workspace-border-soft)] transition-colors last:border-0 hover:bg-[var(--workspace-surface-800)]"
                  >
                    <td className="px-4 py-2.5">
                      <p className={cn('truncate font-medium', unassociated ? 'text-[var(--workspace-text-muted)]' : 'text-[var(--workspace-text-strong)]')}>
                        {name ?? (unassociated ? c.unassociatedName : entry.host)}
                      </p>
                      <p className="truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{entry.host}:{entry.port}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="rounded border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--workspace-text)]">
                        {entry.keyType}
                      </span>
                    </td>
                    <td className="max-w-[16rem] px-4 py-2.5">
                      <p className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]" title={entry.fingerprintSha256}>
                        {entry.fingerprintSha256}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-[var(--workspace-text-muted)]" title={t('knownHosts.recorded', { date: formatDateTime(entry.addedAt) })}>
                      {formatDate(entry.addedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', unassociated ? 'text-[var(--workspace-text-subtle)]' : 'text-[var(--workspace-status-good-text)]')}>
                        <span className={cn('h-1.5 w-1.5 rounded-full', unassociated ? 'bg-[var(--workspace-text-subtle)]' : 'bg-[var(--workspace-status-good)]')} />
                        {unassociated ? c.unassociatedHost : c.verified}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleCopy(entry)}
                        title={c.copy}
                        aria-label={c.copy}
                        className="h-7 w-7 p-0 text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text-strong)]"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleRemove(entry)}
                        title={t('knownHosts.remove')}
                        className="h-7 w-7 p-0 text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-status-bad-text)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-4 py-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-status-warn)]" />
          <p className="text-xs leading-relaxed text-[var(--workspace-text-muted)]">
            {t('knownHosts.mitmWarning')}
          </p>
        </div>
      )}
    </div>
  )
}
