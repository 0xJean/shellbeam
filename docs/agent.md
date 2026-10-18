# Optional ShellBeam Agent

The optional agent is a real standalone Rust collector. It reads local CPU, memory, root filesystem, network counters, load, uptime, OS/kernel and a bounded tool/user-service inventory on Linux and macOS. It never runs arbitrary remote commands, opens a listening port, contacts a server or receives SSH/Vault credentials. Missing counters remain `null`; inventory is explicitly partial. The desktop reads its latest observation over the existing authenticated SSH/ProxyJump connection.

## Runtime and data

- User executable: `~/.local/bin/shellbeam-agent` (0755).
- Private state: `~/.local/share/shellbeam-agent` (0700), `status.json` and `history.jsonl` (0600).
- Collection interval: 60 seconds. The daemon continues independently of ShellBeam, collecting at most 1,440 local observations and 16 MiB of JSONL history. The oldest samples are removed first. Restarts retain history. A process lock prevents duplicate collectors.
- Latest status contains original sample time, heartbeat TTL, source version, capabilities, metrics and inventory. Stale status is offline; unreadable/unsupported values remain unknown.
- The desktop's lifecycle scheduler imports the actual observations into canonical ProbeProvider persistence. These can be read after restarting ShellBeam. It does not manufacture samples for the period when SSH is unreachable.
- The desktop currently imports the latest `probe/status.json` observation, not the remote `history.jsonl` backlog. Remote history survives a desktop outage and can be read with the agent's `history --json` CLI, but reconnecting does not automatically fill that interval in desktop charts.
- The daemon needs only the current user's read permissions. It discovers user systemd services, not privileged services, container workloads, secrets, environments or process command lines. There is no cloud upload or telemetry sink.

## Build and inspect without installing

```sh
cargo build --manifest-path agent/Cargo.toml --release --locked
agent/target/release/shellbeam-agent collect --json
agent/target/release/shellbeam-agent daemon --state-dir /tmp/shellbeam-agent-test --interval-seconds 5
# In another terminal:
agent/target/release/shellbeam-agent probe --json --state-dir /tmp/shellbeam-agent-test
agent/target/release/shellbeam-agent history --json --state-dir /tmp/shellbeam-agent-test --limit 10
```

Stop a foreground daemon with Ctrl+C. `probe` reads the daemon's status; it does not run a substitute live collection or pretend an absent daemon is installed.

## Explicit user service lifecycle

The Workspace probe panel shows commands/permissions before confirmation. For a first installation, it downloads a signed artifact to the desktop, verifies digest and Ed25519 artifact/release signatures, uploads via SFTP/ProxyJump, and atomically activates it. A pre-existing executable is never overwritten without the expected pre-change hash. Installation is successful only after a new heartbeat from the service.

The installed binary provides these explicit commands:

```sh
"$HOME/.local/bin/shellbeam-agent" install --json --path "$HOME/.local/bin/shellbeam-agent"
"$HOME/.local/bin/shellbeam-agent" service status --json
"$HOME/.local/bin/shellbeam-agent" service restart --json
"$HOME/.local/bin/shellbeam-agent" upgrade --json --path "$HOME/.local/bin/shellbeam-agent"
"$HOME/.local/bin/shellbeam-agent" uninstall --json --path "$HOME/.local/bin/shellbeam-agent"
```

`upgrade` activates the binary already placed by the signed artifact flow; it never downloads or executes an unsigned remote installer. All Workspace mutations require confirmation and create OperationJob audit records. Failed activation restores the exact pre-change executable and reactivates it; an unverified rollback remains unknown and requires manual repair.

Linux uses `~/.config/systemd/user/shellbeam-agent.service` with no new privileges, private tmp, read-only home/system and state-directory write access. An active user systemd manager is required. An administrator may explicitly enable linger for the account when collection must survive logout or reboot without login; ShellBeam never changes that policy or runs sudo. Unsupported user namespaces/service managers fail installation rather than silently substituting a foreground process.

macOS uses `~/Library/LaunchAgents/app.shellbeam.agent.plist` with launchd RunAtLoad/KeepAlive. It runs in the logged-in user's session and stops at logout. It continues when the ShellBeam application exits. Windows, mobile targets and other remote operating systems are not supported agent targets; they are rejected during platform selection.

Uninstall stops the user service, removes its service file and executable, and verifies removal. Local history is retained by default. `uninstall --purge` also deletes the default agent state directory; it accepts no arbitrary purge path.

## Signed artifact publication

`.github/workflows/agent-release.yml` builds Linux x86_64/aarch64 and macOS x86_64/aarch64 artifacts, runs native daemon tests and signs a release catalog. The final job creates a GitHub **draft** for human release review. It is not an unattended upgrade mechanism.

The PR agent workflow also builds all four release targets without signing keys or publishing assets. These compile checks are separate from the native Linux/macOS collection and real user-service lifecycle tests.

Configure the protected `agent-release` GitHub environment with two separate Ed25519 private keys, `AGENT_ARTIFACT_SIGNING_KEY_PEM` and `AGENT_RELEASE_SIGNING_KEY_PEM`. Generate and retain keys offline, for example:

```sh
openssl genpkey -algorithm Ed25519 -out artifact-private.pem
openssl genpkey -algorithm Ed25519 -out release-private.pem
openssl pkey -in artifact-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A
openssl pkey -in release-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A
```

Store only the raw 32-byte base64 public keys in ShellBeam settings. Never put private keys in the repository, manifest, desktop settings or agent host. The publisher refuses missing/non-Ed25519 keys. Its canonical signing formats match `shellbeam-agent-artifact.ts` and `shellbeam-agent-release.ts` and protect artifact URL, exact hash, size, version, platform, channel, expiry and rollout.

The signing keys must be distinct; the publisher rejects the same key for both roles. The workflow must exist on the default branch before GitHub allows a manual dispatch. Its inputs include `version`, `channel`, integer `rollout_percentage` (0–100, default 100), and optional `previous_hashes` JSON. Each previous hash belongs to a specific artifact ID, for example `{"shellbeam-agent-linux-x86_64":"<64 hexadecimal characters>"}`. Unknown artifact IDs and malformed hashes are rejected. A partial map pins only the supplied targets; omitted targets retain the manually confirmed pre-change hash guard. Rollout and previous hashes are included in the release signature. Rollout eligibility never authorizes installation by itself.

For an offline publisher invocation, pass the same options as `--rollout-percentage 25 --previous-hashes '{"shellbeam-agent-linux-x86_64":"<64 hexadecimal characters>"}'`. Keys are read only from the two signing environment variables above. Tests create ephemeral test keys and fixture bytes; they do not configure a production trust root or prove that a production release was published. Draft assets are not anonymously downloadable, so end-to-end desktop download acceptance requires an explicitly approved, accessible HTTPS source or publication of a reviewed release.

After reviewing and publishing the draft:

1. In Settings → Agent release policy, enable the channel, enter the HTTPS URL of `release-catalog.json`, trust the two independently verified public keys and configure allowed download hosts.
2. For GitHub-hosted assets, allow `github.com` and `release-assets.githubusercontent.com` (or the precise CDN host used by your release). Every HTTPS redirect is validated; no cookies or authorization are sent. A changed CDN host requires updating the explicit allowlist.
3. Open the host Workspace probe panel and load a signed release. The panel checks the remote OS/architecture, channel, preview opt-in, release expiry, version constraints and both release/local rollout cohorts.
4. Review version, hash, commands and permissions, then explicitly install or upgrade.

Production Tauri downloads use a bounded native HTTPS client to avoid WebView CORS restrictions. Browser-only development uses fetch with redirects disabled and requires a CORS-enabled static host. Native downloads allow at most five redirects, 30 seconds and 32 MiB per artifact; catalogs are limited to 512 KiB and 64 entries. Artifact bytes and signatures are not put in the audit journal.

A release's `previousSha256` can pin a known upgrade source. When omitted for a manually confirmed upgrade, the desktop reads the installed executable's hash first and guards the atomic replacement against changes. There is no background auto-install or auto-upgrade.

## Verification

```sh
cargo test --manifest-path agent/Cargo.toml --locked
cargo clippy --manifest-path agent/Cargo.toml --all-targets -- -D warnings
node --test agent/scripts/publish-release.test.mjs
npx vitest run src/lib/shellbeam-agent*.test.ts
```

The daemon integration test starts a real collector without a desktop process, rejects a duplicate daemon, verifies real metrics/inventory, stops/restarts it and checks retained bounded history. Artifact activation tests execute the generated shell plan, force a new binary to fail activation and verify restoration of the exact old binary. The dedicated agent CI also runs the real Linux user service: installs it without sudo, verifies a new daemon heartbeat, upgrades/restarts it, reads retained history and verifies uninstall/purge. The CI runner prepares its own user manager explicitly; the installer never changes linger. The isolated macOS launchd smoke was also run locally: a unique service label and private temporary state use the real generated plist to verify activation, restart, retained history and confirmed unload. Packaged native OS notification appearance and production signed-release installation still need platform acceptance.
