<div align="center">
  <img src="app-icon.png" width="128" height="128" alt="ShellBeam" />
  <h1>ShellBeam</h1>
  <p><strong>现代化、本地优先的全功能 SSH 与服务器运维工作台，支持 macOS、Windows、Linux、iOS 与 Android。</strong></p>
  <p>
    SSH 终端 · 主机工作空间 · SFTP · 端口转发 · AI 运维助手 · 手机直连电脑（iroh P2P） · 加密保管库 · MCP 授权桥
  </p>

  <p>
    <a href="#功能特性">功能特性</a> ·
    <a href="#安装">安装</a> ·
    <a href="#开发">开发</a> ·
    <a href="#项目结构">项目结构</a> ·
    <a href="https://www.shellbeam.xyz">官网</a> ·
    <a href="./README.md">English</a>
  </p>
</div>

---

## 功能特性

### SSH 终端与主机工作空间

- 基于 `ssh2`（Rust 原生）的交互式 PTY 会话，无需系统 SSH，支持密码与私钥认证（Ed25519、RSA、ECDSA）
- 支持单跳跳板机（ProxyJump），终端、SFTP、端口隧道与监控共享同一链路
- 主机密钥指纹验证、`known_hosts` 管理与可配置自动重连
- xterm.js 6 渲染器（WebGL 加速），内置 8 套深浅配对主题（Obsidian、Tokyo Night、Catppuccin、Rose Pine、Nord、Graphite、Emerald Ops、Solarized）与毛玻璃风格
- 多标签终端 + 可拖拽记忆比例的分屏工作台
- **主机工作空间** — 在同一界面管理进程、systemd 服务、网络、日志、Docker、SFTP、定时任务，并内置通过 SSH 隧道访问内网 Web 面板的浏览器，支持经典列表与多窗口桌面模式

### 手机直连电脑（Desktop Companion Bridge）与内置 `iroh` P2P

- **内置纯 Rust `iroh` 1.5 P2P 穿透与加密中继** — 无需公网 IP、端口映射或第三方 VPN，跨网即连
- 支持 **局域网（LAN）→ Tailscale → `iroh` P2P** 三层自动路由择优与断线无感切换，全程 X25519 + HKDF + AES-256-GCM 端到端加密
- 移动端内置应用内二维码扫描器，一扫即与桌面端完成安全配对
- 桌面端活跃终端会话与 AI 助手状态实时推送至手机，支持全屏查看、键盘接管、远程调用桌面端本地 AI CLI，以及按设备细粒度权限控制（撤销权限即时断开活跃流）

### AI 运维助手

- 用自然语言生成 Shell 命令并在终端旁多步排查，支持每台主机独立设置自动化模式：**每步确认**、**只读自动**、**连续执行**（高危命令强制拦截确认）
- 修改前支持「备份后执行」（自动快照至 `~/.shellbeam-backups/` 并支持一键回滚），发送前本地自动对私钥、Token 与命令行密码掩码脱敏
- **内置 16 家模型 API 供应商**（OpenAI、Anthropic、Google Gemini、DeepSeek、OpenRouter、xAI、Groq、通义千问、智谱 GLM、Kimi、硅基流动、火山方舟、MiniMax、Ollama、LM Studio 及自定义 OpenAI 兼容端点），支持自动拉取模型列表、推理强度选择与跨标签页置顶收藏
- **支持 6 款桌面本地 AI CLI** — 直接复用本机已登录的 **Claude Code**、**Codex**、**Gemini CLI**、**OpenCode**、**Cursor Agent CLI** 与 **Devin CLI**（隔离只读沙盒执行，并通过手机直连支持移动端远程调用）
- 快捷键：`⌘+I` / `Ctrl+I`

### 本地 Agent 访问（MCP）

- 为 Claude Code、Codex 或任意本地 MCP 客户端提供受控的服务器资产、负载历史与按需 Linux 容量检查
- 可选开放通用 SSH 命令与 SFTP 访问；默认关闭，按客户端精细授权主机与能力，凭据仅在保管库内部解析并保留完整访问审计
- 配置入口：**设置 > Agent 访问（MCP）**，详见 [MCP 使用文档](docs/mcp.md)

### SFTP、端口转发与 VPS 资产管理

- **双栏 SFTP** — 拖拽上传下载、批量操作、重命名、建目录、改权限（`chmod`）、实时传输队列与 ProxyJump 支持
- **端口转发** — 本地转发、远程转发与动态 SOCKS 代理按保管库持久化保存，一键启停并支持跳板机链路
- **VPS 资产与监控** — 追踪服务商、续费周期与月均成本；内置零探针 SSH 出口 IP / 延迟 / 连通性一键体检，支持可选 7×24 监控扩展

### 多空间加密保管库与跨设备同步

- AES-256-GCM 本地加密与 PBKDF2 密钥派生，支持多保管库隔离与闲置自动锁屏遮蔽
- 支持生物识别解锁 — Touch ID（macOS）/ Face ID（iOS）/ 指纹识别（Android）/ Windows Hello，支持主密码回退
- 零云端 P2P 加密同步（LAN / Tailscale / `iroh` P2P），核对验证码或扫码配对后按需推送/拉取

### 移动端、折叠屏与桌面窄窗适配

- 三档响应式视口（`compact` / `medium` / `wide`），折叠屏展开态与桌面窄窗自动切换可折叠 60px 侧边图标栏（Icon Rail）
- 移动端底部导航（**主机 · 会话 · 电脑 · 工具 · 设置**）、会话启动器、折叠/展开态均常驻的可收起终端快捷按键条，以及适配暗色模式的移动主机工作空间

### 其他工具

- **SSH 密钥生成** — 生成 Ed25519 / RSA 密钥或导入已有密钥
- **代码片段与命令历史** — 可复用命令模板与可搜索执行记录
- **命令面板** — `⌘+K` / `Ctrl+K` 速达主机、操作与历史命令
- **加密备份与恢复** — 一键导出 / 还原加密 ZIP 备份
- **使用教程与交互式引导** — 8 节中英双语教程 + 可选 Driver.js 实景导览
- **非侵入式更新提醒** — 顶栏胶囊与可稍后提醒的更新提示，应用内直接浏览发布日志

---

## 安装

### 预编译安装包

前往 [GitHub Releases](https://github.com/0xJean/shellbeam/releases/latest) 或 [官网 shellbeam.xyz](https://www.shellbeam.xyz) 下载对应平台的正式安装包：

| 平台 | 格式 | 说明 |
|------|------|------|
| macOS（Apple Silicon & Intel） | `ShellBeam_*_universal.dmg` | Developer ID 签名 + Apple 双重公证通用包 |
| Windows | `.exe` / `.msi` | x64 安装包 |
| Linux | `.deb` / `.rpm` / `.AppImage` | x86_64 安装包 |
| Android | `ShellBeam_*_universal.apk` / `.aab` | 已签名多 ABI 通用包 |
| iOS | TestFlight | 通过 TestFlight 分发（最新测试邀请见 [Release Notes](https://github.com/0xJean/shellbeam/releases/latest)） |

ShellBeam 在启动时及每 12 小时检查一次 GitHub Releases 以便提醒新版本，不会自动下载或安装，也不发送任何主机、保管库或使用数据。iOS 由 TestFlight 管理更新。可在 **设置 → 常规 → 更新** 中关闭检查。

完整发版与签名公证流程见 [docs/release-process.md](./docs/release-process.md) 与 [docs/ci-cd.md](./docs/ci-cd.md)。

### 从源码构建

参见下方[开发](#开发)部分。

---

## 开发

### 环境要求

| 工具 | 版本 |
|------|------|
| [Node.js](https://nodejs.org/) | 20+ |
| [Rust](https://rustup.rs/) | 1.91+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |

macOS / iOS 构建需要 Xcode 与 `rustup component add llvm-tools`（Xcode 27+ 下 `swift-rs` 必需）。Linux 需要 `libwebkit2gtk-4.1-dev`、`libappindicator3-dev` 等系统库，参见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/0xJean/shellbeam.git
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
| `npm test` | 运行 Vitest 单元测试与组件测试 |
| `npx eslint src/` | 运行前端 ESLint 检查 |
| `npm run tauri dev` | 启动 Tauri 桌面开发模式 |
| `npm run build:macos` | 本机构建、签名并双重公证 macOS 通用 `.dmg` |
| `npm run build:android` | 构建已签名多 ABI Android `.apk` 与 `.aab` |
| `npm run build:ios:tf` | 打包 iOS App Store `.ipa` 并上传至 TestFlight |
| `npm run dev:ios` | 在真机 iPhone 上以局域网开发模式运行 |

### iOS 真机运行与 TestFlight

1. 在 `.env` 中配置 `IOS_DEVELOPMENT_TEAM`（或导出环境变量 `APPLE_DEVELOPMENT_TEAM`）。
2. 同局域网热更新调试：
   ```bash
   npx tauri ios dev --force-ip-prompt
   ```
3. 打包并上传 TestFlight：
   ```bash
   npm run build:ios:tf
   ```
   或运行 `npx tauri ios build` 后用 Xcode 打开 `src-tauri/gen/apple/app.xcodeproj` 直接运行到真机。

---

## 项目结构

```
shellbeam-app/
├── src/                          # 前端（React 19 + TypeScript）
│   ├── components/               # 桌面、移动端与工作空间 UI 组件
│   │   ├── ui/                   # 自适应主题基础组件
│   │   ├── workspace/            # 主机工作空间应用与移动主屏
│   │   ├── mobile/               # 移动导航、应用内扫码器与远程桌面会话层
│   │   ├── companion-center-panel.tsx # 手机直连电脑（Companion Bridge）面板
│   │   ├── session-terminal-view.tsx  # xterm.js 6 终端
│   │   ├── sftp-dual-pane.tsx    # 双栏 SFTP 文件管理器
│   │   ├── ai-command-bar.tsx    # AI 运维助手与模型选择器
│   │   └── ...
│   ├── contexts/                 # React Context 状态管理
│   ├── layouts/                  # 桌面 / 折叠屏 / 移动端响应式布局
│   ├── lib/                      # Tauri 封装、Companion 客户端、AI 与多语言
│   └── App.tsx                   # 根组件
├── src-tauri/                    # 后端（Rust + Tauri 2）
│   ├── src/
│   │   ├── ssh/                  # SSH 会话、跳板机、交互式 PTY
│   │   ├── companion/            # 手机直连桥接服务端、客户端、加密协议与 AI Hub
│   │   ├── sync/                 # P2P 加密同步、多路由拨号与内置 iroh 1.5
│   │   ├── net/                  # SFTP、端口转发、已知主机
│   │   ├── vault/                # AES-256-GCM 多保管库与生物识别存储
│   │   ├── ai_cli.rs             # 6 款本地 AI CLI 隔离适配器
│   │   ├── app_update.rs         # 非侵入式 GitHub Releases 更新检查
│   │   ├── data/                 # 主机、VPS 资产、监控、片段、历史、备份
│   │   └── lib.rs                # Tauri 应用入口与命令注册
│   └── Cargo.toml
├── docs/                         # 使用文档、发布说明与发版手册
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
| 加密 | `aes-gcm` + `pbkdf2` + `x25519-dalek` + `hkdf` + `sha2` |
| P2P 与同步 | 内置 `iroh` 1.5（QUIC P2P + 加密中继）+ LAN / Tailscale + `mdns-sd` |

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘+K` / `Ctrl+K` | 打开命令面板 |
| `⌘+I` / `Ctrl+I` | 切换 AI 助手 |
| `Esc` | 关闭面板 / 取消 AI 生成 |

---

## 数据存储

所有数据保存在操作系统对应的应用数据目录（`app.shellbeam`）：

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/app.shellbeam/` |
| Windows | `%APPDATA%/app.shellbeam/` |
| Linux | `~/.local/share/app.shellbeam/` |

除用户主动配置的 AI API 请求、可选的 GitHub Releases 版本检查以及跨网直连时的端到端加密 `iroh` 中继外，不会向任何外部服务器发送数据。

---

## 许可证

源代码采用 **[GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)** 许可。

- **免费使用** — 个人、学术、非商业用途免费。
- **强制开源** — 任何修改或衍生作品必须以 AGPL-3.0 发布，包括网络/SaaS 使用场景。
- **品牌保护** — ShellBeam 的名称、Logo 和图标**不受** AGPL 覆盖。详见 [TRADEMARK.md](./TRADEMARK.md)。Fork 项目必须替换所有品牌资产。
- **商业授权** — 如果 AGPL 不满足您的需求（例如无法开源您的修改），请通过 [GitHub](https://github.com/0xJean/shellbeam) 联系维护者。
