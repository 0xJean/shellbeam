import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  FileCode2,
  Globe,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { BrowserRouteMode, SessionBrowserState } from '@/contexts/session-browser-state'
import type { BrowserRouteIndicator, BrowserTabRouteIndicator } from './browser-view-state'
import { filterBrowserTabs, getBrowserTabDensity, getBrowserTabMonogram, useBrowserTabFavicons } from './browser-tab-visuals'

interface BrowserChromeProps {
  state: SessionBrowserState
  tabs: Array<{ id: string; pinned: boolean; title: string; active: boolean; isLoading: boolean; sourceKind: 'url' | 'html' | 'markdown' | null; url: string; routeIndicator: BrowserTabRouteIndicator | null }>
  routeIndicator: BrowserRouteIndicator
  routeMode: Exclude<BrowserRouteMode, 'auto'>
  canToggleRouteMode: boolean
  onCreateTab: () => void
  onDuplicateTab: (tabId: string) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseTabsToRight: (tabId: string) => void
  onRestoreClosedTab: () => void
  hasClosedTabs: boolean
  onTogglePinTab: (tabId: string) => void
  onReorderTab: (tabId: string, targetTabId: string, position: 'before' | 'after') => void
  onRouteModeChange: (routeMode: Exclude<BrowserRouteMode, 'auto'>) => void
  onAddressInputChange: (value: string) => void
  onSubmitAddress: () => void
  onReload: () => void
  canRebuildTransport?: boolean
  onRebuildTransport?: () => void
  onBack: () => void
  onForward: () => void
  onClose?: () => void
}

export function BrowserChrome({
  state,
  tabs,
  routeIndicator,
  routeMode,
  canToggleRouteMode,
  onCreateTab,
  onDuplicateTab,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onRestoreClosedTab,
  hasClosedTabs,
  onTogglePinTab,
  onReorderTab,
  onRouteModeChange,
  onAddressInputChange,
  onSubmitAddress,
  onReload,
  canRebuildTransport = false,
  onRebuildTransport,
  onBack,
  onForward,
  onClose,
}: BrowserChromeProps) {
  const { t } = useT()
  const [value, setValue] = useState(state.addressInput)
  const [openTabMenuId, setOpenTabMenuId] = useState<string | null>(null)
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false)
  const [tabSwitcherQuery, setTabSwitcherQuery] = useState('')
  const [highlightedTabId, setHighlightedTabId] = useState<string | null>(null)
  const [dragState, setDragState] = useState<{
    tabId: string
    targetTabId: string | null
    position: 'before' | 'after'
  } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const tabSwitcherInputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setValue(state.addressInput)
  }, [state.addressInput])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenTabMenuId(null)
        setTabSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const canGoBack = state.canGoBack
  const canGoForward = state.canGoForward
  const faviconByTabId = useBrowserTabFavicons(tabs)
  const filteredTabs = useMemo(() => filterBrowserTabs(tabs, tabSwitcherQuery), [tabs, tabSwitcherQuery])
  const tabDensity = useMemo(() => getBrowserTabDensity(tabs.length), [tabs.length])
  const lastPinnedTabId = useMemo(() => {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (tabs[index]?.pinned) return tabs[index]!.id
    }
    return null
  }, [tabs])
  const routeBadgeClassName = routeIndicator.scope === 'local'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
    : routeIndicator.scope === 'pending'
      ? 'border-amber-500/25 bg-amber-500/10 text-amber-200'
      : 'border-sky-500/25 bg-sky-500/10 text-sky-200'
  const transportBadge = state.transportStatus === 'recovering'
    ? {
        className: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
        icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" />,
        label: t('browser.transport.recovering'),
      }
    : state.transportStatus === 'failed'
      ? {
          className: 'border-red-500/25 bg-red-500/10 text-red-200',
          icon: <AlertCircle className="h-3.5 w-3.5" />,
          label: t('browser.transport.failed'),
        }
      : null

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onAddressInputChange(value)
    onSubmitAddress()
  }

  function getTabBadge(tab: BrowserChromeProps['tabs'][number]) {
    if (tab.isLoading) {
      return { icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" />, className: 'bg-sky-500/15 text-sky-200' }
    }
    const faviconUrl = faviconByTabId[tab.id]
    if (faviconUrl) {
      return {
        icon: <img src={faviconUrl} alt="" className="h-4 w-4 rounded-[4px] object-cover" />,
        className: 'bg-white/90 text-slate-900',
      }
    }
    if (tab.sourceKind === 'url' && tab.url) {
      return {
        icon: <span className="text-[10px] font-semibold uppercase">{getBrowserTabMonogram(tab)}</span>,
        className: 'bg-emerald-500/15 text-emerald-200',
      }
    }
    if (tab.sourceKind) {
      return {
        icon: tab.sourceKind === 'html' || tab.sourceKind === 'markdown'
          ? <span className="text-[10px] font-semibold uppercase">{getBrowserTabMonogram(tab)}</span>
          : <FileCode2 className="h-3.5 w-3.5" />,
        className: 'bg-amber-500/15 text-amber-200',
      }
    }
    return { icon: <Plus className="h-3.5 w-3.5" />, className: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-subtle)]' }
  }

  async function handleCopyTabLink(url: string) {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setOpenTabMenuId(null)
    } catch {
      // ignore clipboard failures in constrained runtimes
    }
  }

  function getDropPosition(event: DragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX <= rect.left + rect.width / 2 ? 'before' : 'after'
  }

  function getTabDensityClasses() {
    if (tabDensity === 'dense') {
      return {
        tab: 'min-w-[92px] max-w-[148px] gap-1 px-1.5 py-1',
        title: 'text-[11px]',
        route: 'px-1 py-0.5 text-[8px]',
        action: 'p-0.5',
        dot: 'h-1 w-1',
      }
    }
    if (tabDensity === 'compact') {
      return {
        tab: 'min-w-[112px] max-w-[182px] gap-1 px-2 py-1.5',
        title: 'text-[11px]',
        route: 'px-1.5 py-0.5 text-[8px]',
        action: 'p-0.5',
        dot: 'h-1.5 w-1.5',
      }
    }
    return {
      tab: 'min-w-[140px] max-w-[220px] gap-1.5 px-2 py-1.5',
      title: 'text-xs',
      route: 'px-1.5 py-0.5 text-[9px]',
      action: 'p-1',
      dot: 'h-1.5 w-1.5',
    }
  }

  const densityClasses = getTabDensityClasses()

  function openTabSwitcher() {
    setOpenTabMenuId(null)
    setTabSwitcherOpen(true)
    setHighlightedTabId((current) => current ?? tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null)
  }

  useEffect(() => {
    if (!tabSwitcherOpen) {
      setTabSwitcherQuery('')
      return
    }
    setHighlightedTabId(filteredTabs[0]?.id ?? null)
    const frame = window.requestAnimationFrame(() => {
      tabSwitcherInputRef.current?.focus()
      tabSwitcherInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [filteredTabs, tabSwitcherOpen])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || !event.shiftKey) return
      if (event.key.toLowerCase() !== 'o') return
      event.preventDefault()
      openTabSwitcher()
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [tabs])

  return (
    <div ref={rootRef} className="relative flex shrink-0 flex-col gap-2 border-b border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-800)] px-3 py-3">
      <div className="flex items-center gap-2">
        <div className={cn('flex min-w-0 flex-1 items-center overflow-x-auto pb-1', tabDensity === 'dense' ? 'gap-1' : 'gap-2')}>
          {tabs.flatMap((tab) => {
            const showPinnedDivider = lastPinnedTabId === tab.id && tabs.some((item) => !item.pinned)
            return [
              (
            <div
              key={tab.id}
              draggable
              className={cn(
                'group relative flex items-center rounded-xl border transition-[border-color,background-color,box-shadow,transform] duration-150',
                densityClasses.tab,
                tab.active
                  ? 'border-[var(--workspace-accent-solid)]/55 bg-[var(--workspace-surface-900)] text-[var(--workspace-text-strong)] shadow-[0_10px_24px_rgba(15,23,42,0.28)]'
                  : 'border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]/60 text-[var(--workspace-text-muted)] hover:border-[var(--workspace-border-strong)] hover:bg-[var(--workspace-surface-900)]/80',
                dragState?.targetTabId === tab.id && dragState.position === 'before' && 'before:absolute before:inset-y-1 before:left-[-5px] before:w-0.5 before:rounded-full before:bg-[var(--workspace-accent-solid)]',
                dragState?.targetTabId === tab.id && dragState.position === 'after' && 'after:absolute after:inset-y-1 after:right-[-5px] after:w-0.5 after:rounded-full after:bg-[var(--workspace-accent-solid)]',
              )}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
                setOpenTabMenuId(null)
                setDragState({ tabId: tab.id, targetTabId: null, position: 'after' })
              }}
              onDragOver={(event) => {
                if (!dragState || dragState.tabId === tab.id) return
                if (dragState.tabId && tabs.find((item) => item.id === dragState.tabId)?.pinned !== tab.pinned) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const position = getDropPosition(event)
                setDragState((current) => {
                  if (!current) return current
                  if (current.targetTabId === tab.id && current.position === position) return current
                  return {
                    ...current,
                    targetTabId: tab.id,
                    position,
                  }
                })
              }}
              onDrop={(event) => {
                event.preventDefault()
                const draggedTabId = dragState?.tabId ?? event.dataTransfer.getData('text/plain')
                if (!draggedTabId || draggedTabId === tab.id) {
                  setDragState(null)
                  return
                }
                const draggedTab = tabs.find((item) => item.id === draggedTabId)
                if (!draggedTab || draggedTab.pinned !== tab.pinned) {
                  setDragState(null)
                  return
                }
                const position = getDropPosition(event)
                onReorderTab(draggedTabId, tab.id, position)
                setDragState(null)
              }}
              onDragEnd={() => setDragState(null)}
            >
              <span className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-md overflow-hidden',
                tabDensity === 'dense' ? 'h-4.5 w-4.5' : 'h-5 w-5',
                getTabBadge(tab).className,
              )}>
                {getTabBadge(tab).icon}
              </span>
              {tab.pinned && (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-md bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent-text)]',
                    tabDensity === 'dense' ? 'h-4.5 w-4.5' : 'h-5 w-5',
                  )}
                  title="Pinned tab"
                >
                  <Pin className={tabDensity === 'dense' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                </span>
              )}
              <button
                type="button"
                className={cn('min-w-0 flex-1 truncate text-left font-medium', densityClasses.title)}
                onClick={() => onSelectTab(tab.id)}
                aria-pressed={tab.active}
                title={tab.title}
              >
                {tab.title}
              </button>
              {!tab.active && (
                <span
                  className={cn(
                    'shrink-0 rounded-full',
                    densityClasses.dot,
                    tab.isLoading ? 'bg-sky-300' : 'bg-[var(--workspace-border-strong)]',
                  )}
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className={cn(
                  'rounded-md text-[var(--workspace-text-subtle)] transition-[opacity,color,background-color] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]',
                  densityClasses.action,
                  tab.active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                onClick={() => onCloseTab(tab.id)}
                aria-label={`Close ${tab.title}`}
              >
                <X className={tabDensity === 'dense' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  className={cn(
                    'rounded-md text-[var(--workspace-text-subtle)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]',
                    densityClasses.action,
                  )}
                  onClick={() => setOpenTabMenuId((current) => current === tab.id ? null : tab.id)}
                  aria-label={`More actions for ${tab.title}`}
                >
                  <MoreHorizontal className={tabDensity === 'dense' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
                </button>
                {openTabMenuId === tab.id && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[168px] rounded-xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]"
                      onClick={() => {
                        onTogglePinTab(tab.id)
                        setOpenTabMenuId(null)
                      }}
                    >
                      {tab.pinned ? 'Unpin tab' : 'Pin tab'}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]"
                      onClick={() => {
                        onDuplicateTab(tab.id)
                        setOpenTabMenuId(null)
                      }}
                    >
                      Duplicate tab
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]"
                      onClick={() => void handleCopyTabLink(tab.url)}
                      disabled={!tab.url}
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]"
                      onClick={() => {
                        onCloseOtherTabs(tab.id)
                        setOpenTabMenuId(null)
                      }}
                      disabled={tabs.length <= 1}
                    >
                      Close other tabs
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-700)]"
                      onClick={() => {
                        onCloseTabsToRight(tab.id)
                        setOpenTabMenuId(null)
                      }}
                    >
                      Close tabs to right
                    </button>
                  </div>
                )}
              </div>
            </div>
              ),
              ...(showPinnedDivider ? [(
                <div
                  key={`${tab.id}-pinned-divider`}
                  className={cn(
                    'mx-1 flex shrink-0 items-center gap-2 self-stretch px-1',
                    tabDensity === 'dense' ? 'text-[8px]' : 'text-[9px]',
                  )}
                  aria-hidden="true"
                >
                  <div className="h-px w-3 bg-[var(--workspace-border-strong)]" />
                  <span className="font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-subtle)]">Pinned</span>
                  <div className="h-px w-3 bg-[var(--workspace-border-strong)]" />
                </div>
              )] : []),
            ]
          })}
        </div>
        <Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={onCreateTab} aria-label="New browser tab">
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 px-3 text-xs"
          onClick={openTabSwitcher}
        >
          <Search className="h-3.5 w-3.5" />
          Tabs
          <span className="rounded-md bg-[var(--workspace-surface-700)] px-1.5 py-0.5 text-[10px]">{tabs.length}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 px-3 text-xs"
          onClick={onRestoreClosedTab}
          disabled={!hasClosedTabs}
        >
          Reopen Closed
        </Button>
      </div>
      {tabSwitcherOpen && (
        <div className="absolute right-3 top-12 z-30 w-[360px] rounded-2xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] p-3 shadow-[0_24px_64px_rgba(2,6,23,0.48)]">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--workspace-text-subtle)]" />
              <Input
                ref={tabSwitcherInputRef}
                value={tabSwitcherQuery}
                onChange={(event) => setTabSwitcherQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setTabSwitcherOpen(false)
                    return
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    if (filteredTabs.length === 0) return
                    const index = filteredTabs.findIndex((tab) => tab.id === highlightedTabId)
                    const nextIndex = index < 0 ? 0 : Math.min(index + 1, filteredTabs.length - 1)
                    setHighlightedTabId(filteredTabs[nextIndex]!.id)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (filteredTabs.length === 0) return
                    const index = filteredTabs.findIndex((tab) => tab.id === highlightedTabId)
                    const nextIndex = index < 0 ? 0 : Math.max(index - 1, 0)
                    setHighlightedTabId(filteredTabs[nextIndex]!.id)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    const nextTab = filteredTabs.find((tab) => tab.id === highlightedTabId) ?? filteredTabs[0]
                    if (!nextTab) return
                    onSelectTab(nextTab.id)
                    setTabSwitcherOpen(false)
                  }
                }}
                placeholder="Search tabs, urls, routes"
                className="h-9 pl-9 text-sm"
              />
            </div>
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setTabSwitcherOpen(false)} aria-label="Close tabs overview">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-3 max-h-[320px] overflow-y-auto">
            {filteredTabs.length > 0 ? (
              <div className="space-y-1">
                {filteredTabs.map((tab) => {
                  const isHighlighted = tab.id === highlightedTabId
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors',
                        isHighlighted || tab.active
                          ? 'border-[var(--workspace-accent-solid)]/45 bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)]'
                          : 'border-transparent text-[var(--workspace-text-muted)] hover:border-[var(--workspace-border-soft)] hover:bg-[var(--workspace-surface-800)]/80',
                      )}
                      onMouseEnter={() => setHighlightedTabId(tab.id)}
                      onClick={() => {
                        onSelectTab(tab.id)
                        setTabSwitcherOpen(false)
                      }}
                    >
                      <span className={cn(
                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md overflow-hidden',
                        getTabBadge(tab).className,
                      )}>
                        {getTabBadge(tab).icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{tab.title}</span>
                          {tab.pinned && (
                            <Pin className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" />
                          )}
                        </div>
                        {tab.url && (
                          <div className="truncate text-[11px] text-[var(--workspace-text-subtle)]">{tab.url}</div>
                        )}
                      </div>
                      {tab.active && (
                        <span className="shrink-0 rounded-full bg-[var(--workspace-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--workspace-accent-text)]">
                          Active
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--workspace-border-soft)] px-4 py-8 text-center text-sm text-[var(--workspace-text-muted)]">
                No tabs match this search.
              </div>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 px-1 text-[10px] uppercase tracking-[0.12em] text-[var(--workspace-text-subtle)]">
        <span>New Tab: Cmd/Ctrl+T</span>
        <span>Overview: Cmd/Ctrl+Shift+O</span>
        <span>Reopen: Cmd/Ctrl+Shift+T</span>
        <span>Close: Cmd/Ctrl+W</span>
        <span>Switch: Cmd/Ctrl+Shift+[ / ]</span>
        <span>Drag: Reorder tabs</span>
      </div>

      <div className="flex items-center gap-2">
        <div
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]',
            routeBadgeClassName,
          )}
          title={routeIndicator.detail}
        >
          {routeIndicator.scope === 'pending' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Server className="h-3.5 w-3.5" />
          )}
          <span>{routeIndicator.label}</span>
        </div>
        {transportBadge && (
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]',
              transportBadge.className,
            )}
          >
            {transportBadge.icon}
            <span>{transportBadge.label}</span>
          </div>
        )}
        {state.title && (
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--workspace-text-strong)]">
            {state.title}
          </div>
        )}
        {onClose && (
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={onClose} aria-label="Close browser">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="outline" className="h-8 w-8" disabled={!canGoBack} onClick={onBack} aria-label="Go back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="outline" className="h-8 w-8" disabled={!canGoForward} onClick={onForward} aria-label="Go forward">
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={onReload} aria-label="Reload browser">
            <RefreshCw className={cn('h-4 w-4', state.isLoading && 'animate-spin')} />
          </Button>
          {canRebuildTransport && onRebuildTransport && (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8"
              onClick={onRebuildTransport}
              aria-label={t('browser.transport.rebuild')}
              title={t('browser.transport.rebuild')}
            >
              <Server className="h-4 w-4" />
            </Button>
          )}
        </div>

        {canToggleRouteMode && (
          <div className="inline-flex h-9 shrink-0 items-center rounded-xl border border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-1">
            {(['local', 'remote'] as const).map((mode) => {
              const active = routeMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                    active
                      ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]'
                      : 'text-[var(--workspace-text-muted)] hover:text-[var(--workspace-text)]',
                  )}
                  onClick={() => onRouteModeChange(mode)}
                  aria-pressed={active}
                >
                  {mode === 'local' ? 'Local' : 'Server'}
                </button>
              )
            })}
          </div>
        )}

        <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              const nextValue = event.target.value
              setValue(nextValue)
              onAddressInputChange(nextValue)
            }}
            placeholder="Enter URL or preview address"
            className="h-9 min-w-0 border-[var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] text-[var(--workspace-text)]"
            aria-label="Browser address"
          />
          <Button type="submit" size="sm" className="h-9 shrink-0 gap-1.5">
            <Globe className="h-3.5 w-3.5" />
            Go
          </Button>
        </form>
      </div>

      {(state.isLoading || state.error || state.currentUrl || state.source) && (
        <div className="flex items-center gap-2 text-xs text-[var(--workspace-text-muted)]">
          {state.isLoading && (
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </span>
          )}
          {!state.isLoading && state.error && (
            <span className="inline-flex items-center gap-1.5 text-red-300">
              <AlertCircle className="h-3.5 w-3.5" />
              {state.error}
            </span>
          )}
          {!state.isLoading && !state.error && state.currentUrl && (
            <span className="truncate">{state.currentUrl}</span>
          )}
          {!state.isLoading && !state.error && !state.currentUrl && state.source && (
            <span className="truncate text-[var(--workspace-text-subtle)]">
              {state.source.kind === 'markdown' ? 'Markdown preview' : state.source.kind === 'html' ? 'HTML preview' : state.title || 'Ready'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
