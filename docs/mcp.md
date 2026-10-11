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
4. Generate the configuration and merge its `mcpServers.shellbeam` entry into
   your local MCP client's configuration. Keep the token secret. It is shown
   once; only its SHA-256 hash is stored by ShellBeam. Revoke and recreate the
   client if the configuration is lost or the application moves.
5. Unlock the selected vault before remote operations. Trust an SSH host key in
   ShellBeam before using MCP on that server. Unknown and changed keys fail closed.

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

Desktop, local agents and Linux inventory only. Configured jump hosts fail
explicitly rather than being bypassed. Key passphrases, interactive prompts,
PTY sessions, remote/cloud MCP, autonomous deployment and automatic environment
setup are not implemented. Password and unencrypted private-key authentication
reuse the existing vault. Cached information remains readable by authorized
clients while a vault is locked; new remote operations require that vault unlocked.
