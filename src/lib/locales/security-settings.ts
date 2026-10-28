export const securitySettingsCopy = {
  en: {
    vaultTitle: 'Vault', vaultDesc: 'Hosts, keys, snippets and monitoring links are stored per vault, encrypted on this device.',
    unlocked: 'Unlocked', locked: 'Locked', lockNow: 'Lock now', active: 'Current',
    vaultsTitle: 'Vaults', vaultsDesc: 'Switch between separate sets of hosts and credentials, such as personal and a client.',
    switchTo: 'Switch', rename: 'Rename', save: 'Save', cancel: 'Cancel', remove: 'Delete', create: 'New vault', createPlaceholder: 'Vault name', defaultVault: 'Default',
    deleteConfirm: 'Delete vault “{name}”? Its hosts, keys, snippets and settings on this device are removed permanently.',
    deleteDefault: 'The default vault cannot be deleted.', nameRequired: 'Enter a vault name.', unlockFirst: 'Unlock the current vault first.',
    eventsTitle: 'Security events', eventsDesc: 'Unlocks, locks, failed attempts and other security-relevant actions on this device.', eventsEmpty: 'No security events recorded yet.', clear: 'Clear',
    level: { info: 'Info', warn: 'Warning', error: 'Error' },
  },
  'zh-CN': {
    vaultTitle: '保管库', vaultDesc: '主机、密钥、片段和监控关联按保管库分开存放，在本机加密保存。',
    unlocked: '已解锁', locked: '已锁定', lockNow: '立即锁定', active: '当前',
    vaultsTitle: '保管库列表', vaultsDesc: '在不同的主机与凭证集合之间切换，例如个人和客户 A。',
    switchTo: '切换', rename: '重命名', save: '保存', cancel: '取消', remove: '删除', create: '新建保管库', createPlaceholder: '保管库名称', defaultVault: '默认',
    deleteConfirm: '删除保管库「{name}」？它在本机的主机、密钥、片段和设置都会被永久删除。',
    deleteDefault: '默认保管库不能删除。', nameRequired: '请输入保管库名称。', unlockFirst: '请先解锁当前保管库。',
    eventsTitle: '安全事件', eventsDesc: '本机上的解锁、锁定、失败尝试等与安全相关的操作。', eventsEmpty: '还没有记录到安全事件。', clear: '清空',
    level: { info: '信息', warn: '警告', error: '错误' },
  },
} as const
