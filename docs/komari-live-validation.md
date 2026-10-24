# Isolated Komari live contract validation

## PRD 0.5 native offline-rule contract, 2026-10-21

The production `host-notification-rules` adapter was exercised against an
isolated official 1.6.0 executable (upstream commit
`1b76b7ad5bc3de6529bb7f0577069b4ac241fec3`) by `scripts/komari-live-smoke.mjs`.
It reads `/api/admin/notification/offline` and posts only
`[{ client, enable, grace_period }]` to `/api/admin/notification/offline/edit`.
The supported contract is based on the official
[1.6.0 notification handler](https://github.com/komari-monitor/komari/blob/1.6.0/web/rpc/jsonrpc/admin.notification.go)
and [model](https://github.com/komari-monitor/komari/blob/1.6.0/database/models/notification.go).
Runtime fields such as `client_info` and `last_notified` are neither saved nor
written. Node creation identity is checked through the existing metadata adapter.

The smoke verified disabled/90 seconds, enabled/120 seconds, and a separate
external edit to disabled/180 seconds. The adapter read back exact values and
the same node identity. Its safe report records `offlineRuleWriteReadback: true`
and `externalOfflineRuleReadback: true`; existing metadata, authentication,
sampling and history checks also passed. Global notifications were disabled,
no external channel was configured, and the isolated process/data were removed.
This proves the rule API contract, not message delivery or actual desktop Vault
interaction. The editor supports only verified 1.6.x servers; there is no CAS,
so preflight/readback cannot eliminate concurrent third-party write races.

The following setup records are historical observations. PRD 0.5 is replacing
daily server-page tasks incrementally with native ShellBeam controls; it does
not claim that all initialization or channel management has been replaced yet.

## First-time desktop setup

The desktop console already uses ShellBeam's own browser window. In Settings →
Komari, save the server name and base address with the API key left empty, then
choose **Open Komari console**. Complete the server's installation wizard and
sign in there; an external browser is not a desktop prerequisite. If protected
metrics require an API key, create one in that console and separately save it
in the active Vault. Console login does not automatically authorize API sync,
and API keys are never attached to console URLs. Mobile retains the system
browser handoff.

For a loopback-only remote instance, keep an explicitly configured SSH local
forward active and save its local endpoint. The console does not create a
tunnel itself. A forwarded HTTP setup verifies neither public TLS nor mobile
reachability. User-controlled credential setup, actual console rendering and
subsequent metrics/mapping checks must be recorded separately from the smoke
below; the documented entry is not itself a completed GUI acceptance.

### Observed native console entry, 2026-10-18

An isolated macOS app built at `efb1b38` used a separate compiled identifier.
After the user initialized its fresh Vault, the Settings UI saved an integration
with an empty API key and read-only sync disabled. **Open Komari console** opened
ShellBeam's native browser window and rendered the installation wizard of an
authorized remote official 1.6.0 instance through an SSH local forward. The user
completed setup there; the native window subsequently rendered its home and
login pages. The instance's version API returned `1.6.0` and upstream hash
`1b76b7ad5bc3de6529bb7f0577069b4ac241fec3`.

This establishes the real desktop entry and first-run page rendering. Dedicated
API credentials, authenticated sync, node mapping, alert/Workspace linkage and
public TLS remain unaccepted. No credentials or user host addresses are part of
this record; no Komari Agent was installed to manufacture monitoring evidence.

### Follow-up desktop check, 2026-10-20

After the bounded instance had stopped, the same hash-checked executable was
restarted with the original SQLite and StateDirectory, the same loopback-only
listener and the same two-hour CPU/memory limits. The SSH forward was restored;
the version endpoint still identified 1.6.0, public discovery returned one
existing node with zero recent records, and an unauthenticated admin-list
request returned 401. No
database reset or new Agent deployment was needed for these checks.

The actual desktop Vault was unlocked. Its saved integration had synchronization
disabled, which was enabled and saved under the existing user authorization.
Discovery then failed, and the Vault's key list contained zero credentials.
The earlier user-reported key-save step therefore cannot be recorded as verified
API authorization or successful synchronization. Public discovery alone also
does not verify the dedicated key: the adapter can fall back to public discovery
after a denied admin-list request.

This exposed two feedback gaps. A native credential-write failure could be
swallowed by the Vault context, allowing the settings form to clear its input
as though saving had succeeded. Discovery also used one generic failure for
missing credentials, denied API access and transport errors. The follow-up
changes propagate write failures, retain unsaved input, show only fixed local
error copy, and distinguish missing/read-failed credentials, permissions,
connectivity, timeout and successful empty discovery. HTML and unsupported
HTTP 200 list payloads are rejected instead of being normalized into a successful
zero-node result; the existing one-request public fallback remains bounded.
Regression tests for
these behaviors do not replace the next saved-key desktop check, node mapping,
actual telemetry or alert/Workspace acceptance.

### Saved-key investigation, 2026-10-20

After a further user-controlled save, the actual test Vault displayed one
Komari credential entry. Fresh manual discovery, observed after clearing the
native WebInspector console, still received HTTP 403 for
`/api/admin/client/list` from `tauri://localhost`. A read-only boolean check of
the dedicated server database found no API key satisfying official 1.6's
configured-string validation. A separate inode comparison confirmed that the
running acceptance server had that primary database open. These checks returned
only booleans; they did not read a credential value, length, hash or database
copy. The user reports clicking Save on both sides; the specific server-side
save failure remains unconfirmed and must not be attributed to a missed click.

Three App defects were reproduced and fixed independently of that server-side
unknown. Editing an integration now preserves its existing custom credential
reference. New/selection/input changes invalidate older list refreshes so a
late response cannot redirect a credential draft to an old integration. Leaving
Settings after Save continues the requested credential write within the same
Vault generation; switching Vaults, including A→B→A, or unloading the provider
blocks further persistence steps. This preserves the separate metadata and
credential writes; it does not claim an atomic transaction or undo a write
already dispatched.

Successful saves deliberately clear and mask the input rather than reading
the secret back. Bilingual help distinguishes the server API key from Agent
tokens and explains that the form does not configure the server. A success
notice appears only after persistence and the current list reload complete;
editing clears it, and saving does not claim verified authentication.
The real-VaultProvider regression suite covers deferred metadata/credential
writes, page navigation, batched Vault transitions, provider unload and stale
refreshes. The four focused suites passed 56 cases; the complete frontend run
passed 1,305 cases with 17 platform-specific skips on macOS, using two workers
and unchanged assertions/timeouts. The production TypeScript/Vite build passed.

The isolated official-server smoke also passed the console's slashless
`POST /api/admin/settings` route with a synthetic cookie session, same-origin
header and canonical-path redirect, requiring JSON `status: success` rather
than merely HTTP 200. The saved synthetic key then authorized a protected
admin-list request with the desktop Origin. The safe result is retained in
`/tmp/shellbeam-komari-console-save-contract-20261020.log` and includes
`serverKeySaveVerified: true`. This HTTP contract result does not prove that the
external instance's WebView save succeeded. The next actual-instance check must
capture only the save request's method/path/status and immediately repeat the
boolean metadata check; do not inspect Headers, settings bodies or HAR exports.

### Repaired-App authorization confirmed, 2026-10-20

The subsequent controlled server save was observed in the native console's
detached Network list as `POST /api/admin/settings` HTTP 200. The immediately
repeated configured-key boolean was true. The earlier unsuccessful save's cause
remains unconfirmed; this evidence must not be described as user error.

The macOS acceptance App was rebuilt from `75fb7c7`, preserving its compiled
identifier and existing test Vault, then actually quit and relaunched. After
the user unlocked it and saved the existing integration through the repaired
form, the App visibly displayed the new saved-settings notice. Its main WebView
then discovered the one real node. A separately prepared Network list, filtered
to `/api/admin/client/list`, recorded completed **GET 200** requests from that
main window. This is protected administrator API authorization evidence, rather
than console Cookie authentication, a preflight or public fallback. Only the
method/path/status list was inspected; no Headers, bodies, Key values or HAR
were opened.

Actual server-key persistence, repaired App credential saving and protected
node discovery are now accepted for this isolated forwarded instance. The test
Vault still has zero SSH hosts, so mapping, Workspace/OperationJob linkage and
actual telemetry/alert recovery remain unaccepted. The one node previously had
zero recent reports; no Agent or synthetic report was added to that instance.

## Local HTTP contract smoke

Run the explicit smoke with an official Komari 1.6.0 executable for the current OS:

```sh
node scripts/komari-live-smoke.mjs --binary /absolute/path/to/komari
```

The script starts a new process bound only to `127.0.0.1` on an ephemeral port. Its working directory, primary SQLite database and monitoring database live under a new private temporary directory. It does not accept an existing endpoint/database, read ShellBeam credentials, install a service, invoke Docker or request elevated privileges.

The first-run installation uses random temporary credentials kept in memory. The smoke saves the server key through the console's settings route and verifies protected desktop-Origin authorization, creates one synthetic node through the authenticated API and submits two synthetic reports through the official agent v2 RPC. It loads the unchanged production `komari.ts` and `komari-probe-provider.ts` adapters with Vite, then checks version detection, node discovery, recent reports, non-empty stored history, mapped provider metrics, permission errors and authorization CORS response/preflight headers for the desktop origin. Its console output contains only version/hash, booleans, counts and pass/failure stages. Request/response bodies and upstream logs are never dumped because they can contain temporary tokens.

On success or failure, the script stops its own process, waits for confirmed exit, then removes the temporary databases and logs. If exit cannot be confirmed, it reports the private directory path and retains state rather than deleting files beneath a running server.

For macOS, the official 1.6.0 release does not ship a native binary. Build the unmodified official source at tag `1.6.0` (inspected commit `1b76b7ad5bc3de6529bb7f0577069b4ac241fec3`) with Go 1.25 and the official frontend release archive. The `komari-web` `1.6.0` asset `dist-release.zip` has GitHub-reported SHA-256 `85a16daea5bbfcdee17cb2bd799eca95159cb88f16795fd9a05f658712c2f915`. Follow the upstream frontend embed instructions and set the upstream version/hash build flags so `/api/version` identifies the tested source. Keep the checkout, build caches and runtime files in temporary directories.

This test proves the actual local server's HTTP contract with synthetic reports. It does not prove an external deployment's availability, TLS configuration, permissions or WebView behavior, and it does not measure the Komari agent's host collection accuracy. Those require deployment-specific validation.

## Observed result, 2026-10-18

The full native macOS smoke passed against the official source/hash above. The safe summary is retained in `/tmp/shellbeam-komari-live-smoke5.log`:

- One authenticated node and two actual recent reports.
- The original 24-hour HTTP response had zero records; the one-hour endpoint returned one real minute aggregate. The corrected adapter returned that non-empty history with its original bucket time.
- The mapped provider returned CPU 25%, memory 50% and disk 20%, and imported three observations from history/recent reports.
- Invalid API tokens produced the adapter's `permission` error, including the private-site discovery fallback.
- An authenticated request with `Origin: tauri://localhost` returned the matching CORS allow-origin header; the authorization OPTIONS preflight returned 204.
- The script confirmed server exit and removed the temporary runtime databases/logs. It did not modify any Go source or install a service.

### Why the initial history query was empty

This was a query-tier warmup issue, not a JSON parsing failure. The raw 24-hour server response itself was HTTP 200 with `records: []`, while the same real node's one-hour response already contained data.

Official 1.6.0 [`internal/metricstore/config.go`](https://github.com/komari-monitor/komari/blob/1.6.0/internal/metricstore/config.go) keeps the minute tier for 600 minutes by default. [`legacy_records.go`](https://github.com/komari-monitor/komari/blob/1.6.0/internal/metricstore/legacy_records.go) and [`pkg/metric/rollup_query.go`](https://github.com/komari-monitor/komari/blob/1.6.0/pkg/metric/rollup_query.go) select a compatible backing tier from the full requested time range. A 24-hour request therefore selects the coarser five-minute tier. [`batch_series.go`](https://github.com/komari-monitor/komari/blob/1.6.0/pkg/metric/batch_series.go) reads the active hot buckets for the minute tier, while the coarser tier is fed through closed-minute rollups in [`hot_rollup.go`](https://github.com/komari-monitor/komari/blob/1.6.0/pkg/metric/hot_rollup.go). A just-created node can consequently have non-empty fine history while its wide-window coarse history is still empty.

`getKomariHistoryRecords` now makes at most one extra one-hour request when a wider request successfully returns no records. It preserves the server's real values/times, does not manufacture a sample when both windows are empty, and propagates permission/network errors. An already populated wide result needs only one request. The existing history backfill TTL and sync concurrency limits apply to the whole host operation. The narrower fallback provides available observations; it does not imply complete coverage of the requested day.

The earlier failed runs remain evidence of the missing warmup handling, rather than being relabeled as passes. Contract regressions cover the empty coarse tier, real fine observations, one-request populated results, no recursive fallback and denied access to either window.
