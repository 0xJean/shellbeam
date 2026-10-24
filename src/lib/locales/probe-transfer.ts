export const probeTransferCopy = {
  'zh-CN': {
    phases: { reserved: '已锁定来源', staged: '目标文件已准备', stopping: '正在停止来源', stopped: '来源已停止', activating: '正在启动目标', activated: '目标已启动', resuming: '正在恢复来源', 'rolled-back': '已恢复原状态', completed: '切换已确认' },
    readFailed: '无法读取已保存的迁移状态。请先重新读取，再进行更改。', reload: '重新读取迁移状态', running: '上次核验时进程运行', stopped: '上次核验时进程已停止', unrecorded: '暂无迁移回执',
    title: '迁移到其他服务、机器或账号', hint: '选择主机目录中已保存的 SSH 连接和已关联的监控节点。目标须无托管部署，且未被其他探针上报；同一主机可以选择另一个连接或监控服务。',
    load: '选择迁移目标', target: '目标主机 · 连接 · 监控服务', endpoint: '目标探针可访问的监控地址', move: '检查并迁移', inspect: '只读检查两端', restore: '停止目标并恢复来源', finish: '核验并完成切换',
    confirm: '迁移会短暂中断监控：先准备目标文件，再停止来源并核验目标的新上报。使用目标节点自己的凭据；原节点、密钥、配置、版本文件和历史保留。跨服务的历史仍在原服务，不复制指标数据库。中断后不会自动重放；恢复来源前必须证明目标已停止。',
    source: '来源', destination: '目标', preserved: '原服务与节点历史保留。采集参数随迁移保留；跨机器请检查网卡、挂载点和自定义 IP 是否仍适用。默认 SSH 连接不变，后续探针管理使用所选连接。',
    completed: '迁移完成，目标进程和新上报已核验', restored: '来源已恢复，目标已停止', pending: '迁移尚未完成，请先只读检查，再选择完成切换或恢复来源', working: '正在核验两端…', failure: '迁移结果待核验；原数据与审计保留。请检查两端后继续。', empty: '暂无目标。请先在主机目录添加目标 SSH 连接，并关联监控节点。', audit: '迁移审计',
  },
  en: {
    phases: { reserved: 'Source reserved', staged: 'Target files prepared', stopping: 'Stopping source', stopped: 'Source stopped', activating: 'Starting target', activated: 'Target started', resuming: 'Restoring source', 'rolled-back': 'Original state restored', completed: 'Cutover confirmed' },
    readFailed: 'Saved migration state could not be read. Reload it before making changes.', reload: 'Reload migration state', running: 'Process running at last check', stopped: 'Process stopped at last check', unrecorded: 'No transfer receipt',
    title: 'Move to another service, machine or account', hint: 'Choose a saved SSH connection and linked monitoring node from the host directory. The destination must have no managed deployment or other reporting probe. A host can use another connection or monitoring service.',
    load: 'Choose destination', target: 'Destination host · connection · monitoring service', endpoint: 'Monitoring address reachable from the destination', move: 'Check and migrate', inspect: 'Inspect both endpoints', restore: 'Stop target and restore source', finish: 'Verify and finish cutover',
    confirm: 'Monitoring will pause briefly: stage target files, stop the source, then verify a fresh target report. Use the target node’s own credentials. Keep original nodes, keys, configuration, releases and history. Cross-service history stays at the original service; metrics databases are not copied. Interrupted writes are never replayed automatically. The target must be proven stopped before restoring the source.',
    source: 'Source', destination: 'Destination', preserved: 'Original service and node history is retained. Collection settings follow the migration; check NICs, mountpoints and custom IPs when moving machines. The default SSH connection is unchanged; probe management uses the selected connection.',
    completed: 'Migration complete; target process and fresh report verified', restored: 'Source restored; target stopped', pending: 'Migration is unfinished. Inspect both endpoints, then finish cutover or restore the source.', working: 'Verifying both endpoints…', failure: 'Migration needs verification. Original data and audit are retained. Inspect both endpoints before continuing.', empty: 'No destination available. Add a target SSH connection and link its monitoring node in the host directory.', audit: 'Migration audit',
  },
} as const
