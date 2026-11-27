import type { Locale } from '@/lib/i18n'

export const companionCopy: Record<Locale, {
  title: string
  subtitle: string
  myDesktop: string
  connectDesktop: string
  connecting: string
  connected: string
  disconnected: string
  disconnect: string
  reconnect: string
  routeLan: string
  routeTailnet: string
  routeIroh: string
  routeCustom: string
  qrPairTitle: string
  qrPairDesc: string
  copyPairLink: string
  copied: string
  directConnectTitle: string
  directConnectPlaceholder: string
  directConnectAction: string
  directConnectHint: string
  permissionsTitle: string
  allowAiCli: string
  allowAiCliDesc: string
  allowTerminalView: string
  allowTerminalViewDesc: string
  allowTerminalControl: string
  allowTerminalControlDesc: string
  routesTitle: string
  addRoutePlaceholder: string
  addRouteAction: string
  remoteBridgeEnabled: string
  remoteBridgeToggleShort: string
  showQrAction: string
  hideQrAction: string
  linkPairTab: string
  qrPairTab: string
  startServerHint: string
  startServerAction: string
  showAllPeers: string
  collapsePeers: string
  connectedClientsBanner: string
  kickClient: string
  desktopCliReady: string
  activeDesktopSessions: string
  noDesktopSessions: string
  pendingApprovalBadge: string
  terminalTab: string
  aiTab: string
  fitPhoneWidth: string
  keepDesktopWidth: string
  approveAndRun: string
  stopGenerating: string
  sendFollowUpPlaceholder: string
  send: string
  readOnlyNotice: string
  remoteCliTag: string
  localApiGroup: string
  desktopCliGroup: string
  refreshSessions: string
  sessionClosed: string
  typeCommandPlaceholder: string
  navLabel: string
  pageSubtitle: string
  openCenter: string
  networkChannels: string
  tailscaleTip: string
  tailscaleDetected: string
  irohReadyHint: string
  cliCardTitle: string
  cliReadyCount: string
  cliInstalled: string
  cliNotInstalled: string
  sessionsCardTitle: string
  sessionsCount: string
  onlineClientsTitle: string
  noOnlineClients: string
  authorizedDevicesTitle: string
  noAuthorizedDevices: string
  initDeviceFirst: string
  initDeviceFirstClient: string
  syncBannerTitle: string
  syncBannerDesc: string
  syncBannerAction: string
  serverRunningBadge: string
  serverStoppedBadge: string
  revokeDevice: string
  quickPopoverHint: string
  qrUnavailable: string
  refreshStatus: string
  addRouteInline: string
  connectedNow: string
  openTerminal: string
  repairAction: string
  pairNewDesktop: string
  errRepairRequired: string
  errPeerNotFound: string
  errNoRoutes: string
  errBridgeDisabled: string
  errConnectionRefused: string
  errTimeout: string
  errUnreachable: string
  errIdentityMismatch: string
  errDisconnected: string
  errPermissionDenied: string
  errUnknown: string
  scanQrAction: string
  scanQrTitle: string
  scanQrHint: string
  scanQrCameraDenied: string
  scanQrUnsupported: string
  scanQrPickImage: string
  scanQrNotFound: string
  scanQrInvalidLink: string
  sessionStatusRunning: string
  sessionStatusConnecting: string
  sessionStatusClosed: string
  fromDesktop: string
  desktopWaitingHint: string
  aiTabShort: string
  terminalTabShort: string
  copyCommand: string
  rerunCommand: string
  executedBadge: string
  outputLines: string
  expandOutput: string
  collapseOutput: string
  explainOutput: string
  explainOutputPrompt: string
  nextStep: string
  nextStepPrompt: string
  modeConfirm: string
  modeAuto: string
  modeReadOnly: string
  aiThinking: string
  scrollToBottom: string
  localShellLabel: string
  aiEmptyHint: string
}> = {
  'zh-CN': {
    title: '手机直连电脑',
    subtitle: '端到端加密：同 Wi-Fi 自动走内网，跨网自动无感穿透',
    myDesktop: '我的电脑',
    connectDesktop: '直连电脑',
    connecting: '正在直连…',
    connected: '已直连',
    disconnected: '未连接',
    disconnect: '断开',
    reconnect: '重连',
    routeLan: '局域网',
    routeTailnet: 'Tailscale',
    routeIroh: '内置穿透',
    routeCustom: '自定义路由',
    qrPairTitle: '手机扫码 / 跨网直连配对',
    qrPairDesc: '二维码仅包含本机局域网与 Tailscale 地址，不含密钥；配对仍经 X25519 与 6 位确认码加密验证。',
    copyPairLink: '复制配对链接',
    copied: '已复制',
    directConnectTitle: '通过链接或 Tailscale IP 配对',
    directConnectPlaceholder: '粘贴 shellbeam://pair?... 或输入 100.x.x.x:9123',
    directConnectAction: '发起配对',
    directConnectHint: '支持局域网 IP、Tailscale IP / MagicDNS 或自定义端口。',
    permissionsTitle: '远程控制权限',
    allowAiCli: '调用本机 AI CLI',
    allowAiCliDesc: '允许该设备远程调用电脑已安装的 Claude Code / Codex / Cursor / Devin 等 CLI。',
    allowTerminalView: '查看实时终端与 AI 对话',
    allowTerminalViewDesc: '允许该设备镜像查看桌面端当前活跃的 SSH 终端输出与 AI 助手记录。',
    allowTerminalControl: '远程输入与批准执行',
    allowTerminalControlDesc: '允许该设备向桌面终端输入命令，或一键批准桌面 AI 待确认命令。',
    routesTitle: '可用路由（按优先级自动切换）',
    addRoutePlaceholder: '添加 Tailscale / 自定义地址（如 100.88.1.5:9123）',
    addRouteAction: '添加路由',
    remoteBridgeEnabled: '允许已配对手机直连控制本机',
    remoteBridgeToggleShort: '允许手机直连',
    showQrAction: '扫码 / 跨网配对',
    hideQrAction: '收起',
    linkPairTab: '输入链接 / IP',
    qrPairTab: '本机二维码',
    startServerHint: '同步服务尚未启动，启动后手机即可扫码或通过 Tailscale 直连本机。',
    startServerAction: '立即启动服务',
    showAllPeers: '展开全部 {n} 台设备',
    collapsePeers: '收起设备列表',
    connectedClientsBanner: '{name} 已直连本机',
    kickClient: '断开',
    desktopCliReady: '{count} 个电脑 AI CLI 可用',
    activeDesktopSessions: '电脑端活跃会话',
    noDesktopSessions: '电脑端当前没有打开的 SSH 或终端会话',
    pendingApprovalBadge: '待确认命令',
    terminalTab: '终端镜像',
    aiTab: 'AI 接管',
    fitPhoneWidth: '适配手机屏宽',
    keepDesktopWidth: '保持桌面列宽',
    approveAndRun: '批准并在电脑运行',
    stopGenerating: '停止生成',
    sendFollowUpPlaceholder: '向电脑端 AI 助手继续提问或下达下一步…',
    send: '发送',
    readOnlyNotice: '桌面端未授予远程输入权限，当前为只读镜像。',
    remoteCliTag: '经由 {name}',
    localApiGroup: '本机 API 模型',
    desktopCliGroup: '电脑本地 AI CLI',
    refreshSessions: '刷新会话',
    sessionClosed: '会话已结束',
    typeCommandPlaceholder: '输入命令并发送到电脑终端…',
    navLabel: '手机直连',
    pageSubtitle: '手机扫码或通过 Tailscale 端到端加密直连本机，远程调用电脑本地 AI CLI，并随时接管桌面终端与 AI 对话。',
    openCenter: '打开手机直连中心',
    networkChannels: '可用直连通道',
    tailscaleTip: '启动服务后自动启用内置 P2P 穿透，跨网 / 5G 无需安装任何第三方软件。',
    tailscaleDetected: '已检测到 Tailscale，支持内网 → Tailscale → 内置穿透自动切换',
    irohReadyHint: '内置 P2P 穿透与加密中继已就绪：同 Wi-Fi 秒连内网，出门 5G 自动无感穿透。',
    cliCardTitle: '本机 AI CLI 就绪状态',
    cliReadyCount: '{ready} / {total} 可用',
    cliInstalled: '已就绪',
    cliNotInstalled: '未安装',
    sessionsCardTitle: '可接管的桌面会话',
    sessionsCount: '{count} 个活跃',
    onlineClientsTitle: '当前在线直连手机',
    noOnlineClients: '暂无手机在线连接',
    authorizedDevicesTitle: '已授权设备与权限',
    noAuthorizedDevices: '还没有已配对的手机。使用手机端 ShellBeam 扫码或粘贴配对链接，完成 X25519 + 6 位确认码加密配对。',
    initDeviceFirst: '先初始化本机设备身份，即可生成配对二维码并接受手机直连。',
    initDeviceFirstClient: '先初始化本机设备身份，即可扫码或输入连接码直连你的电脑。',
    syncBannerTitle: '手机直连已升级为独立中心',
    syncBannerDesc: '扫码配对、远程调用电脑 AI CLI、接管桌面终端与权限管理均在「手机直连」页面。',
    syncBannerAction: '前往手机直连',
    serverRunningBadge: '监听 :{port}',
    serverStoppedBadge: '服务未启动',
    revokeDevice: '取消信任',
    quickPopoverHint: '手机端 ShellBeam 扫码或粘贴链接即可直连本机',
    qrUnavailable: '暂未检测到可用局域网或 Tailscale 地址',
    refreshStatus: '刷新状态',
    addRouteInline: '添加路由',
    connectedNow: '直连中',
    openTerminal: '进入终端',
    repairAction: '去重新配对',
    pairNewDesktop: '配对',
    errRepairRequired: '该设备配对记录为旧版本或已失效，请重新扫码或粘贴配对链接完成加密配对。',
    errPeerNotFound: '未找到该已信任设备，请重新配对。',
    errNoRoutes: '未配置可用的电脑地址，请重新配对或添加局域网 / Tailscale 路由。',
    errBridgeDisabled: '电脑端未开启「允许手机直连」，请在电脑「手机直连」页面打开开关。',
    errConnectionRefused: '无法连接到电脑（连接被拒绝）。请确认电脑端已启动同步服务，且与手机在同一网络或已连接 Tailscale。',
    errTimeout: '连接电脑超时。电脑的局域网 IP 可能已变化，请重新配对或检查 Tailscale 连接。',
    errUnreachable: '网络不可达或无法解析电脑地址，请确认双方已接入同一 Wi-Fi 或 Tailscale。',
    errIdentityMismatch: '目标地址对应的电脑身份校验不匹配，出于安全考虑已拒绝连接。',
    errDisconnected: '与电脑的直连已断开，请重新点击「直连电脑」。',
    errPermissionDenied: '电脑端未授予该远程操作权限，请在电脑「手机直连」页面开启对应权限。',
    errUnknown: '直连失败：{detail}',
    scanQrAction: '扫码配对',
    scanQrTitle: '扫描电脑配对二维码',
    scanQrHint: '将电脑端「手机直连」页面的二维码放入框内即可自动识别配对',
    scanQrCameraDenied: '未获得相机权限，请在系统设置中允许 ShellBeam 使用相机，或点击下方从相册/拍照识别。',
    scanQrUnsupported: '当前设备暂不支持实时取景扫码，请点击下方拍照或从相册选择二维码图片。',
    scanQrPickImage: '拍照 / 从相册识别二维码',
    scanQrNotFound: '未在图片中识别到二维码，请换一张清晰截图或对准重拍。',
    scanQrInvalidLink: '该二维码不是 ShellBeam 配对码，请扫描电脑「手机直连」页面的二维码。',
    sessionStatusRunning: '运行中',
    sessionStatusConnecting: '连接中',
    sessionStatusClosed: '已结束',
    fromDesktop: '来自 {name}',
    desktopWaitingHint: '电脑端打开 SSH 或本地终端后会自动同步到这里',
    aiTabShort: 'AI',
    terminalTabShort: '终端',
    copyCommand: '复制',
    rerunCommand: '再次执行',
    executedBadge: '已完成',
    outputLines: '输出 · {count} 行',
    expandOutput: '展开',
    collapseOutput: '收起',
    explainOutput: '解释输出',
    explainOutputPrompt: '请简明解释上一条命令的输出结果，并指出关键异常。',
    nextStep: '下一步',
    nextStepPrompt: '基于刚才的结果，给出下一步最合理的排查或操作命令。',
    modeConfirm: '确认执行',
    modeAuto: '连续执行',
    modeReadOnly: '仅建议',
    aiThinking: 'AI 思考中…',
    scrollToBottom: '回到底部',
    localShellLabel: '本机终端',
    aiEmptyHint: '在下方输入需求，即可远程驱动电脑端 AI 助手分析当前会话或执行命令。',
  },
  en: {
    title: 'Desktop Companion Bridge',
    subtitle: 'E2EE bridge: auto LAN on same Wi-Fi, seamless P2P off-LAN',
    myDesktop: 'My Desktop',
    connectDesktop: 'Connect Desktop',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    disconnect: 'Disconnect',
    reconnect: 'Reconnect',
    routeLan: 'LAN',
    routeTailnet: 'Tailscale',
    routeIroh: 'Built-in P2P',
    routeCustom: 'Custom',
    qrPairTitle: 'Mobile QR & Tailscale Pairing',
    qrPairDesc: 'QR carries only LAN and Tailscale addresses (no secrets). Pairing still uses X25519 and 6-digit SAS verification.',
    copyPairLink: 'Copy Pairing Link',
    copied: 'Copied',
    directConnectTitle: 'Pair via Link or Tailscale IP',
    directConnectPlaceholder: 'Paste shellbeam://pair?... or enter 100.x.x.x:9123',
    directConnectAction: 'Pair',
    directConnectHint: 'Supports LAN IP, Tailscale IP / MagicDNS, or custom host:port.',
    permissionsTitle: 'Remote Bridge Permissions',
    allowAiCli: 'Run Desktop AI CLIs',
    allowAiCliDesc: 'Allow this device to invoke Claude Code, Codex, Cursor, Devin, Gemini, or OpenCode installed on this computer.',
    allowTerminalView: 'View Live Terminals & AI Chats',
    allowTerminalViewDesc: 'Allow this device to mirror active desktop SSH terminals and AI assistant conversations.',
    allowTerminalControl: 'Remote Input & Command Approval',
    allowTerminalControlDesc: 'Allow this device to type into desktop terminals and approve pending desktop AI commands.',
    routesTitle: 'Saved Routes (auto-selected by priority)',
    addRoutePlaceholder: 'Add Tailscale or custom host:port (e.g. 100.88.1.5:9123)',
    addRouteAction: 'Add Route',
    remoteBridgeEnabled: 'Allow paired mobile devices to bridge to this computer',
    remoteBridgeToggleShort: 'Allow phone bridge',
    showQrAction: 'QR / Direct Pair',
    hideQrAction: 'Hide',
    linkPairTab: 'Link / IP',
    qrPairTab: 'My QR Code',
    startServerHint: 'Sync server is stopped. Start it so your phone can pair via QR or Tailscale.',
    startServerAction: 'Start Server',
    showAllPeers: 'Show all {n} devices',
    collapsePeers: 'Show fewer',
    connectedClientsBanner: '{name} connected to this computer',
    kickClient: 'Disconnect',
    desktopCliReady: '{count} desktop AI CLIs ready',
    activeDesktopSessions: 'Active Desktop Sessions',
    noDesktopSessions: 'No active SSH or terminal sessions on desktop',
    pendingApprovalBadge: 'Approval needed',
    terminalTab: 'Terminal Mirror',
    aiTab: 'AI Handoff',
    fitPhoneWidth: 'Fit Phone Width',
    keepDesktopWidth: 'Keep Desktop Width',
    approveAndRun: 'Approve & Run on Desktop',
    stopGenerating: 'Stop',
    sendFollowUpPlaceholder: 'Send a follow-up to desktop AI assistant…',
    send: 'Send',
    readOnlyNotice: 'Remote control is disabled on desktop; viewing in read-only mode.',
    remoteCliTag: 'via {name}',
    localApiGroup: 'Local API Model',
    desktopCliGroup: 'Desktop AI CLIs',
    refreshSessions: 'Refresh',
    sessionClosed: 'Session closed',
    typeCommandPlaceholder: 'Type command to send to desktop terminal…',
    navLabel: 'Mobile Remote',
    pageSubtitle: 'Pair over LAN or Tailscale with E2EE to invoke desktop AI CLIs from your phone and mirror or control live desktop terminals.',
    openCenter: 'Open Mobile Remote',
    networkChannels: 'Available Channels',
    tailscaleTip: 'Start the server to activate built-in P2P traversal — no extra apps or VPN needed.',
    tailscaleDetected: 'Tailscale detected — automatic LAN → Tailnet → P2P failover ready',
    irohReadyHint: 'Built-in P2P & encrypted relay ready — LAN on same Wi-Fi, seamless traversal on 5G.',
    cliCardTitle: 'Desktop AI CLIs Ready',
    cliReadyCount: '{ready} / {total} ready',
    cliInstalled: 'Ready',
    cliNotInstalled: 'Not installed',
    sessionsCardTitle: 'Live Desktop Sessions',
    sessionsCount: '{count} active',
    onlineClientsTitle: 'Connected Phones',
    noOnlineClients: 'No phones connected right now',
    authorizedDevicesTitle: 'Authorized Devices & Permissions',
    noAuthorizedDevices: 'No paired phones yet. Scan the QR code or paste the pairing link from ShellBeam Mobile to pair with X25519 + 6-digit SAS.',
    initDeviceFirst: 'Initialize this device identity first to generate a pairing QR code and accept mobile connections.',
    initDeviceFirstClient: 'Initialize this device identity first to scan a QR code or paste a pairing link to connect to your computer.',
    syncBannerTitle: 'Mobile Remote now has its own hub',
    syncBannerDesc: 'Manage QR pairing, desktop AI CLI proxy, live terminal mirroring, and device permissions in Mobile Remote.',
    syncBannerAction: 'Open Mobile Remote',
    serverRunningBadge: 'Listening :{port}',
    serverStoppedBadge: 'Server stopped',
    revokeDevice: 'Revoke',
    quickPopoverHint: 'Scan or paste in ShellBeam Mobile to connect',
    qrUnavailable: 'No LAN or Tailscale address detected yet',
    refreshStatus: 'Refresh',
    addRouteInline: 'Add route',
    connectedNow: 'Connected',
    openTerminal: 'Open terminal',
    repairAction: 'Pair Again',
    pairNewDesktop: 'Pair',
    errRepairRequired: 'This pairing is from an older version or no longer valid. Pair again via QR code or pairing link.',
    errPeerNotFound: 'Trusted desktop not found. Please pair again.',
    errNoRoutes: 'No desktop address configured. Re-pair or add a LAN / Tailscale route.',
    errBridgeDisabled: 'Mobile Remote is disabled on desktop. Turn on "Allow phone bridge" on your computer.',
    errConnectionRefused: 'Connection refused. Make sure the desktop sync server is running and both devices share a LAN or Tailscale network.',
    errTimeout: 'Connection timed out. The desktop IP may have changed — pair again or check Tailscale.',
    errUnreachable: 'Desktop address unreachable. Check that both devices are on the same Wi-Fi or Tailscale.',
    errIdentityMismatch: 'Desktop device identity mismatch; connection rejected for security.',
    errDisconnected: 'Disconnected from desktop. Tap Connect Desktop to reconnect.',
    errPermissionDenied: 'Permission denied by desktop. Enable it in Desktop → Mobile Remote.',
    errUnknown: 'Connection failed: {detail}',
    scanQrAction: 'Scan QR Code',
    scanQrTitle: 'Scan Desktop Pairing QR',
    scanQrHint: 'Align the QR code from Desktop → Mobile Remote inside the frame to pair automatically.',
    scanQrCameraDenied: 'Camera permission was denied. Allow camera access in system settings, or pick a photo below.',
    scanQrUnsupported: 'Live camera preview is unavailable here. Take a photo or choose a QR screenshot below.',
    scanQrPickImage: 'Take Photo / Pick QR Image',
    scanQrNotFound: 'No QR code found in that image. Try a clearer photo or screenshot.',
    scanQrInvalidLink: 'Not a ShellBeam pairing QR code. Scan the QR code shown in Desktop → Mobile Remote.',
    sessionStatusRunning: 'Running',
    sessionStatusConnecting: 'Connecting',
    sessionStatusClosed: 'Closed',
    fromDesktop: 'From {name}',
    desktopWaitingHint: 'Open an SSH or local terminal on desktop and it will appear here automatically.',
    aiTabShort: 'AI',
    terminalTabShort: 'Terminal',
    copyCommand: 'Copy',
    rerunCommand: 'Run Again',
    executedBadge: 'Done',
    outputLines: 'Output · {count} lines',
    expandOutput: 'Expand',
    collapseOutput: 'Collapse',
    explainOutput: 'Explain Output',
    explainOutputPrompt: 'Briefly explain the output of the last command and highlight any issues.',
    nextStep: 'Next Step',
    nextStepPrompt: 'Based on the previous output, suggest the next best diagnostic or action command.',
    modeConfirm: 'Confirm',
    modeAuto: 'Auto-run',
    modeReadOnly: 'Suggest',
    aiThinking: 'AI thinking…',
    scrollToBottom: 'Jump to bottom',
    localShellLabel: 'Local Shell',
    aiEmptyHint: 'Ask below to steer the desktop AI assistant for this live session.',
  },
}
