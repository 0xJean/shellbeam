export type ResourceUsageTone = 'good' | 'warn' | 'bad'

export const RESOURCE_USAGE_WARN_THRESHOLD = 50
export const RESOURCE_USAGE_BAD_THRESHOLD = 80

export function getResourceUsageTone(value: number | null | undefined): ResourceUsageTone | null {
  if (value == null) return null
  if (value >= RESOURCE_USAGE_BAD_THRESHOLD) return 'bad'
  if (value >= RESOURCE_USAGE_WARN_THRESHOLD) return 'warn'
  return 'good'
}

export function getResourceUsageFillClassName(value: number | null | undefined) {
  const tone = getResourceUsageTone(value)
  if (tone === 'bad') return 'bg-[color:var(--workspace-status-bad)]'
  if (tone === 'warn') return 'bg-[color:var(--workspace-status-warn)]'
  if (tone === 'good') return 'bg-[color:var(--workspace-primary-500)]'
  return 'bg-[var(--workspace-meter-track)]'
}

export function getResourceUsageTextClassName(value: number | null | undefined) {
  const tone = getResourceUsageTone(value)
  if (tone === 'bad') return 'text-[color:var(--workspace-status-bad)]'
  if (tone === 'warn') return 'text-[color:var(--workspace-status-warn)]'
  if (tone === 'good') return 'text-[color:var(--workspace-primary-500)]'
  return 'text-[var(--workspace-text-subtle)]'
}

export function getResourceUsageBorderClassName(value: number | null | undefined) {
  const tone = getResourceUsageTone(value)
  if (tone === 'bad') return 'border-[color:var(--workspace-status-bad)]'
  if (tone === 'warn') return 'border-[color:var(--workspace-status-warn)]'
  if (tone === 'good') return 'border-[color:var(--workspace-primary-500)]'
  return 'border-[color:var(--workspace-border-soft)]'
}
