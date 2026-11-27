# ShellBeam 标准发布手册（Release Process Runbook）

本文档定义了 ShellBeam 从版本准备、签名公证、GitHub Release 发布到官网同步的端到端标准流程。

---

## 1. 发布前准备（Release Prep PR）

1. **同步版本号（6 处保持完全一致）**
   - `package.json` → `"version": "X.Y.Z"`
   - `package-lock.json` → 顶层与 `packages[""]` 的 `"version": "X.Y.Z"`
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
   - `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
   - `src-tauri/Cargo.lock`（执行 `cargo update --workspace --manifest-path src-tauri/Cargo.toml` 或 `cargo check` 更新 `app` 节点）
   - `src-tauri/gen/apple/app_iOS/Info.plist` → `CFBundleShortVersionString` 为 `X.Y.Z`（TestFlight 显示版本）
2. **编写中英双语发布说明**
   - 新增 `docs/releases/vX.Y.Z.md`，包含核心功能变更、升级说明与英文摘要。`Release` workflow 会自动将其作为 GitHub Release 正文开头。
3. **提交发布准备 PR**
   - 分支名使用 `release/vX.Y.Z`（仅改版本号与 `docs/releases/vX.Y.Z.md` 时，PR 阶段会自动跳过重复的 Packaged acceptance，完整四项验收会在推 tag 时统一运行）。
   - 等待 CI 全绿后合并至 `main`。

---

## 2. 自动化签名、公证与 TestFlight 配置（推荐，一次性完成）

`Release` workflow（`.github/workflows/build.yml`）支持全自动产出：
- **macOS**：`ShellBeam_X.Y.Z_universal.dmg`（Apple Silicon + Intel 通用包，Developer ID 签名 + `.app` 与外层 `.dmg` 双重 Apple 公证 + `stapler` 装订 + `spctl` 校验）
- **Android**：`ShellBeam_X.Y.Z_universal.apk`（4 ABI 签名包 + `apksigner verify` 校验）与已签名 `ShellBeam_X.Y.Z_universal.aab`
- **Windows / Linux**：`.exe` / `.msi` / `.deb` / `.rpm` / `.AppImage`
- **iOS（TestFlight）**：上传 App Store IPA 至 App Store Connect（不作为 `.ipa` 附件挂在 GitHub Release，而在 Release Notes 中展示 TestFlight 链接）
- **校验文件**：自动生成并附带 `SHA256SUMS`

### 必需的 GitHub Repository Secrets 与 Variables

在 `0xJean/shellbeam` → **Settings → Secrets and variables → Actions** 配置：

| 类型 | 平台 | 名称 | 说明 |
|---|---|---|---|
| Secret | macOS / iOS | `APPLE_CERTIFICATE` | `.p12` base64（仅发 macOS 含 `Developer ID Application`；若同时启用 CI iOS TestFlight，一并包含 `iPhone Distribution` / `Apple Distribution` 证书与私钥） |
| Secret | macOS / iOS | `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| Secret | macOS | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
| Secret | macOS / iOS | `APPLE_ID` | Apple Developer 账号邮箱 |
| Secret | macOS / iOS | `APPLE_PASSWORD` | App 专用密码（appleid.apple.com 生成） |
| Secret | macOS / iOS | `APPLE_TEAM_ID` | 10 位 Team ID（如 `H4NCLYWCAJ`） |
| Secret | iOS（可选） | `IOS_PROVISIONING_PROFILE` | App Store Provisioning Profile 的 base64；不填则走 Xcode 自动签名 |
| Secret | Android | `ANDROID_KEYSTORE_BASE64` | `shellbeam.jks` 的单行 base64 |
| Secret | Android | `ANDROID_KEYSTORE_PASS` | Keystore 密码 |
| Secret | Android | `ANDROID_KEY_ALIAS` | Key Alias（如 `shellbeam`） |
| Secret | Android | `ANDROID_KEY_PASS` | Key 密码 |
| Variable | iOS | `ENABLE_IOS_TESTFLIGHT` | 设为 `true` 时，每次推送 `v*` tag 自动执行 `ios-testflight` 上传 TestFlight |
| Variable | iOS | `TESTFLIGHT_PUBLIC_LINK` | TestFlight 公开测试链接（当前固定为 `https://testflight.apple.com/join/FfZabFz1`），自动写入 Release Notes |

### 从本机钥匙串安全导入单个 Developer ID `.p12` 到 GitHub Secrets（一次性）

> **安全注意**：切勿对整个 `login.keychain-db` 使用 `security export -t identities`，否则会把无关的个人/开发私钥一并导出并上传到 CI。

1. 打开 macOS **钥匙串访问（Keychain Access）** → 左侧选「登录」→「我的证书」；
2. **仅选中** `Developer ID Application: chuang liu (H4NCLYWCAJ)`（展开确认仅包含这一对证书与私钥）→ 右键 → **导出…** → 保存为临时 `.p12` 文件（如 `/tmp/shellbeam-dev-id.p12`），设置强随机导出密码；
3. 在终端将其直接写入 GitHub Secrets 并立即删除临时 `.p12`：

```bash
read -rsp "输入刚才导出 .p12 时设置的密码: " P12_PASS; echo
base64 -i /tmp/shellbeam-dev-id.p12 | tr -d '\n' | gh secret set APPLE_CERTIFICATE --repo 0xJean/shellbeam
printf '%s' "$P12_PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo 0xJean/shellbeam
rm -f /tmp/shellbeam-dev-id.p12
unset P12_PASS
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
4. 附件列表包含 `SHA256SUMS`，且无残留 `-unsigned.apk` 或单架构未签名 `.dmg`；
5. iOS TestFlight 已随本版本完成上传，且已完成出口合规确认、将最新构建加入公开链接外部测试组（`https://testflight.apple.com/join/FfZabFz1`）并提交 Apple Beta 审核（参见第 4.3 节 `npm run build:ios:tf` / `npm run ios:tf:distribute`）。

---

## 4. 本机补签 / 手动替换产物与 TestFlight 上传（应急或未配 Apple `.p12` Secret 时）

当 CI 因缺少签名 Secret 产出 `draft` Release 时，在本机执行签名打包并替换对应附件：

### 4.1 macOS Universal 签名 + 双重公证

```bash
# 首次构建通用包需确保两个 macOS Rust target 均已安装：
rustup target add aarch64-apple-darwin x86_64-apple-darwin

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

### 4.3 iOS TestFlight 构建、上传与自动提审公开测试组

当 CI 未开启 `ENABLE_IOS_TESTFLIGHT=true` 时，在已登录 Apple Distribution 证书（`iPhone Distribution` / `Apple Distribution`）的 macOS 本机执行：

```bash
# 确保 .env 包含 IOS_DEVELOPMENT_TEAM / APPLE_ID / APPLE_PASSWORD
# 若同时配置了 ASC_ISSUER_ID / ASC_KEY_ID / ASC_PRIVATE_KEY_PATH，将自动完成：
#   1. 等待构建处理变为 VALID
#   2. 自动确认出口合规（Info.plist 已永久声明 ITSAppUsesNonExemptEncryption=false，兜底接口 PATCH）
#   3. 同步中英文测试说明（取自 docs/releases/vX.Y.Z.md）
#   4. 自动将最新构建绑定到公开链接外部测试组（https://testflight.apple.com/join/FfZabFz1）
#   5. 自动提交 Apple Beta App Review 审核
npm run build:ios:tf
```

#### 一次性配置 App Store Connect API Key（启用全自动绑定公开测试组与提审）

1. 打开 [App Store Connect → 用户和访问 → 集成 → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api) → 选择 **团队密钥**，点击 `+` 新建一个权限为 **App 管理（App Manager）** 的密钥；
2. 下载 `AuthKey_<KEY_ID>.p8` 到本机安全目录（如 `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`，切勿提交到仓库）；
3. 在 `shellbeam-app/.env` 中追加：
   ```bash
   ASC_ISSUER_ID=<页面顶部的 Issuer ID>
   ASC_KEY_ID=<密钥 ID>
   ASC_PRIVATE_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
   # 可选：若存在多个外部测试组，可指定组名；默认自动选择开启了公开链接的外部测试组
   # ASC_EXTERNAL_GROUP_NAME=Public Beta
   ```
4. 若某次构建已上传完成、只想单独补跑「出口合规 + 绑定公开链接测试组 + 提交 Beta 审核」，直接执行：
   ```bash
   npm run ios:tf:distribute -- --version X.Y.Z
   ```

说明：
- `src-tauri/gen/apple/app_iOS/Info.plist` 与 `project.yml` 已内置 `ITSAppUsesNonExemptEncryption = false`，从后续版本起上传 TestFlight 自动免除「缺少出口合规证明」手动操作。
- `scripts/ios-build-tf.sh` 会自动生成唯一构建号 `CFBundleVersion`（`YYYYMMDD.HHMM`）、执行 `tauri ios build`、导出 App Store IPA、通过 `xcrun altool --upload-app` 上传至 App Store Connect，并在配置了 `ASC_*` 后自动执行 `scripts/ios-tf-distribute.mjs` 完成公开测试组绑定与 Beta 提审。
- 若本机仅作临时发包不希望留下工作区脏改动，可在上传确认后执行 `git checkout -- src-tauri/gen/apple/app_iOS/Info.plist`。
- **外部测试（External Testing）提醒**：TestFlight 单个构建有效期为 90 天；每次发版均须确保最新构建已加入公开链接外部测试组并处于「正在等待审核」或「正在测试」状态。

### 4.4 刷新 `SHA256SUMS` 并正式公开

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

## 5. 发布后官网验证与同步清单（`0xJean/shellbeam-site`）

1. **自动版本同步验证**：`https://www.shellbeam.xyz` 已接入 `https://api.github.com/repos/0xJean/shellbeam/releases/latest` 自动拉取（带 15 分钟 `sessionStorage` 缓存）。正式公开 Release 后，验证接口返回 `tag_name: "vX.Y.Z"`，官网即自动显示新版本，**常规版本无需重新部署官网**。
2. **需要手动更新官网的场景**：
   - 新增或变更安装包格式/平台入口（例如新增 iOS TestFlight 入口或变更链接）；
   - 本版本包含显著 UI/交互改版，需运行 `tools/demo-recorder` 重录演示视频与封面图，或更新官网文案与 `FALLBACK_VERSION`。
3. 如有官网改动，合并 `0xJean/shellbeam-site` PR 至 `main` 并执行 `vercel --prod --yes` 发布至 `https://www.shellbeam.xyz`。
