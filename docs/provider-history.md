# Unified observations and Komari metric history

`shared/probe-collector.sh` is the single Linux SSH collector used by Desktop Server Monitor, Workspace and native MCP. It emits the bounded `__SB_PROBE_SCHEMA=1` frame. Metrics-only requests skip tools/services/projects subprocesses. Combined ProbeProvider requests execute one SSH command and produce one read-only `probe.collect` OperationJob. The native MCP adapter includes the exact same script rather than maintaining a second shell implementation.

The schema preserves CPU, load, memory, disk, uptime and network counters plus rich tool/category/version discovery, service active/enabled states, containers, saved PM2 presence, project names/kinds/deployment roots, filesystems, inodes and listening sockets. PM2 discovery reads saved metadata and does not start a PM2 daemon. Unknown values remain null; project discovery is partial and never executes project code. Legacy exported marker formats remain readable during migration, but incomplete versioned frames are rejected. Maximum wire size is 256 KiB; row counts, external version commands and project depth are bounded.

Both TS adapters and native MCP test the same `shared/fixtures/linux-probe-v1.txt` fixture. The Linux-only test also executes the actual collector and verifies that a metrics-only scan omits inventory subprocesses. That test is skipped on macOS and runs in Linux frontend CI.

## Komari API compatibility

Contract fixtures use synthetic data following the official [API documentation](https://komari-document.pages.dev/en/dev/api), the [1.6.0 route bindings](https://github.com/komari-monitor/komari/blob/1.6.0/web/router/router.go), and the [1.6.0 response handlers](https://github.com/komari-monitor/komari/blob/1.6.0/web/rpc/jsonrpc/public.go). They cover flat historical records, nested live reports, node mappings, denied access, partial observations, and server versions 1.0.3 and 1.6.0. API key support begins at 1.0.3; older and unknown versions are identified rather than assumed compatible.

The adapter reads `/api/recent/:uuid` and backfills `/api/records/load?uuid=...&load_type=all&hours=24`. Historical backfill has a five-minute TTL per vault/integration/node, while recent observations follow the normal integration sync TTL. When a wider history window returns no records, the adapter makes at most one one-hour request because Komari 1.6.0 can expose hot-minute data before its coarser retention tier is populated. Both empty windows remain empty, and permission/network errors propagate. A forced sync bypasses the backfill TTL. Responses are limited to 4 MiB and 10,000 newest valid records. Unknown fields, raw API bodies and authorization tokens are not retained in metric history.

Original sampling times are required. Future/undated/all-missing reports never manufacture online observations. Reports are sorted and deduplicated by timestamp. Backfilled history may advance the latest observation if it is newer; older reports cannot overwrite the latest persisted Komari snapshot. History endpoint failures do not discard a valid recent observation and are reported separately in sync diagnostics.

## Local retention and range UI

`provider_metric_history` uses `(vault, provider kind, provider id, host, node, sampledAt)` as its key. It keeps up to seven days, 10,080 points per source series and 100,000 points globally. Only whitelisted metric fields and provenance/freshness are stored. Each host's history is imported before its bounded sync concurrency slot is released; fleet results keep a bounded preview rather than accumulating all raw records in memory.

Workspace desktop and mobile expose 1h, 6h, 24h and 7d ranges. Queries retain source boundaries, original sampling time and expiry, and downsample across the entire window. Results have a global point cap. When there are too many source series, the newest source series are selected and the UI explicitly marks the result partial. A narrower provider/time range can expose other sources.

Downsampling carries per-metric `gapBefore` metadata whenever omitted observations contain nulls or an expired sampling interval, so retaining fewer points cannot bridge unknown periods. The chart breaks at null values and after an observation's TTL expires; it does not draw a continuous line across periods without collection. Isolated retained points remain visible. The inspector displays CPU/memory/disk values, sample time, TTL and confidence. History is an observation record, not evidence that SSH is currently reachable.

Native persistence tests cover vault/host/provider isolation, duplicate/out-of-order imports, retention, future timestamps, time-range downsampling and global source/point caps. API fixtures prove compatibility with the documented contract, not the availability of any user's live Komari deployment; real endpoints and their configured permissions/CORS policy still require deployment-specific validation.
