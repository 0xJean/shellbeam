import { getResourceUsageTone } from '@/lib/resource-usage'

export type HostBucket = 'attention' | 'normal' | 'offline'
export const HOST_BUCKETS: HostBucket[] = ['attention', 'normal', 'offline']

/**
 * Which card section a host belongs in (v3 host grid): unreachable hosts sink
 * to "offline", anything with an open alert, a resource past the bad threshold or stale
 * data rises to "attention", the rest are "normal".
 */
export function hostBucket(status: string | undefined, openAlerts: number, readings: Array<number | null | undefined>): HostBucket {
  if (status === 'offline' || status === 'jump-unavailable') return 'offline'
  if (openAlerts > 0 || status === 'stale') return 'attention'
  return readings.some((value) => getResourceUsageTone(value) === 'bad') ? 'attention' : 'normal'
}
