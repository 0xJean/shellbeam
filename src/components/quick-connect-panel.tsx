import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Command, Plus, Search, Server, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

interface QuickConnectPanelProps {
  hosts: HostProfile[]
  onConnectHost: (hostId: string) => void
  onNewHost: () => void
  onClose?: () => void
}

export function QuickConnectPanel({ hosts, onConnectHost, onNewHost, onClose }: QuickConnectPanelProps) {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Keyboard shortcut hint
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Focus search on any letter key if not already focused
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && document.activeElement !== searchRef.current) {
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return hosts
    const q = search.toLowerCase()
    return hosts.filter(
      (h) => h.name.toLowerCase().includes(q) ||
        h.address.toLowerCase().includes(q) ||
        (h.username && h.username.toLowerCase().includes(q)) ||
        (h.group && h.group.toLowerCase().includes(q)) ||
        (h.tags && h.tags.some((tag) => tag.toLowerCase().includes(q)))
    )
  }, [hosts, search])

  // Group by group name
  const grouped = useMemo(() => {
    const map = new Map<string, HostProfile[]>()
    for (const host of filtered) {
      const key = host.group || 'Custom'
      map.set(key, [...(map.get(key) ?? []), host])
    }
    return Array.from(map.entries())
  }, [filtered])

  const groupLabel = (g: string) => {
    const k = t(`group.${g}`)
    return k !== `group.${g}` ? k : g
  }

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="shrink-0 border-b border-border/50 px-6 py-4">
        <div className="relative mx-auto max-w-2xl">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tab.searchHosts')}
            className="h-11 w-full rounded-xl border border-border bg-muted/30 pl-11 pr-16 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/50 focus:bg-background"
          />
          <kbd className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            <Command className="h-2.5 w-2.5" />K
          </kbd>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-5">
          {/* Header */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t('tab.recentConnections')}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onNewHost}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('tab.addNewHost')}
              </button>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/50 hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('common.close')}
                </button>
              )}
            </div>
          </div>

          {/* Host list */}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Server className="mb-3 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                {hosts.length === 0 ? t('tab.noHosts') : t('hosts.noMatch')}
              </p>
              {hosts.length === 0 && (
                <button
                  type="button"
                  onClick={onNewHost}
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  <Plus className="h-4 w-4" />
                  {t('tab.addNewHost')}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {grouped.map(([group, groupHosts]) => (
                <div key={group}>
                  {grouped.length > 1 && (
                    <p className="mb-1 mt-3 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 first:mt-0">
                      {groupLabel(group)}
                    </p>
                  )}
                  {groupHosts.map((host) => (
                    <button
                      key={host.id}
                      type="button"
                      onClick={() => onConnectHost(host.id)}
                      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                    >
                      <div className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold',
                        'bg-primary/10 text-primary'
                      )}>
                        {host.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{host.name}</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {groupLabel(host.group || 'Custom')}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
