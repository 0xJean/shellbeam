export const monitoringAlertsCopy = {
  en: {
    monitoringService: 'Monitoring service', sample: 'Sample', evidenceUnavailable: 'Historical rule count without event evidence; excluded from current incidents.', archived: 'Archived', archive: 'Archive', lastObservation: 'Last observation: ',
    observation: { abnormal: 'Abnormal', recovered: 'Recovered', unknown: 'Unknown' },
    localOnly: 'Acknowledging or archiving updates ShellBeam records only; remote health and server notifications are unchanged.', alerts: 'Alerts', relatedDiagnostics: '{count} related diagnostics', noEvidence: 'No event evidence · history and audit retained', open: 'open',
  },
  'zh-CN': {
    monitoringService: '监控服务', sample: '采样', evidenceUnavailable: '历史规则统计缺少事件证据，未计入当前异常。', archived: '已归档', archive: '归档', lastObservation: '最近观测：',
    observation: { abnormal: '异常', recovered: '已恢复', unknown: '未知' },
    localOnly: '确认和归档仅更新 ShellBeam 本地记录，不会修改监控服务的异常事实或停止服务端通知。', alerts: '告警', relatedDiagnostics: '{count} 条关联诊断', noEvidence: '缺少事件证据 · 仅保留历史与审计', open: '未关闭',
  },
} as const
