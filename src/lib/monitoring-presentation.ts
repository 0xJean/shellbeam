import type { Locale } from './i18n'
import type { KomariAlertRecord } from './komari-alerts'

/** Presentation only. Canonical provider IDs, diagnostics and alert titles are
 * persisted contracts used by TS/Rust incident grouping and notification dedupe.
 * Never write these labels back to a record or apply them to user names. */
export function monitoringProviderLabel(provider: string, locale: Locale): string {
  if (provider === 'komari') return locale === 'zh-CN' ? '监控服务' : 'Monitoring service'
  if (provider === 'komari-local') return locale === 'zh-CN' ? '监控告警（本地处置）' : 'Monitoring alerts (local handling)'
  if (provider === 'ssh-agentless') return locale === 'zh-CN' ? 'SSH 无探针扫描' : 'SSH agentless scanning'
  return provider
}

/** Keep the opaque source/node suffix intact so two services remain distinct. */
export function monitoringHistorySourceLabel(key: string, locale: Locale): string {
  const separator = key.indexOf(':')
  if (separator < 0) return monitoringProviderLabel(key, locale)
  return `${monitoringProviderLabel(key.slice(0, separator), locale)} · ${key.slice(separator + 1)}`
}

const diagnostics: Record<string, readonly [string, string]> = {
  "Komari credential reference is required": ["Monitoring credential reference is required", "缺少监控凭据引用"],
  "Komari credential reference is invalid": ["Monitoring credential reference is invalid", "监控凭据引用无效"],
  "Komari integration belongs to another Vault": ["Monitoring service belongs to another Vault", "监控服务属于另一个保管库"],
  "Komari snapshot is too large": ["Monitoring snapshot is too large", "监控快照超过大小限制"],
  "Komari last synced timestamp is invalid": ["Monitoring refresh timestamp is invalid", "监控刷新时间戳无效"],
  "Komari sync TTL must be positive": ["Monitoring refresh TTL must be positive", "监控刷新 TTL 必须大于零"],
  "Komari mapping source is invalid": ["Monitoring association source is invalid", "监控关联来源无效"],
  "Komari mapping integration does not match the sync": ["Monitoring association does not match the service being refreshed", "监控关联与正在刷新的服务不匹配"],
  "Komari snapshot integration does not match the sync": ["Monitoring snapshot does not match the service being refreshed", "监控快照与正在刷新的服务不匹配"],
  "Begin Komari sync provenance migration failed": ["Begin monitoring sync provenance migration failed", "开始监控刷新来源迁移失败"],
  "Migrate Komari sync provenance failed": ["Migrate monitoring sync provenance failed", "迁移监控刷新来源失败"],
  "Commit Komari sync provenance migration failed": ["Commit monitoring sync provenance migration failed", "提交监控刷新来源迁移失败"],
  "Read Komari sync schema failed": ["Read monitoring sync schema failed", "读取监控刷新结构失败"],
  "Save Komari successful sync provenance failed": ["Save monitoring successful sync provenance failed", "保存成功监控刷新的来源失败"],

  'Komari endpoint is required': ['Monitoring service address is required', '请填写监控服务地址'],
  'Komari endpoint must be a valid URL': ['Monitoring service address must be a valid URL', '监控服务地址必须是有效 URL'],
  'Komari endpoint must use HTTP or HTTPS': ['Monitoring service address must use HTTP or HTTPS', '监控服务地址必须使用 HTTP 或 HTTPS'],
  'Komari endpoint must not contain credentials': ['Monitoring service address must not contain credentials', '监控服务地址不能包含凭据'],
  'Komari request failed': ['Monitoring service request failed', '监控服务请求失败'],
  'Komari response exceeds the size limit': ['Monitoring service response exceeds the size limit', '监控服务响应超过大小限制'],
  'Komari request timed out': ['Monitoring service request timed out', '监控服务请求超时'],
  'Komari endpoint is unavailable': ['Monitoring service is unavailable', '监控服务不可用'],
  'Komari node list has an unsupported response format': ['Monitoring service returned an unsupported node list', '监控服务返回的节点列表格式不受支持'],
  'Komari server API key is required': ['Monitoring service API key is required', '请填写监控服务 API 密钥'],
  'Komari node id is required': ['Monitoring node ID is required', '缺少监控节点 ID'],
  'Komari integration id is required': ['Monitoring service ID is required', '缺少监控服务 ID'],
  'Komari vault id is required': ['Monitoring service Vault ID is required', '缺少监控服务的保管库 ID'],
  'Komari integration name is required': ['Monitoring service name is required', '请填写监控服务名称'],
  'Komari node is not mapped': ['Monitoring node is not associated with a host', '监控节点尚未关联主机'],
  'Komari reports have missing or future sample times': ['Monitoring samples have missing or future timestamps', '监控样本缺少时间戳或时间位于未来'],
  'Komari returned no dated metric observations': ['Monitoring service returned no dated metric observations', '监控服务尚未返回带时间的指标样本'],
  'Komari monitoring source is offline': ['Monitoring source is offline', '监控数据源离线'],
  'Komari monitoring data is stale': ['Monitoring data is stale', '监控数据已过期'],
  'Komari monitoring data recovered': ['Monitoring data recovered', '监控数据已恢复'],
  'Komari inventory recovered': ['Monitoring inventory recovered', '监控资产采集已恢复'],
  'Komari Probe health is unknown': ['Monitoring health is unknown', '监控健康状态未知'],
  'Komari alert state is unavailable; refresh the host first': ['Monitoring alert state is unavailable; refresh the host first', '监控告警状态不可用，请先刷新主机'],
  'Komari alert integration was not found': ['Monitoring service for this alert was not found', '找不到此告警关联的监控服务'],
  'Komari alert was not found': ['Monitoring alert was not found', '找不到监控告警'],
  'Komari metrics selected; SSH data retained as fallback.': ['Monitoring service metrics selected; SSH data retained as fallback.', '当前使用监控服务指标，保留 SSH 数据供回退。'],
  'Komari metrics were unavailable or stale; SSH data selected.': ['Monitoring service metrics were unavailable or stale; SSH data selected.', '监控服务指标不可用或过期，当前使用 SSH 数据。'],
}

const diagnosticPrefixes: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["Begin Komari mapping replacement failed", ["Begin monitoring mapping replacement failed", "开始监控关联替换失败"]],
  ["Begin Komari mapping transaction failed", ["Begin monitoring mapping transaction failed", "开始监控关联事务失败"]],
  ["Begin Komari snapshot transaction failed", ["Begin monitoring snapshot transaction failed", "开始监控快照事务失败"]],
  ["Begin Komari sync persistence failed", ["Begin monitoring sync persistence failed", "开始监控刷新持久化失败"]],
  ["Begin Komari sync state transaction failed", ["Begin monitoring sync state transaction failed", "开始监控刷新状态事务失败"]],
  ["Clear Komari mappings failed", ["Clear monitoring mappings failed", "清除监控关联失败"]],
  ["Clear Komari snapshots failed", ["Clear monitoring snapshots failed", "清除监控快照失败"]],
  ["Clear Komari sync state failed", ["Clear monitoring sync state failed", "清除监控刷新状态失败"]],
  ["Commit Komari mapping failed", ["Commit monitoring mapping failed", "提交监控关联失败"]],
  ["Commit Komari mapping replacement failed", ["Commit monitoring mapping replacement failed", "提交监控关联替换失败"]],
  ["Commit Komari snapshot failed", ["Commit monitoring snapshot failed", "提交监控快照失败"]],
  ["Commit Komari sync persistence failed", ["Commit monitoring sync persistence failed", "提交监控刷新持久化失败"]],
  ["Commit Komari sync state failed", ["Commit monitoring sync state failed", "提交监控刷新状态失败"]],
  ["Configure Komari db failed", ["Configure monitoring db failed", "配置监控数据库失败"]],
  ["Configure Komari persistence db failed", ["Configure monitoring persistence db failed", "配置监控持久化数据库失败"]],
  ["Delete Komari integration failed", ["Delete monitoring integration failed", "删除监控服务失败"]],
  ["Initialize Komari db failed", ["Initialize monitoring db failed", "初始化监控数据库失败"]],
  ["Initialize Komari persistence db failed", ["Initialize monitoring persistence db failed", "初始化监控持久化数据库失败"]],
  ["Open Komari db failed", ["Open monitoring db failed", "打开监控数据库失败"]],
  ["Open Komari persistence db failed", ["Open monitoring persistence db failed", "打开监控持久化数据库失败"]],
  ["Prepare Komari integration query failed", ["Prepare monitoring integration query failed", "准备监控服务查询失败"]],
  ["Prepare Komari mapping query failed", ["Prepare monitoring mapping query failed", "准备监控关联查询失败"]],
  ["Prepare Komari snapshot query failed", ["Prepare monitoring snapshot query failed", "准备监控快照查询失败"]],
  ["Query Komari integrations failed", ["Query monitoring integrations failed", "查询监控服务列表失败"]],
  ["Query Komari mappings failed", ["Query monitoring mappings failed", "查询监控关联失败"]],
  ["Query Komari snapshots failed", ["Query monitoring snapshots failed", "查询监控快照失败"]],
  ["Read Komari integration failed", ["Read monitoring integration failed", "读取监控服务失败"]],
  ["Read Komari integration metadata failed", ["Read monitoring integration metadata failed", "读取监控服务资料失败"]],
  ["Read Komari mapping failed", ["Read monitoring mapping failed", "读取监控关联失败"]],
  ["Read Komari snapshot failed", ["Read monitoring snapshot failed", "读取监控快照失败"]],
  ["Read Komari sync state failed", ["Read monitoring sync state failed", "读取监控刷新状态失败"]],
  ["Read existing Komari integration scope failed", ["Read existing monitoring integration scope failed", "读取现有监控服务作用域失败"]],
  ["Read saved Komari integration failed", ["Read saved monitoring integration failed", "读取已保存监控服务失败"]],
  ["Save Komari integration failed", ["Save monitoring integration failed", "保存监控服务失败"]],
  ["Save Komari mapping failed", ["Save monitoring mapping failed", "保存监控关联失败"]],
  ["Save Komari snapshot failed", ["Save monitoring snapshot failed", "保存监控快照失败"]],
  ["Save Komari sync state failed", ["Save monitoring sync state failed", "保存监控刷新状态失败"]],
  ["Serialize Komari snapshot failed", ["Serialize monitoring snapshot failed", "序列化监控快照失败"]],
])

function knownDiagnostic(message: string, locale: Locale): string | undefined {
  const known = Object.hasOwn(diagnostics, message) ? diagnostics[message] : undefined
  if (known) return known[locale === 'zh-CN' ? 1 : 0]
  const separator = message.indexOf(': ')
  if (separator < 0) return undefined
  const prefix = diagnosticPrefixes.get(message.slice(0, separator))
  return prefix ? `${prefix[locale === 'zh-CN' ? 1 : 0]}: ${message.slice(separator + 2)}` : undefined
}

/** Only known application diagnostics are translated. An arbitrary upstream
 * response (even one containing Komari) remains verbatim. */
export function monitoringDiagnostic(message: string, locale: Locale): string {
  const known = knownDiagnostic(message, locale)
  if (known !== undefined) return known
  const retry = /^Probe recovery failed after (\d+) retr(?:y|ies): (.+)$/.exec(message)
  const detail = retry ? knownDiagnostic(retry[2], locale) : undefined
  if (retry && detail !== undefined) {
    return locale === 'zh-CN' ? `探针重试 ${retry[1]} 次后仍未恢复：${detail}` : `Probe recovery failed after ${retry[1]} retries: ${detail}`
  }
  return message
}

export function monitoringAlertTitle(record: Pick<KomariAlertRecord, 'kind' | 'title'>, locale: Locale): string {
  if (!['probe-offline', 'probe-stale', 'probe-unknown', 'probe-error:metrics', 'probe-error:provider', 'probe-error:inventory'].includes(record.kind)) return record.title
  const section = /^Komari Probe (metrics|provider|inventory) error: (.+)$/.exec(record.title)
  if (section && record.kind === `probe-error:${section[1]}`) {
    const label = locale === 'zh-CN'
      ? { metrics: '指标采集', provider: '监控数据源', inventory: '资产采集' }[section[1] as 'metrics' | 'provider' | 'inventory']
      : { metrics: 'Metric collection', provider: 'Monitoring source', inventory: 'Inventory collection' }[section[1] as 'metrics' | 'provider' | 'inventory']
    const detail = monitoringDiagnostic(section[2], locale)
    return locale === 'zh-CN' ? `${label}异常：${detail}` : `${label} error: ${detail}`
  }
  return monitoringDiagnostic(record.title, locale)
}

/** The legacy generated target is an identifier, not a user-supplied name. */
export function monitoringOperationTarget(target: string, action: string, locale: Locale): string {
  const node = action === 'agent.check' ? /^Komari node ([a-zA-Z0-9._:-]+)$/.exec(target) : null
  return node ? `${locale === 'zh-CN' ? '监控节点' : 'Monitoring node'} ${node[1]}` : target
}
