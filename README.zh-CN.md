<div align="center">
  <img src="app-icon.png" width="128" height="128" alt="ShellBeam" />
  <h1>ShellBeam</h1>
  <p><strong>一款现代化的全功能 SSH 客户端，支持 macOS、Windows 和 Linux。</strong></p>
  <p>
    终端 · SFTP · 端口转发 · AI 助手 · 加密保险库 · 代码片段 · 跨设备同步
  </p>

  <p>
    <a href="#功能特性">功能特性</a> ·
    <a href="#安装">安装</a> ·
    <a href="#开发">开发</a> ·
    <a href="#项目结构">项目结构</a> ·
    <a href="./README.md">English</a>
  </p>
</div>

---

## 功能特性

### SSH 终端

- 基于 `ssh2`（Rust 原生）的交互式 PTY 会话，无需系统 SSH
- 支持密码和私钥认证（Ed25519、RSA、ECDSA）
- 主机密钥验证与 `known_hosts` 管理
- 可配置重试次数和间隔的自动重连
- 跳板机（ProxyJump）连接时自动回退到系统 SSH
- xterm.js 终端渲染（WebGL 加速），可自定义主题和字体
- 多标签终端 + 左右分屏

### SFTP 文件传输

- 双栏文件管理器（本地 ↔ 远程）
- 上传、下载、重命名、删除、创建目录
- 权限编辑（`chmod`）
- 多文件批量操作

### 端口转发

- 本地和远程 SSH 隧道
- 一键启停，实时状态显示
- 规则按保险库持久保存

### AI 助手

- 自然语言生成 Shell 命令
- 对话式交互，支持追问
- 执行或复制生成的命令
- 流式输出，可取消
- 支持 OpenAI、Anthropic、OpenRouter、Ollama 及自定义端点
- 快捷键：`⌘+I` / `Ctrl+I`

### 加密保险库

- AES-256-GCM 加密存储密码和私钥
- PBKDF2 密钥派生，可配置自动锁定超时
- 多保险库，独立主密码
- 生物识别解锁 — Touch ID（macOS）/ Face ID（iOS）/ 指纹识别（Android）/ Windows Hello，支持系统密码回退
- 密钥永远不会以明文离开设备

### 代码片段

- 保存可复用的命令模板
- 在任意连接主机上运行
- 跟踪最近使用时间

### 跨设备同步

- 点对点加密同步 — 无需云服务
- 二维码配对
- 同步主机、片段、端口转发规则和设置
- 局域网 mDNS 自动发现

### 其他功能

- **SSH 密钥生成** — 生成 Ed25519 / RSA 密钥，支持从文件导入
- **命令历史** — 所有执行过的命令可搜索
- **命令面板** — `⌘+K` / `Ctrl+K` 快速搜索主机、命令和操作
- **已知主机** — 查看、添加和删除 SSH 主机指纹
- **备份与恢复** — 导出 / 导入所有数据为加密 ZIP
- **主题** — 多种终端配色（Hacker Green、Dracula、Solarized 等）
- **欢迎页** — 首次使用时的动画引导页
- **移动端适配** — 响应式布局 + 虚拟键盘工具栏

---

## 安装

### 预编译安装包

从 [GitHub Releases](https://github.com/zorojean/shellbeam/releases) 页面下载对应平台的安装包：

| 平台 | 格式 |
|------|------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` |
| Linux | `.deb` / `.AppImage` |
| Android | `.apk` / `.aab` |
| iOS | Release notes 中的 TestFlight 链接 |

发布自动化配置见 [docs/ci-cd.md](./docs/ci-cd.md)。

### 从源码构建

参见下方[开发](#开发)部分。

---

## 开发

### 环境要求

| 工具 | 版本 |
|------|------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.77.2+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |

macOS 需要 Xcode Command Line Tools。Linux 需要 `libwebkit2gtk-4.1-dev`、`libappindicator3-dev` 等系统库 — 参见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/user/shellbeam.git
cd shellbeam/shellbeam-app

# 安装前端依赖
npm install

# 开发模式运行（热更新）
npm run tauri dev

# 构建生产版本
npm run tauri build
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | TypeScript 检查 + Vite 生产构建 |
| `npm run lint` | 运行 ESLint |
| `npm run tauri dev` | 启动 Tauri 开发模式 |
| `npm run tauri build` | 构建可分发的应用包 |

### iOS 真机安装（未上架 App Store 前）

可以在自己的 iPhone 上直接安装运行，有两种方式：

**方式一：开发模式（需电脑与手机在同一局域网）**

1. 用数据线连接 iPhone，或在 Xcode 的 Window → Devices and Simulators 中确保设备已通过网络连接。
2. 在项目根目录执行：
   ```bash
   npx tauri ios dev --force-ip-prompt
   ```
3. 按提示选择本机 IP（如 `192.168.10.6`），Vite 已配置为监听所有网卡，手机会自动连上开发服务器并安装运行。适合日常开发、调试。

**方式二：独立安装包（不连电脑也能用）**

1. **配置签名**：在 `src-tauri/tauri.conf.json` 的 `bundle.iOS.developmentTeam` 中填入你的 Apple 开发团队 ID（10 位，如 `59K4B74D5A`），或设置环境变量：
   ```bash
   export APPLE_DEVELOPMENT_TEAM=你的TeamID
   ```
   运行 `npx tauri ios dev` 时终端会列出本机可用证书对应的 Team ID，任选一个即可。

2. **构建并安装**：
   ```bash
   npm run build
   npx tauri ios build
   ```
   构建完成后，用 Xcode 打开 `src-tauri/gen/apple/app.xcodeproj`，在顶部选择你的真机设备，点击 Run（▶️）即可安装到手机。

3. **账号说明**：
   - **免费 Apple ID**：可在真机安装，但应用约 7 天后会过期，需重新用 Xcode 安装。
   - **付费开发者账号（$99/年）**：安装后长期有效，也可用于 Ad Hoc 分发给测试设备。

---

## 项目结构

```
shellbeam-app/
├── src/                          # 前端（React + TypeScript）
│   ├── components/               # UI 组件
│   │   ├── ui/                   # 基础组件（Button、Input、Select 等）
│   │   ├── welcome-page.tsx      # 首次使用引导页
│   │   ├── hosts-dashboard.tsx   # 主机管理
│   │   ├── session-terminal-view.tsx  # xterm.js 终端
│   │   ├── sftp-dual-pane.tsx    # SFTP 文件管理器
│   │   ├── ai-command-bar.tsx    # AI 对话界面
│   │   └── ...
│   ├── contexts/                 # React Context 状态管理
│   ├── layouts/                  # 桌面端 / 移动端布局
│   └── lib/                      # API 封装、工具函数、AI 客户端
├── src-tauri/                    # 后端（Rust + Tauri 2）
│   └── src/
│       ├── ssh/                  # SSH 会话、命令、交互式 PTY
│       ├── net/                  # SFTP、端口转发、已知主机
│       ├── vault/                # 加密保险库（AES-256-GCM）
│       ├── sync/                 # 点对点同步
│       └── data/                 # 主机、片段、历史、备份
└── package.json
```

### 技术栈

| 层 | 技术 |
|----|------|
| 框架 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | React 19、TypeScript 5.9、Vite 7 |
| 样式 | Tailwind CSS 3 |
| 终端 | xterm.js 6（WebGL 渲染） |
| 图标 | Lucide React |
| SSH | `ssh2` 0.9（Rust，libssh2 绑定） |
| 加密 | `aes-gcm` + `pbkdf2` + `sha2` |
| 同步 | 自定义 TCP 协议 + `mdns-sd` 发现 |

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘+K` / `Ctrl+K` | 打开命令面板 |
| `⌘+I` / `Ctrl+I` | 切换 AI 助手 |
| `Esc` | 关闭面板 / 取消 AI 生成 |

---

## 数据存储

所有数据存储在操作系统对应的应用数据目录中：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/com.tauri.dev/` |
| Windows | `%APPDATA%/com.tauri.dev/` |
| Linux | `~/.local/share/com.tauri.dev/` |

数据文件包括 `hosts.json`、`known_hosts.json`、`command_history.json`、`snippets.json` 和加密的保险库文件。除用户主动配置的 AI API 调用外，不会向任何外部服务器发送数据。

---

## 许可证

源代码采用 **[GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)** 许可。

- **免费使用** — 个人、学术、非商业用途免费。
- **强制开源** — 任何修改或衍生作品必须以 AGPL-3.0 发布，包括网络/SaaS 使用场景。
- **品牌保护** — ShellBeam 的名称、Logo 和图标**不受** AGPL 覆盖。详见 [TRADEMARK.md](./TRADEMARK.md)。Fork 项目必须替换所有品牌资产。
- **商业授权** — 如果 AGPL 不满足您的需求（例如无法开源您的修改），可获取商业许可。联系 `shellbeam@example.com`。
