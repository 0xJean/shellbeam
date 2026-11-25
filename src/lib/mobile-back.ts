import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    __shellbeamHandleAndroidBack?: () => boolean
  }
}

/** True when running on an Android or iOS mobile OS (where desktop-only APIs
 * such as local PTY shells and embedded multi-webview browsers are unavailable). */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  // Modern iPadOS reports a MacIntel user agent with touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

type BackHandlerEntry = { id: number; handler: () => void }

let nextHandlerId = 1
const backStack: BackHandlerEntry[] = []

function dispatchMobileBack(): boolean {
  const top = backStack.at(-1)
  if (!top) return false
  top.handler()
  return true
}

function syncGlobalHook() {
  if (typeof window === 'undefined') return
  window.__shellbeamHandleAndroidBack = dispatchMobileBack
}

/** Register a LIFO handler invoked when Android's hardware/gesture back button
 * is pressed while `active` is true. */
export function useMobileBackHandler(active: boolean, onBack: () => void) {
  const handlerRef = useRef(onBack)
  handlerRef.current = onBack

  useEffect(() => {
    if (!active) return
    syncGlobalHook()
    const id = nextHandlerId++
    backStack.push({ id, handler: () => handlerRef.current() })
    return () => {
      const idx = backStack.findIndex((entry) => entry.id === id)
      if (idx >= 0) backStack.splice(idx, 1)
    }
  }, [active])
}

export function triggerMobileBackForTest(): boolean {
  return dispatchMobileBack()
}
