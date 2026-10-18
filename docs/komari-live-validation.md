# Isolated Komari live contract validation

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

## Local HTTP contract smoke

Run the explicit smoke with an official Komari 1.6.0 executable for the current OS:

```sh
node scripts/komari-live-smoke.mjs --binary /absolute/path/to/komari
```

The script starts a new process bound only to `127.0.0.1` on an ephemeral port. Its working directory, primary SQLite database and monitoring database live under a new private temporary directory. It does not accept an existing endpoint/database, read ShellBeam credentials, install a service, invoke Docker or request elevated privileges.

The first-run installation uses random temporary credentials kept in memory. The smoke creates one synthetic node through the authenticated API and submits two synthetic reports through the official agent v2 RPC. It loads the unchanged production `komari.ts` and `komari-probe-provider.ts` adapters with Vite, then checks version detection, node discovery, recent reports, non-empty stored history, mapped provider metrics, permission errors and authorization CORS response/preflight headers for the desktop origin. Its console output contains only version/hash, counts and pass/failure stages. Request/response bodies and upstream logs are never dumped because they can contain temporary tokens.

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
