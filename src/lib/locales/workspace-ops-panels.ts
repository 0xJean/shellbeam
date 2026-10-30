export const workspaceOpsPanelsCopy = {
  en: {
    docker: {
      title: 'Docker', summary: '{count} containers · start / stop / restart need confirmation and verified results',
      container: 'Container', image: 'Image', status: 'Status', ports: 'Ports', actions: 'Actions',
      logsTitle: '{name} · logs', outputTitle: '{name} · output', readOnly: 'read-only',
    },
    ssl: {
      summary: 'Scan sites and certificates · config tests, reloads and renewals need confirmation', lastScan: 'Last scan {time}',
      root: 'Root', config: 'Config', daysLeft: '{count} days left', daysAgo: 'Expired {count} days ago', expiresOn: 'Expires {date}', output: 'Output',
    },
    cron: {
      summary: 'Run on schedule by ShellBeam on this device over SSH · follows the host SSH / ProxyJump route · pauses while the app is closed or the vault is locked',
      every: 'Every {count} min', next: 'Next {time}', startedAt: 'Started {time}', paused: 'Paused', last: 'Last {time} · {status}', neverRun: 'Not run yet',
      authorization: 'Authorization {job}', addTitle: 'Add task', addNote: 'New tasks start disabled; enabling asks for one authorization confirmation that is recorded. Unknown results disable the task automatically.',
      intervalRange: '1–10080', output: 'Output',
    },
  },
  'zh-CN': {
    docker: {
      title: 'Docker', summary: '{count} 个容器 · 启动 / 停止 / 重启需要确认并核验结果',
      container: '容器', image: '镜像', status: '状态', ports: '端口', actions: '操作',
      logsTitle: '{name} · 日志', outputTitle: '{name} · 输出', readOnly: '只读',
    },
    ssl: {
      summary: '扫描站点与证书 · 测试、重载与续期都需要确认', lastScan: '上次扫描 {time}',
      root: '根目录', config: '配置', daysLeft: '剩余 {count} 天', daysAgo: '已过 {count} 天', expiresOn: '到期 {date}', output: '输出',
    },
    cron: {
      summary: '由 ShellBeam 在本机按计划通过 SSH 执行 · 沿用主机 SSH / ProxyJump 路径 · 应用关闭或保管库锁定时暂停',
      every: '每 {count} 分钟', next: '下次 {time}', startedAt: '本次开始于 {time}', paused: '已暂停', last: '上次 {time} · {status}', neverRun: '尚未运行',
      authorization: '授权 {job}', addTitle: '添加任务', addNote: '新任务默认停用；启用时会请求一次授权确认并记录。结果未知时会自动停用。',
      intervalRange: '1–10080', output: '输出',
    },
  },
} as const
