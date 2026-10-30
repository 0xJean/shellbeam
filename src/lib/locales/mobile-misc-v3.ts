export const mobileMiscV3Copy = {
  en: {
    settings: {
      title: 'Settings', back: 'Settings', unlocked: 'Unlocked', locked: 'Locked',
      vaultSummary: '{status} · {hosts} hosts · {secrets} secrets',
      appearance: 'Appearance', terminal: 'Terminal', security: 'Security', more: 'More',
      theme: 'Theme', language: 'Language', font: 'Font', fontSize: 'Font size', connection: 'Connection & reconnect',
      autoLock: 'Auto-lock', minutes: '{n} min', vaults: 'Vaults & security events',
    },
    files: {
      select: 'Select', selectAll: 'Select all', deselectAll: 'Deselect all', done: 'Done', selected: '{n} selected',
      download: 'Download', upload: 'Upload', move: 'Move', rename: 'Rename', delete: 'Delete',
      moveTo: 'Move to folder', newName: 'New name', confirm: 'Confirm', cancel: 'Cancel', actions: 'Actions for selected items',
    },
    deploys: { back: 'Deployments' },
  },
  'zh-CN': {
    settings: {
      title: '设置', back: '设置', unlocked: '已解锁', locked: '已锁定',
      vaultSummary: '{status} · {hosts} 台主机 · {secrets} 项机密',
      appearance: '外观', terminal: '终端', security: '安全', more: '更多',
      theme: '主题', language: '语言', font: '字体', fontSize: '字号', connection: '连接与重连',
      autoLock: '自动锁定', minutes: '{n} 分钟', vaults: '保管库与安全事件',
    },
    files: {
      select: '选择', selectAll: '全选', deselectAll: '取消全选', done: '完成', selected: '已选择 {n} 项',
      download: '下载', upload: '上传', move: '移动', rename: '重命名', delete: '删除',
      moveTo: '移动到目录', newName: '新名称', confirm: '确定', cancel: '取消', actions: '对所选项目的操作',
    },
    deploys: { back: '部署项目' },
  },
} as const
