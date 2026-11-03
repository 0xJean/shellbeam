import { useSyncExternalStore } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * Where iOS wants app bars, read from UITraitCollection.verticalBarEdge.
 *
 * On iPhone Duo the system moves tab bars into a vertical strip on the outer
 * display and in inner-display landscape, and keeps them horizontal in
 * inner-display portrait. Apple asks apps to follow this trait instead of the
 * device model or screen size, so the app's own tab bar does the same.
 */
export type VerticalBarEdge = 'leading' | 'trailing' | 'none'
export type HorizontalSizeClass = 'compact' | 'regular' | 'unspecified'

export interface BarLayout {
  verticalBarEdge: VerticalBarEdge
  horizontalSizeClass: HorizontalSizeClass
}

const HORIZONTAL_BARS: BarLayout = { verticalBarEdge: 'none', horizontalSizeClass: 'unspecified' }

let current = HORIZONTAL_BARS
const subscribers = new Set<() => void>()

export function applyBarLayout(next: BarLayout) {
  current = next
  const root = document.documentElement
  // CSS reads these attributes; components read the same value through useBarLayout.
  if (next.verticalBarEdge === 'none') delete root.dataset.verticalBarEdge
  else root.dataset.verticalBarEdge = next.verticalBarEdge
  root.dataset.horizontalSizeClass = next.horizontalSizeClass
  subscribers.forEach((notify) => notify())
}

export async function startBarLayout() {
  if (!isTauri()) return
  try {
    await listen<BarLayout>('bar-layout', (event) => applyBarLayout(event.payload))
    applyBarLayout(await invoke<BarLayout>('bar_layout'))
  } catch {
    // Desktop builds report no vertical bar; keep horizontal bars.
  }
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  return () => subscribers.delete(notify)
}

export function useBarLayout(): BarLayout {
  return useSyncExternalStore(subscribe, () => current, () => HORIZONTAL_BARS)
}
