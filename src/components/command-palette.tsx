import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ArrowLeftRight, FolderOpen, LayoutGrid, Plus, Search, Server, Settings, SunMoon, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import type { HistoryEntry } from '@/lib/history'
import { cn } from '@/lib/utils'
import { useHostNetworkMetadata } from '@/hooks/use-host-network-metadata'

export type CommandPaletteAction = 'focus-sftp' | 'focus-settings' | 'focus-interactive' | 'focus-vaults-dashboard'
/** Actions offered for the best-matching host. */
export type CommandPaletteHostAction = 'sftp' | 'forward' | 'workspace'

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
  | { kind: 'host'; host: HostProfile; id: string }
  | { kind: 'host-action'; host: HostProfile; action: CommandPaletteHostAction; label: string; icon: ReactNode; id: string }
  | { kind: 'action'; action: CommandPaletteAction | 'toggle-theme'; label: string; icon: ReactNode; id: string; shortcut?: string[] }
  | { kind: 'section-header'; label: string; id: string }

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  hosts: HostProfile[]
  historyEntries: HistoryEntry[]
  selectedHostId: string | null
  onSelectHost: (hostId: string) => void
  onAction?: (action: CommandPaletteAction) => void
  onHostAction?: (hostId: string, action: CommandPaletteHostAction) => void
  onToggleTheme?: () => void
}

const MAX_HOSTS = 6

const ACTION_ITEMS: Array<{ action: CommandPaletteAction; labelKey: string; icon: ReactNode; shortcut: string[] }> = [
  { action: 'focus-interactive', labelKey: 'cmdPalette.interactive', icon: <Plus className="h-4 w-4" />, shortcut: ['Ctrl', 'N'] },
  { action: 'focus-sftp', labelKey: 'cmdPalette.openSftp', icon: <FolderOpen className="h-4 w-4" />, shortcut: ['⇧', '⌥', 'F'] },
  { action: 'focus-settings', labelKey: 'cmdPalette.settings', icon: <Settings className="h-4 w-4" />, shortcut: ['⌘', ','] },
]

/** Wraps the first case-insensitive match of `query` in an accent span. */
function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<span className="text-[var(--workspace-accent-text)]">{text.slice(index, index + query.length)}</span>{text.slice(index + query.length)}</>
}

export function CommandPalette({ open, onClose, hosts, historyEntries, onSelectHost, onAction, onHostAction, onToggleTheme }: CommandPaletteProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const networkByAddress = useHostNetworkMetadata(hosts.map((host) => host.address))

  // Most recently used hosts first, then the rest in their saved order.
  const orderedHosts = useMemo(() => {
    const seen = new Set<string>()
    const recent: HostProfile[] = []
    for (let i = historyEntries.length - 1; i >= 0; i--) {
      const entry = historyEntries[i]
      const host = hosts.find((h) => h.address === entry.host || h.id === entry.hostId)
      if (host && !seen.has(host.id)) { seen.add(host.id); recent.push(host) }
    }
    return [...recent, ...hosts.filter((host) => !seen.has(host.id))]
  }, [hosts, historyEntries])

  const q = query.trim().toLowerCase()
  const { flatItems, selectableIndices } = useMemo(() => {
    const items: FlatItem[] = []
    const selectable: number[] = []
    const push = (item: FlatItem) => { if (item.kind !== 'section-header') selectable.push(items.length); items.push(item) }

    const matchedHosts = (q ? orderedHosts.filter((h) => [h.name, h.address, h.username ?? ''].some((value) => value.toLowerCase().includes(q))) : orderedHosts).slice(0, MAX_HOSTS)
    if (matchedHosts.length) {
      push({ kind: 'section-header', label: t('cmdPalette.sectionHosts'), id: 'sh-hosts' })
      for (const host of matchedHosts) push({ kind: 'host', host, id: `host-${host.id}` })
    }
    const top = matchedHosts[0]
    if (top && onHostAction) {
      push({ kind: 'section-header', label: t('cmdPalette.sectionQuick'), id: 'sh-quick' })
      push({ kind: 'host-action', host: top, action: 'sftp', label: t('cmdPalette.quickSftp', { host: top.name }), icon: <FolderOpen className="h-4 w-4" />, id: 'quick-sftp' })
      push({ kind: 'host-action', host: top, action: 'forward', label: t('cmdPalette.quickForward', { host: top.name }), icon: <ArrowLeftRight className="h-4 w-4" />, id: 'quick-forward' })
      push({ kind: 'host-action', host: top, action: 'workspace', label: t('cmdPalette.quickWorkspace', { host: top.name }), icon: <LayoutGrid className="h-4 w-4" />, id: 'quick-workspace' })
    }
    const actions: FlatItem[] = ACTION_ITEMS.map((a) => ({ kind: 'action', action: a.action, label: t(a.labelKey), icon: a.icon, id: `action-${a.action}`, shortcut: a.shortcut }))
    if (onToggleTheme) actions.push({ kind: 'action', action: 'toggle-theme', label: t('cmdPalette.toggleTheme'), icon: <SunMoon className="h-4 w-4" />, id: 'action-theme' })
    const matchedActions = actions.filter((a) => !q || (a.kind === 'action' && a.label.toLowerCase().includes(q)))
    if (matchedActions.length) {
      push({ kind: 'section-header', label: t('cmdPalette.sectionCommands'), id: 'sh-commands' })
      matchedActions.forEach(push)
    }
    return { flatItems: items, selectableIndices: selectable }
  }, [q, orderedHosts, onHostAction, onToggleTheme, t])

  useEffect(() => {
    if (open) { setQuery(''); setActiveIndex(0); inputRef.current?.focus() }
  }, [open])
  useEffect(() => { setActiveIndex(0) }, [query])
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  const activeItemIndex = selectableIndices[activeIndex] ?? -1

  function run(item: FlatItem) {
    if (item.kind === 'section-header') return
    if (item.kind === 'host') onSelectHost(item.host.id)
    else if (item.kind === 'host-action') onHostAction?.(item.host.id, item.action)
    else if (item.action === 'toggle-theme') onToggleTheme?.()
    else onAction?.(item.action)
    onClose()
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    const count = Math.max(1, selectableIndices.length)
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % count); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + count) % count); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[selectableIndices[activeIndex]]
      if (item) run(item)
    }
  }

  if (!open) return null

  const kbd = (key: string) => <kbd key={key} className="rounded border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-1.5 py-px font-sans text-[10px] text-[var(--workspace-text-subtle)]">{key}</kbd>

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-0 backdrop-blur-[2px] md:pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={handleKeyDown} role="dialog" aria-label={t('cmdPalette.label')}>
      <div data-testid="command-palette" className="flex h-full w-full flex-col overflow-hidden border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] md:h-auto md:max-w-[640px] md:rounded-2xl md:border md:shadow-[var(--workspace-shadow-overlay)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3.5">
          <Search className="h-[18px] w-[18px] shrink-0 text-[var(--workspace-text-muted)]" />
          <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('cmdPalette.search')} autoComplete="off"
            className="flex-1 border-none bg-transparent text-[15px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
          <button type="button" onClick={onClose} aria-label={t('cmdPalette.close')} className="flex h-7 w-7 items-center justify-center rounded text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text)] md:hidden"><X className="h-4 w-4" /></button>
          <span className="hidden md:inline">{kbd('esc')}</span>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 md:max-h-[56vh] md:flex-none">
          {selectableIndices.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--workspace-text-subtle)]">{t('cmdPalette.noResults')}</p>
          ) : flatItems.map((item, idx) => {
            if (item.kind === 'section-header') {
              return <div key={item.id} className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium text-[var(--workspace-text-subtle)]">{item.label}</div>
            }
            const active = idx === activeItemIndex
            const rowClass = cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors', active ? 'bg-[var(--workspace-nav-active-bg)]' : 'hover:bg-[var(--workspace-nav-hover-bg)]')
            const hover = () => { const si = selectableIndices.indexOf(idx); if (si >= 0) setActiveIndex(si) }
            if (item.kind === 'host') {
              const network = networkByAddress[item.host.address]
              const place = network?.resolvedLocationLabel || network?.scopeLabel
              return (
                <button key={item.id} type="button" data-testid="command-palette-host" data-active={active} className={rowClass} onClick={() => run(item)} onMouseEnter={hover}>
                  <Server className={cn('h-4 w-4 shrink-0', active ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)]')} />
                  <span className="shrink-0 font-medium text-[var(--workspace-text-strong)]"><Highlight text={item.host.name} query={q} /></span>
                  <span className="min-w-0 truncate text-xs text-[var(--workspace-text-muted)]">
                    {item.host.username ? `${item.host.username}@` : ''}{item.host.address}{place ? ` · ${place}` : ''}
                  </span>
                  {active && <span className="ml-auto shrink-0">{kbd('↵')}</span>}
                </button>
              )
            }
            return (
              <button key={item.id} type="button" data-testid={item.kind === 'host-action' ? `command-palette-quick-${item.action}` : `command-palette-${item.id}`} data-active={active} className={rowClass} onClick={() => run(item)} onMouseEnter={hover}>
                <span className={cn('shrink-0', active ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)]')}>{item.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--workspace-text-strong)]">{item.kind === 'host-action' ? <Highlight text={item.label} query={q} /> : item.label}</span>
                {item.kind === 'action' && item.shortcut && <span className="flex shrink-0 gap-1">{item.shortcut.map(kbd)}</span>}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-[color:var(--workspace-border-soft)] px-4 py-2 text-[11px] text-[var(--workspace-text-subtle)]">
          <span className="flex items-center gap-1">{kbd('↑')}{kbd('↓')}<span className="ml-0.5">{t('cmdPalette.navigate')}</span></span>
          <span className="flex items-center gap-1">{kbd('↵')}<span className="ml-0.5">{t('cmdPalette.select')}</span></span>
          <span className="flex items-center gap-1">{kbd('esc')}<span className="ml-0.5">{t('cmdPalette.close')}</span></span>
        </div>
      </div>
    </div>
  )
}
