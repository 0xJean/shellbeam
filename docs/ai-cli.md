# Built-in terminal assistant: Claude Code and Codex CLI

Settings → AI Assistant → **Connection** now offers Model API, Claude Code, and
Codex CLI. These backends generate commands inside the existing terminal assistant.
External clients calling ShellBeam's [MCP server](./mcp.md) remain a separate feature.
The desktop Claude/Codex apps are not embedded or launched by this integration.

Install and sign in to the CLI in a local terminal first (`claude` or `codex login`).
ShellBeam uses that CLI's own authentication; it neither imports login tokens nor
asks for an additional API key. Use **Check CLI** to verify the executable and its
required options. This check does not verify model entitlement or authentication;
those are tested by an explicit generation request. CLI/account billing rules apply.
An absolute executable path and a model override are optional. On Windows use the
native `.exe`; `.cmd`/PowerShell wrappers are not run through a shell.

Existing API credentials/model profiles remain in their existing settings storage.
The new backend and per-CLI executable/model fields are additive. Switching back to
Model API restores the previous provider configuration; no Vault, host, snippet,
MCP grant, monitoring data or OperationJob records are migrated or deleted.

## Execution and data boundary

- The user prompt and recent terminal output go to the CLI over stdin, then to its
  configured model service. They never appear in process arguments, ShellBeam logs
  or temporary prompt files. CLI credentials remain CLI-owned. This does not make
  a CLI-backed cloud model an offline model.
- A private empty working directory avoids adopting the terminal host's paths or
  a local repository. No generated command is run on the local machine or sent to
  SSH by the native adapter. Only a successful complete result gets a **Run** button.
  Run uses the existing current-session execution/history path; generation is not
  an OperationJob and does not claim MCP's separate per-client audit semantics.
- Claude uses print/stream-json, safe-mode, an empty tools list, strict empty MCP
  configuration, no slash commands and no session persistence. Codex uses exec/json,
  ephemeral mode, ignored user configuration/rules, read-only sandbox and no approval
  escalation; shell, MCP configuration, plugins, hooks, skills discovery, agents,
  browser/computer/image/JS operations and interactive task tools are disabled.
  A model can still advertise Codex's built-in patch tool depending on its metadata;
  the read-only/never-approve policy remains in force. Any observed tool event aborts
  the result. ShellBeam never treats a tool result as a generated command.
- Claude text deltas stream as they arrive. Codex exec publishes completed assistant
  messages, so the UI may remain in “Thinking” until that message arrives. Both must
  complete successfully and exit zero before Run is enabled. Nonzero exits, tool
  activity, invalid/oversized JSON and incomplete results discard the candidate.
- Stop, hide, terminal switch/disconnect, component teardown and normal app exit
  cancel the worker. Unix process groups / Windows kill-on-close jobs terminate
  children; normal exit waits briefly for cleanup. Two requests at most, 120 seconds
  per generation, bounded stdin/JSON/output. Abrupt OS termination is not a promise
  of a persisted/recoverable generation; no AI request is replayed on restart.
- Raw CLI stderr/errors are not rendered, as they may include authentication details.
  Errors advise checking CLI login, network and model access in the user's terminal.
  Missing isolation flags fail closed and ask the user to upgrade. Browser previews
  and mobile builds explicitly report that local CLI backends require desktop.

## Validation (2026-10-22)

Local macOS: 1574 frontend tests pass (17 Linux-only skipped); 254 Rust library tests
pass (4 opt-in ignored). Targeted tests cover provider/profile preservation, late
channel events, abort-before-start acknowledgement, manual Run, no partial execution,
parser/tool rejection, bounded output and cancellation of actual child process groups.
Eight isolated settings layouts (Chinese/English, dark/light, 640/1280 px) have no
horizontal overflow; screenshots were checked visually. This is a browser component
fixture, not installed-app acceptance. Production frontend build, Rust format and modified assistant files' ESLint pass
(one pre-existing SuggestBar dependency warning). SessionTerminalView has existing
ref-during-render lint findings; this change only scopes the assistant by session and
visibility and does not claim to have repaired that component's baseline lint.

Installed Claude Code **2.1.306** and Codex CLI **0.160.1** also passed the production
Rust adapter against isolated loopback model servers. Each made exactly one mock
inference request with no tools advertised and returned `pwd`. The fixture uses
empty HOME/config directories and synthetic keys, never real CLI login data. It
checks transport/arguments/parsing, not real cloud authentication, subscriptions,
remote execution, every model's metadata or an installed desktop UI end-to-end flow.

Reproduce (macOS/Linux, installed CLI required):

```sh
node scripts/ai-cli-smoke.mjs claude-code /absolute/path/to/claude
node scripts/ai-cli-smoke.mjs codex-cli /absolute/path/to/codex
```

Official interfaces: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference).
