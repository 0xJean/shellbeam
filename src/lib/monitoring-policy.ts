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
export const policyCopy = {
  en: {
    events: 'Recent server load events', accepted: 'Accepted by service · recipient receipt unavailable', deliveryUnknown: 'Dispatch outcome unknown · will not replay', channelDisabled: 'Service notifications disabled', policyChanged: 'Cancelled after configuration changed', recovered: 'Recovered', missing: 'Enable the bundled extension first, then read the configuration.', mismatch: 'The installed extension differs from this App’s bundled version. It has been preserved; installation and editing are blocked.',
    title: 'Server load rules & silence', setup: 'Enable server load alerts', setupConfirm: 'Install and enable the bundled server extension? It can read monitoring samples and send load notifications while ShellBeam is closed. It uses administrator RPC permission and authenticated routes; it does not change existing channels or offline rules.', scope: 'Runs on the monitoring service, including while ShellBeam is closed. Silence affects only load notifications from this extension; offline, expiry and other service notifications keep their existing settings.',
    channelTitle: 'Notification channel', channelHint: 'Edit the fields declared by an installed channel. Text values are hidden until revealed. Unknown fields are preserved; no remote HTML is executed.', unsupported: 'This field format is preserved but cannot be edited here.', scriptHint: 'Saving channel configuration may change server-side script execution and delivery. Review the destination and script before confirming.',
    rules: 'Load rules', silences: 'Silence schedules', name: 'Name', host: 'Monitored host', metric: 'Metric', threshold: 'Alert at or above', recovery: 'Recover at or below', duration: 'Alert sustain (seconds)', recoveryDuration: 'Recovery sustain (seconds)', enabled: 'Enabled', addRule: 'Add load rule', addSilence: 'Add silence', remove: 'Remove', cpu: 'CPU (%)', memory: 'Memory (%)', disk: 'Disk (%)', load1: 'Load average (1 minute)',
    kind: 'Schedule', once: 'One-time window', weekly: 'Weekly (UTC)', start: 'Starts (local time)', end: 'Ends (local time)', startTime: 'Start time (UTC)', endTime: 'End time (UTC)', days: 'Starting weekdays (UTC)', weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], applies: 'Applies to rules', all: 'All extension load rules', selectRules: 'Selected rules', overnight: 'Weekly windows may cross midnight. The selected weekday is the starting day; times use UTC.', noHosts: 'Read the configuration to discover monitored hosts. A monitored host is required to create a rule.', status: 'Server observations', readOnly: 'Saved change for review; read the configuration to edit current values.', unknown: 'Unknown', firing: 'Alerting', silenced: 'Alerting · notifications silenced', healthy: 'Healthy', pending: 'Waiting for sustained samples', disabled: 'Disabled',
  },
  'zh-CN': {
    events: '最近的服务端负载事件', accepted: '服务端已受理 · 无接收方回执', deliveryUnknown: '发送结果未知 · 不会自动重发', channelDisabled: '服务端通知已关闭', policyChanged: '配置变更后已取消发送', recovered: '已恢复', missing: '请先启用内置扩展，再读取配置。', mismatch: '已安装扩展与此 App 内置版本不同，现有扩展已保留，安装和编辑已阻止。',
    title: '服务端负载规则与静默', setup: '启用服务端负载告警', setupConfirm: '安装并启用 App 内置的服务端扩展？扩展使用管理员 RPC 权限和需要认证的接口读取监控样本、发送负载通知，ShellBeam 关闭后仍运行。现有通知渠道和离线规则保持原样。', scope: '规则在监控服务端执行，ShellBeam 关闭后仍生效。静默仅影响本扩展产生的负载通知；离线、到期及其他服务通知保持原有设置。',
    channelTitle: '通知渠道', channelHint: '编辑已安装渠道声明的配置字段。文本默认隐藏，点击显示后可编辑；未识别字段保留，远端 HTML 不会执行。', unsupported: '此字段格式会保留，目前不能在这里编辑。', scriptHint: '保存渠道配置可能改变服务端脚本执行和投递行为，请先核对接收地址与脚本。',
    rules: '负载规则', silences: '静默计划', name: '名称', host: '监控主机', metric: '指标', threshold: '告警阈值（大于等于）', recovery: '恢复阈值（小于等于）', duration: '持续超限秒数', recoveryDuration: '持续恢复秒数', enabled: '启用', addRule: '添加负载规则', addSilence: '添加静默', remove: '移除', cpu: 'CPU（%）', memory: '内存（%）', disk: '磁盘（%）', load1: '系统负载（1 分钟）',
    kind: '计划类型', once: '单次时间段', weekly: '每周重复（UTC）', start: '开始时间（本地时区）', end: '结束时间（本地时区）', startTime: '开始时刻（UTC）', endTime: '结束时刻（UTC）', days: '开始日期（UTC 星期）', weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'], applies: '适用规则', all: '全部扩展负载规则', selectRules: '指定规则', overnight: '每周时间段可跨午夜，选择的星期是开始日；时刻统一使用 UTC。', noHosts: '读取配置以获取监控主机，创建规则前需至少有一台监控主机。', status: '服务端观测', readOnly: '当前是已保存修改的只读预览，请读取配置后再编辑。', unknown: '未知', firing: '告警中', silenced: '告警中 · 通知已静默', healthy: '正常', pending: '等待持续样本', disabled: '未启用',
  },
}
