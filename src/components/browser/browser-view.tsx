import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Laptop, LoaderCircle, RefreshCw, TriangleAlert, Unplug } from 'lucide-react'
import { BrowserChrome } from './browser-chrome'
import { BrowserStatusBar } from './browser-status-bar'
import { EmbeddedBrowserWebview } from './embedded-browser-webview'
import { getBrowserRouteIndicator, getBrowserTabRouteIndicator, shouldWaitForRemoteBrowserTransport } from './browser-view-state'
import { useSessions } from '@/contexts/sessions-context'
import { getSessionBrowserTabs, resolveBrowserRouteMode } from '@/contexts/session-browser-state'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'
import { browserV3Copy } from '@/lib/locales/browser-v3'
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
  const { t, locale } = useT()
  const copy = browserV3Copy[locale]
  const [chromeOverlayOpen, setChromeOverlayOpen] = useState(false)
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
  const localizedRouteIndicator = useMemo(() => ({
    ...routeIndicator,
    label: t(routeIndicator.labelKey),
    detail: t(routeIndicator.detailKey),
  }), [routeIndicator, t])

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
    title: tab.title || tab.currentUrl || tab.addressInput || t('browser.tab.newTitle'),
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
  })), [effectiveRouteMode, hasRemoteSession, state, t])
  const hasClosedTabs = state.closedTabs.length > 0
  const canRebuildTransport = hasRemoteSession && state.source?.kind === 'url' && effectiveRouteMode === 'remote'
  const showTransportRecovering = canRebuildTransport && state.transportStatus === 'recovering'
  const showTransportFailure = canRebuildTransport && state.transportStatus === 'failed'
  const showErrorPanel = showTransportFailure || (!waitingForRemoteTransport && !showTransportRecovering && !!state.error)
  const missingRemoteTransport = canRebuildTransport && !state.resolvedUrl && !state.proxyUrl
  const activeBrowserId = `${sessionId}::${state.activeTabId ?? 'tab'}`
  const transportInstanceKey = `${activeBrowserId}:${state.proxyUrl ?? state.resolvedUrl ?? effectiveRouteMode}`
  const routeTarget = (() => {
    const url = state.currentUrl || (state.source?.kind === 'url' ? state.source.url : '')
    try {
      return url ? new URL(url).host : ''
    } catch {
      return ''
    }
  })()
  const routeLine = [t('browser.status.activeRoute', { detail: localizedRouteIndicator.detail }), routeTarget].filter(Boolean).join(' · ')

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
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)]"
    >
      <BrowserChrome
        state={state}
        tabs={tabs}
        routeIndicator={localizedRouteIndicator}
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
        onOverlayOpenChange={setChromeOverlayOpen}
      />
      <div className="relative min-h-0 flex-1 bg-[var(--workspace-surface-950)]">
        {browserSource ? (
          <>
            <EmbeddedBrowserWebview
              key={transportInstanceKey}
              browserId={activeBrowserId}
              sessionId={sessionId}
              visible={visible && !state.error && !chromeOverlayOpen}
              source={browserSource}
              sourceRevision={state.sourceRevision}
              proxyUrl={state.proxyUrl}
              onError={(error) => {
                sessions.setSessionBrowserError(sessionId, error)
              }}
            />
            {state.error && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--workspace-surface-950)] px-6 py-8">
                <div className="flex max-w-[460px] flex-col items-center gap-2.5 text-center">
                  <div className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]">
                    <TriangleAlert className="h-5 w-5" />
                  </div>
                  <div className="break-words text-sm text-[var(--workspace-text-strong)]">{state.error}</div>
                  <div className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">
                    {t('browser.status.activeRoute', { detail: localizedRouteIndicator.detail })}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : showTransportRecovering || waitingForRemoteTransport ? (
          <div className="flex h-full items-center justify-center px-6 py-10">
            <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
              <div className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </div>
              <div className="text-base font-semibold text-[var(--workspace-text-strong)]">
                {showTransportRecovering
                  ? t('browser.transport.recoveringTitle')
                  : t('browser.transport.preparingTitle')}
              </div>
              <div className="text-[12.5px] leading-relaxed text-[var(--workspace-text-muted)]">
                {localizedRouteIndicator.detail} · {copy.preparingHint}
              </div>
            </div>
          </div>
        ) : showErrorPanel ? (
          <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
            <div className="flex max-w-[460px] flex-col items-center gap-2.5 text-center">
              <div className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]">
                {showTransportFailure ? <Unplug className="h-5 w-5" /> : <TriangleAlert className="h-5 w-5" />}
              </div>
              <div className="text-base font-semibold text-[var(--workspace-text-strong)]">
                {showTransportFailure
                  ? t('browser.transport.failedTitle')
                  : t('browser.transport.errorTitle')}
              </div>
              {showTransportFailure && (
                <p className="text-[12.5px] leading-relaxed text-[var(--workspace-text-muted)]">{copy.failedDescription}</p>
              )}
              <div className="max-w-full break-words rounded-lg bg-[var(--workspace-status-bad-bg)] px-3 py-1.5 font-mono text-[11.5px] text-[color:var(--workspace-status-bad-text)]">
                {state.error ?? localizedRouteIndicator.detail}
              </div>
              {canRebuildTransport && (
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => sessions.rebuildSessionBrowserTransport(sessionId)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('browser.transport.rebuild')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => sessions.setSessionBrowserRouteMode(sessionId, 'local')}
                  >
                    <Laptop className="h-3.5 w-3.5" />
                    {copy.useLocalRoute}
                  </Button>
                </div>
              )}
              <div className="font-mono text-[11px] text-[var(--workspace-text-subtle)]">{routeLine}</div>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-[var(--workspace-text-muted)]">
            <div className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-[var(--workspace-surface-800)] text-[var(--workspace-text-subtle)]">
              <Globe className="h-5 w-5" />
            </div>
            <span>{t('browser.empty')}</span>
          </div>
        )}
      </div>
      <BrowserStatusBar
        state={state}
        routeIndicator={localizedRouteIndicator}
        transportFailed={showTransportFailure}
        transportRecovering={showTransportRecovering}
      />
    </div>
  )
}
