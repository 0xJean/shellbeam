import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react'

const LONG_PRESS_MS = 480
const MOVE_TOLERANCE = 10

/** Long press (or right click) opens quick actions; the click that ends a long press is swallowed. */
export function useLongPress(onLongPress: (target: HTMLElement) => void) {
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const clear = useCallback(() => { if (timer.current != null) window.clearTimeout(timer.current); timer.current = null; origin.current = null }, [])
  useEffect(() => clear, [clear])
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      fired.current = false
      clear()
      const target = event.currentTarget
      origin.current = { x: event.clientX, y: event.clientY }
      timer.current = window.setTimeout(() => { fired.current = true; timer.current = null; onLongPress(target) }, LONG_PRESS_MS)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > MOVE_TOLERANCE) clear()
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (event: MouseEvent<HTMLElement>) => { event.preventDefault(); clear(); fired.current = true; onLongPress(event.currentTarget) },
    /** True once per long press, so the trailing click does not also open the app. */
    consumeLongPress: () => { const value = fired.current; fired.current = false; return value },
  }
}

export type PullState = 'idle' | 'pulling' | 'armed' | 'refreshing'
const PULL_TRIGGER = 64
const PULL_MAX = 96

/** Touch pull-down at the top of a scroll container. */
export function usePullToRefresh(onRefresh: () => Promise<void>) {
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const state: PullState = refreshing ? 'refreshing' : distance >= PULL_TRIGGER ? 'armed' : distance > 0 ? 'pulling' : 'idle'
  const finish = useCallback(async () => {
    setRefreshing(true)
    setDistance(PULL_TRIGGER)
    try { await onRefresh() } catch { /* The data sources report their own errors. */ } finally { setRefreshing(false); setDistance(0) }
  }, [onRefresh])
  return {
    state,
    distance,
    handlers: {
      onTouchStart: (event: TouchEvent<HTMLElement>) => {
        if (refreshing || event.currentTarget.scrollTop > 0) { start.current = null; return }
        start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
      },
      onTouchMove: (event: TouchEvent<HTMLElement>) => {
        if (!start.current) return
        const dy = event.touches[0].clientY - start.current.y
        const dx = event.touches[0].clientX - start.current.x
        if (dy <= 0 || Math.abs(dx) > dy) { if (distance) setDistance(0); return }
        setDistance(Math.min(PULL_MAX, dy * 0.5))
      },
      onTouchEnd: () => {
        start.current = null
        if (refreshing) return
        if (distance >= PULL_TRIGGER) void finish()
        else setDistance(0)
      },
    },
  }
}

/** Horizontal swipe between home pages; vertical scrolling is left alone. */
export function useHorizontalSwipe(onSwipe: (direction: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => { start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY } },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      if (!start.current) return
      const dx = event.changedTouches[0].clientX - start.current.x
      const dy = event.changedTouches[0].clientY - start.current.y
      start.current = null
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1)
    },
  }
}
