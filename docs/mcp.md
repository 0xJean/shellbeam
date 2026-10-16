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
   file reading and file writing. New hosts are never included automatically.
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
| `get_server_operations` | Cached information | Authorized host OperationJob states and bounded audit metadata |
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
