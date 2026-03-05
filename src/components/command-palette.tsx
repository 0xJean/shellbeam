import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, Server, Terminal, FolderOpen, Settings, LayoutDashboard, X } from 'lucide-react'
import type { HostProfile } from '@/lib/hosts'
import type { HistoryEntry } from '@/lib/history'
import { cn } from '@/lib/utils'

export type CommandPaletteAction = 'focus-sftp' | 'focus-settings' | 'focus-interactive' | 'focus-vaults-dashboard'

export interface CommandPaletteItem {
  id: string
  type: 'host'
  host: HostProfile
  subtitle?: string
}

export interface CommandPaletteActionItem {
  id: string
  type: 'action'
  action: CommandPaletteAction
  label: string
  icon: React.ReactNode
}

type FlatItem = { kind: 'host'; host: HostProfile; id: string } | { kind: 'action'; action: CommandPaletteAction; label: string; icon: React.ReactNode; id: string }

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  hosts: HostProfile[]
  historyEntries: HistoryEntry[]
  selectedHostId: string | null
  onSelectHost: (hostId: string) => void
  onAction?: (action: CommandPaletteAction) => void
}

const ACTION_ITEMS: Array<{ action: CommandPaletteAction; labelKey: string; icon: React.ReactNode }> = [
  { action: 'focus-interactive', labelKey: 'cmdPalette.interactive', icon: <Terminal className="h-4 w-4" /> },
  { action: 'focus-sftp', labelKey: 'cmdPalette.openSftp', icon: <FolderOpen className="h-4 w-4" /> },
  { action: 'focus-vaults-dashboard', labelKey: 'cmdPalette.dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { action: 'focus-settings', labelKey: 'cmdPalette.settings', icon: <Settings className="h-4 w-4" /> },
]

export function CommandPalette({
  open,
  onClose,
  hosts,
  historyEntries,
  selectedHostId,
  onSelectHost,
  onAction,
}: CommandPaletteProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const recentHosts = useMemo(() => {
    const seen = new Set<string>()
    const result: HostProfile[] = []
    for (let i = historyEntries.length - 1; i >= 0 && result.length < 5; i--) {
      const entry = historyEntries[i]
      const host = hosts.find((h) => h.address === entry.host || h.id === entry.hostId)
      if (host && !seen.has(host.id)) {
        seen.add(host.id)
        result.push(host)
      }
    }
    return result
  }, [hosts, historyEntries])

  const flatItems = useMemo((): FlatItem[] => {
    const q = query.trim().toLowerCase()
    const actionItems: FlatItem[] = ACTION_ITEMS.map((a) => ({
      kind: 'action' as const,
      action: a.action,
      label: t(a.labelKey),
      icon: a.icon,
      id: `action-${a.action}`,
    }))

    const filteredHosts = q
      ? hosts.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.address.toLowerCase().includes(q) ||
            (h.username && h.username.toLowerCase().includes(q))
        )
      : recentHosts

    const hostItems: FlatItem[] = filteredHosts.map((h) => ({
      kind: 'host' as const,
      host: h,
      id: h.id,
    }))

    return [...hostItems, ...actionItems]
  }, [query, hosts, recentHosts, t])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const el = listRef.current
    if (!el) return
    const active = el.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex, flatItems])

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % Math.max(1, flatItems.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + flatItems.length) % Math.max(1, flatItems.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) {
        if (item.kind === 'host') {
          onSelectHost(item.host.id)
          onClose()
        } else {
          onAction?.(item.action)
          onClose()
        }
      }
      return
    }
  }

  function handleSelect(item: FlatItem) {
    if (item.kind === 'host') {
      onSelectHost(item.host.id)
      onClose()
    } else {
      onAction?.(item.action)
      onClose()
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-0 md:pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Command palette"
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-background md:h-auto md:max-w-2xl md:rounded-xl md:border md:border-border md:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Search className="h-5 w-5 shrink-0 text-primary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('cmdPalette.search')}
            className="flex-1 bg-transparent border-none focus:ring-0 text-base md:text-lg placeholder:text-muted-foreground"
            autoComplete="off"
          />
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted md:hidden">
            <X className="h-4 w-4" />
          </button>
          <kbd className="hidden text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded md:inline">ESC</kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2 md:max-h-[50vh] md:flex-none">
          {flatItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-muted-foreground text-sm">{t('cmdPalette.noResults')}</p>
          ) : (
            flatItems.map((item, idx) => {
              const isActive = idx === activeIndex
              return (
                <button
                  key={item.id}
                  type="button"
                  data-active={isActive}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors md:py-2.5',
                    isActive ? 'bg-primary/15 border-l-2 border-primary' : 'border-l-2 border-transparent hover:bg-muted/50'
                  )}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  {item.kind === 'host' ? (
                    <>
                      <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                        <Server className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{item.host.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {item.host.username}@{item.host.address}:{item.host.port}
                        </p>
                      </div>
                      {selectedHostId === item.host.id && (
                        <span className="text-xs text-primary shrink-0">{t('cmdPalette.selected')}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0 text-muted-foreground">
                        {item.icon}
                      </div>
                      <p className="font-medium">{item.label}</p>
                    </>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="hidden flex-wrap items-center gap-3 px-4 py-2 border-t bg-muted/30 text-xs text-muted-foreground sm:flex sm:gap-4">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted border">↑</kbd>
            <kbd className="px-1 py-0.5 rounded bg-muted border">↓</kbd>
            {t('cmdPalette.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted border">Enter</kbd>
            {t('cmdPalette.select')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-muted border">Esc</kbd>
            {t('cmdPalette.close')}
          </span>
          <span className="ml-auto text-primary/70 font-medium">Cmd+J</span>
        </div>
      </div>
    </div>
  )
}
