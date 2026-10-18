import { COLLECTION_LIMITS } from './collection-limits'
/**
 * User-controlled defaults for ProbeProvider recovery.  Request-level values
 * still take precedence, while this small preference keeps monitor,
 * Workspace and MCP callers on the same retry policy across app sessions.
 */

import {
  DEFAULT_PROBE_RECOVERY_MAX_RETRIES,
  DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS,
  MAX_PROBE_RECOVERY_RETRY_DELAY_MS,
} from './probe-scheduler-constants'

export const PROBE_RETRY_SETTINGS_STORAGE_KEY = 'shellbeam.probeRetrySettings.v1'
export const MAX_PROBE_RECOVERY_RETRIES = COLLECTION_LIMITS.scheduler.maxRetries

export interface ProbeRetrySettings {
  maxRetries: number
  retryDelayMs: number
}

export const DEFAULT_PROBE_RETRY_SETTINGS: ProbeRetrySettings = {
  maxRetries: DEFAULT_PROBE_RECOVERY_MAX_RETRIES,
  retryDelayMs: DEFAULT_PROBE_RECOVERY_RETRY_DELAY_MS,
}

export function normalizeProbeRetrySettings(input: Partial<ProbeRetrySettings> | null | undefined): ProbeRetrySettings {
  const maxRetries = Number(input?.maxRetries)
  const retryDelayMs = Number(input?.retryDelayMs)
  return {
    maxRetries: Number.isFinite(maxRetries)
      ? Math.max(0, Math.min(MAX_PROBE_RECOVERY_RETRIES, Math.floor(maxRetries)))
      : DEFAULT_PROBE_RETRY_SETTINGS.maxRetries,
    retryDelayMs: Number.isFinite(retryDelayMs)
      ? Math.max(0, Math.min(MAX_PROBE_RECOVERY_RETRY_DELAY_MS, Math.floor(retryDelayMs)))
      : DEFAULT_PROBE_RETRY_SETTINGS.retryDelayMs,
  }
}

export function loadProbeRetrySettings(): ProbeRetrySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PROBE_RETRY_SETTINGS }
  try {
    const raw = localStorage.getItem(PROBE_RETRY_SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PROBE_RETRY_SETTINGS }
    return normalizeProbeRetrySettings(JSON.parse(raw) as Partial<ProbeRetrySettings>)
  } catch {
    return { ...DEFAULT_PROBE_RETRY_SETTINGS }
  }
}

export function saveProbeRetrySettings(settings: Partial<ProbeRetrySettings>): ProbeRetrySettings {
  const normalized = normalizeProbeRetrySettings(settings)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(PROBE_RETRY_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
    } catch {
      // Preferences are optional; the in-memory normalized value remains usable.
    }
  }
  return normalized
}

export function clearProbeRetrySettings() {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(PROBE_RETRY_SETTINGS_STORAGE_KEY) } catch { /* storage is optional */ }
  }
}
