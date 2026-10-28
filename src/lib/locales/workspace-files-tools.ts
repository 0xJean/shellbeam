export const workspaceFilesCopy = {
  en: {
    title: 'File system', subtitle: 'Browse and edit remote files · double-click a file to edit it; Markdown / HTML can be previewed in the browser',
    editSubtitle: 'Editing {path} · UTF-8 text files only', recent: 'Recent',
    sftpHintBefore: 'To change permissions, upload or download, use ', sftpHintLink: 'SFTP file transfer', sftpHintAfter: '.',
    edit: 'Edit', cancel: 'Cancel', unsaved: 'Unsaved', saveNote: 'Saving shows a change review first and is recorded in the audit log',
    previewOnly: 'Only .md / .html files can be previewed', modified: 'Modified', cursor: 'Line {line} · UTF-8 · {eol}',
  },
  'zh-CN': {
    title: '文件系统', subtitle: '浏览与编辑远程文件 · 双击文件即可编辑，Markdown / HTML 可在浏览器中预览',
    editSubtitle: '编辑 {path} · 仅支持 UTF-8 文本文件', recent: '最近',
    sftpHintBefore: '修改权限、上传和下载请使用 ', sftpHintLink: 'SFTP 文件传输', sftpHintAfter: '。',
    edit: '编辑', cancel: '取消', unsaved: '未保存', saveNote: '保存前会显示变更确认并写入审计',
    previewOnly: '仅 .md / .html 支持预览', modified: '修改', cursor: '第 {line} 行 · UTF-8 · {eol}',
  },
} as const

export const workspaceToolsCopy = {
  en: {
    title: 'Tool manager', summary: '{host} · {total} tools, {checked} checked, {installed} installed',
    scanNote: 'A scan silently checks only the first 24 visible tools', notChecked: 'Not checked',
    installMethod: 'Install method', checkedAt: 'Checked', close: 'Close',
    serviceRisk: 'start / enable low risk · stop / restart / disable high risk',
  },
  'zh-CN': {
    title: '工具管理', summary: '{host} · {total} 个工具，已检查 {checked} 个，已安装 {installed} 个',
    scanNote: '扫描只静默检查前 24 个可见工具', notChecked: '未检查',
    installMethod: '安装方式', checkedAt: '检查于', close: '关闭',
    serviceRisk: '启动/启用 低风险 · 停止/重启/禁用 高风险',
  },
} as const
