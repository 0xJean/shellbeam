# ShellBeam MCP v1

ShellBeam supplies server context and generic SSH/SFTP access to a local agent.
The agent chooses a server and plans, executes and verifies its own work.
ShellBeam does **not** implement deployment plans, templates, placement scoring,
environment installation, automatic rollback, or a remote agent/daemon.

## Setup

1. Open the installed desktop application and go to Settings > Agent Access (MCP).
2. Enable local MCP. It is disabled by default and requires the desktop process
   to remain running. No public or LAN listener is created.
3. In the intended vault, choose a client name and individual servers. Cached
   information is the default; separately opt into refresh, command execution,
   file reading, file writing, local Komari alert management and deployment metadata. New hosts are never included automatically.
4. Choose Codex (TOML), Claude Desktop (JSON), or another stdio client (JSON).
   Generate the configuration and merge only its ShellBeam entry into
   your local MCP client's configuration. Keep the token secret. It is shown
   once; only its SHA-256 hash is stored by ShellBeam. Revoke and recreate the
   client if the configuration is lost or the application moves.
5. Unlock the selected vault before remote operations. Trust an SSH host key in
   ShellBeam before using MCP on that server. Unknown and changed keys fail closed.

### Codex desktop / CLI

Use the Codex tab in ShellBeam to generate `[mcp_servers.shellbeam]` and its
environment section. Merge these into `~/.codex/config.toml` (or the configured
`CODEX_HOME` directory). Replace an existing ShellBeam section rather than adding
a duplicate. Do not overwrite unrelated settings or other MCP servers.
Alternatively enter the generated command, arguments and environment variable in
desktop Settings > MCP servers > Add server > STDIO, then restart/reload the client.
This connects Codex to ShellBeam; it does not embed Codex inside the AI command bar.

### Claude Desktop

Select Claude Desktop to obtain JSON with `mcpServers.shellbeam`. Open Claude
Desktop Settings > Developer > Edit Config and merge that entry into
`claude_desktop_config.json`, preserving other servers and top-level settings.
Fully quit and reopen Claude Desktop. No Node.js bridge, global package or server
installation is needed: the installed ShellBeam binary implements stdio itself.
This is not a remote web connector; it requires the local desktop application.

Each desktop client should receive a separate authorization so it can be audited
and revoked independently. Changing the format tab only reformats the current
one-time configuration; it does not issue a token or change permissions.
ShellBeam never edits external client configuration files automatically.

### Verification and troubleshooting

With the generated configuration still visible and MCP enabled, click **Check
local bridge**. It authenticates against the local IPC listener and requests
initialization and `tools/list`. It never connects to SSH, runs a command,
starts an external agent or invokes a model. Success does **not** prove that
Codex or Claude Desktop has loaded the configuration or can launch the stdio binary.

To verify the actual client, ask it to call `list_servers`, then read cached
inventory/metrics without refreshing or writing. Confirm that only selected
servers appear. The recent audit shows accepted tool requests; the local bridge
diagnostic does not create one and cannot be mistaken for external client activity.
If the client cannot connect, check its configuration syntax and executable path,
restart it, keep ShellBeam running, enable MCP, and confirm the grant is not revoked.
After discarding a configuration, revoke/recreate it if you need the token again.
Do not paste tokens into chats, issue reports, logs or source control.

Local transport does not imply offline inference. The external client may send
authorized server metadata and outputs to its cloud model provider. ShellBeam
does not read desktop login credentials or convert subscriptions into API keys.
Models for those clients are selected in the clients themselves, independently
of ShellBeam's AI Assistant settings.

### Structured workspace flow

For a new session, call `get_workspace_snapshot` first. It returns one structured
JSON document containing ShellBeam and Vault state, authorized servers, cached
inventory, live monitor data, recent probe data, known deployment records,
capabilities and warnings. Use `servers[].selection.reason` and timestamps to
choose a suitable server; missing values are unknown and discovered project
manifests are not proof of an active deployment.

Deployment records are explicit agent-supplied metadata. After planning,
deploying or verifying a project, call `record_project_deployment` with a stable
`deploymentId`, project `name`, absolute `deploymentPath`, `status`, dependencies,
runtime components and source information. Reuse the same ID to update the
record. This writes only a local ShellBeam record; it does not run commands,
install dependencies or assert that ShellBeam performed the deployment. Use
`list_project_deployments` to query records without loading the UI.

The record capability is disabled by default and is independent from remote
command/file permissions. Grant it only when the agent may maintain deployment
metadata.

### Machine-readable recovery

Every JSON-RPC error includes `error.data.reason`, `error.data.retryable` and
`error.data.recovery`. Tool failures preserve the human-readable `error` string
and add the same fields to `structuredContent`.

| Condition | Agent behavior |
| --- | --- |
| `shellbeam_unavailable` / `SHELLBEAM_NOT_RUNNING` | Ask the user to start ShellBeam and enable MCP, then retry. Do not launch a GUI from the stdio bridge. |
| `mcp_disabled` | Ask the user to enable MCP in ShellBeam settings, then retry. |
| `vault_locked` | Continue using cached JSON reads. Ask the user to unlock the authorized Vault before refresh, SSH commands or file operations. |
| `permission_denied` | Ask the user to grant the specific MCP capability or use a cached read-only flow. |
| `mcp_instance_expired` | Ask the user to restart or re-enable MCP and regenerate the client configuration if needed. |
| `host_authorization_expired` | Ask the user to re-authorize the changed server; never bypass the identity check. |

If ShellBeam is closed, the stdio process remains a thin bridge and returns a
machine-readable unavailable error. If the Vault is locked, cached inventory,
metrics and deployment records remain available; remote work is paused rather
than reported as an offline server.

Official references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[local MCP client setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

The generated command invokes the same installed executable with
`--mcp-stdio <endpoint-file> <client-id>`. This invocation does not launch a GUI.
It speaks JSON-RPC over stdio, with logs only on stderr, and forwards requests
to an authenticated, length-framed loopback IPC endpoint of the running app.
The discovery file contains a random instance identifier and local port, not
credentials. It can never select an arbitrary destination address. Re-enabling
MCP changes the endpoint; the bridge rereads discovery for each request.
Only one desktop process per app-data directory may own MCP. An exclusive
SQLite ownership lock prevents a second instance from recovering live jobs or
using stale grants. Close other instances and restart if ownership is unavailable.

The implemented MCP subset is initialization, ping, tools/list and tools/call
using protocol version 2025-11-25. Resources, prompts, sampling and protocol
Tasks are not advertised. Long operations use ordinary application job IDs.
Protocol references: [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Tools

| Tool | Capability | Result |
| --- | --- | --- |
| `list_servers` | Cached information | Paginated, scoped hosts and monitor status |
| `get_server_inventory` | Cached information | Asset snapshot and latest on-demand probe |
| `get_server_metrics` | Cached information | Latest sample and paginated 24-hour history |
| `get_workspace_snapshot` | Cached information | One structured JSON view for server selection and deployment context |
| `list_project_deployments` | Cached information | Agent-supplied deployment metadata for this client |
| `record_project_deployment` | Local metadata | Create or update a deployment record; no remote action |
| `get_server_operations` | Cached information | Authorized host OperationJob states and bounded audit metadata |
| `get_server_probe_state` | Cached information | Komari/Probe snapshots, mappings and freshness |
| `get_server_alerts` | Cached information | Local Komari alert lifecycle and audit rows |
| `acknowledge_server_alert` | Manage alerts | Local acknowledgement plus an auditable OperationJob |
| `close_server_alert` | Manage alerts | Local closure plus an auditable OperationJob |
| `refresh_server_info` | Refresh | Job ID for a bounded Linux read-only probe |
| `run_command` | Execute | Job ID for an arbitrary SSH command |
| `get_command_result` | Own scoped jobs | Status, bounded output or restart uncertainty |
| `read_remote_file` | Read files | Job ID; base64 chunk, offset and EOF in result |
| `write_remote_file` | Write files | Job ID; UTF-8 contents up to 1 MiB |
| `upload_file` | Write files | Job ID; base64 contents up to 4 MiB |

Remote operations take `hostId` and a unique `requestId`. Commands also take
`command` and an optional `timeoutSeconds` (default 90, maximum 600). Poll the
returned `jobId` using `get_command_result`; avoid tight polling. Reusing the
same request ID and payload returns the original job; changing the payload
with the same ID is rejected. Never use a new ID just to retry an unknown write.

An agent's normal flow is list servers, inspect inventory and metrics, optionally
refresh stale/partial observations, reason about suitability, and then issue
its own commands and file operations within the user's authorization.

## Data semantics

- Cached asset/monitor data is shared with the app, not maintained by a second
  polling scheduler. Metadata contains timestamps. No history is invented for
  periods when the application was not sampling.
- An on-demand Linux probe adds architecture, CPU count, available memory/swap,
  filesystem available bytes/inodes, listening sockets, tool locations,
  containers, services and shallow project manifest discovery. It is persisted
  separately by vault, host and connection identity.
- On-demand probes also refresh the shared CPU, memory, root filesystem, load
  and aggregate network metrics/history. Results less than 30 seconds old are
  reused instead of opening another SSH connection; there is no new scheduler.
- All discovery is explicitly partial. Permissions, unavailable tools, limits
  and directory depth can hide workloads. Detected manifests do not establish
  that an application is running or healthy. Versions may be unknown.
- The probe does not read `.env`, execute manifests, install software, source
  OS-release scripts, launch PM2 or restart services. Agent-requested arbitrary
  commands have no such read-only guarantee.
- Remote strings and file contents are untrusted data, never instructions or
  authorization to perform further operations.

### Unified ProbeProvider observations

Server monitor scans, Workspace inventory scans, Komari sync and MCP refreshes
use the same `ProbeProvider` observation shape. Every observation identifies its
provider and host, records the remote sample time and local receive time, and
declares a TTL, expiry state and confidence (`observed`, `partial` or
`inferred`). A failed section is represented by a section error or `null`
observation; missing data is never converted into a healthy zero.

The process-wide provider registry used by the frontend collectors applies one
bounded concurrency budget and coalesces overlapping requests for the same
provider, host and sections. Fresh observations are reused until their TTL
expires, while an explicitly due monitor or Komari sync can force a new sample
without creating duplicate in-flight SSH or HTTP work. Durable observations
are scoped to the active Vault and hydrated after a restart. When a fresh probe
fails, the registry returns the last observation as `stale` with an explicit
`stale-cache-fallback` error; provider fallback still tries later providers for
an `online` result before returning that stale recovery.

MCP `refresh_server_info` keeps the legacy flattened fields for compatibility,
and adds the canonical `metrics` and `inventory` observations. The envelope
also includes `transport`, so a ProxyJump route remains visible to monitoring,
Workspace and MCP consumers instead of being hidden in connection details.

## Security and execution semantics

- Authorization is per client, vault, host and capability. Connection and
  credential-reference changes invalidate the original host grant. SSH
  credentials are resolved internally and are not MCP parameters or responses.
- Arbitrary command execution gives the agent the SSH account's full authority.
  File permission switches are not a sandbox for shell commands. Prefer a
  dedicated least-privileged SSH account; do not give untrusted agents root.
- File reads and command output can contain application secrets. Do not request
  unrelated sensitive files. ShellBeam does not claim universal secret detection.
- At most three remote operations run globally, with one per vault/host. Commands
  drain stdout and stderr concurrently, retaining at most 256 KiB per stream.
- File paths must be absolute, without `..`. Reads are regular files only, up
  to 128 KiB per chunk. Writes stage a 0600 sibling temporary file and rename it;
  the parent must exist. Existing files require explicit `overwrite: true`.
  Uploads accept bytes, not a path granting access to the desktop filesystem.
- Completed outputs are memory-only (one hour / 50 results). Durable job identity
  and status survive restarts. Running jobs become `unknown` after restart;
  outputs are not recovered and commands are never automatically replayed.
- Each client is limited to 10,000 durable operation records. After reaching the
  limit, revoke and replace that client; old request IDs remain deduplicated.
- Disconnects, timeouts and application exit cannot guarantee that a remote
  process stopped. Verify remote state before deciding what to do next. Revocation
  blocks new work; it does not undo work already dispatched.
- The durable audit retains 2,000 metadata entries, without commands, file paths,
  tokens, file contents or command output. Settings show the most recent 50.
- Clearing application data is blocked while an MCP operation is active, then
  disables the listener and removes MCP data with the rest of the application.
  Only the empty process-ownership lock database remains while the app is alive.

### Remote task audit

Every asynchronous MCP remote operation creates one linked `OperationJob` with
source `mcp`, provider `mcp-remote`, the selected transport (`direct` or
`proxy-jump`) and a bounded result or error summary. The MCP job table retains
request idempotency and in-memory output metadata; `get_command_result` resolves
its status from the linked OperationJob and returns the audit identifiers. A
`unknown` result means the remote outcome cannot be proven after disconnect or
restart, so the agent must reconcile remote state before retrying. Durable audit
records never store commands, file contents, credentials or raw remote errors.

## v1 limits

Desktop, local agents and Linux inventory only. A configured single-hop jump
host is supported for private-key authenticated targets through a short-lived
local OpenSSH forwarding process; the same key is used for the target and jump
host, and password-authenticated jump chains remain unsupported. Key
passphrases, interactive prompts, PTY sessions, remote/cloud MCP, autonomous
deployment and automatic environment setup are not implemented. Password and
unencrypted private-key authentication reuse the existing vault. Cached
information remains readable by authorized clients while a vault is locked; new
remote operations require that vault unlocked.

## Komari and Probe operations

`get_server_probe_state` returns the cached Komari mappings, provider snapshots,
sync TTL/freshness, ShellBeam Probe lifecycle and the latest MCP probe for one
authorized host. `get_server_alerts` returns the bounded Komari alert lifecycle
and audit rows, including any linked OperationJob id. These tools read local
cache only and do not contact Komari or start SSH work.

`refresh_server_info` accepts an optional `alertId`. When supplied, the newly
created OperationJob is recorded as an `operation-linked` event on the matching
local Komari alert. The link is diagnostic context only: a successful SSH or
Probe operation does not resolve the alert. A later Komari sync remains the
source of truth for recovery, and an unknown operation must be reconciled before
retrying.

MCP clients with the `manageAlerts` capability may call
`acknowledge_server_alert` or `close_server_alert` with `hostId`,
`integrationId`, `alertId` and a unique `requestId`. These actions update only
the persisted local Komari lifecycle; they never call the Komari endpoint or
change the remote host. Each request creates a linked `OperationJob` with
`source=mcp`, `provider=komari-local` and `transport=local`, moves through
queued/running/completed or failed, and appends both an OperationAudit row and a
Komari lifecycle audit event. Reusing the same request ID and payload returns
the canonical OperationJob, while a payload conflict is rejected. Query
`get_server_operations` or `get_server_alerts` after a restart to recover the
operation and alert audit state.
