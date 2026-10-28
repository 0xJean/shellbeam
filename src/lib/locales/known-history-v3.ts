export const knownHostsV3Copy = {
  en: {
    summary: '{n} verified hosts · fingerprints are recorded on first connect and checked on every later connection',
    search: 'Search host, address or fingerprint…',
    filterLabel: 'Filter known hosts', all: 'All', associated: 'Verified', unassociated: 'Unassociated',
    colHost: 'Host', colKeyType: 'Key type', colFingerprint: 'Fingerprint', colAdded: 'First recorded', colStatus: 'Status',
    verified: 'Verified', unassociatedHost: 'Not a saved host', unassociatedName: 'Unassociated',
    copy: 'Copy fingerprint', copied: 'Fingerprint copied',
  },
  'zh-CN': {
    summary: '已验证 {n} 台主机 · 首次连接时自动记录主机密钥指纹，之后每次连接都会校验',
    search: '搜索主机名、地址或指纹…',
    filterLabel: '筛选已知主机', all: '全部', associated: '已验证', unassociated: '未关联',
    colHost: '主机', colKeyType: '密钥类型', colFingerprint: '指纹', colAdded: '首次记录', colStatus: '状态',
    verified: '已验证', unassociatedHost: '未关联主机', unassociatedName: '未关联',
    copy: '复制指纹', copied: '已复制指纹',
  },
} as const

export const historyV3Copy = {
  en: {
    summary: 'Connection events (connect / disconnect / reconnect / auth failure / local terminal) merged with the operations audit · stored on this device only',
    tabEvents: 'Connections & operations', tabAudit: 'Operation records', tabAuditBadge: 'Audit', tabsLabel: 'History views',
    search: 'Search host, user or detail…', filterLabel: 'Filter by event', all: 'All', connection: 'Connections',
    today: 'Today', yesterday: 'Yesterday', count: '{n}',
    noMatch: 'No events match the current filter',
    heatmap: 'Connection activity', heatmapSub: 'Last {weeks} weeks', heatmapTotal: '{n} events', less: 'Less', more: 'More',
    heatmapCell: '{date}: {n} events',
    retention: 'Keeps the latest {activity} connection events and {audit} operation records',
    week: 'This week', weekSub: 'Last 7 days', weekTotal: '{n} events', weekDelta: '{n} the 7 days before',
    topHosts: 'Most connected', topHostsSub: '7 days', topHostsEmpty: 'No connections in the last 7 days',
    attention: 'Needs attention', attentionSub: '7 days', authFails: 'Authentication failures', opsFailed: 'Failed operations', opsUnknown: 'Operations with unknown result',
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  'zh-CN': {
    summary: '连接事件（连接 / 断开 / 重连 / 认证失败 / 本地终端）与运维审计合并显示 · 仅保存在本机',
    tabEvents: '连接与操作', tabAudit: '运维记录', tabAuditBadge: '审计', tabsLabel: '历史记录视图',
    search: '搜索主机、用户或详情…', filterLabel: '按事件筛选', all: '全部', connection: '连接',
    today: '今天', yesterday: '昨天', count: '{n} 条',
    noMatch: '没有符合当前筛选的记录',
    heatmap: '连接活跃度', heatmapSub: '最近 {weeks} 周', heatmapTotal: '共 {n} 次', less: '少', more: '多',
    heatmapCell: '{date}：{n} 次',
    retention: '本机保留最近 {activity} 条连接事件和 {audit} 条运维记录',
    week: '本周活动', weekSub: '最近 7 天', weekTotal: '{n} 次', weekDelta: '前 7 天 {n} 次',
    topHosts: '最常连接', topHostsSub: '7 天', topHostsEmpty: '最近 7 天没有连接',
    attention: '需要关注', attentionSub: '7 天', authFails: '认证失败', opsFailed: '失败的运维任务', opsUnknown: '结果未知的运维任务',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
  },
} as const
