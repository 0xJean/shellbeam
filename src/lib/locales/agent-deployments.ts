export const agentDeploymentsCopy = {
  en: {
    viewLabel: 'Deployment source', scanView: 'Asset discovery', all: 'All', directory: 'Deploy directory', copyPath: 'Copy path', copied: 'Copied',
    openTerminal: 'Open terminal here', openSftp: 'Open in SFTP',
    crossCheck: 'Asset scan', dirFound: 'Directory found', dirMissing: 'Not seen by the last scan', notScanned: 'Host not scanned yet', scannedAt: 'scanned {time}',
    source: 'Source', repository: 'Repository', ref: 'Branch / ref', commit: 'Commit', artifact: 'Artifact',
    runtime: 'Runtime', language: 'Language', processManager: 'Process manager', entrypoint: 'Entry point', service: 'Service / container', ports: 'Ports',
    components: 'Components and paths', componentsHint: '{count} · paths supplied by the agent', dependencies: 'Dependencies', notes: 'Agent notes',
    registered: 'Registered by {agent} over MCP · first {created} · updated {updated}', unknownAgent: 'an agent',
    footnote: 'Metadata submitted by an agent over MCP and stored only on this device. ShellBeam did not perform or verify this deployment; verification older than 24 hours shows as expired.',
    select: 'Select a deployment to see its directory and details.',
  },
  'zh-CN': {
    viewLabel: '部署来源', scanView: '资产发现', all: '全部', directory: '部署目录', copyPath: '复制路径', copied: '已复制',
    openTerminal: '在此目录打开终端', openSftp: '在 SFTP 中打开',
    crossCheck: '与资产扫描核对', dirFound: '目录存在', dirMissing: '最近一次扫描未发现该目录', notScanned: '主机尚未扫描', scannedAt: '扫描于 {time}',
    source: '来源', repository: '仓库', ref: '分支 / ref', commit: '提交', artifact: '制品',
    runtime: '运行时', language: '语言', processManager: '进程管理', entrypoint: '入口', service: '服务 / 容器', ports: '端口',
    components: '组件与目录', componentsHint: '{count} 个 · 路径由 Agent 提供', dependencies: '依赖', notes: 'Agent 备注',
    registered: '由 {agent} 通过 MCP 登记 · 首次 {created} · 更新于 {updated}', unknownAgent: 'Agent',
    footnote: '以上是 Agent 通过 MCP 提交的元数据，仅保存在本机。ShellBeam 没有执行、也没有验证这次部署；验证超过 24 小时会标为「验证已过期」。',
    select: '选择一个部署，查看目录和详情。',
  },
} as const
