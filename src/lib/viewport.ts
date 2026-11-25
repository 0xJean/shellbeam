import { useSyncExternalStore } from 'react'

/**
 * Three layout width tiers:
 * - `compact` (< 768px): Folded phone / narrow portrait mobile (bottom tab bar, single-column sheets).
 * - `medium` (768px – 1119px): Unfolded foldables (Pixel Fold / Galaxy Fold), tablets in portrait,
 *   and half-screen desktop windows (auto-collapsed icon rail, no nested sidebars, overlay drawers).
 * - `wide` (>= 1120px): Full desktop & landscape tablet (collapsible full sidebar, split panels).
 */
export type ViewportTier = 'compact' | 'medium' | 'wide'

export const COMPACT_MAX_WIDTH = 767
export const MEDIUM_MAX_WIDTH = 1119

const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`
const MEDIUM_QUERY = `(min-width: ${COMPACT_MAX_WIDTH + 1}px) and (max-width: ${MEDIUM_MAX_WIDTH}px)`

function subscribeQueries(queries: readonly string[], onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const lists = queries.map((q) => window.matchMedia(q))
  lists.forEach((mql) => mql.addEventListener('change', onChange))
  return () => lists.forEach((mql) => mql.removeEventListener('change', onChange))
}

function getViewportTierSnapshot(): ViewportTier {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide'
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact'
  if (window.matchMedia(MEDIUM_QUERY).matches) return 'medium'
  return 'wide'
}

function subscribeViewportTier(onChange: () => void): () => void {
  return subscribeQueries([COMPACT_QUERY, MEDIUM_QUERY], onChange)
}

export function useViewportTier(): ViewportTier {
  return useSyncExternalStore(subscribeViewportTier, getViewportTierSnapshot, () => 'wide')
}

/**
 * True below 1120px (phones, unfolded foldables, portrait tablets, and narrow split-screen PC windows)
 * where side-by-side auxiliary panels would starve the terminal or primary workspace.
 */
export function useCompactWorkspace(): boolean {
  const tier = useViewportTier()
  return tier !== 'wide'
}
