import { useEffect, useMemo, useRef } from 'react'
import { BrowserChrome } from './browser-chrome'
import { EmbeddedBrowserWebview } from './embedded-browser-webview'
import { getBrowserRouteIndicator, getBrowserTabRouteIndicator, shouldWaitForRemoteBrowserTransport } from './browser-view-state'
import { useSessions } from '@/contexts/sessions-context'
import { getSessionBrowserTabs, resolveBrowserRouteMode } from '@/contexts/session-browser-state'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import {
  goBackBrowserWindow,
  goForwardBrowserWindow,
  reloadBrowserWindow,
} from '@/lib/browser'

const LOADING_TIMEOUT_MS = 30_000

interface BrowserViewProps {
  sessionId: string
  visible?: boolean
  onCloseRequest?: () => void
}

export function BrowserView({ sessionId, visible = true, onCloseRequest }: BrowserViewProps) {
  const sessions = useSessions()
  const { t } = useT()
  const { setSessionBrowserLoading } = sessions
  const state = sessions.browserBySession[sessionId]
  const sessionInfo = sessions.interactiveSessions.find((item) => item.sessionId === sessionId)
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasRemoteSession = Boolean(sessionInfo?.hostId)
  const effectiveRouteMode = resolveBrowserRouteMode(state?.routeMode ?? 'auto', hasRemoteSession)
  const waitingForRemoteTransport = shouldWaitForRemoteBrowserTransport({
    source: state?.source ?? null,
    effectiveRouteMode,
    resolvedUrl: state?.resolvedUrl,
    proxyUrl: state?.proxyUrl,
    transportStatus: state?.transportStatus,
    error: state?.error,
  })
  const routeIndicator = getBrowserRouteIndicator({
    source: state?.source ?? null,
    requestedRouteMode: state?.routeMode ?? 'auto',
    effectiveRouteMode,
    hasRemoteSession,
    waitingForRemoteTransport,
    resolvedUrl: state?.resolvedUrl,
    proxyUrl: state?.proxyUrl,
  })

  // Log state changes
  useEffect(() => {
    if (!state) return
    console.log('[Browser:View]', sessionId, 'state:', JSON.stringify({
      presentation: state.presentation,
      source: state.source?.kind,
      sourceUrl: state.source?.kind === 'url' ? state.source.url : undefined,
      sourceRevision: state.sourceRevision,
      routeMode: state.routeMode,
      effectiveRouteMode,
      proxyUrl: state.proxyUrl,
      resolvedUrl: state.resolvedUrl,
      isLoading: state.isLoading,
      error: state.error?.slice(0, 80),
      waitingForRemoteTransport,
      visible,
    }))
  }, [effectiveRouteMode, sessionId, state, visible, waitingForRemoteTransport])

  // Clear loading state if it stays true for too long (e.g. navigation failure with no Finished event)
  useEffect(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current)
      loadingTimerRef.current = null
    }
    if (state?.isLoading) {
      loadingTimerRef.current = setTimeout(() => {
        setSessionBrowserLoading(sessionId, false)
      }, LOADING_TIMEOUT_MS)
    }
    return () => {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current)
        loadingTimerRef.current = null
      }
    }
  }, [sessionId, setSessionBrowserLoading, state?.isLoading])

  if (!state) return null

  const tabs = useMemo(() => getSessionBrowserTabs(state).map((tab) => ({
    id: tab.id,
    pinned: tab.pinned,
    title: tab.title || tab.currentUrl || tab.addressInput || 'New Tab',
    active: tab.id === state.activeTabId,
    isLoading: tab.isLoading,
    sourceKind: tab.source?.kind ?? null,
    url: tab.currentUrl || (tab.source?.kind === 'url' ? tab.source.url : tab.addressInput || ''),
    routeIndicator: getBrowserTabRouteIndicator({
      source: tab.source,
      requestedRouteMode: state.routeMode,
      effectiveRouteMode,
      hasRemoteSession,
      isActiveTab: tab.id === state.activeTabId,
      resolvedUrl: tab.resolvedUrl,
      proxyUrl: tab.proxyUrl,
    }),
  })), [effectiveRouteMode, hasRemoteSession, state])
  const hasClosedTabs = state.closedTabs.length > 0
  const canRebuildTransport = hasRemoteSession && state.source?.kind === 'url' && effectiveRouteMode === 'remote'
  const showTransportRecovering = canRebuildTransport && state.transportStatus === 'recovering'
  const showTransportFailure = canRebuildTransport && state.transportStatus === 'failed'
  const showErrorPanel = showTransportFailure || (!waitingForRemoteTransport && !showTransportRecovering && !!state.error)
  const missingRemoteTransport = canRebuildTransport && !state.resolvedUrl && !state.proxyUrl
  const activeBrowserId = `${sessionId}::${state.activeTabId ?? 'tab'}`
  const transportInstanceKey = `${activeBrowserId}:${state.proxyUrl ?? state.resolvedUrl ?? effectiveRouteMode}`

  useEffect(() => {
    if (!visible || state.presentation === 'closed') return

    const activeIndex = tabs.findIndex((tab) => tab.active)
    const selectTabAt = (index: number) => {
      const next = tabs[index]
      if (!next) return
      sessions.activateSessionBrowserTab(sessionId, next.id)
    }

    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()

      if (key === 't' && !event.shiftKey) {
        event.preventDefault()
        sessions.createSessionBrowserTab(sessionId)
        return
      }

      if (key === 't' && event.shiftKey) {
        event.preventDefault()
        sessions.restoreLastClosedSessionBrowserTab(sessionId)
        return
      }

      if (key === 'w' && !event.shiftKey) {
        event.preventDefault()
        const active = tabs.find((tab) => tab.active)
        if (active) sessions.closeSessionBrowserTab(sessionId, active.id)
        return
      }

      if (event.shiftKey && (event.key === '[' || event.key === '{')) {
        event.preventDefault()
        if (tabs.length > 1) {
          selectTabAt((activeIndex - 1 + tabs.length) % tabs.length)
        }
        return
      }

      if (event.shiftKey && (event.key === ']' || event.key === '}')) {
        event.preventDefault()
        if (tabs.length > 1) {
          selectTabAt((activeIndex + 1) % tabs.length)
        }
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [sessionId, sessions, state.presentation, tabs, visible])

  const browserSource = waitingForRemoteTransport || showTransportRecovering || missingRemoteTransport
    ? null
    : state.source && state.source.kind === 'url' && state.resolvedUrl
      ? { ...state.source, url: state.resolvedUrl }
      : state.source

  return (
    <div
      data-testid="browser-view"
      data-visible={String(visible)}
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)]"
    >
      <BrowserChrome
        state={state}
        tabs={tabs}
        routeIndicator={routeIndicator}
        routeMode={effectiveRouteMode}
        canToggleRouteMode={hasRemoteSession && state.source?.kind === 'url'}
        onCreateTab={() => sessions.createSessionBrowserTab(sessionId)}
        onDuplicateTab={(tabId) => sessions.duplicateSessionBrowserTab(sessionId, tabId)}
        onSelectTab={(tabId) => sessions.activateSessionBrowserTab(sessionId, tabId)}
        onCloseTab={(tabId) => sessions.closeSessionBrowserTab(sessionId, tabId)}
        onCloseOtherTabs={(tabId) => sessions.closeOtherSessionBrowserTabs(sessionId, tabId)}
        onCloseTabsToRight={(tabId) => sessions.closeSessionBrowserTabsToRight(sessionId, tabId)}
        onRestoreClosedTab={() => sessions.restoreLastClosedSessionBrowserTab(sessionId)}
        hasClosedTabs={hasClosedTabs}
        onTogglePinTab={(tabId) => sessions.toggleSessionBrowserTabPinned(sessionId, tabId)}
        onReorderTab={(tabId, targetTabId, position) => sessions.reorderSessionBrowserTab(sessionId, tabId, targetTabId, position)}
        onRouteModeChange={(routeMode) => sessions.setSessionBrowserRouteMode(sessionId, routeMode)}
        onAddressInputChange={(value) => sessions.setSessionBrowserAddressInput(sessionId, value)}
        onSubmitAddress={() => sessions.submitSessionBrowserAddress(sessionId)}
        onReload={() => {
          sessions.reloadSessionBrowser(sessionId)
          void reloadBrowserWindow({ browserId: activeBrowserId, sessionId }).catch((error) => {
            sessions.setSessionBrowserError(sessionId, error instanceof Error ? error.message : String(error))
          })
        }}
        canRebuildTransport={canRebuildTransport}
        onRebuildTransport={() => sessions.rebuildSessionBrowserTransport(sessionId)}
        onBack={() => {
          sessions.goSessionBrowserBack(sessionId)
          void goBackBrowserWindow({ browserId: activeBrowserId, sessionId }).catch((error) => {
            sessions.setSessionBrowserError(sessionId, error instanceof Error ? error.message : String(error))
          })
        }}
        onForward={() => {
          sessions.goSessionBrowserForward(sessionId)
          void goForwardBrowserWindow({ browserId: activeBrowserId, sessionId }).catch((error) => {
            sessions.setSessionBrowserError(sessionId, error instanceof Error ? error.message : String(error))
          })
        }}
        onClose={() => {
          if (onCloseRequest) {
            onCloseRequest()
            return
          }
          sessions.closeSessionBrowser(sessionId)
        }}
      />
      <div className="min-h-0 flex-1 bg-[var(--workspace-surface-950)]">
        {browserSource ? (
          <>
            <EmbeddedBrowserWebview
              key={transportInstanceKey}
              browserId={activeBrowserId}
              sessionId={sessionId}
              visible={visible && !state.error}
              source={browserSource}
              sourceRevision={state.sourceRevision}
              proxyUrl={state.proxyUrl}
              onError={(error) => {
                sessions.setSessionBrowserError(sessionId, error)
              }}
            />
            {state.error && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--workspace-surface-950)] px-6 py-8">
                <div className="max-w-xl rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <div>{state.error}</div>
                  <div className="mt-2 text-xs text-red-200/75">
                    Active route: {routeIndicator.detail}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : showTransportRecovering || waitingForRemoteTransport ? (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <div className="max-w-sm rounded-2xl border border-[var(--workspace-border-strong)] bg-[var(--workspace-surface-900)] px-5 py-4 text-center">
              <div className="text-sm font-medium text-[var(--workspace-text)]">
                {showTransportRecovering
                  ? t('browser.transport.recoveringTitle')
                  : t('browser.transport.preparingTitle')}
              </div>
              <div className="mt-2 text-xs text-[var(--workspace-text-muted)]">
                {routeIndicator.detail}
              </div>
            </div>
          </div>
        ) : showErrorPanel ? (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <div className="max-w-md rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-center text-red-100">
              <div className="text-sm font-semibold">
                {showTransportFailure
                  ? t('browser.transport.failedTitle')
                  : t('browser.transport.errorTitle')}
              </div>
              <div className="mt-2 text-sm text-red-100/90">
                {state.error ?? routeIndicator.detail}
              </div>
              <div className="mt-2 text-xs text-red-100/70">
                {routeIndicator.detail}
              </div>
              {canRebuildTransport && (
                <div className="mt-4">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => sessions.rebuildSessionBrowserTransport(sessionId)}
                  >
                    {t('browser.transport.rebuild')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 py-10 text-center text-sm text-[var(--workspace-text-muted)]">
            <span>{t('browser.empty')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
