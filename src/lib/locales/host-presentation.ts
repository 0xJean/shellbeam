export const hostPresentationCopy = {
  'zh-CN': {
    monitoring: '显示详细运维摘要', monitoringHint: '地区和已有基础指标始终显示；此项展开运维摘要，不改变采集或通知设置。',
    filters: '筛选', batch: '批量选择', done: '完成选择', selectHost: '选择主机',
    alerts: '告警', open: '待处理', all: '全部', noAlerts: '没有符合条件的告警',
    source: '来源', local: 'ShellBeam', host: '主机', history: '包含历史记录',
    overview: '主机概览', diagnostics: '查看诊断与操作记录', details: '查看告警与状态',
    notObserved: '尚未检查', noOpenAlerts: '暂无待处理告警',
    monitoringOffline: '监控中断', monitoringStale: '监控数据过期',
    historicalSource: '历史记录 · 非当前数据源',
  },
  en: {
    monitoring: 'Show detailed operations summary', monitoringHint: 'Location and available basic metrics stay visible. Expand operations summaries without changing collection or notifications.',
    filters: 'Filters', batch: 'Select hosts', done: 'Done selecting', selectHost: 'Select host',
    alerts: 'Alerts', open: 'open', all: 'All', noAlerts: 'No matching alerts',
    source: 'Source', local: 'ShellBeam', host: 'Host', history: 'Include history',
    overview: 'Host overview', diagnostics: 'Diagnostics and operation history', details: 'Alerts and status',
    notObserved: 'Not checked', noOpenAlerts: 'No open alerts',
    monitoringOffline: 'Monitoring interrupted', monitoringStale: 'Monitoring data stale',
    historicalSource: 'History · inactive data source',
  },
} as const
