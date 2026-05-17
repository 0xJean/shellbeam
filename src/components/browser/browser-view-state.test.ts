import { describe, expect, it } from 'vitest'
import { shouldWaitForRemoteBrowserTransport } from './browser-view-state'

describe('browser view state', () => {
  it('waits for remote transport while a remote proxy route is still being prepared', () => {
    expect(shouldWaitForRemoteBrowserTransport({
      source: { kind: 'url', url: 'https://example.com' },
      effectiveRouteMode: 'remote',
      proxyUrl: null,
      resolvedUrl: null,
      transportStatus: 'idle',
      error: null,
    })).toBe(true)
  })

  it('does not keep waiting once the remote transport has failed', () => {
    expect(shouldWaitForRemoteBrowserTransport({
      source: { kind: 'url', url: 'https://example.com' },
      effectiveRouteMode: 'remote',
      proxyUrl: null,
      resolvedUrl: null,
      transportStatus: 'failed',
      error: null,
    })).toBe(false)
  })

  it('does not keep waiting once an error is already present', () => {
    expect(shouldWaitForRemoteBrowserTransport({
      source: { kind: 'url', url: 'http://localhost:3000' },
      effectiveRouteMode: 'remote',
      proxyUrl: null,
      resolvedUrl: null,
      transportStatus: 'idle',
      error: 'proxy failed',
    })).toBe(false)
  })
})
