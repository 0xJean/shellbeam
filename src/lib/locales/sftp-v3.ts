export const sftpV3Copy = {
  en: {
    subtitle: 'Drop files onto the remote pane to upload · uploads, deletes, renames and permission changes always ask you first',
    uploadSelected: 'Upload {n} files', host: 'Remote host', local: 'Local', remote: 'Remote', refresh: 'Refresh', parentDir: 'Parent directory',
    dropHint: 'Release to upload {n} files to {dir}', dropHintAny: 'Release to upload to {dir}',
    queue: 'Transfer queue', queueEmpty: 'No transfers yet', clearFinished: 'Clear finished',
    summary: '{active} in progress · {done} done', summaryFailed: ' · {failed} failed',
    queued: 'Queued', running: 'Transferring', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
    upload: 'Upload', download: 'Download',
  },
  'zh-CN': {
    subtitle: '把文件拖到远程窗格即可上传 · 上传、删除、重命名、改权限前都会请你确认',
    uploadSelected: '上传 {n} 个文件', host: '远程主机', local: '本地', remote: '远程', refresh: '刷新', parentDir: '上级目录',
    dropHint: '松开以上传 {n} 个文件到 {dir}', dropHintAny: '松开以上传到 {dir}',
    queue: '传输队列', queueEmpty: '还没有传输任务', clearFinished: '清除已完成',
    summary: '{active} 个进行中 · {done} 个已完成', summaryFailed: ' · {failed} 个失败',
    queued: '排队中', running: '传输中', done: '完成', failed: '失败', cancelled: '已取消',
    upload: '上传', download: '下载',
  },
} as const

export type SftpV3Copy = (typeof sftpV3Copy)[keyof typeof sftpV3Copy]

export function sftpCopyFor(locale: string | undefined): SftpV3Copy {
  return sftpV3Copy[locale as keyof typeof sftpV3Copy] ?? sftpV3Copy['zh-CN']
}
