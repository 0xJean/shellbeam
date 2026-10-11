<div align="center">
  <img src="app-icon.png" width="128" height="128" alt="ShellBeam" />
  <h1>ShellBeam</h1>
  <p><strong>A modern, all-in-one SSH client for macOS, Windows, and Linux.</strong></p>
  <p>
    Terminal · SFTP · Port Forwarding · AI Assistant · Encrypted Vault · Snippets · Cross-Device Sync
  </p>

  <p>
    <a href="#features">Features</a> ·
    <a href="#installation">Installation</a> ·
    <a href="#development">Development</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="./README.zh-CN.md">中文文档</a>
  </p>
</div>

---

## Features

### SSH Terminal

- Interactive PTY sessions via `ssh2` (Rust-native, no system SSH required)
- Password and private key authentication (Ed25519, RSA, ECDSA)
- Host key verification with `known_hosts` management
- Auto-reconnect with configurable retry count and interval
- System SSH fallback for jump host / ProxyJump connections
- xterm.js renderer with WebGL acceleration, customizable themes and fonts
- Multi-tab terminal with split-pane view (left / right)

### SFTP File Transfer

- Dual-pane file manager (local ↔ remote)
- Upload, download, rename, delete, create directories
- Permission editing (`chmod`)
- Batch operations on multiple files

### Port Forwarding

- Local and remote SSH tunnels
- One-click start / stop with real-time status
- Persistent rules saved per vault

### AI Assistant

- Natural language → shell command generation
- Conversational UI with follow-up questions
- Execute or copy generated commands
- Streaming output with cancel support
- Supports OpenAI, Anthropic, OpenRouter, Ollama, and custom endpoints
- Keyboard shortcut: `⌘+I` / `Ctrl+I`

### Local Agent Access (MCP)

- Scoped server inventory, load history, and on-demand Linux capacity checks
- Optional generic SSH commands and SFTP file access; the agent owns deployment decisions
- Disabled by default, per-client host permissions, internal vault credentials, and access audit
- Configure in **Settings > Agent Access (MCP)**; see the [MCP guide](docs/mcp.md) for setup and v1 limits

### Encrypted Vault

- AES-256-GCM encrypted storage for passwords and private keys
- PBKDF2 key derivation with configurable auto-lock timeout
- Multiple vaults with independent master passwords
- Biometric unlock — Touch ID (macOS) / Face ID (iOS) / fingerprint (Android) / Windows Hello, with system password fallback
- Secrets never leave the device unencrypted

### Snippets

- Save reusable command templates
- Run snippets on any connected host
- Track last-used time

### Cross-Device Sync

- Peer-to-peer encrypted sync — no cloud required
- QR code pairing between devices
- Sync hosts, snippets, port-forward rules, and settings
- mDNS auto-discovery on local network

### Additional Features

- **SSH Key Generator** — generate Ed25519 / RSA keys, import from file
- **Command History** — searchable log of all executed commands
- **Command Palette** — `⌘+K` / `Ctrl+K` quick search for hosts, commands, and actions
- **Known Hosts** — view, add, and remove SSH host fingerprints
- **Backup & Restore** — export / import all data as encrypted ZIP
- **Themes** — multiple terminal color schemes (Hacker Green, Dracula, Solarized, etc.)
- **Welcome Page** — animated onboarding for first-time users
- **User Guide** — eight bilingual chapters covering Vault, first connection, monitoring, everyday tools, MCP, backup, and troubleshooting. Reading progress stays on this device; reopen from the sidebar, Settings, or More on mobile. Reading the guide does not enable permissions or complete setup automatically.
- **Interactive Walkthroughs** — optional Driver.js tours in User Guide highlight the real add-host form, monitoring, and MCP settings. Exit with Escape or the close button and replay anytime. Tours never save hosts, open terminals, or grant permissions; unavailable sections are omitted rather than populated with mock data. The existing reading guide stays available.
- **Mobile-Ready** — responsive layout with virtual keyboard toolbar

---

## Installation

### Pre-built Binaries

Download the latest release for your platform from the [GitHub Releases](https://github.com/zorojean/shellbeam/releases) page:

| Platform | Format |
|----------|--------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` |
| Linux | `.deb` / `.AppImage` |
| Android | `.apk` / `.aab` |
| iOS | TestFlight link in the release notes |

Release automation is documented in [docs/ci-cd.md](./docs/ci-cd.md).

### Build from Source

See [Development](#development) below.

---

## Development

### Prerequisites

| Tool | Version |
|------|---------|
| [Node.js](https://nodejs.org/) | 18+ |
| [Rust](https://rustup.rs/) | 1.77.2+ |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x |

macOS also requires Xcode Command Line Tools. Linux requires `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, and other system libraries — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Setup

```bash
# Clone the repository
git clone https://github.com/user/shellbeam.git
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
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview production build |
| `npm run tauri dev` | Launch Tauri app in development mode |
| `npm run tauri build` | Build distributable app bundle |
| `npx tauri ios dev --force-ip-prompt` | Run on physical iPhone (dev server, same LAN) |

### iOS: Install on a physical iPhone (before App Store)

You can install and run the app on your own iPhone without publishing to the App Store.

**Option 1: Development mode (Mac and iPhone on same network)**

1. Connect the iPhone via cable, or ensure it appears in Xcode → Window → Devices and Simulators.
2. From the project root run:
   ```bash
   npx tauri ios dev --force-ip-prompt
   ```
3. Enter your machine’s LAN IP (e.g. `192.168.10.6`) when prompted. Vite is configured to listen on all interfaces, so the device will load the dev server and the app will launch. Best for day-to-day development and debugging.

**Option 2: Standalone build (runs without a computer)**

1. **Code signing**: Set your Apple development team ID in `src-tauri/tauri.conf.json` under `bundle.iOS.developmentTeam` (10-character ID, e.g. `59K4B74D5A`), or set:
   ```bash
   export APPLE_DEVELOPMENT_TEAM=YourTeamID
   ```
   When you run `npx tauri ios dev`, the CLI lists available Team IDs from your certificates; use any one that you’re allowed to use.

2. **Build and install**:
   ```bash
   npm run build
   npx tauri ios build
   ```
   Then open `src-tauri/gen/apple/app.xcodeproj` in Xcode, select your physical device as the run target, and press Run (▶️) to install on the device.

3. **Accounts**:
   - **Free Apple ID**: You can install on a real device, but the app will expire after about 7 days and must be reinstalled from Xcode.
   - **Paid Apple Developer Program ($99/year)**: Installed apps stay valid and you can use Ad Hoc distribution for test devices.

---

## Architecture

```
shellbeam-app/
├── src/                          # Frontend (React + TypeScript)
│   ├── assets/                   # Logo and static assets
│   ├── components/               # UI components
│   │   ├── ui/                   # Primitives (Button, Input, Select, etc.)
│   │   ├── welcome-page.tsx      # First-launch onboarding
│   │   ├── hosts-dashboard.tsx   # Host management
│   │   ├── session-terminal-view.tsx  # xterm.js terminal
│   │   ├── sftp-dual-pane.tsx    # SFTP file manager
│   │   ├── ai-command-bar.tsx    # AI chat interface
│   │   ├── port-forward-panel.tsx
│   │   ├── snippet-panel.tsx
│   │   └── ...
│   ├── contexts/                 # React context providers
│   ├── layouts/                  # Desktop / mobile layouts
│   ├── lib/                      # API wrappers, utilities, AI client
│   └── App.tsx                   # Root component
├── src-tauri/                    # Backend (Rust + Tauri 2)
│   ├── src/
│   │   ├── ssh/                  # SSH sessions, commands, interactive PTY
│   │   ├── net/                  # SFTP, port forwarding, known hosts
│   │   ├── vault/                # Encrypted vault (AES-256-GCM)
│   │   ├── sync/                 # Peer-to-peer sync
│   │   ├── data/                 # Hosts, snippets, history, backup
│   │   ├── keys.rs               # SSH key generation / import
│   │   ├── error.rs              # Standardized error handling
│   │   ├── storage.rs            # JSON persistence layer
│   │   └── lib.rs                # Tauri app entry + command registration
│   └── Cargo.toml
├── tailwind.config.ts
├── vite.config.ts
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
| Encryption | `aes-gcm` + `pbkdf2` + `sha2` |
| Sync | Custom TCP protocol + `mdns-sd` for discovery |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘+K` / `Ctrl+K` | Open command palette |
| `⌘+I` / `Ctrl+I` | Toggle AI assistant |
| `Esc` | Close panel / cancel AI generation |

---

## Data Storage

All data is stored locally in the OS-specific app data directory:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/com.tauri.dev/` |
| Windows | `%APPDATA%/com.tauri.dev/` |
| Linux | `~/.local/share/com.tauri.dev/` |

Data files include `hosts.json`, `known_hosts.json`, `command_history.json`, `snippets.json`, and encrypted vault files. No data is sent to external servers (except AI API calls when configured by the user).

---

## License

The source code is licensed under the **[GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE)**.

- **Free to use** — personal, academic, non-commercial use at no cost.
- **Copyleft** — any modifications or derivative works must also be released under AGPL-3.0, including network/SaaS use.
- **Brand protection** — the ShellBeam name, logo, and icons are **not** covered by the AGPL. See [TRADEMARK.md](./TRADEMARK.md) for details. Forks must replace all brand assets.
- **Commercial license** — if the AGPL does not meet your needs (e.g., you cannot open-source your modifications), a commercial license is available. Contact `shellbeam@example.com`.
