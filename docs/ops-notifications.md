# Operations notification delivery

ShellBeam routes Komari, integration-linked Probe and local-rule lifecycle
transitions through local, system, and webhook channels. Standalone SSH
ProbeProvider attempts now enter the same durable local alert lifecycle,
independently for metrics and inventory. A real failed attempt can open an alert
without a prior cache; cached data, a cache-fallback telemetry status, locked,
paused or unsupported observations cannot resolve it. Recovery requires a new
successful sample from the same current Vault, host configuration, Provider and
section. Duplicate cache reads do not create collection events.

The application-level subscriber persists each transition before dispatching
its notification. A stale configuration, late Vault switch or failed revision
transaction cannot emit a successful delivery. Publication and persistence
failures show fixed scoped diagnostics in the host view without copying remote
exceptions or changing Provider health. Host cards expose the existing confirmed
local-alert actions and canonical OperationJob audit for these built-in alerts.
The complete isolated Ubuntu X11 metrics incident/recovery journey passed in
[run 39113100124](https://github.com/0xJean/shellbeam/actions/runs/39113100124),
head `11d9f6331a3214c5bb572cd1ff2786a804f6ac32`, merge checkout
`48d6212cfb1a8877514030171847adc0a394205c`. Its downloaded
[artifact 12131831582](https://github.com/0xJean/shellbeam/actions/runs/39113100124/artifacts/12131831582)
confirms actual metrics OS banners, retained metadata jobs, fresh inventory and
both real application restarts, with cleanup and final app exit passed.
Inventory/Komari OS delivery and other desktop environments still need their
own evidence. This result does not claim a person read a notification;
local-service or test-button cases alone do not establish Probe metrics delivery.
Built-in SSH alert titles include their actual host name so different hosts'
metrics/inventory incidents can be distinguished. Grid/List views expose the
canonical evaluation state and original sampling time for each section even
when no incident is open. Evidence older than the shared 180-second evaluation
freshness window becomes unknown; missing, invalid or future timestamps never
borrow a current UI refresh time.
Recovery notifications keep their independent channel
policy. Notification delivery is separate from alert health and OperationJob
completion: an accepted send does not prove that the operator saw it or that a
remote operation succeeded.

## System channel

The desktop app uses three narrow Rust commands: permission status, an explicit
permission request, and send. Only the main app webview can call them. The send
command accepts bounded title/body text, checks permission again, and returns
fixed error codes. Remote embedded webviews do not receive a notification API.

The desktop path does not use the notification plugin's unconditional permission
grant or asynchronous send that discards backend errors:

- macOS uses `UNUserNotificationCenter` to read actual authorization, request it
  only from the explicit settings action, and await the add-request callback.
  The bundle identifier must match the embedded app identifier. An unbundled
  development executable reports unavailable instead of impersonating Terminal.
  UserNotifications is weak-linked and class availability is checked before use;
  older supported macOS versions without this framework report unavailable
  instead of failing at process startup. The app's minimum macOS version is not raised.
- Windows uses this application's notifier identity, reads its actual OS setting
  and propagates the `Show` result. A denied setting cannot be overridden by an
  application prompt; the user changes it in Windows notification settings.
- Linux uses real Freedesktop D-Bus requests with a bounded method timeout. A
  missing notification daemon is unavailable. Since the protocol has no per-app
  permission query, an available daemon produces a system-managed/unknown status,
  never a fabricated grant. Sending is allowed in that state and awaits the
  daemon's notification ID. It does not trigger a permission prompt.

OS callback waits run outside the UI thread. Mobile targets retain their native
notification plugin permission flow; they are not covered by desktop acceptance.

Browser previews use the Web Notification API. A native backend error never
falls back to the browser API. Background alert delivery does not prompt for
permission. Use **Settings → Notifications → Allow system notifications**, then
**Send test notification** to verify the configured environment. The test uses
fixed translated text, records its outcome, and does not send a webhook.

A successful desktop result means that the OS API acknowledged the request. OS notification
settings, focus modes, and native transport behavior can still suppress a banner;
this is not a read receipt. Packaged builds should be checked on each supported
OS before release. Permission and backend acceptance are separate from an actual
banner, notification-center entry or read receipt.

Linux CI runs two explicitly enabled native tests on independent private D-Bus
sessions: delivery without a notification daemon must fail, and a real `dunst`
process must acknowledge delivery. The test bus disables notification-service
auto-activation, and the positive test uses Xvfb and cleans up its own daemon.
These tests exercise the production D-Bus adapter; they do not prove visible
desktop presentation. Helper/frontend tests separately cover permission guards,
late backend failures, XML/text bounds and safe error codes.

The installed Ubuntu X11 GUI gate additionally exercises the actual test button
with an owned, version-pinned dunst. Run 39101718712 passed normal visibility,
paused acceptance without display, visibility after resuming the same queued
message, and unavailable-daemon diagnostics. Exact banner OCR and real window
counts are retained with controlled screenshots. Later run 39106223515 also
verified actual direct/ProxyJump service-opening banners, direct cancellation
without a mutation, a single confirmed restart and its real recovery banner.
It failed at the via-host Services row click before completing that route.
That run did not establish the full two-route restart journey or independent
SSH Probe failure/recovery delivery; later complete evidence is recorded below
and in `ops-ui-live-validation.md`.

Run 39108730917 subsequently passed the complete direct/ProxyJump Local Service
journey, all four lifecycle banners and no replay after the first actual app
restart. It also observed six real independent SSH Probe failure/recovery
banners with full OCR. The run stopped at inventory-summary readiness before
the final Probe notification counter and second restart, so that run did not
establish the larger journey.

The seventeenth installed-app run, 39113100124, subsequently passed the complete
service and independent metrics journeys together. It verified six actual
metrics banners across the direct, via and collateral jump profiles, full
title/body OCR and their downloaded PNG hashes; six linked target-host metadata
OperationJobs; three real inventory refreshes with newer original sample times;
and a second actual app restart recovering those jobs and three fresh metrics
observations. The four original service jobs and both fresh service observations
were rechecked after that restart.

The System channel's aggregate delivered count was six at the start of the Probe
journey and 16 after settlement, including other legitimate notifications. The
final 16 was stable for five seconds before restart and unchanged for five seconds
after it; this does not assert an aggregate increase of only six. The separate
metrics daemon retained exactly six history entries, zero displayed and zero
waiting, with no replay. The bounded report records success, cleanup passed and
confirmed final app exit. `inventoryLifecycleVerified`, `komariLifecycleVerified`
and `readReceiptVerified` remain false: fresh inventory does not establish visible
inventory notifications, Komari delivery or a person's receipt. macOS/Windows,
other Linux desktops and mobile/device presentation remain unaccepted by this
isolated Linux result.

## Delivery diagnostics

Local journals retain at most 1,000 successful deliveries and 1,000 attempts per
integration. Attempts contain only an opaque event/channel key, bounded audit ID,
channel, outcome, fixed reason code, and timestamp. They never contain title/body,
webhook URLs, remote output, arbitrary sink errors, or provider payloads. Generic
events without audit IDs use hashed fallback keys.

Settings and the alert panel show the most recent channel outcome, last attempt,
successful sends, and events whose latest attempt failed or was blocked. A
successful retry supersedes the corresponding failure. Policy and deduplication
skips do not hide prior failures. Diagnostic history may include expired or
superseded events that no longer qualify for retry.

Settings refreshes after same-window writes, storage events, foreground return,
and focus. Older successful-delivery-only journals remain readable.

## Bounded retries

Host refresh and the alert dashboard may retry a failed channel from a durable
attempt even when no new Probe/Komari lifecycle event arrived:

- Only the exact retained audit ID is eligible, and only while it is the newest
  lifecycle transition for that alert.
- A channel that already accepted the event is never replayed by the retry path.
- Failed/unavailable attempts retry no more often than once per 60 seconds, with
  at most three additional attempts and a 24-hour age limit from the first try.
- Current enabled/severity/recovery/channel policy still applies.
- Historical audit rows without a failed attempt and newly enabled channels do
  not create a retry backlog.
- Per-integration dispatch is serialized within the app process. This is not a
  distributed exactly-once guarantee across independent app processes.

The alert dashboard also discovers the latest recent lifecycle transition from
MCP/local persistence when it has no delivery attempt yet (within the last 24
hours and the latest sync/action boundary). Once seen, enabling a new channel
does not backfill that old event.

Retries occur during app refresh; no notification daemon runs after app exit.
Webhook requests abort after 10 seconds, omit credentials, reject redirects,
and report fixed failure reasons. Retrying a notification never replays an
OperationJob or remote command.
