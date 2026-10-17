# Operations notification delivery

ShellBeam routes Komari and Probe lifecycle transitions through local, system,
and webhook channels. Recovery notifications keep their independent channel
policy. Notification delivery is separate from alert health and OperationJob
completion: an accepted send does not prove that the operator saw it or that a
remote operation succeeded.

## System channel

The desktop app uses `tauri-plugin-notification` through three narrow Rust
commands: permission status, an explicit permission request, and send. Only the
main app webview can call them. The send command accepts bounded title/body text,
checks permission again, and returns fixed error codes. Remote embedded webviews
do not receive the raw notification plugin API.

Browser previews use the Web Notification API. A native backend error never
falls back to the browser API. Background alert delivery does not prompt for
permission. Use **Settings → Notifications → Allow system notifications**, then
**Send test notification** to verify the configured environment. The test uses
fixed translated text, records its outcome, and does not send a webhook.

A successful result means that the backend accepted the request. OS notification
settings, focus modes, and native transport behavior can still suppress a banner;
this is not a read receipt. Packaged builds should be checked on each supported
OS before release. Native integration follows the
[Tauri notification plugin](https://v2.tauri.app/plugin/notification/).

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
