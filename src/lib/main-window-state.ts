export interface PersistedMainWindowState {
  version: 1
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
}

export const DEFAULT_MAIN_WINDOW_STATE: PersistedMainWindowState = {
  version: 1,
  width: 1280,
  height: 800,
  x: null,
  y: null,
  maximized: false,
}

const MIN_WINDOW_WIDTH = 1100
const MIN_WINDOW_HEIGHT = 720
const MAIN_WINDOW_STATE_NAMESPACE = 'app.shellbeam.mainWindowState'

export function getMainWindowStateStorageKey(windowLabel: string = 'main') {
  return `${MAIN_WINDOW_STATE_NAMESPACE}.${windowLabel}`
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isDesktopTauriRuntime() {
  if (!isTauriRuntime()) return false
  const ua = navigator.userAgent
  return !/iPhone|iPad|iPod|Android/i.test(ua)
}

export function sanitizePersistedMainWindowState(raw: unknown): PersistedMainWindowState | null {
  if (!raw || typeof raw !== 'object') return null

  const candidate = raw as Partial<PersistedMainWindowState>
  const width = Number(candidate.width)
  const height = Number(candidate.height)
  const x = candidate.x == null ? null : Number(candidate.x)
  const y = candidate.y == null ? null : Number(candidate.y)
  const maximized = candidate.maximized === true

  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null
  if (x != null && !Number.isFinite(x)) return null
  if (y != null && !Number.isFinite(y)) return null

  return {
    version: 1,
    width: Math.round(width),
    height: Math.round(height),
    x: x == null ? null : Math.round(x),
    y: y == null ? null : Math.round(y),
    maximized,
  }
}

export function loadPersistedMainWindowState(storageKey: string = getMainWindowStateStorageKey()) {
  try {
    return sanitizePersistedMainWindowState(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
  } catch {
    return null
  }
}

export function savePersistedMainWindowState(
  state: PersistedMainWindowState,
  storageKey: string = getMainWindowStateStorageKey(),
) {
  const sanitized = sanitizePersistedMainWindowState(state)
  if (!sanitized) return false
  localStorage.setItem(storageKey, JSON.stringify(sanitized))
  return true
}

// Legacy export retained for callers/tests that only need the default key constant.
export const MAIN_WINDOW_STATE_KEY = getMainWindowStateStorageKey()
