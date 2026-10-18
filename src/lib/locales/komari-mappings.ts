export const komariMappingCopy = {
  en: {
    title: 'Komari node mappings', description: 'Bind a node to one host in this Vault. Manual choices survive address changes and synchronization.',
    refresh: 'Discover nodes', loading: 'Loading mappings…', empty: 'No enabled Komari servers in this Vault.',
    loadFailed: 'Node discovery failed. Check the server, token and Vault; saved choices remain available.',
    saveFailed: 'The mapping could not be saved. Refresh and try again.', conflict: 'Mappings changed in another session. Discover nodes again before saving.',
    locked: 'Unlock this Vault to discover nodes or change mappings.', node: 'Node', host: 'Host', automatic: 'Automatic address matching',
    manual: 'Manual binding', matched: 'Address match', unmapped: 'Unmapped', ambiguous: 'Address matches multiple hosts; choose one explicitly.',
    missing: 'Node absent from the latest discovery; manual binding is retained.', unavailable: 'Saved node; current discovery is unavailable.',
    apply: 'Save binding', reset: 'Return to automatic', saving: 'Saving…', choose: 'Choose a host', noHosts: 'No hosts in this Vault.',
    hostMissing: 'Saved host is unavailable', occupied: 'already manually bound',
  },
  'zh-CN': {
    title: 'Komari 节点映射', description: '将节点绑定到当前 Vault 的一台主机。手动选择会在地址变化和后续同步中保留。',
    refresh: '发现节点', loading: '正在加载映射…', empty: '当前 Vault 没有已启用的 Komari 服务器。',
    loadFailed: '节点发现失败，请检查服务器、Token 和 Vault；已保存的绑定仍然保留。',
    saveFailed: '映射保存失败，请刷新后重试。', conflict: '其他会话已修改映射，请重新发现节点后再保存。',
    locked: '请解锁当前 Vault 后发现节点或修改映射。', node: '节点', host: '主机', automatic: '按地址自动匹配',
    manual: '手动绑定', matched: '地址匹配', unmapped: '未映射', ambiguous: '地址匹配到多台主机，请明确选择一台。',
    missing: '最近发现结果中没有此节点，手动绑定仍保留。', unavailable: '已保存的节点，当前无法完成发现。',
    apply: '保存绑定', reset: '恢复自动匹配', saving: '正在保存…', choose: '选择主机', noHosts: '当前 Vault 没有主机。',
    hostMissing: '已绑定的主机不可用', occupied: '已被手动绑定',
  },
} as const
