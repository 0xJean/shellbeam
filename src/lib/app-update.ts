import { invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { isTauriRuntime } from './main-window-state'

/** Scheduled checks ask GitHub at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
/** A startup check is skipped only if one succeeded this recently, so quick restarts stay quiet. */
export const UPDATE_STARTUP_GAP_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 5_000
const TICK_MS = 60 * 60 * 1000
const ENABLED_KEY = 'shellbeam.updateCheck.enabled'
const STATE_KEY = 'shellbeam.updateCheck.state'

interface ParsedVersion { core: [number, number, number]; prerelease: string[] }

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] }
}

/** Semver order, or null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1
  // A prerelease comes before its release; 0.2.0-beta.1 < 0.2.0.
  if (!left.prerelease.length || !right.prerelease.length) return Math.sign(right.prerelease.length - left.prerelease.length) as number
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export interface LatestReleaseRecord { tag_name?: unknown; draft?: unknown; prerelease?: unknown }

/** The version a release record offers, or null for anything that must not produce a reminder. */
export function releasedVersion(record: LatestReleaseRecord | null | undefined): string | null {
  if (!record || record.draft !== false || record.prerelease !== false || typeof record.tag_name !== 'string') return null
  const parsed = parseVersion(record.tag_name)
  if (!parsed || parsed.prerelease.length || !record.tag_name.startsWith('v') || record.tag_name.includes('+')) return null
  return parsed.core.join('.')
}

export interface AppUpdateSnapshot {
  /** Null until the native side answers, and always outside the Tauri app. */
  platform: string | null
  currentVersion: string | null
  enabled: boolean
  latestVersion: string | null
  dismissedVersion: string | null
  lastCheckedAt: number | null
  checking: boolean
  lastCheckFailed: boolean
}

function readStored(): Pick<AppUpdateSnapshot, 'enabled' | 'latestVersion' | 'dismissedVersion' | 'lastCheckedAt'> {
  const stored = { enabled: true, latestVersion: null as string | null, dismissedVersion: null as string | null, lastCheckedAt: null as number | null }
  try {
    stored.enabled = localStorage.getItem(ENABLED_KEY) !== 'false'
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, unknown>
    if (typeof raw.latestVersion === 'string' && parseVersion(raw.latestVersion)) stored.latestVersion = raw.latestVersion
    if (typeof raw.dismissedVersion === 'string') stored.dismissedVersion = raw.dismissedVersion
    if (typeof raw.lastCheckedAt === 'number' && Number.isFinite(raw.lastCheckedAt)) stored.lastCheckedAt = raw.lastCheckedAt
  } catch { /* Unreadable state only means asking GitHub again. */ }
  return stored
}

function initialSnapshot(): AppUpdateSnapshot {
  return { platform: null, currentVersion: null, checking: false, lastCheckFailed: false, ...readStored() }
}

let snapshot = initialSnapshot()
let infoLoading: Promise<void> | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Partial<AppUpdateSnapshot>) {
  snapshot = { ...snapshot, ...next }
  try {
    if ('latestVersion' in next || 'dismissedVersion' in next || 'lastCheckedAt' in next) {
      localStorage.setItem(STATE_KEY, JSON.stringify({ latestVersion: snapshot.latestVersion, dismissedVersion: snapshot.dismissedVersion, lastCheckedAt: snapshot.lastCheckedAt }))
    }
    if ('enabled' in next) localStorage.setItem(ENABLED_KEY, String(snapshot.enabled))
  } catch { /* Kept for this session only. */ }
  for (const listener of listeners) listener()
}

export const getAppUpdateSnapshot = () => snapshot
export function subscribeAppUpdate(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** TestFlight tells iOS users about new builds, and it may lag or lead a GitHub release. */
export const usesGitHubUpdates = (state: AppUpdateSnapshot) => state.platform !== null && state.platform !== 'ios'

/** The newer version on offer, whether or not its reminder was dismissed. */
export function availableVersion(state: AppUpdateSnapshot): string | null {
  if (!usesGitHubUpdates(state) || !state.currentVersion || !state.latestVersion) return null
  return compareVersions(state.latestVersion, state.currentVersion) === 1 ? state.latestVersion : null
}

/** The version to remind about, once. A newer release than the dismissed one reminds again. */
export function reminderVersion(state: AppUpdateSnapshot): string | null {
  const version = availableVersion(state)
  return version && state.enabled && version !== state.dismissedVersion ? version : null
}

export const useAppUpdate = () => useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot)
export const useAppUpdateReminderVersion = () => reminderVersion(useAppUpdate())

export function loadAppUpdateInfo(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve()
  infoLoading ??= invoke<{ version?: unknown; platform?: unknown }>('app_update_info').then((info) => {
    if (typeof info?.version === 'string' && typeof info.platform === 'string') publish({ currentVersion: info.version, platform: info.platform })
  }).catch(() => { infoLoading = null })
  return infoLoading
}

/** Never rejects. A failure leaves the last known answer in place and only sets lastCheckFailed. */
export function checkForAppUpdate(): Promise<void> {
  inFlight ??= (async () => {
    await loadAppUpdateInfo()
    if (!usesGitHubUpdates(snapshot)) return
    publish({ checking: true, lastCheckFailed: false })
    try {
      const version = releasedVersion(await invoke<LatestReleaseRecord>('check_latest_app_release'))
      if (!version) throw new Error('update_check_failed')
      publish({ checking: false, latestVersion: version, lastCheckedAt: Date.now() })
    } catch {
      publish({ checking: false, lastCheckFailed: true })
    }
  })().finally(() => { inFlight = null })
  return inFlight
}

/** A clock moved backwards counts as due, so it cannot silence checks. */
export function isUpdateCheckDue(lastCheckedAt: number | null, now: number, gapMs: number) {
  return lastCheckedAt === null || now < lastCheckedAt || now - lastCheckedAt >= gapMs
}

async function checkIfDue(gapMs: number) {
  if (snapshot.enabled && isUpdateCheckDue(snapshot.lastCheckedAt, Date.now(), gapMs)) await checkForAppUpdate()
}

/** Starts the startup and periodic checks; returns the cleanup. Hourly ticks survive sleep better than one long timer. */
export function startAppUpdateChecks(): () => void {
  if (!isTauriRuntime()) return () => {}
  void loadAppUpdateInfo()
  const startup = setTimeout(() => void checkIfDue(UPDATE_STARTUP_GAP_MS), STARTUP_DELAY_MS)
  const tick = setInterval(() => void checkIfDue(UPDATE_CHECK_INTERVAL_MS), TICK_MS)
  return () => { clearTimeout(startup); clearInterval(tick) }
}

export function dismissAppUpdate(version: string) { publish({ dismissedVersion: version }) }

export function setAppUpdateChecksEnabled(enabled: boolean) {
  publish({ enabled })
  if (enabled) void checkIfDue(UPDATE_STARTUP_GAP_MS)
}

export function openAppReleasePage(version: string): Promise<void> {
  return invoke('open_app_release_page', { version })
}

export function resetAppUpdateForTests() {
  snapshot = initialSnapshot()
  infoLoading = null
  inFlight = null
  listeners.clear()
}
