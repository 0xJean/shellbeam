<div align="center">
  <img src="app-icon.png" width="128" height="128" alt="ShellBeam" />
  <h1>ShellBeam</h1>
  <p><strong>A modern, local-first SSH &amp; server ops workspace for macOS, Windows, Linux, iOS, and Android.</strong></p>
  <p>
    SSH Terminal · Host Workspace · SFTP · Port Forwarding · AI Ops Assistant · Desktop Companion (iroh P2P) · Encrypted Vault · MCP Bridge
  </p>

  <p>
    <a href="#features">Features</a> ·
    <a href="#installation">Installation</a> ·
    <a href="#development">Development</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="https://www.shellbeam.xyz">Website</a> ·
    <a href="./README.zh-CN.md">中文文档</a>
  </p>
</div>

---

## Features

### SSH Terminal & Host Workspace

- Interactive PTY sessions via `ssh2` (Rust-native, no system SSH required) with password and private key auth (Ed25519, RSA, ECDSA)
- Single-hop ProxyJump bastion support shared across terminals, SFTP, port tunnels, and monitoring
- Host key verification with `known_hosts` management and configurable auto-reconnect
- xterm.js 6 renderer with WebGL acceleration, 8 paired dark/light themes (Obsidian, Tokyo Night, Catppuccin, Rose Pine, Nord, Graphite, Emerald Ops, Solarized), and Glass UI mode
- Multi-tab terminal with resizable, persisted split panes
- **Host Workspace** — processes, systemd services, network, logs, Docker, SFTP, cron jobs, and an internal SSH-tunneled browser in classic list or multi-window desktop layout

### Desktop Companion Bridge & Built-in `iroh` P2P

- **Zero-config cross-network connection** powered by embedded pure-Rust `iroh` 1.5 P2P hole-punching + encrypted relay — no port forwarding, public IP, or third-party VPN required
- Automatic 3-tier route failover (**LAN → Tailscale → `iroh` P2P**) with end-to-end X25519 + HKDF + AES-256-GCM encryption
- Built-in mobile QR scanner for one-scan pairing with your desktop
- Real-time push of active desktop terminal sessions and AI assistant state to your phone, full-screen mobile viewing & keyboard takeover, remote access to desktop-installed AI CLIs, and per-device permission controls (revoking a permission immediately terminates active streams)

### AI Ops Assistant

- Natural language → shell command generation and multi-step troubleshooting right beside your terminal
- Per-server autonomy modes: **Ask every step**, **Auto-run read-only checks**, or **Run continuously** (with mandatory confirmation for destructive commands)
- Pre-change automatic snapshots (`~/.shellbeam-backups/`) with 1-click rollback, plus automatic local secret redaction before sending context
- **16 built-in API providers** (OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, xAI, Groq, Qwen, Zhipu GLM, Kimi, SiliconFlow, Volcengine, MiniMax, Ollama, LM Studio, and custom OpenAI-compatible endpoints) with live `/models` discovery, reasoning effort selection, and cross-tab synced favorites
- **6 local desktop AI CLIs** — reuse your existing **Claude Code**, **Codex**, **Gemini CLI**, **OpenCode**, **Cursor Agent CLI**, and **Devin CLI** logins in isolated read-only scratch sandboxes (also remotely accessible from mobile via Desktop Companion Bridge)
- Keyboard shortcut: `⌘+I` / `Ctrl+I`

### Local Agent Access (MCP)

- Scoped server inventory, load history, and on-demand Linux capacity checks for external agents (Claude Code, Codex, or any local MCP client)
- Optional generic SSH commands and SFTP file access; disabled by default with per-client host permissions, vault-internal credential resolution, and full access audit
- Configure in **Settings > Agent Access (MCP)**; see the [MCP guide](docs/mcp.md)

### SFTP, Port Forwarding & VPS Fleet

- **Dual-pane SFTP** — drag-and-drop upload/download, batch operations, rename, mkdir, `chmod`, live transfer queue, and ProxyJump support
- **Port Forwarding** — local, remote, and dynamic SOCKS tunnels persisted per vault with 1-click toggle and ProxyJump routing
- **VPS Assets & Monitoring** — track provider, pricing, monthly quota, and renewal dates; zero-agent SSH network/IP/latency health checks and optional 24×7 monitoring extension

### Encrypted Multi-Vault & Cross-Device Sync

- AES-256-GCM local encryption with PBKDF2 key derivation, multiple isolated vaults, and configurable auto-lock privacy shield
- Biometric unlock — Touch ID (macOS) / Face ID (iOS) / fingerprint (Android) / Windows Hello with master-password fallback
- Zero-cloud peer-to-peer encrypted vault sync over LAN, Tailscale, or `iroh` P2P with QR / verification-code pairing

### Mobile, Foldable & Narrow-Desktop Experience

- Responsive 3-tier layout (`compact` / `medium` / `wide`) with a collapsible 60px Icon Rail on medium/narrow viewports and foldable phones
- Dedicated mobile bottom navigation (**Hosts · Sessions · Desktop · Tools · Settings**), fast Session Launcher, collapsible virtual terminal key toolbar on both folded and unfolded screens, and dark-mode mobile Host Workspace

### Additional Tools

- **SSH Key Generator** — generate Ed25519 / RSA keys and import existing keys
- **Snippets & Command History** — reusable command templates and searchable execution history
- **Command Palette** — `⌘+K` / `Ctrl+K` quick jump across hosts, actions, and history
- **Backup & Restore** — encrypted ZIP export / import
- **User Guide & Interactive Walkthroughs** — 8 bilingual chapters plus optional Driver.js guided tours
- **Non-Blocking Update Reminders** — unobtrusive top-bar pill and dismissible toast with in-app release notes

---

## Installation

### Pre-built Binaries

Download the latest release from [GitHub Releases](https://github.com/0xJean/shellbeam/releases/latest) or visit [shellbeam.xyz](https://www.shellbeam.xyz):

| Platform | Format | Notes |
|----------|--------|-------|
| macOS (Apple Silicon & Intel) | `ShellBeam_*_universal.dmg` | Signed with Developer ID and notarized by Apple |
| Windows | `.exe` / `.msi` | x64 installers |
| Linux | `.deb` / `.rpm` / `.AppImage` | x86_64 packages |
| Android | `ShellBeam_*_universal.apk` / `.aab` | Signed multi-ABI universal packages |
| iOS | [TestFlight](https://testflight.apple.com/join/FfZabFz1) | Join the public beta via [TestFlight](https://testflight.apple.com/join/FfZabFz1) |

ShellBeam checks GitHub Releases on launch and every 12 hours to notify you when a new version is available — it never downloads or installs updates automatically, and sends no vault, host, or telemetry data. iOS updates are managed through TestFlight. You can turn off update checks under **Settings → General → Updates**.

Release automation and signing runbooks are documented in [docs/release-process.md](./docs/release-process.md) and [docs/ci-cd.md](./docs/ci-cd.md).

### Build from Source

See [Development](#development) below.

---

## Development

### Prerequisites

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org/) | 20+ |
| [Rust](https://rustup.rs/) | 1.91+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |

macOS / iOS builds require Xcode and `rustup component add llvm-tools` (required by `swift-rs` on Xcode 27+). Linux requires `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, and other system libraries — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Setup

```bash
# Clone the repository
git clone https://github.com/0xJean/shellbeam.git
cd shellbeam/shellbeam-app

# Install frontend dependencies
npm install

# Run in development mode (hot-reload)
npm run tauri dev

# Build for production
npm run tauri build
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (frontend only) |
| `npm run build` | TypeScript check + Vite production build |
| `npm test` | Run Vitest unit & component tests |
| `npx eslint src/` | Lint frontend TypeScript/React sources |
| `npm run tauri dev` | Launch Tauri desktop app in development mode |
| `npm run build:macos` | Build, sign, and double-notarize macOS Universal `.dmg` |
| `npm run build:android` | Build signed multi-ABI Android `.apk` and `.aab` |
| `npm run build:ios:tf` | Build iOS App Store `.ipa` and upload to TestFlight |
| `npm run dev:ios` | Run on physical iPhone (dev server, same LAN) |

### iOS: Install on a physical iPhone

1. Set your Apple Team ID (`IOS_DEVELOPMENT_TEAM` in `.env` or `APPLE_DEVELOPMENT_TEAM` in your shell).
2. For development on the same LAN:
   ```bash
   npx tauri ios dev --force-ip-prompt
   ```
3. For standalone release build & TestFlight upload:
   ```bash
   npm run build:ios:tf
   ```
   Or run `npx tauri ios build` and open `src-tauri/gen/apple/app.xcodeproj` in Xcode to run on your device.

---

## Architecture

```
shellbeam-app/
├── src/                          # Frontend (React 19 + TypeScript)
│   ├── components/               # Desktop, mobile & workspace UI components
│   │   ├── ui/                   # Theme-adaptive UI primitives
│   │   ├── workspace/            # Host workspace apps & mobile home screen
│   │   ├── mobile/               # Mobile navigation, QR scanner & remote companion sheet
│   │   ├── companion-center-panel.tsx # Desktop Companion Bridge & pairing UI
│   │   ├── session-terminal-view.tsx  # xterm.js 6 terminal
│   │   ├── sftp-dual-pane.tsx    # Dual-pane SFTP file manager
│   │   ├── ai-command-bar.tsx    # AI assistant & model switcher
│   │   └── ...
│   ├── contexts/                 # React context providers
│   ├── layouts/                  # Responsive desktop / foldable / mobile layouts
│   ├── lib/                      # Tauri bindings, companion client, AI & locales
│   └── App.tsx                   # Root component
├── src-tauri/                    # Backend (Rust + Tauri 2)
│   ├── src/
│   │   ├── ssh/                  # SSH sessions, ProxyJump, interactive PTY
│   │   ├── companion/            # Desktop Companion Bridge server, client, protocol & AI hub
│   │   ├── sync/                 # P2P encrypted sync, multi-route dialer & embedded iroh 1.5
│   │   ├── net/                  # SFTP, port forwarding, known hosts
│   │   ├── vault/                # AES-256-GCM multi-vault & biometric secret storage
│   │   ├── ai_cli.rs             # Isolated adapters for 6 local AI CLIs
│   │   ├── app_update.rs         # Non-blocking GitHub Releases update checker
│   │   ├── data/                 # Hosts, VPS assets, monitoring, snippets, history, backup
│   │   └── lib.rs                # Tauri app entry + command registration
│   └── Cargo.toml
├── docs/                         # Guides, architecture, release notes & runbooks
└── package.json
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Tauri 2](https://v2.tauri.app/) |
| Frontend | React 19, TypeScript 5.9, Vite 7 |
| Styling | Tailwind CSS 3 |
| Terminal | xterm.js 6 (WebGL renderer) |
| Icons | Lucide React |
| SSH | `ssh2` 0.9 (Rust, libssh2 bindings) |
| Encryption | `aes-gcm` + `pbkdf2` + `x25519-dalek` + `hkdf` + `sha2` |
| P2P & Sync | Embedded `iroh` 1.5 (QUIC P2P + encrypted relay) + LAN / Tailscale + `mdns-sd` |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘+K` / `Ctrl+K` | Open command palette |
| `⌘+I` / `Ctrl+I` | Toggle AI assistant |
| `Esc` | Close panel / cancel AI generation |

---

## Data Storage

All data is stored locally in the OS-specific app data directory (`app.shellbeam`):

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/app.shellbeam/` |
| Windows | `%APPDATA%/app.shellbeam/` |
| Linux | `~/.local/share/app.shellbeam/` |

No data is sent to external servers except user-configured AI API calls, optional GitHub release checks, and encrypted `iroh` relay transport when connecting across networks without direct LAN/Tailscale reachability.

---

## License

The source code is licensed under the **[GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)**.

- **Free to use** — personal, academic, non-commercial use at no cost.
- **Copyleft** — any modifications or derivative works must also be released under AGPL-3.0, including network/SaaS use.
- **Brand protection** — the ShellBeam name, logo, and icons are **not** covered by the AGPL. See [TRADEMARK.md](./TRADEMARK.md) for details. Forks must replace all brand assets.
- **Commercial license** — if the AGPL does not meet your needs (e.g., you cannot open-source your modifications), open an issue or contact the maintainer via [GitHub](https://github.com/0xJean/shellbeam).
