# GitHub CI/CD

ShellBeam has eight GitHub Actions workflows.

| Workflow | File | Runs on | Purpose |
|---|---|---|---|
| CI | `ci.yml` | every pull request, pushes to `main` | Frontend tests and build, Rust and real SSH on three platforms, monitoring extension contract |
| Packaged acceptance | `packaged-acceptance.yml` | see below | Installs the real Linux package and drives four UI journeys |
| Release | `build.yml` | `v*` tags, manual | Builds all platforms and creates a draft GitHub Release. iOS goes to TestFlight instead of being attached as an IPA |
| Optional agent CI | `agent-ci.yml` | pull requests and `main` pushes touching `agent/` | Builds and tests the optional agent |
| Build signed optional agent | `agent-release.yml` | manual, default branch | Signs an optional agent release |
| Compatible monitoring probe lifecycle | `komari-agent-ci.yml` | pull requests touching probe code, manual | Probe install and upgrade lifecycle |
| Monitoring probe release contract | `komari-agent-release-check.yml` | pull requests and `main` pushes touching release files | Probe release contract tests |
| Publish trusted compatible probe | `komari-agent-release.yml` | manual, default branch | Publishes a probe release |

## Packaged acceptance

The `build` job produces one `.deb` and one WebDriver per run. Each suite is a separate job that installs that package, so a failure stays on its own check and **Re-run failed jobs** does not rebuild.

| Check | Journey |
|---|---|
| `Installed Linux app, Vault and Ops UI` | `scripts/ci-ops-ui-live.sh` |
| `Installed app signed agent upgrade and rollback` | `scripts/ci-monitoring-agent-ui.sh` |
| `Installed app probe migration and recovery` | `scripts/ci-probe-transfer-ui.sh` |
| `Installed app extension lifecycle and recovery` | `scripts/ci-extension-ui.sh` |

Which suites run depends on the trigger:

| Trigger | Suites |
|---|---|
| Pull request, push to `main` | Those whose paths changed |
| Pull request from a `release/*` branch | All four |
| `v*` tag push | All four |
| Nightly at 19:17 UTC, on `main` | All four |
| Manual **Run workflow**, on any branch | All four |

The path rules live in `scripts/ci-acceptance-scope.mjs` and are tested by `scripts/ci-acceptance-scope.test.mjs`. A path no rule names runs every suite. When no suite is needed, only `Select acceptance suites` does any work and the others show as skipped. Skipped jobs count as passing, so these checks can be made required without blocking such a pull request.

The nightly run is the safety net for a path rule that is too narrow. GitHub sends its failure notice only to the person who last edited the cron line, and disables schedules after 60 days without repository activity.

## Release flow

1. Update `src-tauri/tauri.conf.json` and `package.json` versions.
2. Push a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Wait for the `Release` workflow and for `Packaged acceptance` on the same tag. Both start from the tag push:
   ```bash
   gh run list --workflow packaged-acceptance.yml --branch v0.1.0
   ```
4. Publish the draft GitHub Release only after all four acceptance checks pass and the attached files and release notes look right. Nothing enforces this order yet: `Release` does not wait for acceptance, so check it by hand.

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
