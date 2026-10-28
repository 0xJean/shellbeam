import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  CopyPlus,
  Ellipsis,
  FileCode2,
  Globe,
  History,
  LayoutGrid,
  Link,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import { browserV3Copy } from '@/lib/locales/browser-v3'
import { cn } from '@/lib/utils'
import type { BrowserRouteMode, SessionBrowserState } from '@/contexts/session-browser-state'
import type { BrowserTabRouteIndicator, LocalizedBrowserRouteIndicator } from './browser-view-state'
import { BrowserKbd } from './browser-kbd'
import {
  browserModKey,
  filterBrowserTabs,
  getBrowserRouteChipClass,
  getBrowserRouteDotClass,
  getBrowserRouteTone,
  getBrowserTabDensity,
  getBrowserTabMonogram,
  useBrowserTabFavicons,
} from './browser-tab-visuals'

interface BrowserChromeProps {
  state: SessionBrowserState
  tabs: Array<{ id: string; pinned: boolean; title: string; active: boolean; isLoading: boolean; sourceKind: 'url' | 'html' | 'markdown' | null; url: string; routeIndicator: BrowserTabRouteIndicator | null }>
  routeIndicator: LocalizedBrowserRouteIndicator
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
  onOverlayOpenChange?: (open: boolean) => void
}

const iconButtonClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-40'
const menuItemClass = 'flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-accent-subtle)] hover:text-[var(--workspace-text-strong)] disabled:pointer-events-none disabled:opacity-40'

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
  onOverlayOpenChange,
}: BrowserChromeProps) {
  const { t, locale } = useT()
  const copy = browserV3Copy[locale]
  const [value, setValue] = useState(state.addressInput)
  const [tabMenu, setTabMenu] = useState<{ tabId: string; top: number; left: number } | null>(null)
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
  const overlayOpen = tabMenu !== null || tabSwitcherOpen

  useEffect(() => {
    setValue(state.addressInput)
  }, [state.addressInput])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setTabMenu(null)
        setTabSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    onOverlayOpenChange?.(overlayOpen)
  }, [onOverlayOpenChange, overlayOpen])

  useEffect(() => {
    if (!tabMenu) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTabMenu(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tabMenu])

  const canGoBack = state.canGoBack
  const canGoForward = state.canGoForward
  const faviconByTabId = useBrowserTabFavicons(tabs)
  const searchableTabs = useMemo(() => tabs.map((tab) => ({
    ...tab,
    routeIndicator: tab.routeIndicator
      ? {
          ...tab.routeIndicator,
          label: t(tab.routeIndicator.labelKey),
          detail: t(tab.routeIndicator.detailKey),
        }
      : null,
  })), [tabs, t])
  const filteredTabs = useMemo(() => filterBrowserTabs(searchableTabs, tabSwitcherQuery), [searchableTabs, tabSwitcherQuery])
  const tabDensity = useMemo(() => getBrowserTabDensity(tabs.length), [tabs.length])
  const lastPinnedTabId = useMemo(() => {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (tabs[index]?.pinned) return tabs[index]!.id
    }
    return null
  }, [tabs])
  const activeTab = tabs.find((tab) => tab.active) ?? null
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null
  const isSecureAddress = /^https:\/\//i.test(value.trim())

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onAddressInputChange(value)
    onSubmitAddress()
  }

  function getRouteChipLabel(tab: BrowserChromeProps['tabs'][number]) {
    if (tab.sourceKind === 'markdown') return t('browser.status.markdownPreview')
    if (tab.sourceKind === 'html') return t('browser.status.htmlPreview')
    return tab.routeIndicator ? t(tab.routeIndicator.labelKey) : null
  }

  function getTabBadge(tab: BrowserChromeProps['tabs'][number]) {
    if (tab.isLoading) {
      return { icon: <LoaderCircle className="h-3 w-3 animate-spin" />, className: 'text-[var(--workspace-accent-text)]' }
    }
    const faviconUrl = faviconByTabId[tab.id]
    if (faviconUrl) {
      return {
        icon: <img src={faviconUrl} alt="" className="h-4 w-4 rounded-[4px] object-cover" />,
        className: '',
      }
    }
    if (tab.sourceKind === 'url' && tab.url) {
      return {
        icon: <span className="text-[9px] font-bold uppercase">{getBrowserTabMonogram(tab)}</span>,
        className: 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]',
      }
    }
    if (tab.sourceKind) {
      return {
        icon: tab.sourceKind === 'html' || tab.sourceKind === 'markdown'
          ? <span className="text-[9px] font-bold uppercase">{getBrowserTabMonogram(tab)}</span>
          : <FileCode2 className="h-3 w-3" />,
        className: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)]',
      }
    }
    return { icon: <Plus className="h-3 w-3" />, className: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-subtle)]' }
  }

  function toggleTabMenu(tabId: string, event: ReactMouseEvent<HTMLButtonElement>) {
    if (tabMenu?.tabId === tabId) {
      setTabMenu(null)
      return
    }
    const rootRect = rootRef.current?.getBoundingClientRect()
    const anchorRect = event.currentTarget.getBoundingClientRect()
    const rootLeft = rootRect?.left ?? 0
    const rootWidth = rootRect?.width ?? 0
    const left = Math.max(8, Math.min(anchorRect.right - rootLeft - 210, rootWidth - 218))
    setTabSwitcherOpen(false)
    setTabMenu({ tabId, top: anchorRect.bottom - (rootRect?.top ?? 0) + 4, left })
  }

  async function handleCopyTabLink(url: string) {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setTabMenu(null)
    } catch {
      // ignore clipboard failures in constrained runtimes
    }
  }

  function getDropPosition(event: DragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX <= rect.left + rect.width / 2 ? 'before' : 'after'
  }

  const densityClasses = tabDensity === 'dense'
    ? { tab: 'min-w-[84px] max-w-[140px] gap-1.5 pl-2 pr-1', title: 'text-[11px]', chip: 'hidden' }
    : tabDensity === 'compact'
      ? { tab: 'min-w-[100px] max-w-[176px] gap-1.5 pl-2 pr-1', title: 'text-[11.5px]', chip: 'hidden xl:inline-flex' }
      : { tab: 'min-w-[120px] max-w-[220px] gap-[7px] pl-2.5 pr-1.5', title: 'text-xs', chip: 'inline-flex' }

  function openTabSwitcher() {
    setTabMenu(null)
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
    <div ref={rootRef} className="relative flex shrink-0 flex-col">
      <div className="flex items-end gap-1 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-2.5 pt-2">
        <div className={cn('flex min-w-0 items-end overflow-x-auto [scrollbar-width:none]', tabDensity === 'dense' ? 'gap-0.5' : 'gap-1')}>
          {tabs.flatMap((tab) => {
            const showPinnedDivider = lastPinnedTabId === tab.id && tabs.some((item) => !item.pinned)
            const badge = getTabBadge(tab)
            const chipLabel = getRouteChipLabel(tab)
            return [
              (
            <div
              key={tab.id}
              draggable
              title={copy.dragHint}
              className={cn(
                'group relative -mb-px flex h-8 shrink-0 items-center rounded-t-lg transition-colors duration-150',
                densityClasses.tab,
                tab.active
                  ? 'bg-[var(--workspace-surface-950)] text-[var(--workspace-text-strong)] shadow-[0_0_0_1px_var(--workspace-border-soft)] [clip-path:inset(-1px_-1px_0_-1px)]'
                  : 'text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text)]',
                dragState?.targetTabId === tab.id && dragState.position === 'before' && 'before:absolute before:inset-y-1.5 before:left-[-3px] before:w-0.5 before:rounded-full before:bg-[hsl(var(--primary))]',
                dragState?.targetTabId === tab.id && dragState.position === 'after' && 'after:absolute after:inset-y-1.5 after:right-[-3px] after:w-0.5 after:rounded-full after:bg-[hsl(var(--primary))]',
              )}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
                setTabMenu(null)
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
              {tab.pinned && (
                <span className="inline-flex shrink-0 text-[var(--workspace-accent-text)]" title={t('browser.tab.pinnedTitle')}>
                  <Pin className="h-[13px] w-[13px]" />
                </span>
              )}
              <span className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px]', badge.className)}>
                {badge.icon}
              </span>
              <button
                type="button"
                className={cn('min-w-0 flex-1 truncate text-left font-medium', densityClasses.title)}
                onClick={() => onSelectTab(tab.id)}
                aria-pressed={tab.active}
                title={tab.title}
              >
                {tab.title}
              </button>
              {chipLabel && (
                <span className={cn(
                  'h-[17px] shrink-0 items-center rounded px-[5px] text-[10px] font-medium',
                  densityClasses.chip,
                  getBrowserRouteChipClass(getBrowserRouteTone(tab.routeIndicator?.scope, tab.sourceKind)),
                )}>
                  {chipLabel}
                </span>
              )}
              <button
                type="button"
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--workspace-text-subtle)] transition-[opacity,color,background-color] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] focus-visible:opacity-100',
                  tab.active && !tab.pinned ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
                onClick={() => onCloseTab(tab.id)}
                aria-label={t('browser.tab.close', { title: tab.title })}
              >
                <X className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--workspace-text-subtle)] transition-[opacity,color,background-color] hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)] focus-visible:opacity-100',
                  tabMenu?.tabId === tab.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-70',
                )}
                onClick={(event) => toggleTabMenu(tab.id, event)}
                aria-label={t('browser.tab.moreActions', { title: tab.title })}
                aria-expanded={tabMenu?.tabId === tab.id}
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </div>
              ),
              ...(showPinnedDivider ? [(
                <div
                  key={`${tab.id}-pinned-divider`}
                  className="mx-0.5 mb-2 h-4 w-px shrink-0 self-end bg-[var(--workspace-border-strong)]"
                  title={t('browser.tab.pinned')}
                  aria-hidden="true"
                />
              )] : []),
            ]
          })}
        </div>
        <button type="button" className={cn(iconButtonClass, 'mb-0.5 h-7 w-7')} onClick={onCreateTab} aria-label={t('browser.tab.new')} title={`${t('browser.tab.new')} ${browserModKey}T`}>
          <Plus className="h-4 w-4" />
        </button>
        <span className="min-w-2 flex-1" />
        <button
          type="button"
          className={cn(iconButtonClass, 'mb-0.5 h-7 w-7')}
          onClick={onRestoreClosedTab}
          disabled={!hasClosedTabs}
          aria-label={t('browser.tab.reopenClosed')}
          title={`${t('browser.tab.reopenClosed')} ⇧${browserModKey}T`}
        >
          <History className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="mb-0.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-[var(--workspace-text-muted)] transition-colors hover:bg-[var(--workspace-surface-700)] hover:text-[var(--workspace-text-strong)]"
          onClick={openTabSwitcher}
          aria-label={t('browser.tab.tabs')}
          title={`${t('browser.tab.tabs')} ⇧${browserModKey}O`}
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="min-w-4 rounded bg-[var(--workspace-surface-700)] px-1 text-[10.5px] font-medium tabular-nums text-[var(--workspace-text)]">{tabs.length}</span>
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2.5 py-2">
        {onClose && (
          <button type="button" className={iconButtonClass} onClick={onClose} aria-label={t('browser.action.close')} title={t('browser.action.close')}>
            <X className="h-4 w-4" />
          </button>
        )}
        <button type="button" className={iconButtonClass} disabled={!canGoBack} onClick={onBack} aria-label={t('browser.action.back')}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button type="button" className={iconButtonClass} disabled={!canGoForward} onClick={onForward} aria-label={t('browser.action.forward')}>
          <ArrowRight className="h-4 w-4" />
        </button>
        <button type="button" className={iconButtonClass} onClick={onReload} aria-label={t('browser.action.reload')}>
          <RotateCw className={cn('h-4 w-4', state.isLoading && 'animate-spin')} />
        </button>

        <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={handleSubmit}>
          <div className="relative min-w-0 flex-1">
            <span
              className={cn('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2', isSecureAddress ? 'text-[color:var(--workspace-status-good-text)]' : 'text-[var(--workspace-text-subtle)]')}
              title={isSecureAddress ? copy.secure : routeIndicator.detail}
            >
              {isSecureAddress ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
            </span>
            <Input
              ref={inputRef}
              value={value}
              onChange={(event) => {
                const nextValue = event.target.value
                setValue(nextValue)
                onAddressInputChange(nextValue)
              }}
              placeholder={t('browser.address.placeholder')}
              className="h-8 min-w-0 rounded-full border-transparent bg-[var(--workspace-surface-800)] pl-8 pr-3 font-mono text-xs text-[var(--workspace-text-strong)] placeholder:font-sans placeholder:text-[var(--workspace-text-subtle)] focus-visible:border-[color:var(--workspace-border-strong)]"
              aria-label={t('browser.address.label')}
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" className="h-8 shrink-0 px-3 text-xs">
            {t('browser.action.go')}
          </Button>
        </form>

        {canToggleRouteMode && (
          <div className="inline-flex h-8 shrink-0 items-center rounded-lg bg-[var(--workspace-surface-800)] p-0.5">
            {(['local', 'remote'] as const).map((mode) => {
              const active = routeMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    'h-7 rounded-md px-3 text-xs font-medium transition-colors',
                    active
                      ? 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-strong)] shadow-sm'
                      : 'text-[var(--workspace-text-subtle)] hover:text-[var(--workspace-text)]',
                  )}
                  onClick={() => onRouteModeChange(mode)}
                  aria-pressed={active}
                >
                  {mode === 'local' ? t('browser.route.local') : t('browser.route.server')}
                </button>
              )
            })}
          </div>
        )}

        {canRebuildTransport && onRebuildTransport && (
          <button
            type="button"
            className={iconButtonClass}
            onClick={onRebuildTransport}
            aria-label={t('browser.transport.rebuild')}
            title={t('browser.transport.rebuild')}
          >
            <RefreshCw className={cn('h-4 w-4', state.transportStatus === 'recovering' && 'animate-spin')} />
          </button>
        )}
        {activeTab && (
          <button
            type="button"
            className={cn(iconButtonClass, tabMenu?.tabId === activeTab.id && 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)]')}
            onClick={(event) => toggleTabMenu(activeTab.id, event)}
            aria-label={copy.tabMenu}
            title={copy.tabMenu}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        )}
      </div>

      {tabMenu && menuTab && (
        <div
          className="absolute z-30 w-[210px] rounded-[10px] border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-[5px] shadow-[var(--workspace-shadow-overlay)]"
          style={{ top: tabMenu.top, left: tabMenu.left }}
        >
          <button
            type="button"
            className={menuItemClass}
            onClick={() => {
              onTogglePinTab(menuTab.id)
              setTabMenu(null)
            }}
          >
            {menuTab.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {menuTab.pinned ? t('browser.tab.unpin') : t('browser.tab.pin')}
          </button>
          <button
            type="button"
            className={menuItemClass}
            onClick={() => {
              onDuplicateTab(menuTab.id)
              setTabMenu(null)
            }}
          >
            <CopyPlus className="h-3.5 w-3.5" />
            {t('browser.tab.duplicate')}
          </button>
          <button
            type="button"
            className={menuItemClass}
            onClick={() => void handleCopyTabLink(menuTab.url)}
            disabled={!menuTab.url}
          >
            <Link className="h-3.5 w-3.5" />
            {t('browser.tab.copyLink')}
          </button>
          <div className="mx-0.5 my-1 h-px bg-[var(--workspace-border-soft)]" />
          <button
            type="button"
            className={menuItemClass}
            onClick={() => {
              onCloseOtherTabs(menuTab.id)
              setTabMenu(null)
            }}
            disabled={tabs.length <= 1}
          >
            <X className="h-3.5 w-3.5" />
            {t('browser.tab.closeOthers')}
          </button>
          <button
            type="button"
            className={menuItemClass}
            onClick={() => {
              onCloseTabsToRight(menuTab.id)
              setTabMenu(null)
            }}
          >
            <ArrowRightToLine className="h-3.5 w-3.5" />
            {t('browser.tab.closeRight')}
          </button>
        </div>
      )}

      {tabSwitcherOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[18vh] backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTabSwitcherOpen(false)
          }}
        >
          <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] shadow-[var(--workspace-shadow-overlay)]">
            <div className="flex h-[54px] items-center gap-2.5 border-b border-[color:var(--workspace-border-soft)] px-4">
              <Search className="h-[18px] w-[18px] shrink-0 text-[var(--workspace-text-subtle)]" />
              <input
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
                placeholder={t('browser.tab.searchPlaceholder')}
                className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]"
              />
              <button type="button" className="shrink-0" onClick={() => setTabSwitcherOpen(false)} aria-label={t('browser.tab.closeOverview')}>
                <BrowserKbd>esc</BrowserKbd>
              </button>
            </div>
            <div className="max-h-[340px] overflow-y-auto px-1.5 pb-2 pt-1">
              {filteredTabs.length > 0 ? (
                filteredTabs.map((tab) => {
                  const isHighlighted = tab.id === highlightedTabId
                  const tone = getBrowserRouteTone(tab.routeIndicator?.scope, tab.sourceKind)
                  const sideLabel = tab.routeIndicator?.scope === 'pending'
                    ? tab.routeIndicator.detail
                    : getRouteChipLabel(tab)
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={cn(
                        'grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors',
                        isHighlighted ? 'bg-[var(--workspace-accent-subtle)]' : 'hover:bg-[var(--workspace-surface-800)]',
                      )}
                      onMouseEnter={() => setHighlightedTabId(tab.id)}
                      onClick={() => {
                        onSelectTab(tab.id)
                        setTabSwitcherOpen(false)
                      }}
                    >
                      <span className={cn('h-2 w-2 rounded-full', tone === 'preview' ? 'bg-[var(--workspace-text-subtle)]' : getBrowserRouteDotClass(tab.routeIndicator?.scope))} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-[var(--workspace-text-strong)]">{tab.title}</span>
                          {tab.pinned && <Pin className="h-3 w-3 shrink-0 text-[var(--workspace-accent-text)]" />}
                          {tab.active && (
                            <span className="shrink-0 rounded bg-[var(--workspace-accent-subtle)] px-1.5 text-[10px] font-medium leading-[17px] text-[var(--workspace-accent-text)]">
                              {t('browser.tab.active')}
                            </span>
                          )}
                        </span>
                        {tab.url && (
                          <span className="mt-px block truncate font-mono text-[11px] text-[var(--workspace-text-subtle)]">{tab.url}</span>
                        )}
                      </span>
                      {sideLabel ? (
                        <span className="max-w-[180px] truncate rounded bg-[var(--workspace-surface-800)] px-1.5 text-[11px] leading-5 text-[var(--workspace-text-muted)]">{sideLabel}</span>
                      ) : <span />}
                    </button>
                  )
                })
              ) : (
                <div className="px-4 py-8 text-center text-sm text-[var(--workspace-text-subtle)]">
                  {t('browser.tab.noMatches')}
                </div>
              )}
            </div>
            <div className="flex h-[38px] items-center gap-4 border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-800)] px-3.5 text-[11px] text-[var(--workspace-text-subtle)]">
              <span className="flex items-center gap-1"><BrowserKbd>↑</BrowserKbd><BrowserKbd>↓</BrowserKbd><span className="ml-0.5">{copy.select}</span></span>
              <span className="flex items-center gap-1"><BrowserKbd>↵</BrowserKbd><span className="ml-0.5">{copy.switchTo}</span></span>
              <span className="flex-1" />
              <span>⇧{browserModKey}O</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
