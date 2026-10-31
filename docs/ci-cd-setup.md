# ShellBeam CI/CD 配置指南

Push `v*` tag 自动构建 macOS / Linux / Windows / Android，产物发布到 GitHub Release（draft）。

## 1. GitHub Secrets 配置

仓库 → Settings → Secrets and variables → Actions → New repository secret

### macOS 签名 + 公证（可选，不配则产出未签名 .dmg）

| Secret | 值 |
|---|---|
| `APPLE_CERTIFICATE` | `.p12` 证书文件的 base64：`base64 -i certificate.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_PASSWORD` | App 专用密码（appleid.apple.com → 登录与安全 → App 专用密码） |
| `APPLE_TEAM_ID` | 开发者 Team ID（如 `H4NCLYWCAJ`） |

### Android 签名（可选，不配则产出未签名 APK）

| Secret | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64：`base64 -i shellbeam.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASS` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | key alias（如 `shellbeam`） |
| `ANDROID_KEY_PASS` | key 密码 |

没有 keystore？生成一个：
```bash
keytool -genkey -v -keystore shellbeam.jks -keyalg RSA -keysize 2048 -validity 10000 -alias shellbeam
```

### iOS（可选）

同 macOS 的 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_TEAM_ID`，额外需要：

| Secret | 值 |
|---|---|
| `IOS_PROVISIONING_PROFILE` | `.mobileprovision` 文件的 base64 |

### Windows

无需额外 secrets，直接构建。如需代码签名，后续可加。

## 2. iOS 自动构建开关

iOS 默认不随 tag push 触发（需要证书才能构建成功）。

启用：仓库 → Settings → Secrets and variables → Actions → Variables tab → New repository variable

| Variable | 值 |
|---|---|
| `ENABLE_IOS_TESTFLIGHT` 或 `ENABLE_IOS_BUILD` | `true` |

## 3. 触发构建

### 自动（推荐）
```bash
git tag v0.1.0
git push origin v0.1.0
```

自动构建 macOS + Linux + Windows + Android，完成后在 Releases 页面出现 draft release。

同一个 tag 也会触发 `Packaged acceptance` 的全部四项验收。发布 draft 之前，请先确认这四项都已通过；目前 `Release` 不会等待验收，需要人工确认。详见 [ci-cd.md](ci-cd.md)。

### 手动

仓库 → Actions → Release → Run workflow，勾选需要的平台。

## 4. 产物

| 平台 | 格式 |
|---|---|
| macOS | `.dmg` |
| Linux | `.deb` `.AppImage` `.rpm` |
| Windows | `.msi` `.exe` |
| Android | `.apk` `.aab` |
| iOS | 上传到 TestFlight，不作为 GitHub Release 附件 |
