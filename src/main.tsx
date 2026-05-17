import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './index.css'
import App from './App.tsx'
import {
  DEFAULT_MAIN_WINDOW_STATE,
  getMainWindowStateStorageKey,
  isDesktopTauriRuntime,
  loadPersistedMainWindowState,
  savePersistedMainWindowState,
} from './lib/main-window-state'

// iOS keyboard viewport fix: resize layout instead of overlapping
function syncAppHeight() {
  const vh = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${vh}px`)
}
syncAppHeight()
window.visualViewport?.addEventListener('resize', syncAppHeight)
window.visualViewport?.addEventListener('scroll', () => {
  // Prevent iOS from scrolling the viewport when keyboard appears
  if (window.visualViewport && window.visualViewport.offsetTop > 0) {
    window.scrollTo(0, 0)
  }
})

async function setupMainWindowState() {
  if (!isDesktopTauriRuntime()) return

  const appWindow = getCurrentWindow()
  const storageKey = getMainWindowStateStorageKey(appWindow.label)
  const persisted = loadPersistedMainWindowState(storageKey)
  const restoreState = persisted ?? DEFAULT_MAIN_WINDOW_STATE

  try {
    await appWindow.unmaximize().catch(() => {})
    await appWindow.setSize(new PhysicalSize(restoreState.width, restoreState.height))
    if (restoreState.x != null && restoreState.y != null) {
      await appWindow.setPosition(new PhysicalPosition(restoreState.x, restoreState.y))
    }
    if (restoreState.maximized) {
      await appWindow.maximize()
    }
  } catch (error) {
    console.warn('Restore main window state failed', error)
  }

  let saveTimer: number | null = null
  let persistReady = false
  let initialPersistTimer: number | null = null

  const persistWindowState = async () => {
    if (!persistReady) return
    try {
      const maximized = await appWindow.isMaximized()
      const previous = loadPersistedMainWindowState(storageKey) ?? DEFAULT_MAIN_WINDOW_STATE
      if (maximized) {
        savePersistedMainWindowState({
          ...previous,
          maximized: true,
        }, storageKey)
        return
      }

      const [size, position] = await Promise.all([
        appWindow.innerSize(),
        appWindow.outerPosition(),
      ])

      savePersistedMainWindowState({
        version: 1,
        width: Math.round(size.width),
        height: Math.round(size.height),
        x: Math.round(position.x),
        y: Math.round(position.y),
        maximized: false,
      }, storageKey)
    } catch (error) {
      console.warn('Persist main window state failed', error)
    }
  }

  const schedulePersist = () => {
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void persistWindowState()
    }, 180)
  }

  const persistBeforeUnload = () => {
    persistReady = true
    void persistWindowState()
  }

  const [unlistenResized, unlistenMoved] = await Promise.all([
    appWindow.onResized(schedulePersist),
    appWindow.onMoved(schedulePersist),
  ])

  window.addEventListener('beforeunload', persistBeforeUnload)
  initialPersistTimer = window.setTimeout(() => {
    persistReady = true
    void persistWindowState()
  }, 900)

  return () => {
    if (saveTimer) window.clearTimeout(saveTimer)
    if (initialPersistTimer) window.clearTimeout(initialPersistTimer)
    window.removeEventListener('beforeunload', persistBeforeUnload)
    unlistenResized()
    unlistenMoved()
  }
}

async function bootstrap() {
  await setupMainWindowState()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
