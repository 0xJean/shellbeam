import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, Server, FolderOpen, Settings, Plus, X } from 'lucide-react'
import type { HostProfile } from '@/lib/hosts'
import type { HistoryEntry } from '@/lib/history'
import { cn } from '@/lib/utils'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'
import { useWorkspaceInventoryStates } from '@/lib/workspace-inventory-state'
import { getHostInventoryResource, HostMetadataLine } from './host-display-meta'
import { WorkspaceOsIcon } from './workspace/workspace-os-icon'

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

type FlatItem =
  | { kind: 'host'; host: HostProfile; id: string; section: string }
  | { kind: 'action'; action: CommandPaletteAction; label: string; icon: React.ReactNode; id: string; shortcut?: string[]; section: string }
  | { kind: 'section-header'; label: string; id: string }

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  hosts: HostProfile[]
  historyEntries: HistoryEntry[]
  selectedHostId: string | null
  onSelectHost: (hostId: string) => void
  onAction?: (action: CommandPaletteAction) => void
}

const MONO = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" } as const

const ACTION_ITEMS: Array<{ action: CommandPaletteAction; labelKey: string; icon: React.ReactNode; shortcut: string[] }> = [
  { action: 'focus-interactive', labelKey: 'cmdPalette.interactive', icon: <Plus className="h-4 w-4" />, shortcut: ['Ctrl', 'N'] },
  { action: 'focus-sftp', labelKey: 'cmdPalette.openSftp', icon: <FolderOpen className="h-4 w-4" />, shortcut: ['Shift', 'Alt', 'F'] },
  { action: 'focus-settings', labelKey: 'cmdPalette.settings', icon: <Settings className="h-4 w-4" />, shortcut: ['Cmd', ','] },
]

function authLabel(host: HostProfile): string {
  if (host.authType === 'password') return 'password'
  if (host.privateKeyRef) return 'ssh-rsa'
  return host.authType || 'key'
}

export function CommandPalette({
  open,
  onClose,
  hosts,
  historyEntries,
  onSelectHost,
  onAction,
}: CommandPaletteProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inventoryStates = useWorkspaceInventoryStates()
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

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

  const recentHostIds = useMemo(() => new Set(recentHosts.map((h) => h.id)), [recentHosts])

  const { flatItems, selectableIndices } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const items: FlatItem[] = []
    const selectable: number[] = []

    if (q) {
      // Filtered mode: flat list of matching hosts + matching actions
      const filteredHosts = hosts.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.address.toLowerCase().includes(q) ||
          (h.username && h.username.toLowerCase().includes(q)),
      )
      if (filteredHosts.length > 0) {
        items.push({ kind: 'section-header', label: 'RESULTS', id: 'sh-results' })
        for (const h of filteredHosts) {
          selectable.push(items.length)
          items.push({ kind: 'host', host: h, id: h.id, section: 'results' })
        }
      }
      const filteredActions = ACTION_ITEMS.filter((a) => t(a.labelKey).toLowerCase().includes(q))
      if (filteredActions.length > 0) {
        items.push({ kind: 'section-header', label: 'COMMANDS', id: 'sh-commands' })
        for (const a of filteredActions) {
          selectable.push(items.length)
          items.push({
            kind: 'action',
            action: a.action,
            label: t(a.labelKey),
            icon: a.icon,
            id: `action-${a.action}`,
            shortcut: a.shortcut,
            section: 'commands',
          })
        }
      }
    } else {
      // Default mode: recent connections + commands + saved sessions
      if (recentHosts.length > 0) {
        items.push({ kind: 'section-header', label: 'RECENT CONNECTIONS', id: 'sh-recent' })
        for (const h of recentHosts) {
          selectable.push(items.length)
          items.push({ kind: 'host', host: h, id: h.id, section: 'recent' })
        }
      }

      items.push({ kind: 'section-header', label: 'COMMANDS', id: 'sh-commands' })
      for (const a of ACTION_ITEMS) {
        selectable.push(items.length)
        items.push({
          kind: 'action',
          action: a.action,
          label: t(a.labelKey),
          icon: a.icon,
          id: `action-${a.action}`,
          shortcut: a.shortcut,
          section: 'commands',
        })
      }

      const savedHosts = hosts.filter((h) => !recentHostIds.has(h.id))
      if (savedHosts.length > 0) {
        items.push({ kind: 'section-header', label: 'SAVED SESSIONS', id: 'sh-saved' })
        for (const h of savedHosts) {
          selectable.push(items.length)
          items.push({ kind: 'host', host: h, id: h.id, section: 'saved' })
        }
      }
    }

    return { flatItems: items, selectableIndices: selectable }
  }, [query, hosts, recentHosts, recentHostIds, t])

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
  }, [activeIndex, open])

  const activeItemIndex = selectableIndices[activeIndex] ?? -1

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % Math.max(1, selectableIndices.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + selectableIndices.length) % Math.max(1, selectableIndices.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const itemIdx = selectableIndices[activeIndex]
      if (itemIdx == null) return
      const item = flatItems[itemIdx]
      if (!item || item.kind === 'section-header') return
      if (item.kind === 'host') {
        onSelectHost(item.host.id)
        onClose()
      } else {
        onAction?.(item.action)
        onClose()
      }
      return
    }
  }

  function handleSelect(item: FlatItem) {
    if (item.kind === 'section-header') return
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
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/70 pt-0 backdrop-blur-sm md:pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Command palette"
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden border-[#1e3a5f]/60 bg-[#0c1222] md:h-auto md:max-w-[620px] md:rounded-xl md:border md:shadow-2xl md:shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Search bar ── */}
        <div className="flex items-center gap-3 border-b border-[#1e3a5f]/40 px-4 py-3.5">
          <Search className="h-5 w-5 shrink-0 text-[#3b82f6]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('cmdPalette.search')}
            className="flex-1 border-none bg-transparent text-[15px] text-[#e2e8f0] outline-none placeholder:text-[#475569]"
            style={MONO}
            autoComplete="off"
          />
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-[#475569] transition-colors hover:text-[#94a3b8] md:hidden">
            <X className="h-4 w-4" />
          </button>
          <kbd className="hidden rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-2 py-0.5 text-[10px] font-semibold text-[#475569] md:inline" style={MONO}>
            ESC
          </kbd>
        </div>

        {/* ── Item list ── */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1 md:max-h-[54vh] md:flex-none">
          {selectableIndices.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[#475569]">{t('cmdPalette.noResults')}</p>
          ) : (
            flatItems.map((item, idx) => {
              if (item.kind === 'section-header') {
                return (
                  <div key={item.id} className="px-5 pb-1.5 pt-4 first:pt-2.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#475569]" style={MONO}>
                      {item.label}
                    </span>
                  </div>
                )
              }

              const isActive = idx === activeItemIndex

              if (item.kind === 'host') {
                const isSaved = item.section === 'saved'
                const resource = getHostInventoryResource(item.host, inventoryStates)
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-active={isActive}
                    className={cn(
                      'group flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors',
                      isActive
                        ? 'border-[#3b82f6] bg-[#3b82f6]/10'
                        : 'border-transparent hover:bg-[#1e293b]/50',
                    )}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => {
                      const si = selectableIndices.indexOf(idx)
                      if (si >= 0) setActiveIndex(si)
                    }}
                  >
                    <div className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                      isActive ? 'bg-[#3b82f6]/20 text-[#3b82f6]' : 'bg-[#1e293b] text-[#3b82f6]/70',
                    )}>
                      {isSaved && resource?.os ? (
                        <WorkspaceOsIcon os={resource.os} className="h-4.5 w-4.5" />
                      ) : (
                        <Server className="h-4.5 w-4.5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[#e2e8f0]">{item.host.name}</p>
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-xs text-[#475569]">
                          {item.host.address}{item.host.username ? ` \u00b7 ${authLabel(item.host)}` : ''}
                        </p>
                        <HostMetadataLine
                          network={networkByAddress[item.host.address]}
                          resource={resource}
                          showSystem={!isSaved}
                          className="min-w-0 flex-nowrap gap-x-2 text-xs text-[#64748b]"
                          itemClassName="max-w-[7rem]"
                          iconClassName="h-3 w-3"
                        />
                      </div>
                    </div>
                    {isActive && (
                      <span className="shrink-0 text-xs font-medium text-[#3b82f6]/70" style={MONO}>Enter</span>
                    )}
                  </button>
                )
              }

              // action item
              return (
                <button
                  key={item.id}
                  type="button"
                  data-active={isActive}
                  className={cn(
                    'group flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors',
                    isActive
                      ? 'border-[#3b82f6] bg-[#3b82f6]/10'
                      : 'border-transparent hover:bg-[#1e293b]/50',
                  )}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => {
                    const si = selectableIndices.indexOf(idx)
                    if (si >= 0) setActiveIndex(si)
                  }}
                >
                  <div className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    isActive ? 'bg-[#3b82f6]/20 text-[#e2e8f0]' : 'bg-[#1e293b] text-[#64748b]',
                  )}>
                    {item.icon}
                  </div>
                  <p className="min-w-0 flex-1 text-sm font-medium text-[#e2e8f0]">{item.label}</p>
                  {item.shortcut && (
                    <div className="flex shrink-0 items-center gap-1">
                      {item.shortcut.map((key) => (
                        <kbd key={key} className="rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-1.5 py-0.5 text-[10px] font-semibold text-[#475569]" style={MONO}>
                          {key}
                        </kbd>
                      ))}
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* ── Bottom hints bar ── */}
        <div className="flex items-center gap-4 border-t border-[#1e3a5f]/40 bg-[#080e1a] px-4 py-2 text-[11px] text-[#475569]" style={MONO}>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-1 py-0.5 text-[9px]">&#8593;</kbd>
            <kbd className="rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-1 py-0.5 text-[9px]">&#8595;</kbd>
            <span className="ml-0.5">{t('cmdPalette.navigate')}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-1.5 py-0.5 text-[9px]">ENTER</kbd>
            <span>{t('cmdPalette.select')}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-[#1e3a5f]/60 bg-[#0d1b2a] px-1.5 py-0.5 text-[9px]">ESC</kbd>
            <span>{t('cmdPalette.close')}</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[#3b82f6]/50 font-medium">
            <span>&#9889;</span> Quick Launch v2.4
          </span>
        </div>
      </div>
    </div>
  )
}
