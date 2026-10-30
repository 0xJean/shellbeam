import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 767px)'

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

/** True below Tailwind's `md` breakpoint, where the terminal renders its phone layout. */
export function useNarrowViewport() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
