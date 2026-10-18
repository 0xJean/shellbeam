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

The checks distinguish normal display, paused acceptance without display,
unpausing the same queued message, and unavailable delivery after confirmed daemon
exit. Visible evidence requires both a mapped X11 daemon window and OCR of the
actual root framebuffer's banner rectangle. A WebView screenshot, successful IPC
call or D-Bus notification ID alone cannot satisfy the display assertion.
Linux permission remains system-managed/unknown. These explicit test-button
checks do not prove real incident-notification policy, delivery or read receipts.

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

Host-save, trust-prompt and tab-state checkpoints remain credential-free. Local
syntax, protocol and safety-helper tests are not substitutes for an executed
Linux GUI pass. Exact commit CI results must be checked before counting the
journey or Linux notification presentation as accepted.

Even a successful isolated Linux run does not prove macOS/Windows notification
presentation, mobile browser/device behavior, an external Komari deployment,
public-CA domain-control renewal or production Agent distribution. Those remain
separate entries in `terminal-ops-acceptance.md`.
