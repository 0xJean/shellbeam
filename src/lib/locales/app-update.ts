export const appUpdateCopy = {
  en: {
    available: 'ShellBeam {version} is available', viewRelease: 'View release', dismiss: 'Dismiss this version',
    openFailed: 'Could not open the browser. The release is on GitHub: 0xJean/shellbeam.',
    title: 'Updates', version: 'Version', upToDate: 'You are on the latest version.', notChecked: 'Not checked yet.',
    checkFailed: 'Could not check right now. Try again later.', checking: 'Checking…', checkNow: 'Check for updates',
    autoCheck: 'Check automatically', autoCheckDesc: 'Checks when ShellBeam starts and every 12 hours, and only reminds you. Nothing is installed for you.',
    privacy: 'A check asks GitHub for the latest release of ShellBeam. GitHub sees your IP address and the request time. No hosts, vault data, usage data or app version are sent.',
    testFlight: 'Updates for iOS arrive through TestFlight. This build does not contact GitHub.',
  },
  'zh-CN': {
    available: 'ShellBeam {version} 已发布', viewRelease: '查看发布页', dismiss: '忽略此版本',
    openFailed: '无法打开浏览器。可在 GitHub 的 0xJean/shellbeam 查看发布页。',
    title: '更新', version: '版本', upToDate: '已是最新版本。', notChecked: '尚未检查。',
    checkFailed: '暂时无法检查，请稍后再试。', checking: '正在检查…', checkNow: '检查更新',
    autoCheck: '自动检查', autoCheckDesc: '在 ShellBeam 启动时及每 12 小时检查一次，只作提醒，不会自动安装。',
    privacy: '检查时会向 GitHub 查询 ShellBeam 的最新发布。GitHub 能看到你的 IP 地址和请求时间；主机、保险库数据、使用数据及应用版本都不会发送。',
    testFlight: 'iOS 版通过 TestFlight 更新，此版本不会连接 GitHub。',
  },
} as const
