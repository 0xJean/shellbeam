# AI model discovery

In Settings > AI Assistant, select a provider and click **Refresh models**.
This is an explicit metadata request, not an inference or automatic model change.
Opening Settings does not send requests. All providers also accept manual model IDs.
Existing settings and selections remain valid; disappearing models are not silently
replaced. Built-in suggestions are fallbacks, not an up-to-date model catalog.

| Provider | Discovery endpoint | Authentication |
| --- | --- | --- |
| OpenAI | `/v1/models` | Provider API key |
| Anthropic | `/v1/models`, including cursor pagination | Provider API key |
| OpenRouter | `/api/v1/models` | Optional key for its public catalog |
| Ollama | `http://localhost:11434/api/tags` | No API key forwarded |
| Custom | OpenAI-compatible `/v1/models` | Optional bearer token |

Base URLs ending in `/v1` are not given a second `/v1`. Enter the base URL, not
a completion or models endpoint. Embedded URL credentials, query parameters and
fragments are rejected for discovery. Changing a custom URL clears its active
key; enter a key only after confirming the destination. Prefer HTTPS for nonlocal
endpoints. Browser/WebView CORS restrictions still apply; ShellBeam does not
bypass them or send credentials through an intermediary server.

Model catalogs are cached locally by provider, endpoint and a SHA-256 account
fingerprint. The cache does not contain API keys. Catalogs older than 24 hours
are labeled stale, but remain usable when discovery fails. Requests time out
after 15 seconds and are canceled when the provider, endpoint or key changes.
Provider errors do not echo response bodies that might contain secrets.
Storage errors leave the fetched list usable in memory with a warning.

Provider settings remember their own model/key rather than sharing the previous
provider's key. Legacy active settings are preserved. API-key storage remains the
existing local settings storage, not an encrypted Vault migration in this change.

The model list is a suggestion list, not a capability or billing guarantee.
OpenAI's general catalog includes non-chat models, which are conservatively
filtered. OpenRouter modality metadata is used when present. Manual IDs remain
available for custom, newly named or otherwise unlisted models. OpenAI requests
use `max_completion_tokens`; other compatible providers retain `max_tokens`.
The Model API backend uses Chat Completions or Anthropic Messages, so a model
requiring another API may still be incompatible. No inference probes or paid
automatic fallback attempts are made.

External Codex and Claude Desktop integration uses [MCP](./mcp.md), independently
of these API settings. For CLI-backed generation within the built-in terminal
assistant, see [Claude Code / Codex CLI backends](./ai-cli.md). These use the locally
installed CLI and its own sign-in, without embedding either desktop client.

Official references: [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list),
[Anthropic models](https://platform.claude.com/docs/en/api/models/list),
[OpenRouter catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
[Ollama tags](https://docs.ollama.com/api/tags).
