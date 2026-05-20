import type { BrowserSource } from '@/lib/browser'
import { isLoopbackBrowserUrl } from '@/lib/browser'
import type { BrowserRouteMode } from '@/contexts/session-browser-state'

export interface BrowserRouteIndicator {
  scope: 'local' | 'remote' | 'pending'
  labelKey: string
  detailKey: string
}

export interface BrowserTabRouteIndicator {
  scope: 'local' | 'remote' | 'pending'
  labelKey: string
  detailKey: string
}

export type LocalizedBrowserRouteIndicator = BrowserRouteIndicator & {
  label: string
  detail: string
}

export type LocalizedBrowserTabRouteIndicator = BrowserTabRouteIndicator & {
  label: string
  detail: string
}

export function shouldWaitForRemoteBrowserTransport(params: {
  source: BrowserSource | null
  effectiveRouteMode: 'local' | 'remote'
  resolvedUrl?: string | null
  proxyUrl?: string | null
  transportStatus?: 'idle' | 'recovering' | 'failed'
  error?: string | null
}) {
  const { source, effectiveRouteMode, resolvedUrl, proxyUrl, transportStatus, error } = params
  if (effectiveRouteMode !== 'remote' || source?.kind !== 'url') return false
  if (transportStatus === 'failed' || error) return false
  if (isLoopbackBrowserUrl(source.url)) return !resolvedUrl
  return !proxyUrl
}

export function getBrowserRouteIndicator(params: {
  source: BrowserSource | null
  requestedRouteMode: BrowserRouteMode
  effectiveRouteMode: 'local' | 'remote'
  hasRemoteSession: boolean
  waitingForRemoteTransport: boolean
  resolvedUrl?: string | null
  proxyUrl?: string | null
}): BrowserRouteIndicator {
  const {
    source,
    requestedRouteMode,
    effectiveRouteMode,
    hasRemoteSession,
    waitingForRemoteTransport,
    resolvedUrl,
    proxyUrl,
  } = params

  if (source && source.kind !== 'url') {
    return { scope: 'local', labelKey: 'browser.route.local', detailKey: 'browser.route.previewLocal' }
  }

  if (effectiveRouteMode === 'local') {
    if (requestedRouteMode === 'remote' && !hasRemoteSession) {
      return { scope: 'local', labelKey: 'browser.route.local', detailKey: 'browser.route.serverUnavailable' }
    }
    if (hasRemoteSession && requestedRouteMode === 'local') {
      return { scope: 'local', labelKey: 'browser.route.local', detailKey: 'browser.route.forcedLocal' }
    }
    return { scope: 'local', labelKey: 'browser.route.local', detailKey: 'browser.route.localOrigin' }
  }

  if (waitingForRemoteTransport) {
    if (source?.kind === 'url' && isLoopbackBrowserUrl(source.url)) {
      return { scope: 'pending', labelKey: 'browser.route.server', detailKey: 'browser.route.preparingPortForward' }
    }
    return { scope: 'pending', labelKey: 'browser.route.server', detailKey: 'browser.route.preparingProxy' }
  }

  if (source?.kind === 'url' && isLoopbackBrowserUrl(source.url) && resolvedUrl) {
    return { scope: 'remote', labelKey: 'browser.route.server', detailKey: 'browser.route.viaPortForward' }
  }

  if (proxyUrl) {
    return { scope: 'remote', labelKey: 'browser.route.server', detailKey: 'browser.route.viaProxy' }
  }

  return { scope: 'remote', labelKey: 'browser.route.server', detailKey: 'browser.route.serverOrigin' }
}

export function getBrowserTabRouteIndicator(params: {
  source: BrowserSource | null
  requestedRouteMode: BrowserRouteMode
  effectiveRouteMode: 'local' | 'remote'
  hasRemoteSession: boolean
  isActiveTab: boolean
  resolvedUrl?: string | null
  proxyUrl?: string | null
}): BrowserTabRouteIndicator | null {
  const waitingForRemoteTransport = params.isActiveTab
    ? shouldWaitForRemoteBrowserTransport({
      source: params.source,
      effectiveRouteMode: params.effectiveRouteMode,
      resolvedUrl: params.resolvedUrl,
      proxyUrl: params.proxyUrl,
    })
    : false

  if (!params.source) return null

  const indicator = getBrowserRouteIndicator({
    source: params.source,
    requestedRouteMode: params.requestedRouteMode,
    effectiveRouteMode: params.effectiveRouteMode,
    hasRemoteSession: params.hasRemoteSession,
    waitingForRemoteTransport,
    resolvedUrl: params.resolvedUrl,
    proxyUrl: params.proxyUrl,
  })

  return {
    scope: indicator.scope,
    labelKey: indicator.scope === 'pending'
      ? 'browser.route.pending'
      : indicator.scope === 'remote'
        ? 'browser.route.server'
        : 'browser.route.local',
    detailKey: indicator.detailKey,
  }
}
