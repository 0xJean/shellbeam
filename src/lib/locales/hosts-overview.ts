export const hostsOverviewCopy = {
  en: {
    online: 'Online hosts', onlineSub: '{offline} offline · {stale} stale', onlineAll: 'All reachable',
    alerts: 'Open alerts', alertsNone: 'Nothing needs attention', alertsSub: 'Open the alert center',
    cpu: 'Average CPU', cpuSub: 'Peak {value}% · {host}', disk: 'Average disk', diskSub: 'Highest {value}% · {host}', noData: 'No samples yet',
    bannerTitle: '{count} hosts have no monitoring probe', bannerBody: 'They rely on SSH sampling, so data exists only while connected. The ShellBeam Monitoring Agent keeps history and alerts when a host goes offline.',
    bannerLater: 'Later', bannerInstall: 'Install on hosts', bannerMore: 'First {count} hosts; install the rest afterwards.',
    drawerAlerts: 'Alerts', drawerLocal: 'Local open', drawerSource: 'Data source', drawerTasks: 'Ops tasks',
    selected: '{count} selected', installProbe: 'Install probe', exitBatch: 'Exit batch selection',
  },
  'zh-CN': {
    online: '在线主机', onlineSub: '{offline} 台离线 · {stale} 台数据陈旧', onlineAll: '全部可连接',
    alerts: '活跃告警', alertsNone: '暂无需要处理的告警', alertsSub: '打开告警中心',
    cpu: '平均 CPU', cpuSub: '峰值 {value}% · {host}', disk: '平均磁盘', diskSub: '最高 {value}% · {host}', noData: '暂无采样',
    bannerTitle: '{count} 台主机还没有监控探针', bannerBody: '目前靠 SSH 临时扫描，连接时才有数据。装上 ShellBeam 监控探针后可持续记录历史曲线，主机离线也会告警。',
    bannerLater: '稍后', bannerInstall: '批量安装', bannerMore: '先安装前 {count} 台，其余稍后再装。',
    drawerAlerts: '告警', drawerLocal: '本地未关闭', drawerSource: '数据源', drawerTasks: '运维任务',
    selected: '已选 {count} 台', installProbe: '安装探针', exitBatch: '退出批量选择',
  },
} as const
