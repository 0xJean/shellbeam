export const monitoringModeCopy = {
  'zh-CN': {
    title: '监控方式', ssh: 'SSH 无探针扫描', server: 'ShellBeam Server + 自有探针',
    sshHint: '默认方式。App 运行且保管库已解锁时，通过已有 SSH 连接扫描，不安装常驻探针。',
    serverHint: '可选。连接 ShellBeam Server、关联节点后，仍需单独确认安装已签名的自有探针。',
    next: '保存后到「设置 → 监控与通知 → ShellBeam 监控」连接服务并关联主机，再在主机「运维详情 → 监控探针」确认安装。已有连接和部署继续保留。',
    retained: '切回 SSH 仅改变本机监控方式，不停止远端探针或服务端通知。需要停止时，请单独确认卸载；关联、凭据、历史和审计均保留。',
    confirmServer: '选择 ShellBeam Server 监控？保存后可关联服务并管理自有探针。此选择不会连接新服务或安装探针；安装仍需单独确认。',
    confirmSsh: '切换到 SSH 无探针扫描？已有远端探针和服务端通知不会自动停止。监控关联、凭据、历史和审计保留，卸载需单独操作。',
    chooseFirst: '请先编辑主机，将监控方式选择为「ShellBeam Server + 自有探针」并确认保存。',
    importConfirm: '将此节点添加为使用 ShellBeam Server 的仅监控主机？不会创建 SSH 凭据或安装探针。',
  },
  en: {
    title: 'Monitoring mode', ssh: 'SSH agentless scanning', server: 'ShellBeam Server + owned probe',
    sshHint: 'Default. Scan over the existing SSH connection while the app is running and the Vault is unlocked. No resident probe is installed.',
    serverHint: 'Optional. Connect ShellBeam Server and link a node, then separately confirm installation of a signed, owned probe.',
    next: 'After saving, connect and link the host in Settings → Monitoring & notifications → ShellBeam monitoring. Confirm installation in the host’s Operations details → Monitoring probe. Existing connections and deployments are retained.',
    retained: 'Switching to SSH changes local monitoring only. Remote probes and server notifications keep running until separately managed. Uninstall requires confirmation; bindings, credentials, history and audit are retained.',
    confirmServer: 'Choose ShellBeam Server monitoring? After saving, you can link a service and manage an owned probe. This choice does not connect a new service or install a probe; installation requires separate confirmation.',
    confirmSsh: 'Switch to SSH agentless scanning? Existing remote probes and server notifications will not stop automatically. Bindings, credentials, history and audit are retained. Uninstall is a separate action.',
    chooseFirst: 'First edit this host, choose “ShellBeam Server + owned probe”, confirm and save.',
    importConfirm: 'Add this node as a monitoring-only host using ShellBeam Server? This does not create SSH credentials or install a probe.',
  },
} as const
