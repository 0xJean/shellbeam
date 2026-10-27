export const probeInstallCopy = {
  en: {
    entry: 'Install probe', entryHint: 'Uses SSH sampling now. Install the ShellBeam Monitoring Agent for continuous history and offline alerts.',
    title: 'Install monitoring probe', stepOf: 'Step {current} of 4',
    steps: { server: 'Monitoring service', node: 'Link node', check: 'Check host', install: 'Install and verify' },
    stepHints: { server: 'Connect ShellBeam Server', node: 'Map a node to this host', check: 'System, permissions, network', install: 'Signed release' },
    railNote: 'Finished steps are skipped. A failing step stops here and does not change the host.',
    serverTitle: 'Connect ShellBeam Server first', serverBody: 'The probe reports to your own ShellBeam Server. Connect it once in Settings and every host can install directly.', openSettings: 'Open Settings · Monitoring', serverRecheck: 'I have connected it',
    nodeTitle: 'Link a monitoring node to {host}', nodeBody: 'Pick the ShellBeam Server node this host will report as. Saving the link does not install anything.',
    modeTitle: 'Switch {host} to server monitoring', modeBody: 'Installing needs the monitoring mode “ShellBeam Server + own probe”. SSH sampling stops for this host once the probe reports.', switchMode: 'Switch monitoring mode',
    checkTitle: 'Check {host}', checkBody: 'Read-only over SSH. Nothing on the host is changed.', runCheck: 'Run check', rerun: 'Check again', checking: 'Checking over SSH…',
    checks: { ssh: 'SSH connection', system: 'Operating system and systemd', account: 'Account permissions', existing: 'Existing probe', server: 'Monitoring service', node: 'Monitoring node', release: 'Signed release' },
    checkFailed: { ssh: 'Could not connect or the host key changed.', system: 'This host is not a supported Linux system with systemd and Python 3.9+.', account: 'This account needs a user service manager (linger) so the probe survives reboots. Run on the host: sudo loginctl enable-linger {user}', existing: 'Another monitoring agent is already reporting for this node.', server: 'The monitoring service rejected the request or is unreachable.', node: 'The node link changed. Link a node again.', release: 'No trusted signed release is available.' },
    planTitle: 'After you confirm', planDownload: 'Download the signed ShellBeam Monitoring Agent {version} and verify publisher and checksum', planWrite: 'Install as a {scope} under {dir}', planReport: 'Wait for the first report from node {node}',
    system: 'system service', user: 'user service', via: 'via {transport} · account {account}',
    risk: 'High risk: writes files on the host and registers a service', install: 'Confirm and install', installing: 'Installing…',
    doneTitle: 'Probe is online on {host}', doneBody: 'History and offline alerts are recorded from now on.', failedTitle: 'Installation did not finish', pendingTitle: 'Result pending verification',
    details: 'Operations details', close: 'Close', cancel: 'Cancel', back: 'Back', code: 'Code',
  },
  'zh-CN': {
    entry: '安装探针', entryHint: '当前为 SSH 无探针扫描。安装 ShellBeam 监控探针后可持续记录历史，主机离线也会告警。',
    title: '安装监控探针', stepOf: '第 {current} 步，共 4 步',
    steps: { server: '监控服务', node: '关联节点', check: '检查主机', install: '安装并验证' },
    stepHints: { server: '连接 ShellBeam Server', node: '为这台主机关联节点', check: '系统、权限、网络', install: '签名版本' },
    railNote: '已完成的步骤会自动跳过；任何一步失败都停在原处，不会改动主机。',
    serverTitle: '先连接 ShellBeam Server', serverBody: '探针把数据上报到你自己的 ShellBeam Server。在设置里连接一次，之后所有主机都可以直接安装。', openSettings: '打开设置 · 监控与通知', serverRecheck: '我已连接，重新检查',
    nodeTitle: '为 {host} 关联监控节点', nodeBody: '选择这台主机上报时使用的 ShellBeam Server 节点。保存关联不会安装任何东西。',
    modeTitle: '把 {host} 切换为 Server 监控', modeBody: '安装探针需要监控方式为「ShellBeam Server + 自有探针」。探针开始上报后，这台主机不再用 SSH 临时采样。', switchMode: '切换监控方式',
    checkTitle: '检查 {host}', checkBody: '通过 SSH 只读检查，不会改动主机。', runCheck: '开始检查', rerun: '重新检查', checking: '正在通过 SSH 检查…',
    checks: { ssh: 'SSH 连接', system: '操作系统与 systemd', account: '账号权限', existing: '已有探针', server: '监控服务', node: '监控节点', release: '签名版本' },
    checkFailed: { ssh: '无法连接，或主机密钥已变化。', system: '这台主机不是受支持的 Linux（需要 systemd 和 Python 3.9 以上）。', account: '这个账号需要启用用户服务（linger），探针才能在重启后运行。请在主机上执行：sudo loginctl enable-linger {user}', existing: '已有其他监控探针在为这个节点上报。', server: '监控服务拒绝了请求或无法访问。', node: '节点关联已变化，请重新关联。', release: '没有可信的签名版本。' },
    planTitle: '确认后将执行', planDownload: '下载签名的 ShellBeam 监控探针 {version}，核验发布者与校验和', planWrite: '以{scope}安装到 {dir}', planReport: '等待节点 {node} 的首次上报',
    system: '系统服务', user: '用户服务', via: '{transport} · 账号 {account}',
    risk: '高风险操作：会在远端写入文件并注册系统服务', install: '确认并安装', installing: '正在安装…',
    doneTitle: '{host} 的探针已上线', doneBody: '历史曲线和离线告警从现在开始记录。', failedTitle: '安装没有完成', pendingTitle: '执行结果待核验',
    details: '运维详情', close: '关闭', cancel: '取消', back: '返回', code: '错误码',
  },
} as const

export function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}
