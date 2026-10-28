import type { WorkspaceAppId } from '@/lib/workspace'

export const MOBILE_WIDGET_IDS = ['host', 'cpu', 'docker', 'certs', 'tasks', 'network'] as const
export type MobileWidgetId = (typeof MOBILE_WIDGET_IDS)[number]
export type MobileHomeLayout = 'grid' | 'list'

export interface MobileHomePrefs {
  widgets: MobileWidgetId[]
  layout: MobileHomeLayout
}

export const MOBILE_HOME_PREFS_KEY = 'shellbeam.workspace.mobileHome.v3'
export const DEFAULT_MOBILE_HOME_PREFS: MobileHomePrefs = { widgets: [...MOBILE_WIDGET_IDS], layout: 'grid' }

/** Page 1 carries the host summary next to the icons; everything else lives on page 2. */
export const FIRST_PAGE_WIDGETS: readonly MobileWidgetId[] = ['host', 'cpu']

export function loadMobileHomePrefs(): MobileHomePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(MOBILE_HOME_PREFS_KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return DEFAULT_MOBILE_HOME_PREFS
    const widgets = Array.isArray(raw.widgets) ? MOBILE_WIDGET_IDS.filter((id) => raw.widgets.includes(id)) : DEFAULT_MOBILE_HOME_PREFS.widgets
    return { widgets, layout: raw.layout === 'list' ? 'list' : 'grid' }
  } catch {
    return DEFAULT_MOBILE_HOME_PREFS
  }
}

export function saveMobileHomePrefs(prefs: MobileHomePrefs) {
  try { localStorage.setItem(MOBILE_HOME_PREFS_KEY, JSON.stringify(prefs)) } catch { /* Preferences are a convenience only. */ }
}

export const WIDGET_SPAN: Record<MobileWidgetId, string> = {
  host: 'col-span-4 row-span-2', cpu: 'col-span-2 row-span-2', certs: 'col-span-2 row-span-2', tasks: 'col-span-2 row-span-2', docker: 'col-span-4 row-span-2', network: 'col-span-4 row-span-2',
}
export const WIDGET_APP: Record<MobileWidgetId, WorkspaceAppId> = { host: 'charts', cpu: 'charts', certs: 'sitesSsl', tasks: 'scheduledTasks', docker: 'docker', network: 'charts' }

export const HOME_GRID_APPS: WorkspaceAppId[] = ['processes', 'services', 'logs', 'network', 'fileTransfer', 'docker', 'browser', 'scheduledTasks', 'sitesSsl', 'toolManager', 'assetInventory', 'overview']
export const DOCK_APPS: WorkspaceAppId[] = ['terminal', 'fileSystem', 'charts']
