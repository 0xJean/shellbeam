import { useEffect, useRef, useCallback } from 'react'
import {
  closeBrowserWindow,
  hideBrowserWebview,
  loadBrowserSource,
  openEmbeddedBrowser,
  showBrowserWebview,
  updateBrowserBounds,
  type BrowserSource,
} from '@/lib/browser'

interface EmbeddedBrowserWebviewProps {
  browserId: string
  sessionId: string
  visible: boolean
  source: BrowserSource | null
  sourceRevision: number
  proxyUrl?: string | null
  onError?: (error: string) => void
}

const LOG = '[Browser:Webview]'
const CLOSE_DELAY_MS = 160

interface BrowserWebviewLease {
  refCount: number
  isOpen: boolean
  proxyUrl: string | null
  openPromise: Promise<void> | null
  closePromise: Promise<void> | null
  closeTimer: ReturnType<typeof setTimeout> | null
  /** The mounted view currently showing this webview. A page and a workspace window can share one. */
  shownBy: symbol | null
}

const browserWebviewLeases = new Map<string, BrowserWebviewLease>()

function getLease(browserId: string): BrowserWebviewLease {
  let lease = browserWebviewLeases.get(browserId)
  if (!lease) {
    lease = {
      refCount: 0,
      isOpen: false,
      proxyUrl: null,
      openPromise: null,
      closePromise: null,
      closeTimer: null,
      shownBy: null,
    }
    browserWebviewLeases.set(browserId, lease)
  }
  return lease
}

function retainLease(browserId: string) {
  const lease = getLease(browserId)
  lease.refCount += 1
  if (lease.closeTimer) {
    clearTimeout(lease.closeTimer)
    lease.closeTimer = null
  }
  return lease
}

function releaseLease(browserId: string, sessionId: string) {
  const lease = browserWebviewLeases.get(browserId)
  if (!lease) return
  lease.refCount = Math.max(lease.refCount - 1, 0)
  if (lease.refCount > 0 || lease.closeTimer) return

  lease.closeTimer = setTimeout(() => {
    lease.closeTimer = null
    if (lease.refCount > 0) return
    const closingPromise = (async () => {
      if (lease.openPromise) {
        await lease.openPromise.catch(() => {})
      }
      if (!lease.isOpen) return
      console.log(LOG, 'lease: closing native webview', browserId, 'session=', sessionId)
      try {
        await closeBrowserWindow(browserId, sessionId)
      } catch (error) {
        console.warn(LOG, 'lease: closeBrowserWindow failed', browserId, error)
      } finally {
        lease.isOpen = false
        lease.proxyUrl = null
      }
    })()

    const trackedClosePromise = closingPromise.finally(() => {
      if (lease.closePromise === trackedClosePromise) {
        lease.closePromise = null
      }
      if (lease.refCount === 0 && !lease.openPromise && !lease.closeTimer) {
        browserWebviewLeases.delete(browserId)
      }
    })
    lease.closePromise = trackedClosePromise
  }, CLOSE_DELAY_MS)
}

async function ensureLeaseOpen(browserId: string, sessionId: string, proxyUrl?: string | null) {
  const desiredProxyUrl = proxyUrl ?? null
  const lease = getLease(browserId)

  if (lease.closeTimer) {
    clearTimeout(lease.closeTimer)
    lease.closeTimer = null
  }

  if (lease.openPromise) {
    await lease.openPromise
    if (lease.isOpen && lease.proxyUrl === desiredProxyUrl) return
  }

  const openingPromise = (async () => {
    if (lease.closePromise) {
      await lease.closePromise.catch(() => {})
    }

    if (lease.isOpen && lease.proxyUrl === desiredProxyUrl) {
      return
    }

    if (lease.isOpen && lease.proxyUrl !== desiredProxyUrl) {
      console.log(LOG, 'lease: proxy changed, recreating webview', browserId, 'from=', lease.proxyUrl ?? '(none)', 'to=', desiredProxyUrl ?? '(none)')
      await closeBrowserWindow(browserId, sessionId)
      lease.isOpen = false
      lease.proxyUrl = null
    }

    console.log(LOG, 'lease: opening embedded browser', browserId, 'proxyUrl=', desiredProxyUrl ?? '(none)')
    await openEmbeddedBrowser({ browserId, sessionId, proxyUrl: desiredProxyUrl ?? undefined })
    lease.isOpen = true
    lease.proxyUrl = desiredProxyUrl
  })()

  const trackedOpenPromise = openingPromise.finally(() => {
    if (lease.openPromise === trackedOpenPromise) {
      lease.openPromise = null
    }
  })
  lease.openPromise = trackedOpenPromise
  await lease.openPromise
}

export function EmbeddedBrowserWebview({ browserId, sessionId, visible, source, sourceRevision, proxyUrl, onError }: EmbeddedBrowserWebviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const shownRef = useRef(false)
  const ownerRef = useRef(Symbol('browser-view'))
  const lastBoundsRef = useRef<string | null>(null)
  const pendingBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const sendingBoundsRef = useRef(false)
  const visibleRef = useRef(visible)
  const pendingSourceRef = useRef<{ source: BrowserSource; revision: number } | null>(null)
  const loadedRevisionRef = useRef<number | undefined>(undefined)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const flushPendingSource = useCallback(() => {
    if (!createdRef.current) {
      console.log(LOG, 'flushPendingSource: skip, webview not created yet', sessionId)
      return
    }
    const pending = pendingSourceRef.current
    if (!pending) {
      console.log(LOG, 'flushPendingSource: skip, no pending source', sessionId)
      return
    }
    if (loadedRevisionRef.current === pending.revision) {
      console.log(LOG, 'flushPendingSource: skip, revision already loaded', sessionId, pending.revision)
      return
    }
    console.log(LOG, 'flushPendingSource: loading source', sessionId, 'rev=', pending.revision, 'kind=', pending.source.kind, 'url=', pending.source.kind === 'url' ? pending.source.url : '(n/a)')
    loadedRevisionRef.current = pending.revision
    pendingSourceRef.current = null
    void loadBrowserSource({
      browserId,
      sessionId,
      source: pending.source,
    }).then(() => {
      console.log(LOG, 'loadBrowserSource: success', sessionId)
    }).catch((error) => {
      console.error(LOG, 'loadBrowserSource: FAILED', sessionId, error)
      loadedRevisionRef.current = undefined
      onErrorRef.current?.(error instanceof Error ? error.message : String(error))
    })
  }, [browserId, sessionId])

  const syncBounds = useCallback(() => {
    if (!createdRef.current || !containerRef.current) return false
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      console.log(LOG, 'syncBounds: container has zero size', sessionId, rect.width, rect.height)
      return false
    }
    const key = `${rect.x},${rect.y} ${rect.width}x${rect.height}`
    if (lastBoundsRef.current === key) return true
    lastBoundsRef.current = key
    console.log(LOG, 'syncBounds: updating', sessionId, key)
    pendingBoundsRef.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    // One update at a time, always the newest, so an older rect can never land after a newer one.
    if (!sendingBoundsRef.current) {
      sendingBoundsRef.current = true
      void (async () => {
        while (pendingBoundsRef.current) {
          const next = pendingBoundsRef.current
          pendingBoundsRef.current = null
          await updateBrowserBounds(browserId, next).catch(() => {})
        }
        sendingBoundsRef.current = false
      })()
    }
    return true
  }, [browserId, sessionId])

  const showNative = useCallback(() => {
    getLease(browserId).shownBy = ownerRef.current
    void showBrowserWebview(browserId).catch(() => {})
    shownRef.current = true
  }, [browserId])

  const hideNative = useCallback(() => {
    shownRef.current = false
    const lease = browserWebviewLeases.get(browserId)
    if (lease?.shownBy && lease.shownBy !== ownerRef.current) return
    if (lease) lease.shownBy = null
    void hideBrowserWebview(browserId).catch(() => {})
  }, [browserId])

  const showIfReady = useCallback(() => {
    if (!createdRef.current || !visibleRef.current) {
      console.log(LOG, 'showIfReady: skip', sessionId, 'created=', createdRef.current, 'visible=', visibleRef.current)
      return
    }
    // Another view may have moved this webview while it was hidden here.
    lastBoundsRef.current = null
    if (!syncBounds()) {
      console.log(LOG, 'showIfReady: syncBounds failed', sessionId)
      return
    }
    console.log(LOG, 'showIfReady: showing webview', sessionId)
    showNative()
  }, [sessionId, showNative, syncBounds])

  useEffect(() => {
    let cancelled = false
    retainLease(browserId)
    console.log(LOG, 'creation effect: acquiring embedded browser', browserId, 'session=', sessionId, 'proxyUrl=', proxyUrl ?? '(none)')
    void ensureLeaseOpen(browserId, sessionId, proxyUrl)
      .then(() => {
        if (cancelled) {
          console.log(LOG, 'creation effect: resolved after cancel, lease retained by next effect', browserId)
          return
        }
        console.log(LOG, 'creation effect: embedded browser ready', browserId)
        createdRef.current = true
        showIfReady()
        flushPendingSource()
      })
      .catch((error) => {
        console.error(LOG, 'creation effect: ensureLeaseOpen FAILED', browserId, error)
        if (!cancelled) {
          onErrorRef.current?.(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      console.log(LOG, 'creation effect: cleanup', sessionId, 'created=', createdRef.current, 'shown=', shownRef.current)
      cancelled = true
      if (shownRef.current) hideNative()
      lastBoundsRef.current = null
      if (createdRef.current) {
        createdRef.current = false
      }
      releaseLease(browserId, sessionId)
    }
  }, [browserId, flushPendingSource, hideNative, proxyUrl, sessionId, showIfReady])

  useEffect(() => {
    if (!source) return
    if (loadedRevisionRef.current === sourceRevision) return
    console.log(LOG, 'source effect: queuing source', sessionId, 'rev=', sourceRevision)
    pendingSourceRef.current = { source, revision: sourceRevision }
    flushPendingSource()
  }, [flushPendingSource, source, sourceRevision])

  useEffect(() => {
    console.log(LOG, 'visibility effect:', sessionId, 'visible=', visible)
    visibleRef.current = visible
    if (!createdRef.current) return
    if (visible) showIfReady()
    else hideNative()
  }, [hideNative, sessionId, showIfReady, visible])

  useEffect(() => {
    if (!containerRef.current) return
    const handleBounds = () => {
      if (!createdRef.current || !visibleRef.current) return
      const ok = syncBounds()
      if (ok && !shownRef.current) showNative()
    }
    const observer = new ResizeObserver(handleBounds)
    observer.observe(containerRef.current)
    window.addEventListener('resize', handleBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleBounds)
    }
  }, [showNative, syncBounds])

  // A resize observer misses a container that moves without changing size, which would leave the
  // native webview covering the browser's own toolbar. Follow its position while it is showing.
  useEffect(() => {
    if (!visible) return
    let frame = requestAnimationFrame(function follow() {
      if (createdRef.current) syncBounds()
      frame = requestAnimationFrame(follow)
    })
    return () => cancelAnimationFrame(frame)
  }, [syncBounds, visible])

  return <div ref={containerRef} data-testid="embedded-browser-webview" className="h-full w-full min-h-0" />
}
