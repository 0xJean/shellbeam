import type { FleetHost } from '@/hooks/use-fleet-metrics'
import { hostBucket } from '@/lib/host-grouping'
import { hasSshConnection, type HostProfile } from '@/lib/hosts'

export type MobileHostStatus = 'online' | 'attention' | 'offline' | 'checking' | 'unknown'

export function hostReadings(entry: FleetHost | undefined): Array<number | null> {
  const metrics = entry?.view?.metrics
  const resource = entry?.view?.resource
  if (metrics) return [metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent]
  if (resource) return [resource.cpuPercent, resource.memoryPercent, resource.diskPercent]
  return [null, null, null]
}

export function hostOs(entry: FleetHost | undefined) {
  return entry?.view?.metrics?.os || entry?.view?.resource?.os || ''
}

export function mobileHostStatus(entry: FleetHost | undefined, loading: boolean): MobileHostStatus {
  if (!entry) return loading ? 'checking' : 'unknown'
  const bucket = hostBucket(entry.status, entry.openAlerts, hostReadings(entry))
  if (bucket === 'offline') return 'offline'
  if (bucket === 'attention') return 'attention'
  if (entry.status === 'online') return 'online'
  if (entry.status === 'checking') return 'checking'
  return 'unknown'
}

export const STATUS_DOT: Record<MobileHostStatus, string> = {
  online: 'bg-[color:var(--workspace-status-good)]',
  attention: 'bg-[color:var(--workspace-status-warn)]',
  offline: 'bg-[color:var(--workspace-status-bad)]',
  checking: 'bg-[var(--workspace-text-subtle)] animate-pulse',
  unknown: 'bg-[var(--workspace-text-subtle)]',
}

export const STATUS_PILL: Record<MobileHostStatus, string> = {
  online: 'bg-[var(--workspace-status-good-bg)] text-[color:var(--workspace-status-good-text)]',
  attention: 'bg-[var(--workspace-status-warn-bg)] text-[color:var(--workspace-status-warn-text)]',
  offline: 'bg-[var(--workspace-status-bad-bg)] text-[color:var(--workspace-status-bad-text)]',
  checking: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]',
  unknown: 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]',
}

export function hostEndpoint(host: HostProfile, monitoringOnly: string) {
  if (!hasSshConnection(host)) return monitoringOnly
  return `${host.username ? `${host.username}@` : ''}${host.address}${host.port !== 22 ? `:${host.port}` : ''}`
}
