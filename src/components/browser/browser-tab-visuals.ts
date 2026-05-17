import { useEffect, useState } from 'react'

interface BrowserChromeTabVisualInput {
  id: string
  title: string
  sourceKind: 'url' | 'html' | 'markdown' | null
  url: string
}

interface BrowserChromeTabSearchInput extends BrowserChromeTabVisualInput {
  routeIndicator?: { label: string; detail: string } | null
}

const faviconCache = new Map<string, string | null>()

export type BrowserTabDensity = 'comfortable' | 'compact' | 'dense'

export function getBrowserTabDensity(tabCount: number): BrowserTabDensity {
  if (tabCount >= 14) return 'dense'
  if (tabCount >= 8) return 'compact'
  return 'comfortable'
}

export function getBrowserTabMonogram(tab: Pick<BrowserChromeTabVisualInput, 'title' | 'sourceKind' | 'url'>) {
  if (tab.sourceKind === 'url' && tab.url) {
    try {
      const hostname = new URL(tab.url).hostname.replace(/^www\./, '')
      return (hostname.charAt(0) || 'W').toUpperCase()
    } catch {
      return 'W'
    }
  }
  if (tab.sourceKind === 'markdown') return 'M'
  if (tab.sourceKind === 'html') return 'H'
  return (tab.title.trim().charAt(0) || '+').toUpperCase()
}

export function getBrowserTabFaviconCandidates(url: string) {
  if (!url) return []
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return []
    return [`${parsed.origin}/favicon.ico`]
  } catch {
    return []
  }
}

export function useBrowserTabFavicons(tabs: BrowserChromeTabVisualInput[]) {
  const [, setVersion] = useState(0)

  useEffect(() => {
    const pending = tabs.flatMap((tab) => getBrowserTabFaviconCandidates(tab.url))
      .filter((candidate) => !faviconCache.has(candidate))

    if (pending.length === 0) return

    let cancelled = false
    const uniqueCandidates = Array.from(new Set(pending))

    uniqueCandidates.forEach((candidate) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => {
        if (cancelled) return
        faviconCache.set(candidate, candidate)
        setVersion((value) => value + 1)
      }
      image.onerror = () => {
        if (cancelled) return
        faviconCache.set(candidate, null)
        setVersion((value) => value + 1)
      }
      image.src = candidate
    })

    return () => {
      cancelled = true
    }
  }, [tabs])

  return Object.fromEntries(tabs.map((tab) => {
    const iconUrl = getBrowserTabFaviconCandidates(tab.url).find((candidate) => faviconCache.get(candidate)) ?? null
    return [tab.id, iconUrl]
  })) as Record<string, string | null>
}

export function filterBrowserTabs<T extends BrowserChromeTabSearchInput>(tabs: T[], query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return tabs

  return tabs.filter((tab) => {
    const haystack = [
      tab.title,
      tab.url,
      tab.routeIndicator?.label,
      tab.routeIndicator?.detail,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(normalizedQuery)
  })
}
