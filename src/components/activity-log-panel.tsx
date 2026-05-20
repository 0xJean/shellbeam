import { useEffect, useState, useCallback } from 'react'
import type { HostProfile } from '@/lib/hosts'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import {
  Clock,
  Server,
  Plug,
  PlugZap,
  KeyRound,
  Terminal,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { listActivityLog, type ActivityEntry } from '@/lib/activity-log'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getHostInventoryResource, HostMetadataLine, resolveHostForDisplay } from './host-display-meta'

const EVENT_ICONS: Record<string, { Icon: typeof Plug; color: string }> = {
  connect: { Icon: Plug, color: 'text-emerald-500' },
  disconnect: { Icon: PlugZap, color: 'text-red-400' },
  reconnect: { Icon: RefreshCw, color: 'text-amber-400' },
  auth_fail: { Icon: AlertTriangle, color: 'text-red-500' },
  local_terminal: { Icon: Terminal, color: 'text-blue-400' },
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

function groupByDate(entries: ActivityEntry[]): { label: string; items: ActivityEntry[] }[] {
  const groups: Map<string, ActivityEntry[]> = new Map()
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()

  for (const entry of entries) {
    const dateStr = new Date(entry.createdAt).toDateString()
    let label: string
    if (dateStr === today) label = 'Today'
    else if (dateStr === yesterday) label = 'Yesterday'
    else label = new Date(entry.createdAt).toLocaleDateString()

    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(entry)
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}

interface ActivityLogPanelProps {
  hosts?: HostProfile[]
}

export function ActivityLogPanel({ hosts = [] }: ActivityLogPanelProps) {
  const { t } = useT()
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  const refresh = useCallback(() => {
    setLoading(true)
    listActivityLog()
      .then((res) => setEntries(res.reverse()))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const grouped = groupByDate(entries)

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center justify-between px-6 pb-4 pt-6">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">{t('activity.title')}</h2>
          <span className="text-xs text-muted-foreground">({entries.length})</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {loading && entries.length === 0 && (
        <div className="px-6 py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="px-6 py-12 text-center">
          <Clock className="mx-auto h-10 w-10 text-muted-foreground/20" />
          <p className="mt-3 text-sm text-muted-foreground">{t('activity.empty')}</p>
        </div>
      )}

      <div className="space-y-4 px-6 pb-6">
        {grouped.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((entry) => {
                const meta = EVENT_ICONS[entry.event] ?? { Icon: Server, color: 'text-muted-foreground' }
                const host = resolveHostForDisplay(hosts, entry.hostId, entry.hostAddress)
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 rounded-lg border border-border/40 bg-card/30 px-3 py-2.5 transition-colors hover:bg-muted/30"
                  >
                    <div className={cn('mt-0.5 shrink-0', meta.color)}>
                      <meta.Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {entry.hostName || entry.hostAddress}
                        </span>
                        {host && (
                          <HostMetadataLine
                            network={networkByAddress[host.address]}
                            resource={getHostInventoryResource(host, inventoryStates)}
                            showLocationText={false}
                            showSystemText={false}
                            className="gap-x-1"
                            iconClassName="h-3 w-3"
                          />
                        )}
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatRelative(entry.createdAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>{t(`activity.event.${entry.event}`)}</span>
                        {entry.username && <span>{entry.username}@{entry.hostAddress}</span>}
                        {host && (
                          <HostMetadataLine
                            network={networkByAddress[host.address]}
                            resource={getHostInventoryResource(host, inventoryStates)}
                            className="flex-nowrap"
                            itemClassName="max-w-[8rem]"
                            iconClassName="h-3 w-3"
                          />
                        )}
                        {entry.authType && (
                          <span className="flex items-center gap-0.5">
                            <KeyRound className="h-2.5 w-2.5" />
                            {entry.authType}
                          </span>
                        )}
                      </div>
                      {entry.detail && (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{entry.detail}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
