import { invoke, isTauri } from '@tauri-apps/api/core'

export type SystemNotificationPermission = 'granted' | 'denied' | 'default' | 'limited' | 'unknown' | 'unavailable'
export type SystemNotificationErrorCode = 'system-unavailable' | 'system-permission-required' | 'system-permission-denied' | 'system-send-failed'

export class SystemNotificationError extends Error {
  readonly code: SystemNotificationErrorCode

  constructor(code: SystemNotificationErrorCode) {
    super(code)
    this.name = 'SystemNotificationError'
    this.code = code
  }
}

export interface SystemNotificationContent {
  /** Redacted user-visible text only. Never pass provider payloads or metadata. */
  title: string
  body: string
}

function browserNotification(): typeof Notification | undefined {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined
}

function permissionState(value: unknown): SystemNotificationPermission {
  return value === 'granted' || value === 'denied' || value === 'default' || value === 'limited' || value === 'unknown' ? value : 'unavailable'
}

function nativeError(cause: unknown): SystemNotificationError {
  // Never expose native errors, which can include paths or platform details.
  const code = cause === 'system-unavailable' || cause === 'system-permission-required' || cause === 'system-permission-denied'
    ? cause
    : 'system-send-failed'
  return new SystemNotificationError(code)
}

/** Read capability without prompting. Native failures never fall back to a webview API. */
export async function getSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  if (isTauri()) {
    try {
      return permissionState(await invoke('system_notification_permission'))
    } catch {
      return 'unavailable'
    }
  }
  return permissionState(browserNotification()?.permission)
}

/** Call only from an explicit user action; dispatch never invokes this method. */
export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  if (isTauri()) {
    try {
      return permissionState(await invoke('request_system_notification_permission'))
    } catch {
      return 'unavailable'
    }
  }
  const constructor = browserNotification()
  if (!constructor) return 'unavailable'
  const current = permissionState(constructor.permission)
  if (current !== 'default') return current
  try {
    return permissionState(await constructor.requestPermission())
  } catch {
    return 'unavailable'
  }
}

function boundedText(value: string, length: number): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('').replace(/\s+/g, ' ').trim().slice(0, length)
}

/** Resolves after backend acceptance. OS focus modes can still suppress banners. */
export async function sendSystemNotification(content: SystemNotificationContent): Promise<void> {
  const native = isTauri()
  const permission = await getSystemNotificationPermission()
  if (permission === 'unavailable') throw new SystemNotificationError('system-unavailable')
  if (permission === 'denied') throw new SystemNotificationError('system-permission-denied')
  // Freedesktop has a real notification service but no per-app permission API.
  // Its native backend may attempt delivery without claiming OS authorization.
  if (permission !== 'granted' && !(native && (permission === 'unknown' || permission === 'limited'))) throw new SystemNotificationError('system-permission-required')
  const title = boundedText(content.title, 120)
  const body = boundedText(content.body, 240)
  if (!title || !body) throw new SystemNotificationError('system-send-failed')
  if (native) {
    try {
      await invoke('send_system_notification', { title, body })
    } catch (cause) {
      throw nativeError(cause)
    }
    return
  }
  const constructor = browserNotification()
  if (!constructor) throw new SystemNotificationError('system-unavailable')
  try {
    new constructor(title, { body })
  } catch {
    throw new SystemNotificationError('system-send-failed')
  }
}
