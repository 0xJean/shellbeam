import { fill } from '@/lib/locales/probe-install'
import type { WorkspaceMobileV3Copy } from '@/lib/locales/workspace-mobile-v3'
import type { HostOpsHealthState } from '@/lib/host-ops-view'

const DAY_MS = 86_400_000

export function relativeTime(now: number, time: number | null | undefined, copy: WorkspaceMobileV3Copy) {
  if (!time) return null
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return fill(copy.secondsAgo, { value: seconds })
  if (seconds < 3600) return fill(copy.minutesAgo, { value: Math.floor(seconds / 60) })
  return fill(copy.hoursAgo, { value: Math.floor(seconds / 3600) })
}

export function formatUptime(seconds: number | null | undefined, locale: string) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
  const zh = locale === 'zh-CN'
  if (seconds >= DAY_MS / 1000) return `${Math.floor(seconds / 86_400)}${zh ? ' 天' : 'd'}`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}${zh ? ' 小时' : 'h'}`
  return `${Math.max(1, Math.floor(seconds / 60))}${zh ? ' 分钟' : 'm'}`
}

/** "12.4M" style rate for the small ring centre. */
export function compactRate(bytesPerSec: number | null | undefined) {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return null
  const units = ['B', 'K', 'M', 'G']
  let value = Math.max(0, bytesPerSec)
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)}${units[index]}`
}

export function daysLeft(notAfter: number | null, now: number) {
  return notAfter == null ? null : Math.floor((notAfter - now) / DAY_MS)
}

export function formatClock(time: number, locale: string) {
  return new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

export function healthDotClass(state: HostOpsHealthState | undefined) {
  if (state === 'online') return 'bg-[var(--workspace-status-good)]'
  if (state === 'stale' || state === 'paused' || state === 'checking') return 'bg-[var(--workspace-status-warn)]'
  if (state === 'offline' || state === 'jump-unavailable') return 'bg-[var(--workspace-status-bad)]'
  return 'bg-[var(--workspace-text-subtle)]'
}
