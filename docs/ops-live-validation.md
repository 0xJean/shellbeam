# Disposable Linux Ops acceptance

The Linux native CI job explicitly runs the production TypeScript Docker and
Sites/SSL operations against real local services. It is separate from unit tests
that supply fixture output. No existing server, Vault or SSH credential is read.

## What the workflow executes

1. Build the native library's `cfg(test)` executable as the ordinary runner user.
   The single `ssh::ops_smoke::tests::ops_live_bridge` test is ignored during
   normal library tests. It is not included in a production binary or registered
   as a Tauri command.
2. On a disposable GitHub-hosted Ubuntu runner only, allocate a private temporary
   directory and three independent loopback SSH servers, each with new host/client
   keys: two targets and one jump server. Verify their exact fingerprints through
   the existing transport. The primary target is reachable directly and through
   the jump server; a mixed batch uses the direct primary and the jumped peer.
3. Build a test container from the installed static BusyBox executable using
   `FROM scratch`, without pulling a business image. Create a dedicated nginx
   site on loopback ports and a real two-SAN OpenSSL certificate. An independent
   HTTPS check uses that explicit test CA and hostname resolution; certificate
   verification is never disabled and the CA is not added to the OS trust store.
   Start a second Docker daemon with private state/socket and no bridge or
   packet-filter changes. Import the exact same local image; same-name containers
   have different immutable IDs and neither daemon can inspect the other's ID.
4. Run the actual `runDockerContainerAction`, `runSiteOperation`,
   `runSiteSslScan`, Workspace SSH helper and `runConfirmedOperation`. The only
   substituted boundaries are Tauri IPC (JSONL to the native test process) and
   the confirmation input. Remote output and OperationJobs are not fabricated.
5. Persist jobs/audits with the same SQLite functions used by the desktop
   commands. Shut down the bridge, verify its process exits and start a new
   process against the same private database to check retained scoped history.
6. Run the actual finite Docker batch API across the two targets. Verify one
   confirmation, independent immutable IDs, scoped child jobs and retained batch
   identity after a bridge restart. Stop only the peer SSH listener after its
   successful mutation; the direct child completes and the peer stays `unknown`,
   with no automatic replay. A rejected batch sends zero remote commands.
7. Use pinned official Pebble/challtestsrv binaries and a fully hash-pinned
   Certbot wheel environment for real private ACME HTTP-01 validation against
   nginx. A fresh transport CA verifies ACME TLS; the independently retrieved
   issuance root verifies nginx HTTPS. No public ACME server, public DNS, OS
   trust-store import or always-valid challenge bypass is used.
8. Invoke the unmodified product Certbot dry-run and renewal commands through
   both routes. Dry-run must preserve the live serial/dates; renewal must change
   the serial and extend expiry. Independently verify both SANs, chain, served
   HTTPS content and served serial. A real post-renewal SSH disconnect leaves
   the job `unknown`, while recovery proves the single issuance was not replayed.

Both routes exercise Docker start/restart/stop/logs, nginx config-test/reload and
site rediscovery, certificate SAN/validity parsing, private-ACME dry-run/renewal,
and rejected confirmations with zero remote calls. No test retries are enabled. Missing dependencies,
skipped live cases, an absent test report or unavailable services fail the gate.

## Isolation and cleanup

`scripts/ci-ops-live.sh` and `scripts/run-ops-live.mjs` reject ordinary desktops
and self-hosted runners. The fixture requires Linux, root inside the disposable
runner, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted` and the explicit
`SHELLBEAM_OPS_LIVE=1` flag. These guards prevent accidental use; they are not a
security sandbox for untrusted code.

The shell fixture owns only its uniquely named containers/images, private Docker
daemon, ACME processes, certificates and nginx configuration. Existing Certbot
configuration/executable or enabled/active renewal timers cause setup to refuse;
the fixture never replaces them. Its own temporary Certbot symlinks are removed
only after exact ownership checks. It restores the original nginx configuration/service state
and removes its resources on exit; unconfirmed cleanup fails the gate and retains
private state. SSH keys and SQLite state stay in private
temporary directories. The bridge releases its own SSH children on shutdown or
stdin EOF. The production store still selects its normal application data path;
the explicit temporary database path is supplied only by the test bridge.

The runner uploads only `linux-ops-live-result`: a redacted JSON summary of
executed assertions and pass/fail counts. It does not upload private keys,
database files, full remote output or the raw Vitest report. The gate requires
actual passing cases and zero skips before marking the summary successful.

## Limits of this evidence

This proves a combined Linux command/SSH/direct/ProxyJump/post-state/SQLite
workflow on isolated endpoints sharing one Linux kernel, rather than independent
machines. It does not exercise a graphical confirmation dialog, desktop
notification presentation, production Vault credential resolution, a user's
external Komari deployment or a public CA's Certbot issuance/renewal. The private
ACME fixture exercises actual issuance/renewal and verified HTTPS deployment;
public trust and real domain-control deployment remain separate acceptance items
in `terminal-ops-acceptance.md`.

## Execution record

The first real run passed on 2026-10-18: [CI 39091612213](https://github.com/0xJean/shellbeam/actions/runs/39091612213),
head `7c98ab0f255a8a5249262f44e02f4950e4845082`, with **8 passed / 0 skipped** and no retries.
The [redacted result](https://github.com/0xJean/shellbeam/actions/runs/39091612213/artifacts/12122144672)
confirms `success: true` and `cleanup: passed`. Its `checkedOutCommit` is GitHub's
PR merge commit `5337042c496b3f743bf7a113b7252d8e64c1b0de`, separate from the run's head SHA.
This evidence belongs to that commit; later changes require their own CI result.
Ordinary frontend tests skip the live cases unless explicitly
invoked by the isolated workflow. A locally skipped test is not a passing live
validation. The runner guard tests can be run locally with
`node --test scripts/run-ops-live.test.mjs`.

The expanded suite contains 16 cases. Its local syntax/type/guard checks and
disabled-mode skips are not Linux acceptance. The private-ACME/mixed-target
execution record must be attached to the exact new PR head after CI runs.
