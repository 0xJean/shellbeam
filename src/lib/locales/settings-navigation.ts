export const settingsNavigationCopy = {
  en: {
    navigation: 'Settings categories', general: 'General', connection: 'Connections & terminal',
    monitoring: 'Monitoring & notifications', integrations: 'Integrations', advanced: 'Advanced',
    optionalKomari: 'Optionally connect Komari for monitoring data on associated hosts. Terminal, SFTP, forwarding and SSH monitoring work without a Komari connection.',
    addSource: 'Add data source', closeEditor: 'Back to data sources', savedSources: 'Saved data sources',
    editSource: 'Select a data source to manage its connection and host associations.',
    enabled: 'Sync enabled', paused: 'Sync paused',
  },
  'zh-CN': {
    navigation: '设置分类', general: '常规', connection: '连接与终端',
    monitoring: '监控与通知', integrations: '集成', advanced: '高级',
    optionalKomari: '按需接入 Komari，为关联主机提供监控数据。终端、SFTP、端口转发及 SSH 监控均可独立使用。',
    addSource: '添加数据源', closeEditor: '返回数据源列表', savedSources: '已保存的数据源',
    editSource: '选择数据源，管理连接设置和主机关联。',
    enabled: '已启用同步', paused: '已暂停同步',
  },
} as const
