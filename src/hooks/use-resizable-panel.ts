import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

const STORAGE_PREFIX = 'shellbeam.panelSize.'
const PANEL_SIZE_EVENT = 'shellbeam:panel-size'

export interface ResizablePanelOptions {
  /** Unique persistence key (stored under `shellbeam.panelSize.<storageKey>`). */
  storageKey: string
  /** Default width in pixels (or percentage when `unit === 'percent'`). */
  defaultSize: number
  /** Minimum allowed size in the chosen unit. */
  minSize: number
  /** Maximum allowed size in the chosen unit (or dynamic getter evaluated during drag). */
  maxSize: number | (() => number)
  /**
   * Which edge of the panel the drag handle sits on:
   * - `'left'`: dragging pointer left (negative deltaX) INCREASES panel width (e.g. right-side panels).
   * - `'right'`: dragging pointer right (positive deltaX) INCREASES panel width (e.g. left-side panels).
   */
  edge: 'left' | 'right'
  /** Optional container ref when `unit === 'percent'` so pixel deltas convert to % of container width. */
  containerRef?: React.RefObject<HTMLElement | null>
  unit?: 'px' | 'percent'
}

function resolveMax(maxSize: number | (() => number)): number {
  return typeof maxSize === 'function' ? maxSize() : maxSize
}

function clamp(value: number, min: number, max: number): number {
  const safeMax = Math.max(min, max)
  return Math.min(safeMax, Math.max(min, Math.round(value)))
}

export function readSavedPanelSize(storageKey: string, defaultSize: number, minSize: number, maxSize: number | (() => number)): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (raw !== null) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return clamp(parsed, minSize, resolveMax(maxSize))
    }
  } catch { /* storage unavailable */ }
  return clamp(defaultSize, minSize, resolveMax(maxSize))
}

function persistPanelSize(storageKey: string, size: number) {
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, String(size))
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(PANEL_SIZE_EVENT, { detail: { storageKey, size } }))
}

export function useResizablePanel({
  storageKey,
  defaultSize,
  minSize,
  maxSize,
  edge,
  containerRef,
  unit = 'px',
}: ResizablePanelOptions) {
  const maxSizeRef = useRef(maxSize)
  useEffect(() => { maxSizeRef.current = maxSize }, [maxSize])

  const [size, setSizeState] = useState<number>(() => readSavedPanelSize(storageKey, defaultSize, minSize, maxSize))
  const [dragging, setDragging] = useState(false)
  const sizeRef = useRef(size)
  useEffect(() => { sizeRef.current = size }, [size])

  // Re-sync if storageKey changes or another mounted tab resizes the same panel.
  useEffect(() => {
    setSizeState(readSavedPanelSize(storageKey, defaultSize, minSize, maxSizeRef.current))
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey: string; size: number }>).detail
      if (detail?.storageKey === storageKey && Number.isFinite(detail.size)) {
        const next = clamp(detail.size, minSize, resolveMax(maxSizeRef.current))
        setSizeState(next)
      }
    }
    window.addEventListener(PANEL_SIZE_EVENT, onSync)
    return () => window.removeEventListener(PANEL_SIZE_EVENT, onSync)
  }, [storageKey, defaultSize, minSize])

  // Re-clamp when the browser/app window resizes so panels never overflow small screens.
  useEffect(() => {
    const onResize = () => {
      const clamped = clamp(sizeRef.current, minSize, resolveMax(maxSizeRef.current))
      if (clamped !== sizeRef.current) setSizeState(clamped)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [minSize])

  const commitSize = useCallback((next: number) => {
    const clamped = clamp(next, minSize, resolveMax(maxSizeRef.current))
    setSizeState(clamped)
    persistPanelSize(storageKey, clamped)
  }, [storageKey, minSize])

  const resetSize = useCallback(() => {
    commitSize(defaultSize)
  }, [commitSize, defaultSize])

  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { cleanupRef.current?.() }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget
    const pointerId = event.pointerId
    try { target.setPointerCapture?.(pointerId) } catch { /* synthetic events in tests */ }

    const startX = event.clientX
    const startSize = sizeRef.current
    const sign = edge === 'left' ? -1 : 1
    const containerWidth = unit === 'percent' ? (containerRef?.current?.getBoundingClientRect().width || 0) : 0

    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    setDragging(true)

    let latest = startSize

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPx = (moveEvent.clientX - startX) * sign
      const delta = unit === 'percent'
        ? (containerWidth > 0 ? (deltaPx / containerWidth) * 100 : 0)
        : deltaPx
      latest = clamp(startSize + delta, minSize, resolveMax(maxSizeRef.current))
      setSizeState(latest)
    }

    const finish = () => {
      cleanup()
      persistPanelSize(storageKey, latest)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      try { target.releasePointerCapture?.(pointerId) } catch { /* ignore */ }
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      setDragging(false)
      cleanupRef.current = null
    }

    cleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [edge, minSize, storageKey, unit, containerRef])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const step = unit === 'percent' ? 2 : (event.shiftKey ? 40 : 16)
    const sign = edge === 'left' ? -1 : 1
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitSize(sizeRef.current - step * sign)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitSize(sizeRef.current + step * sign)
    } else if (event.key === 'Home') {
      event.preventDefault()
      commitSize(minSize)
    } else if (event.key === 'End') {
      event.preventDefault()
      commitSize(resolveMax(maxSizeRef.current))
    }
  }, [commitSize, edge, minSize, unit])

  const currentMax = Math.max(minSize, resolveMax(maxSize))

  return {
    size,
    dragging,
    resetSize,
    handleProps: {
      onPointerDown,
      onDoubleClick: resetSize,
      onKeyDown,
      'aria-valuemin': minSize,
      'aria-valuemax': currentMax,
      'aria-valuenow': size,
    },
  }
}
