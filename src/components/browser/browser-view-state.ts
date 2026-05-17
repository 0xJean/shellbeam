import type { BrowserSource } from '@/lib/browser'
import { isLoopbackBrowserUrl } from '@/lib/browser'
import type { BrowserRouteMode } from '@/contexts/session-browser-state'

export interface BrowserRouteIndicator {
  scope: 'local' | 'remote' | 'pending'
  label: string
  detail: string
}

export interface BrowserTabRouteIndicator {
  scope: 'local' | 'remote' | 'pending'
  label: 'Local' | 'Server' | 'Pending'
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
    return { scope: 'local', label: 'Local', detail: 'Preview content is rendered locally' }
  }

  if (effectiveRouteMode === 'local') {
    if (requestedRouteMode === 'remote' && !hasRemoteSession) {
      return { scope: 'local', label: 'Local', detail: 'Server route unavailable for this session' }
    }
    if (hasRemoteSession && requestedRouteMode === 'local') {
      return { scope: 'local', label: 'Local', detail: 'Forced local route from this device' }
    }
    return { scope: 'local', label: 'Local', detail: 'Requests originate from this device' }
  }

  if (waitingForRemoteTransport) {
    if (source?.kind === 'url' && isLoopbackBrowserUrl(source.url)) {
      return { scope: 'pending', label: 'Server', detail: 'Preparing remote port forward' }
    }
    return { scope: 'pending', label: 'Server', detail: 'Preparing SSH proxy route' }
  }

  if (source?.kind === 'url' && isLoopbackBrowserUrl(source.url) && resolvedUrl) {
    return { scope: 'remote', label: 'Server', detail: 'Via remote port forward' }
  }

  if (proxyUrl) {
    return { scope: 'remote', label: 'Server', detail: 'Via server proxy' }
  }

  return { scope: 'remote', label: 'Server', detail: 'Requests originate from the server' }
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
    label: indicator.scope === 'pending'
      ? 'Pending'
      : indicator.scope === 'remote'
        ? 'Server'
        : 'Local',
    detail: indicator.detail,
  }
}
