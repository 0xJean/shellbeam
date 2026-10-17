import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROBE_RETRY_SETTINGS,
  PROBE_RETRY_SETTINGS_STORAGE_KEY,
  clearProbeRetrySettings,
  loadProbeRetrySettings,
  normalizeProbeRetrySettings,
  saveProbeRetrySettings,
} from './probe-retry-settings'

describe('ProbeProvider retry settings', () => {
  afterEach(() => clearProbeRetrySettings())

  it('uses bounded defaults when no preference is saved', () => {
    expect(loadProbeRetrySettings()).toEqual(DEFAULT_PROBE_RETRY_SETTINGS)
    expect(normalizeProbeRetrySettings({ maxRetries: 99, retryDelayMs: 99999 })).toEqual({ maxRetries: 5, retryDelayMs: 2000 })
  })

  it('persists a normalized policy across loads', () => {
    expect(saveProbeRetrySettings({ maxRetries: 3.9, retryDelayMs: 425.8 })).toEqual({ maxRetries: 3, retryDelayMs: 425 })
    expect(loadProbeRetrySettings()).toEqual({ maxRetries: 3, retryDelayMs: 425 })
    expect(localStorage.getItem(PROBE_RETRY_SETTINGS_STORAGE_KEY)).toContain('"maxRetries":3')
  })

  it('ignores malformed persisted data', () => {
    localStorage.setItem(PROBE_RETRY_SETTINGS_STORAGE_KEY, '{broken')
    expect(loadProbeRetrySettings()).toEqual(DEFAULT_PROBE_RETRY_SETTINGS)
  })
})
