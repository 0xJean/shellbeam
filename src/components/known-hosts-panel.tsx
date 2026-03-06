import { useEffect, useMemo, useState } from 'react'
import { Shield, Trash2, RefreshCw, Fingerprint, ShieldAlert, ShieldCheck, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  listKnownHosts,
  removeKnownHost,
  type KnownHostEntry,
} from '@/lib/known-hosts'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

interface KnownHostsPanelProps {
  onOutput?: (message: string) => void
  onError?: (message: string) => void
}

export function KnownHostsPanel({ onOutput, onError }: KnownHostsPanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<KnownHostEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  async function refresh() {
    setLoading(true)
    try {
      const items = await listKnownHosts()
      setEntries(items)
    } catch (e) {
      onError?.(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries
    const q = search.toLowerCase()
    return entries.filter((e) =>
      e.host.toLowerCase().includes(q) ||
      e.keyType.toLowerCase().includes(q) ||
      e.fingerprintSha256.toLowerCase().includes(q),
    )
  }, [entries, search])

  async function handleRemove(entry: KnownHostEntry) {
    try {
      await removeKnownHost(entry.host, entry.port)
      await refresh()
      onOutput?.(`Removed known host: ${entry.host}:${entry.port}`)
    } catch (e) {
      onError?.(String(e))
    }
  }

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex w-full flex-col">
      {/* Title section */}
      <div className="shrink-0 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Shield className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{t('knownHosts.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('knownHosts.desc')}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? '' : t('knownHosts.refresh')}
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="min-h-0 flex-1">
        <div className="flex min-h-[200px] min-w-0 flex-1 flex-col px-6">
          {entries.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('hosts.search')} className="h-9 pl-9 text-sm" />
              </div>
              <div className="flex-1" />
              <p className="text-xs text-muted-foreground">
                {t('knownHosts.verified', { n: entries.length })}
              </p>
            </div>
          )}

          {/* Host list */}
          <div className="pb-6">
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border py-16">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Fingerprint className="h-7 w-7" />
                </div>
                <div className="text-center">
                  <p className="font-medium">
                    {entries.length === 0 ? t('knownHosts.empty') : t('hosts.noMatch')}
                  </p>
                  <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                    {entries.length === 0 ? t('knownHosts.emptyHint') : t('hosts.noMatchHint')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredEntries.map((entry) => (
                  <div
                    key={`${entry.host}:${entry.port}`}
                    className="group flex items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/30"
                  >
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                      <ShieldCheck className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">{entry.host}</p>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          :{entry.port}
                        </span>
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {entry.keyType}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={entry.fingerprintSha256}>
                        {entry.fingerprintSha256}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {t('knownHosts.recorded', { date: formatDate(entry.addedAt) })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleRemove(entry)}
                      title={t('knownHosts.remove')}
                      className="shrink-0 text-muted-foreground opacity-100 transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {entries.length > 0 && (
              <div className="mt-6 flex items-start gap-2 rounded-lg bg-muted/40 px-4 py-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('knownHosts.mitmWarning')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
