# Installed Linux Ops UI acceptance

This gate runs the actual release Debian package on a disposable GitHub-hosted
Ubuntu 22.04 runner. `tauri.ops-ui.conf.json` changes only the installed binary
filename to avoid collisions; the application identifier, native IPC, encrypted
Vault, transport, persistence and notification implementations stay unchanged.
It uses the external, pinned `tauri-driver` 0.1.5 and Ubuntu's WebKitWebDriver,
following the [official Tauri WebDriver setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/).
No automation plugin, embedded listener, JavaScript evaluation, mocked invoke,
pre-seeded app database, localStorage write or fake confirmation is used.

## Journey and independent evidence

The runner initializes a private Personal Vault through the UI, saves three
fixture-generated host credentials, configures the jump reference, and verifies
each actual host-key prompt against an independently generated fingerprint.
Direct and jumped targets have separate loopback SSH endpoints and separate
initially failed systemd services. The endpoints share the runner's Linux kernel.

The GUI journey creates real local service rules and waits for real observations.
From the abnormal host card it clicks the visible Services button, selects the
failed unit and requests its actual status: three physical clicks, without
counting a native dropdown's open-and-select as one interaction. It then
dismisses a real confirmation, then explicitly accepts a restart confirmation.
An independent, pinned SSH observer checks the service state, actual start counter
and start timestamp: cancellation must change none of them, and confirmation must
produce exactly one new start and an active service. This observer never modifies
the application's known-hosts store or replaces the UI transport.

The same-host OperationJob audit is read through the UI, followed by confirmed
application exit, a new app process using the same isolated profile, actual Vault
unlock and retained audit checks. Diagnosis-step and audit assertions fail the
gate; an absent dependency, missing assertion or skipped case is not a pass.

## Linux notification presentation

The UI's explicit system-channel test button sends through the production native
D-Bus adapter to an owned dunst 1.7.3 process on a private bus. Only the fixed,
credential-free English test message is allowed to display in the owned daemon.
Ubuntu 22.04's packaged dunst is 1.5.0 and lacks the required displayed/waiting
counts. The gate builds upstream commit
`c8c415a8d4520d552ff3d71b9388d88044036068` after verifying its archive SHA-256,
keeps the matching daemon and control script in a private runner-owned directory,
and checks their version and ownership before use. It neither replaces the
system package nor installs notification activation services.

The checks distinguish normal display, paused acceptance without display,
unpausing the same queued message, and unavailable delivery after confirmed daemon
exit. Visible evidence requires both a mapped X11 daemon window and OCR of the
actual root framebuffer's banner rectangle. A WebView screenshot, successful IPC
call or D-Bus notification ID alone cannot satisfy the display assertion.
Linux permission remains system-managed/unknown. These explicit test-button
checks do not prove real incident-notification policy, delivery or read receipts.

## Real service-alert delivery and restart checks

The extended journey saves the real System-only opening and recovery policy
before creating either service rule. A separate owned daemon displays only the
two fixed fixture rule titles and their exact `opened` / `resolved` bodies.
Each actual failed-service observation and later confirmed recovery requires its
own mapped OS banner, bounded root-framebuffer crop and exact OCR match. The
already-verified banner is then closed. Channel counters and daemon history must
show exactly four accepted lifecycle deliveries, independently of the explicit
test-button cases.

After confirmed application exit, the runner records the real wall-clock restart
boundary before launching the new process. Unlock and audit recovery must also
observe both rules healthy with actual collection timestamps at or after that
boundary. Only then can unchanged delivery counters and empty displayed/waiting
queues establish that the new process did not replay the notifications. Merely
waiting or reading old healthy caches cannot satisfy that assertion. Notification
metadata is retained in the WebView's bounded local delivery ledger; it is not
described as SQLite OperationJob storage.

These added assertions require their own successful exact-commit CI result.
They cover local service rules, not real Komari alert delivery or ProbeProvider
failure/recovery delivery, and do not claim that a person read a banner.

## Isolation and cleanup

Root privileges are restricted to disposable-fixture setup and teardown. The app,
WebDriver, Xvfb, private D-Bus session and notification daemon run under the
existing ordinary runner user. Private XDG directories isolate the app profile;
HOME is not overridden and the WebKit sandbox is not disabled. The script refuses
ordinary desktops, self-hosted runners, other operating systems and implicit runs.

Only uniquely owned systemd units, SSH endpoints, keys and runtime directories
are created. The final cleanup verifies owned cgroups and service removal before
deleting private state. The installed fixture package is removed independently.
Cleanup failure fails acceptance and retains private state when needed.

Artifacts contain only a bounded redacted JSON report and controlled notification
PNG screenshots after credential forms are closed. Passwords, private keys, Vault
databases, full DOM, OCR text, remote output and raw driver logs are not uploaded.
The report records both the PR head and the actual checked-out merge commit.

## Execution status and remaining scope

The first actual [UI run 39098763837](https://github.com/0xJean/shellbeam/actions/runs/39098763837)
tested head `db9933af748728736a46bf6e046ad2f17b3656b6`, merge checkout
`3fd812effd2d04e7468977a01875c4be2e4ec509`. It built and installed the release
package, started the real app and initialized a fresh Vault. Subsequent host setup
timed out. The redacted report records `success: false`, `cleanup: passed`,
confirmed application exit and no exported screenshots. Notification, incident
and restart assertions were not reached; this run is not an accepted GUI journey.

The second [UI run 39099428247](https://github.com/0xJean/shellbeam/actions/runs/39099428247),
head `dcdef130bd9f0c24b3c6de68b655b2234999a74f`, independently authenticated all
three pinned SSH endpoints, then failed during initialization with a genuine
`element not interactable` response. Cleanup and confirmed app exit passed again.
The next correction waits for the actual native `dialog[open]` and visible,
enabled controls before issuing each interaction once. It never clicks Welcome
under a pending modal, retries a submitted write or substitutes app state.

The third [UI run 39100046447](https://github.com/0xJean/shellbeam/actions/runs/39100046447),
head `8511b4f5c3a7a6e861b346011382143a9083adff`, completed actual Vault
initialization and Welcome dismissal. It refused to save the first host because
the multiline private-key input failed its exact UI roundtrip assertion. No key,
credential form image or raw error was exported; cleanup passed. The keyboard
adapter now uses the standard W3C virtual Enter key for textarea line breaks,
retains genuine editor/input events and still requires the exact roundtrip.

The fourth [UI run 39100444727](https://github.com/0xJean/shellbeam/actions/runs/39100444727),
head `a46d34196a91c8f34e0fca74fbae5f311dec5922`, merge checkout
`056790fcb5a7a93f49bad64c2f4162e61cbd2c3e`, passed actual Vault initialization,
all three exact private-key form roundtrips, individual fingerprint review and
real terminal connections for the jump, direct and ProxyJump hosts. Both local
service rules reached active through native collectors. It then failed before
notification presentation at `ops_ui_notifications_unsupported_daemon_version`;
no screenshots were exported. The report confirms `success: false`,
`cleanup: passed` and application exit. Incident operations and restart recovery
were not reached and remain unaccepted.

Local service alerts and HTTP/TCP checks now share the OperationJob route
classification, including saved `jumpHostId` references without copied jump
addresses. The GUI additionally requires the matching alert route while active,
after recovery and after app restart; a successful jumped SSH connection cannot
mask an alert incorrectly labeled direct.

The fifth [UI run 39101144044](https://github.com/0xJean/shellbeam/actions/runs/39101144044),
head `238536f8b7f66d47a57cb09c76fd9cf919ea28df`, merge checkout
`f4aabcaa5356996009bdb6524e32ce635078d169`, built the checksum-pinned daemon,
repeated the real Vault and connection checks, and reached the first actual OS
banner. Its controlled screenshot visibly contains the complete fixed title and
body, but automated OCR failed with `ops_ui_notifications_visible_text_missing`.
The failed assertion is retained: `success: false`, `cleanup: passed`, confirmed
application exit and one safe PNG. Paused/resumed/unavailable notifications and
incident/restart assertions were not reached. A visible first banner does not
make the entire notification or GUI journey pass.

Host-save, trust-prompt and tab-state checkpoints remain credential-free. Local
syntax, protocol and safety-helper tests are not substitutes for an executed
Linux GUI pass. Exact commit CI results must be checked before counting the
journey or Linux notification presentation as accepted.

Even a successful isolated Linux run does not prove macOS/Windows notification
presentation, mobile browser/device behavior, an external Komari deployment,
public-CA domain-control renewal or production Agent distribution. Those remain
separate entries in `terminal-ops-acceptance.md`.
