# Optional ShellBeam Agent

The optional agent is a real standalone Rust collector. It reads local CPU, memory, root filesystem, network counters, load, uptime, OS/kernel and a bounded tool/user-service inventory on Linux and macOS. It never runs arbitrary remote commands, opens a listening port, contacts a server or receives SSH/Vault credentials. Missing counters remain `null`; inventory is explicitly partial. The desktop reads its latest observation over the existing authenticated SSH/ProxyJump connection.

## Runtime and data

- User executable: `~/.local/bin/shellbeam-agent` (0755).
- Private state: `~/.local/share/shellbeam-agent` (0700), `status.json` and `history.jsonl` (0600).
- Collection interval: 60 seconds. The daemon continues independently of ShellBeam, collecting at most 1,440 local observations and 16 MiB of JSONL history. The oldest samples are removed first. Restarts retain history. A process lock prevents duplicate collectors.
- Latest status contains original sample time, heartbeat TTL, source version, capabilities, metrics and inventory. Stale status is offline; unreadable/unsupported values remain unknown.
- The desktop's lifecycle scheduler imports the actual observations into canonical ProbeProvider persistence. These can be read after restarting ShellBeam. It does not manufacture samples for the period when SSH is unreachable.
- After a successful live probe, the desktop also imports retained `history.jsonl` observations through bounded `history-page` requests. Each host pass uses a fixed heartbeat cutoff and at most four pages (64 points by default, at most 100 points / 192 KiB per page). The next scheduler tick continues from the committed cursor; missing periods and expired sampling gaps are never fabricated.
- History progress has its own Vault/host/provider/node cursor. SQLite appends the page and advances that cursor atomically, with revision checks and an unlocked-Vault guard. Backfill never overwrites an existing sample or advances the latest live snapshot. Failed, cancelled or conflicting imports retain the last committed progress. Clearing a host/provider's history also clears its corresponding import cursors.
- Workspace shows session backfill outcome separately from its last durable progress. Older agents without `history-page` report history unavailable and require an explicitly confirmed upgrade; there is no unbounded legacy-history fallback. A completed pass covers the valid retained remote window, not samples already removed by the agent's 24-hour / 16 MiB retention.
- `identity.json` stores a stable private installation ID across daemon restarts and hostname changes. Existing installations retain their previous status ID once during migration; unrelated node/source histories are not silently merged. The original `history --json` CLI remains available for manual inspection.
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

Consent stays bound to the initiating Vault, host and referenced jump configuration throughout staged work. Download/verification, home-directory and previous-hash reads recheck that scope before the first remote mutation; staging preparation and SFTP upload recheck it before activation. A scope change before any mutation cancels the confirmed job. After a mutation may have been sent, a lost scope produces `unknown` and does not issue cleanup, rollback or follow-up commands against a newly resolved route. An actual completed activation keeps its known command outcome, but cannot project fresh health or lifecycle state into a changed host context. Failed or uncertain staging preparation never proceeds to upload or activation.

Linux uses `~/.config/systemd/user/shellbeam-agent.service` with no new privileges, private tmp, read-only home/system and state-directory write access. An active user systemd manager is required. An administrator may explicitly enable linger for the account when collection must survive logout or reboot without login; ShellBeam never changes that policy or runs sudo. Unsupported user namespaces/service managers fail installation rather than silently substituting a foreground process.

macOS uses `~/Library/LaunchAgents/app.shellbeam.agent.plist` with launchd RunAtLoad/KeepAlive. It runs in the logged-in user's session and stops at logout. It continues when the ShellBeam application exits. Windows, mobile targets and other remote operating systems are not supported agent targets; they are rejected during platform selection.

Uninstall stops the user service, removes its service file and executable, and verifies removal. Local history is retained by default. `uninstall --purge` also deletes the default agent state directory; it accepts no arbitrary purge path.

## Signed artifact publication

`.github/workflows/agent-release.yml` builds Linux x86_64/aarch64 and macOS x86_64/aarch64 artifacts, runs native daemon tests and signs a release catalog. The final job creates a GitHub **draft** for human release review. It is not an unattended upgrade mechanism.

The PR agent workflow also builds all four release targets without signing keys or publishing assets. These compile checks are separate from the native Linux/macOS collection and real user-service lifecycle tests.

### Proposed production trust and custody

This is the selected release plan, ready for review. It does not record an environment, signing keys or a production release as already provisioned. Creating secrets, configuring repository protection, merging the workflow, signing production artifacts and publishing a release remain separate actions requiring explicit authorization. Private keys, backup passwords, access tokens and SSH/Vault credentials must never be sent in chat or included in a PR, terminal transcript or CI artifact.

Use two independent Ed25519 key pairs:

| Role | GitHub environment secret | Signed content |
| --- | --- | --- |
| Artifact | `AGENT_ARTIFACT_SIGNING_KEY_PEM` | Exact artifact ID, version, OS/architecture, HTTPS URL, byte size and SHA-256 |
| Release | `AGENT_RELEASE_SIGNING_KEY_PEM` | Release ID/channel, dates/expiry, rollout and per-target predecessor hash, bound to the artifact identity/version/hash |

The publisher rejects reuse of the same key for both roles. This separates signing roles; it is not threshold signing or two independent signing services. The approved signing step receives both private keys. Keep them only as environment-scoped secrets, never repository/organization-wide secrets available to ordinary PR workflows.

The owner generates the two pairs on a trusted offline machine in a private directory outside any checkout, with shell tracing and recording disabled. For example, the following commands are documentation only and have not been executed for production:

```sh
umask 077
openssl genpkey -algorithm Ed25519 -out artifact-private.pem
openssl genpkey -algorithm Ed25519 -out release-private.pem
openssl pkey -in artifact-private.pem -pubout -outform DER -out artifact-public.der
openssl pkey -in release-private.pem -pubout -outform DER -out release-public.der
tail -c 32 artifact-public.der > artifact-public.raw
tail -c 32 release-public.der > release-public.raw
openssl base64 -A -in artifact-public.raw
openssl dgst -sha256 artifact-public.raw
openssl base64 -A -in release-public.raw
openssl dgst -sha256 release-public.raw
```

Retain encrypted offline backups in two separately controlled locations; keep backup-unlock credentials separately and verify restoration offline before enabling a channel. Record each role, creation date, custodian and SHA-256 fingerprint of the **raw 32-byte public key**, rather than hashing its base64 text or PEM file. Compare these public fingerprints with the known offline record through an established channel separate from the artifact download location. With an existing second maintainer, both people compare them independently; a solo owner can compare the two independent channels without claiming a second person's approval. Public keys and fingerprints may be documented; private material may not. Only the raw 32-byte base64 public keys belong in ShellBeam settings. A catalog fetched from a new endpoint cannot authorize its own replacement trust keys.

### Protected signing and manual release review

For this personal repository, the selected baseline is **single-maintainer release review**: the owner reviews the source/input plan, manually dispatches from the default branch, checks signed output and separately publishes the reviewed draft. This does not claim two-person approval and does not require adding a collaborator.

Before the first production-key run, the owner verifies `agent-release` allows the exact current default **branch** only, with no tags or wildcard branches. Review workflow/publisher changes through the normal branch process and store the two private keys only as environment secrets. Record the chosen owner-reviewed SHA, version, channel, rollout and per-target predecessor hashes before dispatch. Never remove or weaken protection that is already configured merely to run this plan.

If an existing trusted second maintainer and the repository's plan support it, the recommended stronger mode adds a required reviewer, prevents self-review and disallows administrator bypass. GitHub needs one listed reviewer, not unanimous approval. This mode requires a person other than the dispatcher; it is an optional stronger custody arrangement rather than a prerequisite for a solo project.

GitHub limits environment/reviewer features by plan and repository visibility. Environment settings must be inspected before adding secrets: `environment: agent-release` alone does not install branch/review protection, and a missing environment can be created automatically without rules. If environment branch restriction or secret isolation is unavailable, keep production keys out of Actions and select the already supported offline publisher with owner-reviewed output instead. Do not silently use repository-wide keys or disable existing gates. See [GitHub environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).

The workflow's no-secret validation job rejects non-default-branch/tag dispatches before checkout, then runs publisher tests with ephemeral test keys. All four builds depend on it. The signing job has its own default-branch condition and uses the configured environment; only its signing step receives private keys. The draft-creation step alone sets `GH_TOKEN`; the signing job's GitHub token nevertheless has job-wide `contents: write` permission for draft creation. In solo mode, the owner reviews the chosen SHA's existing CI and version/channel/rollout/predecessor inputs **before dispatch**; after this run's checks/builds succeed, signing follows automatically. There is no additional human pause between build and signing unless an environment reviewer rule is configured. In the stronger mode, that reviewer also checks the immutable run SHA and actual build results before granting environment access. The workflow creates a draft and does not publish it. After signing, inspect all four artifact hashes/sizes/URLs and independently verify the catalog's two signature roles before the human publication decision. In solo mode the same owner can perform both decisions; the workflow does not enforce two separate people.

The workflow must exist on the default branch before GitHub allows a manual dispatch. Its inputs include `version` (matching `agent/Cargo.toml`), `channel` (default `preview`), integer `rollout_percentage` (0–100, default 5), and optional `previous_hashes` JSON. Each previous hash belongs to a specific artifact ID, for example `{"shellbeam-agent-linux-x86_64":"<64 hexadecimal characters>"}`. Unknown artifact IDs and malformed hashes are rejected. A partial map pins only the supplied targets; omitted targets retain the manually confirmed pre-change hash guard. Rollout and previous hashes are included in the release signature. Rollout eligibility never authorizes installation by itself.

For the first offline preview invocation, explicitly pass `--channel preview --rollout-percentage 5`; for an upgrade, also pass the applicable `--previous-hashes '{"shellbeam-agent-linux-x86_64":"<64 hexadecimal characters>"}'`. Keys are read only from the two signing environment variables above. Tests create ephemeral test keys and fixture bytes; they do not configure a production trust root or prove that a production release was published. Draft assets are not anonymously downloadable, so end-to-end desktop download acceptance requires an explicitly approved, accessible HTTPS source or publication of a reviewed release.

### First preview and promotion

The first release is an explicitly opted-in `preview` at 5% signed rollout; default clients stay disabled or on `stable`. Do not increase the client-side percentage or change the cohort salt just to make an ineligible host pass. Use eligible disposable test hosts and preserve the signed cohort in the evidence. Increasing to 25% and then 100%, or changing to `stable`, requires a newly signed catalog and another review. Use a new version matching the crate for each run rather than replacing published assets. The workflow uses version-specific `agent-v<version>` tags/releases and `gh release create`, which refuses an existing release; this does **not** enforce tag or release immutability. Before dispatch, confirm the chosen tag/release do not already exist. Before publication, verify the actual tag resolves to the reviewed run SHA: `--target` creates a missing tag but does not validate or move a pre-existing tag. Stop for review on any collision or mismatch; do not move tags or delete/recreate releases as a shortcut. Promotion is based on completed evidence and explicit approval, not elapsed time alone.

GitHub draft assets cannot be downloaded anonymously by the production native client, which sends no credentials. Therefore the first preview needs a reviewed and explicitly authorized **preview publication** before its GitHub URLs can be exercised. If acceptance must precede any public preview, the owner must first approve an accessible HTTPS acceptance host, then use the existing offline publisher's `--base-url` for that exact immutable source; artifact URLs are signed, so copying a GitHub-bound catalog to another host does not change its signed artifact locations. Neither route is implicitly authorized by this plan. Full acceptance precedes stable-draft publication; it cannot be claimed from inaccessible draft assets.

After the relevant source is reviewed and accessible, the tester:

1. In Settings → Agent release policy, enable the channel, enter the HTTPS URL of `release-catalog.json`, trust the two independently verified public keys and configure allowed download hosts.
2. For GitHub-hosted assets, allow `github.com` and `release-assets.githubusercontent.com` (or the precise CDN host used by your release). Every HTTPS redirect is validated; no cookies or authorization are sent. A changed CDN host requires updating the explicit allowlist.
3. Open the host Workspace probe panel and load a signed release. The panel checks the remote OS/architecture, channel, preview opt-in, release expiry, version constraints and both release/local rollout cohorts.
4. Review version, hash, commands and permissions, then explicitly install or upgrade.

On approved disposable hosts, complete the following before promoting to stable:

- First installation: actual native HTTPS download and both signature checks, SFTP staging, explicit confirmation, observed installed version and a new service heartbeat. Exercise a direct host and a saved ProxyJump host; retain same-Vault/host OperationJob and audit references.
- Second-version upgrade: use the target's real previous executable hash, confirm exactly one activation, observe the new version/heartbeat, close the desktop while the service keeps collecting, then reopen and verify retained history backfill.
- Controlled activation failure: use a deliberately failing test artifact/catalog signed by **temporary test-only keys on an isolated client and disposable host**. Verify the previous executable's exact hash and reactivation, or preserve `unknown` if rollback cannot be observed. Never sign an intentionally broken agent with production keys or put it in a production preview catalog. The desktop's production trust configuration is restored and independently checked before further preview testing.
- Uninstall: explicitly confirm, verify service/file removal, and verify the selected history-retention behavior. Retain clean shutdown/cleanup evidence; do not issue implicit sudo, enable linger or rerun an unknown mutation.

Record tested app/build SHA, Agent versions, platform/architecture, catalog and artifact hashes, public-key fingerprints, transport, scoped Job/audit IDs and cleanup outcome, without keys, tokens, database contents or full command output. Native compile checks cover all four release targets; real installation evidence must name the targets actually exercised rather than implying all four were installed. Review the completed report and stable draft before explicitly authorizing stable publication.

Production Tauri downloads use a bounded native HTTPS client to avoid WebView CORS restrictions. Browser-only development uses fetch with redirects disabled and requires a CORS-enabled static host. Native downloads allow at most five redirects, 30 seconds and 32 MiB per artifact; catalogs are limited to 512 KiB and 64 entries. Artifact bytes and signatures are not put in the audit journal.

A release's `previousSha256` can pin a known upgrade source. When omitted for a manually confirmed upgrade, the desktop reads the installed executable's hash first and guards the atomic replacement against changes. There is no background auto-install or auto-upgrade.

### Rotation and revocation

For planned rotation, generate a new independent pair offline, restore-test its encrypted backup, distribute and independently compare the new public fingerprints, then pause channel use while replacing both environment secrets and each participating client's trusted public keys. The current client stores **one key per role**; it has no overlapping trust-set, cross-signing or automatic key-discovery protocol. Resume only after a new signed preview passes download/signature checks and the staged acceptance above. Preserve old public keys and release hashes for historical verification; retire private keys from the signing environment and keep any required archive encrypted offline. Do not delete evidence or silently rewrite existing tags/assets.

For suspected compromise, stop new signing and publication, remove the affected environment secrets and disable Agent release policy in participating clients; remove old trusted keys before accepting replacements. Depublish or mark affected releases as withdrawn through a separately authorized repository action, and communicate affected versions/fingerprints through the independent channel. Neither removing a GitHub asset, lowering rollout, nor catalog expiry revokes a signature already trusted by an offline client. There is no remote revocation list or automatic uninstall/rollback: assess already installed agents, then explicitly authorize repair or removal per host with audit records. Replace compromised keys and re-enable clients only after the new trust material and release have been reviewed.

## Verification

```sh
cargo test --manifest-path agent/Cargo.toml --locked
cargo clippy --manifest-path agent/Cargo.toml --all-targets -- -D warnings
node --test agent/scripts/publish-release.test.mjs
npx vitest run src/lib/shellbeam-agent*.test.ts
```

The daemon integration test starts a real collector without a desktop process, rejects a duplicate daemon, verifies real metrics/inventory, stops/restarts it and checks retained bounded history. Artifact activation tests execute the generated shell plan, force a new binary to fail activation and verify restoration of the exact old binary. The dedicated agent CI also runs the real Linux user service: installs it without sudo, verifies a new daemon heartbeat, upgrades/restarts it, reads retained history and verifies uninstall/purge. The CI runner prepares its own user manager explicitly; the installer never changes linger. The isolated macOS launchd smoke was also run locally: a unique service label and private temporary state use the real generated plist to verify activation, restart, retained history and confirmed unload. Packaged native OS notification appearance and production signed-release installation still need platform acceptance.
