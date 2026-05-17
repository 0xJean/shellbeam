# GitHub CI/CD

ShellBeam uses two GitHub Actions workflows:

- `CI`: runs on pull requests and branch pushes. It installs dependencies, runs the Vitest suite, and builds the frontend.
- `Release`: runs on `v*` tags or manual dispatch. It publishes macOS, Windows, Linux, and Android files as GitHub Release assets. iOS is uploaded to TestFlight instead of being attached as an IPA.

## Release flow

1. Update `src-tauri/tauri.conf.json` and `package.json` versions.
2. Push a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Wait for the `Release` workflow.
4. Publish the draft GitHub Release after checking the attached files and release notes.

Manual builds can be started from GitHub Actions with `workflow_dispatch`; platform builds can be enabled or disabled there. To create a draft GitHub Release from a manual run, dispatch the workflow on a `v*` tag ref. The iOS option uploads a build to TestFlight.

## GitHub downloads

The release workflow attaches these files directly to the GitHub Release:

- macOS: `.dmg`
- Windows: `.msi`, `.exe`
- Linux: `.deb`, `.AppImage`, `.rpm`
- Android: `.apk`, `.aab`

iOS is intentionally excluded from GitHub assets. Set the repository variable `TESTFLIGHT_PUBLIC_LINK` to show the TestFlight link in release notes.

## Required secrets and variables

Android signing secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded `.jks` file
- `ANDROID_KEYSTORE_PASS`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASS`

Apple signing and TestFlight secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` signing certificate
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`: Developer ID Application identity for macOS signing
- `APPLE_ID`: App Store Connect Apple ID
- `APPLE_PASSWORD`: app-specific password for upload
- `APPLE_TEAM_ID`
- `IOS_PROVISIONING_PROFILE`: optional base64-encoded App Store provisioning profile; if omitted, Xcode automatic provisioning is used

Repository variables:

- `ENABLE_IOS_TESTFLIGHT`: set to `true` to upload iOS on tag releases
- `TESTFLIGHT_PUBLIC_LINK`: public or internal TestFlight invite link shown in release notes
