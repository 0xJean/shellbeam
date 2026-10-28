export interface LoadEvent { ruleId: string; name: string; kind: string; sampledAt: number; delivery: string }
export interface MonitoringNode { id: string; name: string; createdAt: string }
export interface LoadRule { id: string; name: string; nodeId: string; nodeCreatedAt: string; metric: 'cpu' | 'memory' | 'disk' | 'load1'; threshold: number; recovery: number; durationSeconds: number; recoverySeconds: number; enabled: boolean }
export interface LoadSilence { id: string; name: string; enabled: boolean; ruleIds: string[]; kind: 'once' | 'weekly'; startAt?: number; endAt?: number; days?: number[]; startMinute?: number; endMinute?: number; timezone?: 'UTC' }
export interface ChannelField { key: string; name?: unknown; type: string; options?: string; required?: boolean; help?: unknown }
export function channelFields(values: Record<string, unknown>): ChannelField[] {
  const schema = values.__shellbeam_channel_schema as { type?: string; data?: unknown } | undefined
  if (!schema || !['', 'managed'].includes(schema.type ?? '') || !Array.isArray(schema.data)) return []
  const rows = schema.data.filter((f): f is ChannelField => !!f && typeof f === 'object' && typeof f.key === 'string' && typeof f.type === 'string').slice(0, 128)
  return rows.filter(f => !f.key.startsWith('__shellbeam_') && rows.filter(x => x.key === f.key).length === 1).map(f => ({ ...f, options: typeof f.options === 'string' ? f.options : '', required: f.required === true }))
}
export function channelLabel(value: unknown, fallback: string, locale: string) {
  if (typeof value === 'string') return value.slice(0, 300)
  if (value && typeof value === 'object') { const map = value as Record<string, unknown>; const v = map[locale] ?? map[locale.replace('-', '_')] ?? map.en; if (typeof v === 'string') return v.slice(0, 300) }
  return fallback
}
export { policyCopy } from './locales/monitoring-policy'
