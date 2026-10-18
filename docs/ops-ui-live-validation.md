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

The sixth [UI run 39101718712](https://github.com/0xJean/shellbeam/actions/runs/39101718712),
head `21187d635947d49574a55690b038c0e7e459b3a8`, merge checkout
`a555a88e8086ac47d770eae1219c1b2ce4b3479a`, passed all four explicit test-button
notification cases. The downloaded report retains `notifications.passed: true`,
with actual daemon counts, mapped-window checks and controlled frame/crop PNGs.
PSM 6 matched the complete title and body in one read; PSM 11 matched neither.
Both modes confirmed absence for paused and unavailable cases. This verifies the
bounded OCR adjustment without changing the required words.

The overall run still failed at
`ops_ui_alert_notifications_invalid_system_delivery_diagnostic` after saving and
remounting the actual alert policy. The subsequent lifecycle, incident and
restart cases were not reached. Cleanup and application exit passed. The next
readiness correction scrolls the inert System diagnostic card into view and
waits for a strictly parsed count; it never turns a missing count into zero.

The seventh [UI run 39102128622](https://github.com/0xJean/shellbeam/actions/runs/39102128622),
head `a954f37cfe2c1fd5a95c288f87482a8d880ee430`, merge checkout
`6769f4cf6cc2b9c5e9d2ff563df750e1a093f316`, again passed all four explicit
test-button cases, but still failed at
`ops_ui_alert_notifications_system_delivery_diagnostic_not_ready`.
Cleanup and confirmed application exit passed. Real service lifecycle delivery,
incident mutations and restart recovery were not reached. The next correction
reads separate actual visible count and outcome spans inside the exact System
card rather than relying on concatenated icon/flex text. It still rejects
missing, hidden, malformed or duplicate fields, and reports only bounded
readiness booleans and lengths on failure. This correction needs fresh CI;
the failed report does not establish the precise rendering cause.

The eighth [UI run 39103821275](https://github.com/0xJean/shellbeam/actions/runs/39103821275),
head `bce00614a6c84578538c260816066ef3dc6642eb`, merge checkout
`dd62525dd8b42aa48cd398259af05791d8e537cd`, passed the saved-policy diagnostics
and both real service-opening notifications with independent X11 counts and
complete title/body OCR. The direct host's actual failed-service diagnosis
passed in three clicks, and the independent observer confirmed the original
start count of one. It then timed out during the first confirmation workflow.
The report still records `success: false`, successful cleanup and confirmed
application exit; cancellation, confirmed mutation, recovery delivery and restart
were not verified. The next runner records fixed ready/click/prompt/respond/settle
boundaries and only fixed categories from the already-visible Services error.
It does not repeat a click, bypass a prompt, or infer consent from a timeout.

Host-save, trust-prompt and tab-state checkpoints remain credential-free. Local
syntax, protocol and safety-helper tests are not substitutes for an executed
Linux GUI pass. Exact commit CI results must be checked before counting the
journey or Linux notification presentation as accepted.

The ninth [UI run 39104588281](https://github.com/0xJean/shellbeam/actions/runs/39104588281),
head `f40ea7b907d0b012b3cc35fbf8a020100d8b06c8`, merge checkout
`b487772174b0161e91d86fbdde5152ae6b765102`, again proved both actual service-opening
banners and the direct three-click diagnosis. The added checkpoints locate its
failure at `ops_ui_service_confirmation_prompt_failed`, after one actual
`workspace-service-restart` click. No visible Services error or cancelled output
was observed. Cleanup and application exit passed; the full journey did not.

Inspection of the installed `tauri-plugin-dialog` 2.6.0 initialization found that
it replaces `window.confirm` with an async function. The old synchronous boolean
test could therefore proceed before any human decision. The shared confirmation
path now awaits an explicit decision and uses an actual application dialog on
desktop/mobile. Cancel is the initial focus; the host/route/action are visible,
destructive file tokens remain exact, and unavailable/busy prompts do not invent
human rejection. A retained scope guard is checked after the running-job write
before sending an operation, including host and referenced-jump changes. Native
fallbacks for standalone consumers also await a strict boolean result. The GUI
journey reads the real same-Vault/host dialog and clicks its response once; it
does not inject consent or treat a missing dialog as success. New CI must prove
this correction and all subsequent steps.

The next installed-app journey preserves the complete service flow and its
first actual process restart, then independently stops/restores the owned direct
SSHD and saved jump SSHD. It requires three profiles' actual metrics failure and
new-sample recovery, six fully visible metrics lifecycle OS banners, confirmed
local-alert metadata jobs, fresh inventory observations before capturing final
delivery counters, and a second real app restart with retained audit IDs and no
notification replay. These are pending acceptance assertions, not live results.
The root controller restores each affected SSHD in `finally`. The Activity UI's
actual native source/status filters and bounded older-page controls are used to
find retained records instead of enlarging the latest-100 window or reading IPC.

The tenth [UI run 39106223515](https://github.com/0xJean/shellbeam/actions/runs/39106223515),
head `31f33a5abc009e2c5eeb1b0f6118f00c8d4f8578`, merge checkout
`6ee63b32d843facf25f7a18e8ba02cc7db8959b2`, passed the actual application confirmation
window on the direct route. Cancellation preserved the independent service
counter at one; acceptance restarted it exactly once to counter two and a fresh
active state. Both canonical jobs were visible in Activity, and the actual
direct recovery OS banner passed complete title/body OCR. The journey then
failed with `element not interactable` while selecting the exact via-host
service row, after verifying that its service state was failed. No second-route
diagnosis, restart or independent Probe acceptance is claimed. Cleanup and app
exit passed. Its main/Agent CI independently passed all 11 checks, and the
downloaded real Ops artifact reports 16 passed, zero skipped and cleanup passed.

The existing Network screenshot cannot establish the failed Services row's
clipping or geometry. The next runner records bounded real W3C element rects
for the row, list, app, window and content area, waits for two identical layout
reads, then performs one actual click and checks both the selected service and
pressed row. On failure it captures only the scoped owned-fixture Services
surface, with no open dialog or nonempty password/textarea controls. An invalid
row rect does not suppress that safe screenshot. There are no retries, forced
scrolls, injected clicks, changed layout or omitted diagnosis steps. This is
readiness and diagnostic evidence; another actual GUI run must determine the
remaining cause and establish a complete pass.

Even a successful isolated Linux run does not prove macOS/Windows notification
presentation, mobile browser/device behavior, an external Komari deployment,
public-CA domain-control renewal or production Agent distribution. Those remain
separate entries in `terminal-ops-acceptance.md`.

The eleventh [UI run 39107634937](https://github.com/0xJean/shellbeam/actions/runs/39107634937),
head `0150e806d4cd067abc93d2bdeb6de9d165451daf`, merge checkout
`d8f5b9e02a7ea16c376bddbc0e71ba588c6ebdfb`, again passed the four real test-button
cases and both real service-opening banners. It failed earlier than the previous
run: geometry collection for the direct Services surface returned `element not
interactable` before any row click. The controlled failure screenshot succeeded
and shows the window's lower edge clipping the service list; the service row,
list and app rectangles were not exported because the diagnostic discarded its
partial result. That screenshot does not identify which rectangle request failed
or establish the earlier via-row click's cause. Cleanup and app exit passed.

The diagnostic correction retains each available rectangle independently and
records only a fixed unavailable marker when the standard rectangle endpoint
returns `element not interactable`. Unavailable geometry is not a replacement
for, or a prerequisite to, the original real click. Invalid rectangles and other
driver errors still fail, and the real selected-service/pressed-row checks and
scoped failure screenshot remain required. No product layout fix or complete
incident pass is claimed from this correction.

The seven Node contract suites pass 104 tests after the diagnostic correction,
including each unavailable field, retained partial geometry after a real click
failure, and rejection of malformed rectangles or unrelated transport errors.
These tests do not replace another installed-app run.
