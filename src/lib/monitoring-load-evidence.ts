/** Safe persisted evidence from the optional server evaluator, never channel
 * configuration, secrets or remote response text. */
export interface MonitoringLoadEvidence {
  endpoint: string
  extensionIdentity: string
  ruleId: string
  nodeCreatedAt: string
  hostCreatedAt: number
  metric: 'cpu' | 'memory' | 'disk' | 'load1'
  sampledAt: number
  observedAt: number
  state: 'firing' | 'healthy' | 'pending' | 'unknown' | 'disabled' | 'retired' | 'unavailable'
  notification: 'server-managed' | 'silenced' | 'channel-disabled'
  value: number | null
}
export function parseMonitoringLoadEvidence(value: unknown): MonitoringLoadEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const r = value as MonitoringLoadEvidence
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 2048 || !/^https?:\/\//.test(r.endpoint)
    || typeof r.extensionIdentity !== 'string' || !/^[a-f0-9]{48}$/.test(r.extensionIdentity)
    || typeof r.ruleId !== 'string' || !/^[\w-]{1,80}$/.test(r.ruleId)
    || typeof r.nodeCreatedAt !== 'string' || !r.nodeCreatedAt || r.nodeCreatedAt.length > 120
    || !Number.isFinite(r.hostCreatedAt) || r.hostCreatedAt < 0
    || !['cpu', 'memory', 'disk', 'load1'].includes(r.metric)
    || !Number.isSafeInteger(r.sampledAt) || r.sampledAt < 0 || !Number.isSafeInteger(r.observedAt) || r.observedAt <= 0
    || !['firing', 'healthy', 'pending', 'unknown', 'disabled', 'retired', 'unavailable'].includes(r.state)
    || !['server-managed', 'silenced', 'channel-disabled'].includes(r.notification)
    || (r.value !== null && (!Number.isFinite(r.value) || r.value < 0))) return
  return { endpoint: r.endpoint, extensionIdentity: r.extensionIdentity, ruleId: r.ruleId, nodeCreatedAt: r.nodeCreatedAt,
    hostCreatedAt: r.hostCreatedAt, metric: r.metric, sampledAt: r.sampledAt, observedAt: r.observedAt,
    state: r.state, notification: r.notification, value: r.value }
}
export function isHistoricalLoadEvidence(evidence?: MonitoringLoadEvidence) {
  return evidence?.state === 'disabled' || evidence?.state === 'retired'
}
export function loadEvidenceObservation(evidence: MonitoringLoadEvidence, now = Date.now()): 'abnormal' | 'recovered' | 'unknown' {
  if (evidence.sampledAt <= 0 || evidence.sampledAt > now || now - evidence.sampledAt > 180_000) return 'unknown'
  return evidence.state === 'firing' ? 'abnormal' : evidence.state === 'healthy' ? 'recovered' : 'unknown'
}
export function loadEvidenceCopy(evidence: MonitoringLoadEvidence, locale: string, now = Date.now()) {
  const zh = locale === 'zh-CN'
  const state = evidence.state === 'retired' ? (zh ? '规则已移除或身份已变化，保留历史' : 'Rule removed or identity changed; history retained')
    : evidence.state === 'disabled' ? (zh ? '规则已停用，不代表故障恢复' : 'Rule disabled; recovery is not proven')
      : evidence.state === 'unavailable' ? (zh ? '服务观测读取失败，保留最后状态' : 'Server observation unavailable; last state retained')
        : loadEvidenceObservation(evidence, now) === 'unknown' ? (zh ? '等待有效的新样本' : 'Waiting for valid new samples') : ''
  const notification = evidence.notification === 'silenced' ? (zh ? '负载通知已静默' : 'Load notifications silenced')
    : evidence.notification === 'channel-disabled' ? (zh ? '服务端通知已关闭' : 'Server notifications disabled')
      : (zh ? '由服务端发送通知，App 不重复发送' : 'Notifications managed by the server; no duplicate App delivery')
  return [state, notification].filter(Boolean).join(' · ')
}
