# ShellBeam 标准发布手册（Release Process Runbook）

本文档定义了 ShellBeam 从版本准备、签名公证、GitHub Release 发布到官网同步的端到端标准流程。

---

## 1. 发布前准备（Release Prep PR）

1. **同步版本号（4 处保持完全一致）**
   - `package.json` → `"version": "X.Y.Z"`
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
   - `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
   - `src-tauri/Cargo.lock`（执行 `cargo update --workspace --manifest-path src-tauri/Cargo.toml` 或 `cargo check` 更新 `app` 节点）
2. **编写中英双语发布说明**
   - 新增 `docs/releases/vX.Y.Z.md`，包含核心功能变更、升级说明与英文摘要。`Release` workflow 会自动将其作为 GitHub Release 正文开头。
3. **提交发布准备 PR**
   - 分支名使用 `release/vX.Y.Z`（仅改版本号与 `docs/releases/vX.Y.Z.md` 时，PR 阶段会自动跳过重复的 Packaged acceptance，完整四项验收会在推 tag 时统一运行）。
   - 等待 CI 全绿后合并至 `main`。

---

## 2. 自动化签名与公证配置（推荐，一次性完成）

`Release` workflow（`.github/workflows/build.yml`）支持全自动产出：
- **macOS**：`ShellBeam_X.Y.Z_universal.dmg`（Apple Silicon + Intel 通用包，Developer ID 签名 + `.app` 与外层 `.dmg` 双重 Apple 公证 + `stapler` 装订 + `spctl` 校验）
- **Android**：`ShellBeam_X.Y.Z_universal.apk`（4 ABI 签名包 + `apksigner verify` 校验）与已签名 `ShellBeam_X.Y.Z_universal.aab`
- **Windows / Linux**：`.exe` / `.msi` / `.deb` / `.rpm` / `.AppImage`
- **校验文件**：自动生成并附带 `SHA256SUMS`

### 必需的 10 项 GitHub Repository Secrets

在 `0xJean/shellbeam` → **Settings → Secrets and variables → Actions** 配置：

| 平台 | Secret 名称 | 说明 |
|---|---|---|
| macOS | `APPLE_CERTIFICATE` | 含 `Developer ID Application` 证书与私钥的 `.p12` base64 |
| macOS | `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| macOS | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
| macOS | `APPLE_ID` | Apple Developer 账号邮箱 |
| macOS | `APPLE_PASSWORD` | App 专用密码（appleid.apple.com 生成） |
| macOS | `APPLE_TEAM_ID` | 10 位 Team ID（如 `H4NCLYWCAJ`） |
| Android | `ANDROID_KEYSTORE_BASE64` | `shellbeam.jks` 的单行 base64 |
| Android | `ANDROID_KEYSTORE_PASS` | Keystore 密码 |
| Android | `ANDROID_KEY_ALIAS` | Key Alias（如 `shellbeam`） |
| Android | `ANDROID_KEY_PASS` | Key 密码 |

### 从本机钥匙串安全导入 `.p12` 到 GitHub Secrets（一次性）

在已安装 Developer ID 证书的 Mac 终端执行（会弹出系统钥匙串授权确认，结束后自动销毁临时 `.p12`）：

```bash
P12_TMP=$(mktemp -t shellbeam-cert).p12
P12_PASS=$(openssl rand -base64 24)
# 从「钥匙串访问」右键导出 Developer ID Application 证书与私钥为 "$P12_TMP"（密码填 "$P12_PASS"），
# 或运行：
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -P "$P12_PASS" -o "$P12_TMP"

base64 -i "$P12_TMP" | tr -d '\n' | gh secret set APPLE_CERTIFICATE --repo 0xJean/shellbeam
printf '%s' "$P12_PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo 0xJean/shellbeam
rm -f "$P12_TMP"
unset P12_PASS P12_TMP
```

> **安全兜底机制**：如果任意一项 macOS 或 Android 签名 Secret 缺失导致 CI 降级为未签名包，`Release` workflow 会自动将 GitHub Release 设为 **`draft: true`**，绝不把未签名包直接对外公开。

---

## 3. 触发发版与验收

```bash
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

观察工作流执行：
```bash
gh run list --workflow build.yml --branch vX.Y.Z --repo 0xJean/shellbeam
```

必须满足以下全部条件才能对外公开：
1. `Packaged acceptance` 全部 4 项 UI 验收通过；
2. 4 个桌面/移动平台构建全部成功；
3. macOS 产物为 **已公证通用包**（`ShellBeam_X.Y.Z_universal.dmg`），Android 产物为 **已签名通用包**（`ShellBeam_X.Y.Z_universal.apk` / `.aab`）；
4. 附件列表包含 `SHA256SUMS`，且无残留 `-unsigned.apk` 或单架构未签名 `.dmg`。

---

## 4. 本机补签 / 手动替换产物（应急或未配 `.p12` Secret 时）

当 CI 因缺少签名 Secret 产出 `draft` Release 时，在本机执行签名打包并替换对应附件：

### 4.1 macOS Universal 签名 + 双重公证

```bash
# 确保 .env 包含 APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID
npm run build:macos
```

脚本会自动完成 `universal-apple-darwin` 编译、`.app` 签名公证、外层 `.dmg` 公证装订，并强制校验：
- `codesign -dv --verbose=2`（确认为 `Developer ID Application` + `Timestamp`）
- `xcrun stapler validate`（`.app` 与 `.dmg` 均提示 `The validate action worked!`）
- `spctl -a -vvv` 与 `spctl -a -t open --context context:primary-signature -vvv`（均返回 `accepted · source=Notarized Developer ID`）

上传并移除未签名旧包：
```bash
gh release upload vX.Y.Z \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/ShellBeam_X.Y.Z_universal.dmg" \
  --repo 0xJean/shellbeam --clobber
gh release delete-asset vX.Y.Z ShellBeam_X.Y.Z_aarch64.dmg --repo 0xJean/shellbeam --yes || true
```

### 4.2 Android 签名与校验

```bash
npm run build:android
```

使用 `apksigner verify` 校验后上传并移除未签名包：
```bash
TMPDIR=$(mktemp -d)
cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   "$TMPDIR/ShellBeam_X.Y.Z_universal.apk"
cp src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab \
   "$TMPDIR/ShellBeam_X.Y.Z_universal.aab"
gh release upload vX.Y.Z "$TMPDIR"/* --repo 0xJean/shellbeam --clobber
gh release delete-asset vX.Y.Z app-universal-release-unsigned.apk --repo 0xJean/shellbeam --yes || true
gh release delete-asset vX.Y.Z app-universal-release.aab --repo 0xJean/shellbeam --yes || true
rm -rf "$TMPDIR"
```

### 4.3 刷新 `SHA256SUMS` 并正式公开

```bash
gh release view vX.Y.Z --repo 0xJean/shellbeam --json assets \
  --jq '.assets[] | select(.name != "SHA256SUMS") | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
  | sort -k2 > /tmp/SHA256SUMS
gh release upload vX.Y.Z /tmp/SHA256SUMS --repo 0xJean/shellbeam --clobber
rm -f /tmp/SHA256SUMS

# 确认无未签名资产后公开 draft Release
gh release edit vX.Y.Z --draft=false --repo 0xJean/shellbeam
```

---

## 5. 发布后官网同步清单（`0xJean/shellbeam-site`）

1. 检查官网版本号徽章（`src/locales/zh.json`、`en.json`、下载按钮版本标签）是否更新至 `vX.Y.Z`。
2. 核对下载区安装包格式与架构说明与 GitHub Release 实际附件完全一致（例如 macOS 为通用包 `.dmg`、Android 为 `.apk / .aab`）。
3. 若本版本包含显著 UI/交互改版，运行 `tools/demo-recorder` 重录演示视频与封面图。
4. 合并官网 PR 至 `main` 并执行 `vercel --prod --yes` 发布至 `https://www.shellbeam.xyz`。
