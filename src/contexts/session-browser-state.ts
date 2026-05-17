import type { BrowserSource } from '@/lib/browser'

export type BrowserPresentation = 'embedded' | 'window' | 'closed'
export type BrowserRouteMode = 'auto' | 'local' | 'remote'
export type BrowserTransportStatus = 'idle' | 'recovering' | 'failed'

export interface BrowserTabState {
  id: string
  pinned: boolean
  source: BrowserSource | null
  addressInput: string
  currentUrl: string | null
  resolvedUrl: string | null
  resolvedLocalPort: number | null
  proxyUrl: string | null
  transportStatus: BrowserTransportStatus
  title: string
  error: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  history: BrowserSource[]
  historyIndex: number
  sourceRevision: number
}

export interface SessionBrowserState {
  presentation: BrowserPresentation
  routeMode: BrowserRouteMode
  activeTabId: string | null
  tabs: BrowserTabState[]
  closedTabs: BrowserTabState[]
  source: BrowserSource | null
  addressInput: string
  currentUrl: string | null
  resolvedUrl: string | null
  resolvedLocalPort: number | null
  proxyUrl: string | null
  transportStatus: BrowserTransportStatus
  title: string
  error: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  history: BrowserSource[]
  historyIndex: number
  sourceRevision: number
}

const MAX_CLOSED_BROWSER_TABS = 12

let browserTabSequence = 0

export function createBrowserTabId() {
  browserTabSequence += 1
  return `browser-tab-${browserTabSequence}`
}

function getInitialBrowserTabState(id: string = createBrowserTabId()): BrowserTabState {
  return {
    id,
    pinned: false,
    source: null,
    addressInput: '',
    currentUrl: null,
    resolvedUrl: null,
    resolvedLocalPort: null,
    proxyUrl: null,
    transportStatus: 'idle',
    title: '',
    error: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    history: [],
    historyIndex: -1,
    sourceRevision: 0,
  }
}

function getActiveTabFromState(state: { activeTabId?: string | null; tabs?: BrowserTabState[] }) {
  if (!state.tabs?.length) return null
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null
}

function orderBrowserTabs(tabs: BrowserTabState[]) {
  const pinnedTabs = tabs.filter((tab) => tab.pinned)
  const regularTabs = tabs.filter((tab) => !tab.pinned)
  return [...pinnedTabs, ...regularTabs]
}

function applyActiveTabSnapshot(state: {
  presentation: BrowserPresentation
  routeMode: BrowserRouteMode
  activeTabId: string | null
  tabs: BrowserTabState[]
  closedTabs?: BrowserTabState[]
}): SessionBrowserState {
  const orderedTabs = state.tabs.length > 0 ? orderBrowserTabs(state.tabs) : [getInitialBrowserTabState()]
  const activeTab = getActiveTabFromState({
    activeTabId: state.activeTabId,
    tabs: orderedTabs,
  }) ?? orderedTabs[0] ?? getInitialBrowserTabState()
  return {
    ...state,
    activeTabId: activeTab.id,
    tabs: orderedTabs,
    closedTabs: state.closedTabs ?? [],
    source: activeTab.source,
    addressInput: activeTab.addressInput,
    currentUrl: activeTab.currentUrl,
    resolvedUrl: activeTab.resolvedUrl,
    resolvedLocalPort: activeTab.resolvedLocalPort,
    proxyUrl: activeTab.proxyUrl,
    transportStatus: activeTab.transportStatus,
    title: activeTab.title,
    error: activeTab.error,
    isLoading: activeTab.isLoading,
    canGoBack: activeTab.canGoBack,
    canGoForward: activeTab.canGoForward,
    history: activeTab.history,
    historyIndex: activeTab.historyIndex,
    sourceRevision: activeTab.sourceRevision,
  }
}

function normalizeBrowserTabState(input: Partial<BrowserTabState> | undefined, fallbackId?: string): BrowserTabState {
  const base = getInitialBrowserTabState(fallbackId)
  const next = {
    ...base,
    ...input,
    id: input?.id ?? base.id,
    history: input?.history ?? base.history,
  }
  return {
    ...next,
    canGoBack: input?.canGoBack ?? next.historyIndex > 0,
    canGoForward: input?.canGoForward ?? (next.historyIndex >= 0 && next.historyIndex < next.history.length - 1),
  }
}

function normalizeClosedBrowserTabs(tabs: Partial<BrowserTabState>[] | undefined) {
  return (tabs ?? []).slice(0, MAX_CLOSED_BROWSER_TABS).map((tab) => normalizeBrowserTabState(tab))
}

function sanitizeBrowserTabForStoredState(
  tab: BrowserTabState,
  options?: { keepLoading?: boolean; preserveId?: boolean },
) {
  const keepLoading = options?.keepLoading ?? false
  return normalizeBrowserTabState({
    ...tab,
    id: options?.preserveId ? tab.id : createBrowserTabId(),
    resolvedUrl: null,
    resolvedLocalPort: null,
    proxyUrl: null,
    transportStatus: 'idle',
    error: null,
    isLoading: keepLoading ? Boolean(tab.source) : false,
    sourceRevision: tab.source ? tab.sourceRevision + 1 : tab.sourceRevision,
    canGoBack: tab.historyIndex > 0,
    canGoForward: tab.historyIndex >= 0 && tab.historyIndex < tab.history.length - 1,
  })
}

function prependClosedBrowserTabs(current: SessionBrowserState, tabs: BrowserTabState[]) {
  if (tabs.length === 0) return current.closedTabs
  return [
    ...tabs.map((tab) => sanitizeBrowserTabForStoredState(tab)).reverse(),
    ...current.closedTabs,
  ].slice(0, MAX_CLOSED_BROWSER_TABS)
}

function mergeLegacyActiveTabFields(
  tab: BrowserTabState,
  input: Partial<SessionBrowserState> | null | undefined,
): BrowserTabState {
  if (!input) return tab
  return normalizeBrowserTabState({
    ...tab,
    source: input.source ?? tab.source,
    addressInput: input.addressInput ?? tab.addressInput,
    currentUrl: input.currentUrl ?? tab.currentUrl,
    resolvedUrl: input.resolvedUrl ?? tab.resolvedUrl,
    resolvedLocalPort: input.resolvedLocalPort ?? tab.resolvedLocalPort,
    proxyUrl: input.proxyUrl ?? tab.proxyUrl,
    transportStatus: input.transportStatus ?? tab.transportStatus,
    title: input.title ?? tab.title,
    error: input.error ?? tab.error,
    isLoading: input.isLoading ?? tab.isLoading,
    canGoBack: input.canGoBack ?? tab.canGoBack,
    canGoForward: input.canGoForward ?? tab.canGoForward,
    history: input.history ?? tab.history,
    historyIndex: input.historyIndex ?? tab.historyIndex,
    sourceRevision: input.sourceRevision ?? tab.sourceRevision,
  }, tab.id)
}

export function normalizeSessionBrowserState(input?: Partial<SessionBrowserState> | null): SessionBrowserState {
  const baseTab = normalizeBrowserTabState(input ?? undefined, input?.activeTabId ?? undefined)
  let tabs = input?.tabs?.length
    ? input.tabs.map((tab) => normalizeBrowserTabState(tab))
    : [baseTab]
  const activeTabId = input?.activeTabId ?? tabs[0]?.id ?? null
  tabs = tabs.map((tab) => (
    tab.id === activeTabId ? mergeLegacyActiveTabFields(tab, input) : tab
  ))

  return applyActiveTabSnapshot({
    presentation: input?.presentation ?? 'closed',
    routeMode: input?.routeMode ?? 'auto',
    activeTabId,
    tabs,
    closedTabs: normalizeClosedBrowserTabs((input as { closedTabs?: Partial<BrowserTabState>[] } | undefined)?.closedTabs),
  })
}

export function getInitialSessionBrowserState(): SessionBrowserState {
  return normalizeSessionBrowserState()
}

function getSessionBrowserState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
): SessionBrowserState {
  return normalizeSessionBrowserState(state[sessionId])
}

export function getSessionBrowserTabs(state: SessionBrowserState | null | undefined) {
  return normalizeSessionBrowserState(state).tabs
}

export function getActiveSessionBrowserTab(state: SessionBrowserState | null | undefined) {
  return getActiveTabFromState(normalizeSessionBrowserState(state))
}

function updateActiveTab(
  current: SessionBrowserState,
  updater: (tab: BrowserTabState) => BrowserTabState,
): SessionBrowserState {
  const activeTab = getActiveTabFromState(current) ?? getInitialBrowserTabState(current.activeTabId ?? undefined)
  const tabs = current.tabs.map((tab) => (tab.id === activeTab.id ? normalizeBrowserTabState(updater(tab), tab.id) : tab))
  return applyActiveTabSnapshot({
    presentation: current.presentation,
    routeMode: current.routeMode,
    activeTabId: activeTab.id,
    tabs,
    closedTabs: current.closedTabs,
  })
}

function updateTabById(
  current: SessionBrowserState,
  tabId: string,
  updater: (tab: BrowserTabState) => BrowserTabState,
): SessionBrowserState {
  const tabs = current.tabs.map((tab) => (tab.id === tabId ? normalizeBrowserTabState(updater(tab), tab.id) : tab))
  return applyActiveTabSnapshot({
    presentation: current.presentation,
    routeMode: current.routeMode,
    activeTabId: current.activeTabId,
    tabs,
    closedTabs: current.closedTabs,
  })
}

export function getBrowserSourceTitle(source: BrowserSource): string {
  if (source.kind === 'url') {
    try {
      const url = new URL(source.url)
      return url.hostname || source.url
    } catch {
      return source.url
    }
  }
  return source.title ?? (source.kind === 'markdown' ? 'Markdown Preview' : 'HTML Preview')
}

export function getBrowserSourceAddress(source: BrowserSource): string {
  if (source.kind === 'url') return normalizeBrowserUrl(source.url)
  return source.baseUrl ?? ''
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/.test(trimmed)) return `http://${trimmed}`
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+(\/.*)?$/.test(trimmed)) return `http://${trimmed}`
  if (/^[a-zA-Z0-9.-]+:\d+(\/.*)?$/.test(trimmed)) return `http://${trimmed}`
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function setSessionBrowserPresentationState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  presentation: BrowserPresentation,
) {
  const current = getSessionBrowserState(state, sessionId)
  const next = applyActiveTabSnapshot({
    presentation,
    routeMode: current.routeMode,
    activeTabId: current.activeTabId,
    tabs: current.tabs.map((tab) => ({
      ...tab,
      error: presentation === 'closed' ? null : tab.error,
      isLoading: presentation === 'closed' ? false : tab.isLoading,
    })),
    closedTabs: current.closedTabs,
  })
  if (
    current.presentation === next.presentation
    && current.error === next.error
    && current.isLoading === next.isLoading
  ) {
    return state
  }
  return { ...state, [sessionId]: next }
}

export function resolveBrowserRouteMode(routeMode: BrowserRouteMode, hasRemoteSession: boolean): 'local' | 'remote' {
  if (routeMode === 'local') return 'local'
  if (routeMode === 'remote') return hasRemoteSession ? 'remote' : 'local'
  return hasRemoteSession ? 'remote' : 'local'
}

export function setSessionBrowserAddressInputState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  addressInput: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.addressInput === addressInput) return state
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => ({ ...tab, addressInput })),
  }
}

export function setSessionBrowserRouteModeState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  routeMode: BrowserRouteMode,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.routeMode === routeMode) return state
  const next = updateActiveTab(
    applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode,
      activeTabId: current.activeTabId,
      tabs: current.tabs,
      closedTabs: current.closedTabs,
    }),
    (tab) => {
      const shouldReload = tab.source?.kind === 'url'
      return {
        ...tab,
        resolvedUrl: null,
        resolvedLocalPort: null,
        proxyUrl: null,
        error: null,
        isLoading: shouldReload ? true : tab.isLoading,
        sourceRevision: shouldReload ? tab.sourceRevision + 1 : tab.sourceRevision,
      }
    },
  )
  return { ...state, [sessionId]: next }
}

export function createSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const tab = getInitialBrowserTabState()
  return {
    ...state,
    [sessionId]: applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: tab.id,
      tabs: [...current.tabs, tab],
      closedTabs: current.closedTabs,
    }),
  }
}

export function duplicateSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId?: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const sourceTab = current.tabs.find((tab) => tab.id === (tabId ?? current.activeTabId)) ?? getActiveSessionBrowserTab(current)
  if (!sourceTab) return state

  const duplicatedTab = sanitizeBrowserTabForStoredState(sourceTab, { keepLoading: true })
  const sourceIndex = current.tabs.findIndex((tab) => tab.id === sourceTab.id)
  const insertIndex = sourceIndex >= 0 ? sourceIndex + 1 : current.tabs.length
  const nextTabs = [...current.tabs]
  nextTabs.splice(insertIndex, 0, duplicatedTab)

  return {
    ...state,
    [sessionId]: applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: duplicatedTab.id,
      tabs: nextTabs,
      closedTabs: current.closedTabs,
    }),
  }
}

export function activateSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.activeTabId === tabId || !current.tabs.some((tab) => tab.id === tabId)) return state
  const next = updateTabById(
    applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: tabId,
      tabs: current.tabs,
      closedTabs: current.closedTabs,
    }),
    tabId,
    (tab) => ({
      ...tab,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      error: null,
      isLoading: Boolean(tab.source),
      sourceRevision: tab.source ? tab.sourceRevision + 1 : tab.sourceRevision,
    }),
  )
  return { ...state, [sessionId]: next }
}

export function closeSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (!current.tabs.some((tab) => tab.id === tabId)) return state

  const currentIndex = current.tabs.findIndex((tab) => tab.id === tabId)
  const remainingTabs = current.tabs.filter((tab) => tab.id !== tabId)
  const fallbackTab = remainingTabs[currentIndex] ?? remainingTabs[currentIndex - 1] ?? getInitialBrowserTabState()
  const nextTabs = remainingTabs.length > 0 ? remainingTabs : [fallbackTab]
  const nextActiveTabId = current.activeTabId === tabId ? fallbackTab.id : current.activeTabId

  const next = updateTabById(
    applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: nextActiveTabId,
      tabs: nextTabs,
      closedTabs: prependClosedBrowserTabs(current, current.tabs.filter((tab) => tab.id === tabId)),
    }),
    nextActiveTabId ?? fallbackTab.id,
    (tab) => ({
      ...tab,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      error: null,
      isLoading: tab.source ? true : false,
      sourceRevision: tab.source ? tab.sourceRevision + 1 : tab.sourceRevision,
    }),
  )
  return { ...state, [sessionId]: next }
}

export function closeOtherSessionBrowserTabsState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const remaining = current.tabs.filter((tab) => tab.id === tabId)
  if (remaining.length !== 1 || current.tabs.length === 1) return state
  const next = updateTabById(
    applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: tabId,
      tabs: remaining,
      closedTabs: prependClosedBrowserTabs(current, current.tabs.filter((tab) => tab.id !== tabId)),
    }),
    tabId,
    (tab) => ({
      ...tab,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      error: null,
      isLoading: Boolean(tab.source),
      sourceRevision: tab.source ? tab.sourceRevision + 1 : tab.sourceRevision,
    }),
  )
  return { ...state, [sessionId]: next }
}

export function closeSessionBrowserTabsToRightState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const tabIndex = current.tabs.findIndex((tab) => tab.id === tabId)
  if (tabIndex < 0 || tabIndex === current.tabs.length - 1) return state
  const remaining = current.tabs.slice(0, tabIndex + 1)
  const nextActiveTabId = remaining.some((tab) => tab.id === current.activeTabId)
    ? current.activeTabId
    : remaining[remaining.length - 1]?.id ?? tabId
  const next = updateTabById(
    applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: nextActiveTabId,
      tabs: remaining,
      closedTabs: prependClosedBrowserTabs(current, current.tabs.slice(tabIndex + 1)),
    }),
    nextActiveTabId ?? tabId,
    (tab) => ({
      ...tab,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      error: null,
      isLoading: tab.id === nextActiveTabId ? Boolean(tab.source) : tab.isLoading,
      sourceRevision: tab.id === nextActiveTabId && tab.source ? tab.sourceRevision + 1 : tab.sourceRevision,
    }),
  )
  return { ...state, [sessionId]: next }
}

export function toggleSessionBrowserTabPinnedState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const currentIndex = current.tabs.findIndex((tab) => tab.id === tabId)
  if (currentIndex < 0) return state

  const currentTab = current.tabs[currentIndex]!
  const remaining = current.tabs.filter((tab) => tab.id !== tabId)
  const nextPinned = !currentTab.pinned
  const nextTab = normalizeBrowserTabState({ ...currentTab, pinned: nextPinned }, currentTab.id)
  const pinnedCount = remaining.filter((tab) => tab.pinned).length
  const insertIndex = nextPinned ? pinnedCount : pinnedCount
  const nextTabs = [...remaining]
  nextTabs.splice(insertIndex, 0, nextTab)

  return {
    ...state,
    [sessionId]: applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: current.activeTabId,
      tabs: nextTabs,
      closedTabs: current.closedTabs,
    }),
  }
}

export function reorderSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  tabId: string,
  targetTabId: string,
  position: 'before' | 'after',
) {
  const current = getSessionBrowserState(state, sessionId)
  const sourceIndex = current.tabs.findIndex((tab) => tab.id === tabId)
  const targetIndex = current.tabs.findIndex((tab) => tab.id === targetTabId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return state

  const sourceTab = current.tabs[sourceIndex]!
  const targetTab = current.tabs[targetIndex]!
  if (sourceTab.pinned !== targetTab.pinned) return state

  const remaining = current.tabs.filter((tab) => tab.id !== tabId)
  const nextTargetIndex = remaining.findIndex((tab) => tab.id === targetTabId)
  if (nextTargetIndex < 0) return state

  const insertIndex = position === 'before' ? nextTargetIndex : nextTargetIndex + 1
  const nextTabs = [...remaining]
  nextTabs.splice(insertIndex, 0, sourceTab)

  const unchanged = nextTabs.every((tab, index) => tab.id === current.tabs[index]?.id)
  if (unchanged) return state

  return {
    ...state,
    [sessionId]: applyActiveTabSnapshot({
      presentation: current.presentation,
      routeMode: current.routeMode,
      activeTabId: current.activeTabId,
      tabs: nextTabs,
      closedTabs: current.closedTabs,
    }),
  }
}

export function restoreLastClosedSessionBrowserTabState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const closedTab = current.closedTabs[0]
  if (!closedTab) return state

  const restoredTab = sanitizeBrowserTabForStoredState(closedTab, { keepLoading: true })
  return {
    ...state,
    [sessionId]: applyActiveTabSnapshot({
      presentation: current.presentation === 'closed' ? 'embedded' : current.presentation,
      routeMode: current.routeMode,
      activeTabId: restoredTab.id,
      tabs: [...current.tabs, restoredTab],
      closedTabs: current.closedTabs.slice(1),
    }),
  }
}

export function setSessionBrowserLoadingState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  isLoading: boolean,
  tabId?: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const targetTab = tabId ? current.tabs.find((tab) => tab.id === tabId) : getActiveSessionBrowserTab(current)
  if (!targetTab) return state
  if (targetTab.isLoading === isLoading) return state
  return {
    ...state,
    [sessionId]: tabId
      ? updateTabById(current, tabId, (tab) => ({ ...tab, isLoading }))
      : updateActiveTab(current, (tab) => ({ ...tab, isLoading })),
  }
}

export function setSessionBrowserErrorState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  error: string | null,
  tabId?: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const targetTab = tabId ? current.tabs.find((tab) => tab.id === tabId) : getActiveSessionBrowserTab(current)
  if (!targetTab) return state
  if (targetTab.error === error && targetTab.isLoading === false) return state
  return {
    ...state,
    [sessionId]: tabId
      ? updateTabById(current, tabId, (tab) => ({ ...tab, error, isLoading: false }))
      : updateActiveTab(current, (tab) => ({ ...tab, error, isLoading: false })),
  }
}

export function openSessionBrowserSourceState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  source: BrowserSource,
  presentation: BrowserPresentation = 'embedded',
) {
  const current = getSessionBrowserState(state, sessionId)
  const next = updateActiveTab(
    applyActiveTabSnapshot({
      presentation,
      routeMode: current.routeMode,
      activeTabId: current.activeTabId,
      tabs: current.tabs,
      closedTabs: current.closedTabs,
    }),
    (tab) => {
      const nextHistory = tab.history.slice(0, tab.historyIndex + 1)
      nextHistory.push(source)
      return {
        ...tab,
        source,
        addressInput: getBrowserSourceAddress(source),
        currentUrl: source.kind === 'url' ? source.url : source.baseUrl ?? null,
        resolvedUrl: null,
        resolvedLocalPort: null,
        proxyUrl: null,
        title: getBrowserSourceTitle(source),
        error: null,
        isLoading: true,
        canGoBack: nextHistory.length > 1,
        canGoForward: false,
        history: nextHistory,
        historyIndex: nextHistory.length - 1,
        sourceRevision: tab.sourceRevision + 1,
      }
    },
  )
  return { ...state, [sessionId]: next }
}

export function submitSessionBrowserAddressState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  presentation: BrowserPresentation = 'embedded',
) {
  const current = getSessionBrowserState(state, sessionId)
  const url = normalizeBrowserUrl(current.addressInput)
  if (!url) return state
  return openSessionBrowserSourceState(state, sessionId, { kind: 'url', url }, presentation)
}

export function goSessionBrowserBackState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.historyIndex <= 0) return state
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => {
      const historyIndex = tab.historyIndex - 1
      const source = tab.history[historyIndex]
      return {
        ...tab,
        source,
        historyIndex,
        addressInput: getBrowserSourceAddress(source),
        currentUrl: source.kind === 'url' ? source.url : source.baseUrl ?? null,
        resolvedUrl: null,
        resolvedLocalPort: null,
        proxyUrl: null,
        title: getBrowserSourceTitle(source),
        error: null,
        isLoading: true,
        canGoBack: historyIndex > 0,
        canGoForward: historyIndex < tab.history.length - 1,
        sourceRevision: tab.sourceRevision + 1,
      }
    }),
  }
}

export function goSessionBrowserForwardState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.historyIndex >= current.history.length - 1) return state
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => {
      const historyIndex = tab.historyIndex + 1
      const source = tab.history[historyIndex]
      return {
        ...tab,
        source,
        historyIndex,
        addressInput: getBrowserSourceAddress(source),
        currentUrl: source.kind === 'url' ? source.url : source.baseUrl ?? null,
        resolvedUrl: null,
        resolvedLocalPort: null,
        proxyUrl: null,
        title: getBrowserSourceTitle(source),
        error: null,
        isLoading: true,
        canGoBack: historyIndex > 0,
        canGoForward: historyIndex < tab.history.length - 1,
        sourceRevision: tab.sourceRevision + 1,
      }
    }),
  }
}

export function reloadSessionBrowserState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (!current.source) return state
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => ({
      ...tab,
      error: null,
      isLoading: true,
      sourceRevision: tab.sourceRevision + 1,
    })),
  }
}

export function setSessionBrowserNavigationState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  values: { canGoBack?: boolean; canGoForward?: boolean; title?: string | null },
  tabId?: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const targetTab = tabId ? current.tabs.find((tab) => tab.id === tabId) : getActiveSessionBrowserTab(current)
  if (!targetTab) return state
  const nextCanGoBack = values.canGoBack ?? targetTab.canGoBack
  const nextCanGoForward = values.canGoForward ?? targetTab.canGoForward
  const nextTitle = values.title ?? targetTab.title
  if (
    targetTab.canGoBack === nextCanGoBack
    && targetTab.canGoForward === nextCanGoForward
    && targetTab.title === nextTitle
  ) {
    return state
  }
  return {
    ...state,
    [sessionId]: tabId
      ? updateTabById(current, tabId, (tab) => ({
        ...tab,
        canGoBack: nextCanGoBack,
        canGoForward: nextCanGoForward,
        title: nextTitle,
      }))
      : updateActiveTab(current, (tab) => ({
        ...tab,
        canGoBack: nextCanGoBack,
        canGoForward: nextCanGoForward,
        title: nextTitle,
      })),
  }
}

export function setSessionBrowserTransportState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  values: { resolvedUrl?: string | null; resolvedLocalPort?: number | null; proxyUrl?: string | null },
) {
  const current = getSessionBrowserState(state, sessionId)
  const nextResolvedUrl = Object.prototype.hasOwnProperty.call(values, 'resolvedUrl')
    ? values.resolvedUrl ?? null
    : current.resolvedUrl
  const nextResolvedLocalPort = Object.prototype.hasOwnProperty.call(values, 'resolvedLocalPort')
    ? values.resolvedLocalPort ?? null
    : current.resolvedLocalPort
  const nextProxyUrl = Object.prototype.hasOwnProperty.call(values, 'proxyUrl')
    ? values.proxyUrl ?? null
    : current.proxyUrl
  if (
    current.resolvedUrl === nextResolvedUrl
    && current.resolvedLocalPort === nextResolvedLocalPort
    && current.proxyUrl === nextProxyUrl
  ) {
    return state
  }
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => ({
      ...tab,
      resolvedUrl: nextResolvedUrl,
      resolvedLocalPort: nextResolvedLocalPort,
      proxyUrl: nextProxyUrl,
    })),
  }
}

export function setSessionBrowserTransportStatusState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  transportStatus: BrowserTransportStatus,
) {
  const current = getSessionBrowserState(state, sessionId)
  if (current.transportStatus === transportStatus) return state
  return {
    ...state,
    [sessionId]: updateActiveTab(current, (tab) => ({ ...tab, transportStatus })),
  }
}

/** Compare browser URLs ignoring trivial differences like trailing slashes on the root path. */
function urlsMatch(a: string | null, b: string): boolean {
  if (!a) return false
  if (a === b) return true
  try {
    const urlA = new URL(a)
    const urlB = new URL(b)
    return (
      urlA.origin === urlB.origin
      && urlA.pathname.replace(/\/+$/, '') === urlB.pathname.replace(/\/+$/, '')
      && urlA.search === urlB.search
      && urlA.hash === urlB.hash
    )
  } catch {
    return false
  }
}

export function syncSessionBrowserUrlState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
  url: string,
  tabId?: string,
) {
  const current = getSessionBrowserState(state, sessionId)
  const targetTab = tabId ? current.tabs.find((tab) => tab.id === tabId) : getActiveSessionBrowserTab(current)
  if (!targetTab) return state
  const updateTarget = (updater: (tab: BrowserTabState) => BrowserTabState) => ({
    ...state,
    [sessionId]: tabId ? updateTabById(current, tabId, updater) : updateActiveTab(current, updater),
  })
  if (!url) {
    return setSessionBrowserLoadingState(state, sessionId, false, tabId)
  }

  if (targetTab.source?.kind === 'url' && urlsMatch(targetTab.resolvedUrl, url)) {
    const sourceUrl = targetTab.source.url
    return updateTarget((tab) => ({
      ...tab,
      currentUrl: sourceUrl,
      addressInput: sourceUrl,
      isLoading: false,
    }))
  }

  if (urlsMatch(targetTab.currentUrl, url)) {
    return setSessionBrowserLoadingState(state, sessionId, false, tabId)
  }

  if (targetTab.source?.kind !== 'url') {
    if (/^data:/i.test(url)) {
      return setSessionBrowserLoadingState(state, sessionId, false, tabId)
    }

    return updateTarget((tab) => ({
        ...tab,
        currentUrl: url,
        addressInput: url,
        resolvedUrl: null,
        resolvedLocalPort: null,
        isLoading: false,
      }))
  }

  const existingIndex = targetTab.history.findIndex((entry) => entry.kind === 'url' && urlsMatch(entry.url, url))
  if (existingIndex >= 0) {
    const source = targetTab.history[existingIndex]
    return updateTarget((tab) => ({
        ...tab,
        source,
        currentUrl: url,
        addressInput: url,
        resolvedUrl: null,
        resolvedLocalPort: null,
        title: getBrowserSourceTitle(source),
        isLoading: false,
        historyIndex: existingIndex,
        canGoBack: existingIndex > 0,
        canGoForward: existingIndex < tab.history.length - 1,
      }))
  }

  const source: BrowserSource = { kind: 'url', url }
  return updateTarget((tab) => {
      const nextHistory = tab.history.slice(0, tab.historyIndex + 1)
      const history = [...nextHistory, source]
      const historyIndex = history.length - 1
      return {
        ...tab,
        source,
        currentUrl: url,
        addressInput: url,
        resolvedUrl: null,
        resolvedLocalPort: null,
        title: getBrowserSourceTitle(source),
        isLoading: false,
        history,
        historyIndex,
        canGoBack: historyIndex > 0,
        canGoForward: false,
      }
    })
}

export function closeSessionBrowserState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
): Record<string, SessionBrowserState> {
  const current = getSessionBrowserState(state, sessionId)
  if (
    current.presentation === 'closed'
    && current.error === null
    && current.isLoading === false
    && current.canGoBack === false
    && current.canGoForward === false
  ) {
    return state
  }
  const next = applyActiveTabSnapshot({
    presentation: 'closed',
    routeMode: current.routeMode,
    activeTabId: current.activeTabId,
    tabs: current.tabs.map((tab) => ({
      ...tab,
      error: null,
      isLoading: false,
      canGoBack: tab.id === current.activeTabId ? false : tab.canGoBack,
      canGoForward: tab.id === current.activeTabId ? false : tab.canGoForward,
    })),
    closedTabs: current.closedTabs,
  })
  return { ...state, [sessionId]: next }
}

export function removeSessionBrowserState(
  state: Record<string, SessionBrowserState>,
  sessionId: string,
) {
  const next = { ...state }
  delete next[sessionId]
  return next
}

export function stripSessionBrowserRuntimeState(state: SessionBrowserState): SessionBrowserState {
  const normalized = normalizeSessionBrowserState(state)
  return applyActiveTabSnapshot({
    presentation: normalized.presentation,
    routeMode: normalized.routeMode,
    activeTabId: normalized.activeTabId,
    tabs: normalized.tabs.map((tab) => ({
      ...tab,
      resolvedUrl: null,
      resolvedLocalPort: null,
      proxyUrl: null,
      error: null,
      isLoading: false,
      canGoBack: tab.historyIndex > 0,
      canGoForward: tab.historyIndex >= 0 && tab.historyIndex < tab.history.length - 1,
    })),
    closedTabs: normalized.closedTabs.map((tab) => sanitizeBrowserTabForStoredState(tab)),
  })
}
