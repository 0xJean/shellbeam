import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_WINDOW_STATE,
  getMainWindowStateStorageKey,
  loadPersistedMainWindowState,
  savePersistedMainWindowState,
  sanitizePersistedMainWindowState,
} from './main-window-state'

describe('main window state helpers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('accepts a valid persisted window state', () => {
    expect(sanitizePersistedMainWindowState({
      version: 1,
      width: 1440,
      height: 900,
      x: 120,
      y: 48,
      maximized: true,
    })).toEqual({
      version: 1,
      width: 1440,
      height: 900,
      x: 120,
      y: 48,
      maximized: true,
    })
  })

  it('rejects suspiciously small persisted window sizes', () => {
    expect(sanitizePersistedMainWindowState({
      ...DEFAULT_MAIN_WINDOW_STATE,
      width: 320,
      height: 240,
    })).toBeNull()
  })

  it('rejects invalid coordinates', () => {
    expect(sanitizePersistedMainWindowState({
      ...DEFAULT_MAIN_WINDOW_STATE,
      x: Number.NaN,
      y: 10,
    })).toBeNull()
  })

  it('uses per-window scoped storage keys', () => {
    expect(getMainWindowStateStorageKey()).toBe('app.shellbeam.mainWindowState.main')
    expect(getMainWindowStateStorageKey('settings')).toBe('app.shellbeam.mainWindowState.settings')
  })

  it('loads and saves window state through the scoped storage key', () => {
    const storageKey = getMainWindowStateStorageKey('main')
    const state = {
      version: 1 as const,
      width: 1440,
      height: 900,
      x: 80,
      y: 40,
      maximized: false,
    }

    expect(savePersistedMainWindowState(state, storageKey)).toBe(true)
    expect(loadPersistedMainWindowState(storageKey)).toEqual(state)
  })

  it('does not persist suspiciously small window sizes', () => {
    const storageKey = getMainWindowStateStorageKey('main')
    const existing = {
      version: 1 as const,
      width: 1440,
      height: 900,
      x: 100,
      y: 64,
      maximized: false,
    }

    expect(savePersistedMainWindowState(existing, storageKey)).toBe(true)
    expect(savePersistedMainWindowState({
      ...existing,
      width: 480,
      height: 320,
    }, storageKey)).toBe(false)
    expect(loadPersistedMainWindowState(storageKey)).toEqual(existing)
  })
})
