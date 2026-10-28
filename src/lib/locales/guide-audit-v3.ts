export const guideAuditCopy = {
  en: {
    steps: '{count} steps', tours: 'Interactive tours',
    tourProgress: '{tour} · {progress}',
    tourHint: 'The page is locked during the tour; press Esc to exit. The tour ends automatically and explains why if the page, vault or a dialog changes.',
    auditTitle: 'Operations log', auditDescription: 'Remote operations started from the terminal, workspace, MCP and monitoring, with their audit trail, grouped by request',
    tabOperations: 'Operations', tabAudit: 'Audit', refresh: 'Refresh', sourceFilter: 'Source', statusFilter: 'Status',
    live: 'Live refresh (every 15 s) · paused while browsing history',
    page: 'Page {page} · {size} per page', onlyUnknown: 'Unknown only',
    colTime: 'Time', colEvent: 'Event', colAction: 'Action', colHost: 'Target host', colRequest: 'Request', colStatus: 'Status', colSummary: 'Summary',
  },
  'zh-CN': {
    steps: '{count} 步', tours: '交互式引导',
    tourProgress: '{tour} · {progress}',
    tourHint: '引导期间页面不可操作；按 Esc 退出。页面、保管库或弹窗状态变化时引导会自动结束并提示原因。',
    auditTitle: '运维记录', auditDescription: '终端、工作台、MCP 和监控发起的所有远端操作及其审计，按请求分组',
    tabOperations: '操作', tabAudit: '审计', refresh: '刷新', sourceFilter: '来源', statusFilter: '状态',
    live: '实时刷新（每 15 秒）· 翻看历史时暂停',
    page: '第 {page} 页 · 每页 {size} 条', onlyUnknown: '只看未知',
    colTime: '时间', colEvent: '事件', colAction: '操作', colHost: '目标主机', colRequest: '请求', colStatus: '状态', colSummary: '摘要',
  },
} as const
