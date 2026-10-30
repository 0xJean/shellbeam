import type { ReactNode } from 'react'
import { ChevronLeft, LayoutGrid, List, Loader2, Plus, RefreshCw, Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { fill } from '@/lib/locales/probe-install'
import { workspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import type { HostOpsHealthState } from '@/lib/host-ops-view'
import type { WorkspaceAppId } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { WorkspaceAppIcon } from '../workspace-app-grid'
import { DOCK_APPS, FIRST_PAGE_WIDGETS, HOME_GRID_APPS, WIDGET_SPAN, type MobileHomeLayout, type MobileWidgetId } from './mobile-home-prefs'
import { healthDotClass } from './mobile-format'
import { MobileHomeWidget } from './mobile-home-widgets'
import { useLongPress, type PullState } from './use-mobile-gestures'
import type { MobileHomeData } from './use-mobile-home-data'


const glass = 'border border-[color:var(--workspace-mobile-stroke)] bg-[var(--workspace-mobile-card)] backdrop-blur-2xl'

export function MobileHomeTopBar({ hostName, health, layout, onBackToHosts, onToggleLayout, onAddWidgets }: {
  hostName: string; health?: HostOpsHealthState; layout: MobileHomeLayout; onBackToHosts?: () => void; onToggleLayout: () => void; onAddWidgets: () => void
}) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const pill = cn('inline-flex h-11 items-center gap-1 rounded-full px-1 text-[13.5px] font-semibold text-[var(--workspace-text-strong)] active:opacity-60')
  const pillInner = cn('inline-flex h-[30px] items-center gap-1.5 rounded-full px-3 shadow-sm', glass)
  return <div data-testid="mobile-home-topbar" className="relative z-10 flex items-center gap-1 px-3.5">
    {onBackToHosts && <button type="button" className={pill} onClick={onBackToHosts} aria-label={copy.hosts}>
      <span className={cn(pillInner, 'pl-2')}><ChevronLeft className="h-4 w-4" aria-hidden="true" />{copy.hosts}</span>
    </button>}
    <span className={cn(pill, 'min-w-0')}>
      <span className={cn(pillInner, 'min-w-0')}><span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', healthDotClass(health))} /><span className="truncate">{hostName}</span></span>
    </span>
    <div className="ml-auto flex items-center">
      <button type="button" data-testid="mobile-home-layout-toggle" className="flex h-11 w-11 items-center justify-center active:opacity-60" aria-label={layout === 'grid' ? copy.listLayout : copy.gridLayout} onClick={onToggleLayout}>
        <span className={cn('flex h-[30px] w-[30px] items-center justify-center rounded-full text-[var(--workspace-text-strong)]', glass)}>{layout === 'grid' ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}</span>
      </button>
      <button type="button" data-testid="mobile-home-add-widgets" className="flex h-11 w-11 items-center justify-center active:opacity-60" aria-label={copy.addWidgets} onClick={onAddWidgets}>
        <span className={cn('flex h-[30px] w-[30px] items-center justify-center rounded-full text-[var(--workspace-text-strong)]', glass)}><Plus className="h-4 w-4" /></span>
      </button>
    </div>
  </div>
}

export function MobilePullIndicator({ state, distance }: { state: PullState; distance: number }) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  if (state === 'idle') return null
  return <div data-testid="mobile-pull-indicator" role="status" className="flex items-center justify-center gap-2 overflow-hidden text-[12.5px] text-[var(--workspace-text-muted)]" style={{ height: distance }}>
    <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-[color:var(--workspace-primary-500)]', glass)}>
      {state === 'refreshing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" style={{ transform: `rotate(${distance * 3}deg)` }} />}
    </span>
    {state === 'refreshing' ? copy.refreshing : state === 'armed' ? copy.releaseToRefresh : copy.pullToRefresh}
  </div>
}

function badgeFor(app: WorkspaceAppId, data: MobileHomeData, copy: (typeof workspaceMobileV3Copy)['en' | 'zh-CN']) {
  if (app === 'services' && data.failedServices) return { count: data.failedServices, label: fill(copy.badgeFailedServices, { count: data.failedServices }) }
  if (app === 'docker' && data.exitedContainers) return { count: data.exitedContainers, label: fill(copy.badgeExited, { count: data.exitedContainers }) }
  return null
}

export function SpringboardApp({ app, data, onOpen, onQuickActions, dock, compact }: { app: WorkspaceAppId; data: MobileHomeData; onOpen: (app: WorkspaceAppId) => void; onQuickActions: (app: WorkspaceAppId) => void; dock?: boolean; compact?: boolean }) {
  const { t, locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  const press = useLongPress(() => onQuickActions(app))
  const label = t(`workspace.app.${app}`)
  const badge = badgeFor(app, data, copy)
  const { consumeLongPress, ...handlers } = press
  return <button type="button" data-testid={`mobile-home-app-${app}`} aria-label={badge ? `${label} · ${badge.label}` : label} {...handlers}
    onClick={() => { if (!consumeLongPress()) onOpen(app) }}
    className="flex min-h-[44px] min-w-0 select-none flex-col items-center gap-1.5 [-webkit-touch-callout:none] active:scale-90 active:opacity-75 transition-transform">
    <WorkspaceAppIcon app={app} size={dock || compact ? 'md' : 'lg'} badge={badge?.count} />
    {!dock && <span className={cn('w-full truncate px-0.5 text-center font-medium', compact ? 'text-[11.5px] text-[var(--workspace-text)]' : 'text-[11.5px] text-[var(--workspace-text-strong)]')}>{label}</span>}
  </button>
}

export function MobileHomePage({ page, widgets, data, onOpen, onQuickActions, onOpenWidgetApp }: {
  page: 1 | 2; widgets: MobileWidgetId[]; data: MobileHomeData; onOpen: (app: WorkspaceAppId) => void; onQuickActions: (app: WorkspaceAppId) => void; onOpenWidgetApp: (app: WorkspaceAppId) => void
}) {
  const own = widgets.filter((id) => (page === 1) === FIRST_PAGE_WIDGETS.includes(id))
  return <div data-testid={`mobile-home-page-${page}`} className="grid grid-cols-4 auto-rows-[84px] gap-x-1 gap-y-3 px-3">
    {own.map((id) => <div key={id} className={cn(WIDGET_SPAN[id], id === 'cpu' || id === 'certs' || id === 'tasks' ? 'pr-2' : '')}><MobileHomeWidget id={id} data={data} onOpenApp={onOpenWidgetApp} /></div>)}
    {page === 1 && HOME_GRID_APPS.map((app) => <SpringboardApp key={app} app={app} data={data} onOpen={onOpen} onQuickActions={onQuickActions} />)}
  </div>
}

export function MobilePageDots({ pages, page, onSelect }: { pages: number; page: number; onSelect: (page: 1 | 2) => void }) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  if (pages < 2) return null
  return <div role="tablist" aria-label={copy.pages} className="flex justify-center">
    {Array.from({ length: pages }, (_, index) => index + 1).map((value) => <button key={value} type="button" role="tab" aria-selected={page === value} aria-label={fill(copy.page, { page: value })} onClick={() => onSelect(value as 1 | 2)} className="flex h-11 w-7 items-center justify-center">
      <span className={cn('h-[7px] w-[7px] rounded-full bg-[var(--workspace-text-muted)]', page === value ? 'opacity-100' : 'opacity-40')} />
    </button>)}
  </div>
}

export function MobileDock({ data, onOpen, onQuickActions, onSearch }: { data: MobileHomeData; onOpen: (app: WorkspaceAppId) => void; onQuickActions: (app: WorkspaceAppId) => void; onSearch: () => void }) {
  const { locale } = useT()
  const copy = workspaceMobileV3Copy[locale]
  return <div className="flex flex-col items-center gap-2">
    <button type="button" data-testid="mobile-home-search" onClick={onSearch} className="flex h-11 items-center active:opacity-60" aria-label={copy.searchPlaceholder}>
      <span className={cn('inline-flex h-[30px] items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-semibold text-[var(--workspace-text-strong)]', glass)}><Search className="h-3.5 w-3.5" aria-hidden="true" />{copy.search}</span>
    </button>
    <div data-testid="mobile-home-dock" className={cn('flex w-full justify-around rounded-[32px] px-1.5 py-3.5 shadow-[var(--workspace-shadow-overlay)]', glass)}>
      {DOCK_APPS.map((app) => <SpringboardApp key={app} app={app} data={data} onOpen={onOpen} onQuickActions={onQuickActions} dock />)}
    </div>
  </div>
}

export function MobileSheetScrim({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  return <div role="dialog" aria-modal="true" aria-label={label} className="absolute inset-0 z-50">
    <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 h-full w-full cursor-default bg-[var(--workspace-surface-950)] opacity-60 backdrop-blur-md" onClick={onClose} />
    {children}
  </div>
}
