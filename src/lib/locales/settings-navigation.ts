export const settingsNavigationCopy = {
  en: {
    navigation: 'Settings categories', general: 'General', connection: 'Connections & terminal',
    monitoring: 'Monitoring & notifications', integrations: 'Integrations', advanced: 'Advanced',
    optionalKomari: 'Optionally connect ShellBeam Server for continuous data on associated hosts. Your connection and SSH workflows remain available independently.',
    addSource: 'Add monitoring service', closeEditor: 'Back to monitoring services', savedSources: 'Saved monitoring services',
    editSource: 'Select a service to manage its connection, host associations and delivery settings.',
    enabled: 'Collection enabled', paused: 'Collection paused',
  },
  'zh-CN': {
    navigation: '设置分类', general: '常规', connection: '连接与终端',
    monitoring: '监控与通知', integrations: '集成', advanced: '高级',
    optionalKomari: '按需接入 ShellBeam Server，为关联主机持续采集数据。原有连接及 SSH 运维流程可独立使用。',
    addSource: '添加监控服务', closeEditor: '返回监控服务列表', savedSources: '已保存的监控服务',
    editSource: '选择服务，管理连接、主机关联与通知投递。',
    enabled: '已启用采集', paused: '已暂停采集',
  },
} as const
