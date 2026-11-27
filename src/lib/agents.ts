/**
 * Single source of truth for local AI Agents across ShellBeam:
 * - AI Assistant local CLI backends (Settings -> AI, AI Command Bar, Desktop Companion)
 * - Local MCP auto-detection & 1-click configuration (Settings -> Agent Access / MCP)
 *
 * Mirrors `src-tauri/src/agents.rs` so adding a new local agent updates every surface once.
 */

export type LocalAgentId =
  | 'claude-code'
  | 'codex-cli'
  | 'antigravity'
  | 'cursor-cli'
  | 'gemini-cli'
  | 'opencode-cli'
  | 'devin-cli'
  | 'claude-desktop'

export type AICliBackend =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'opencode-cli'
  | 'cursor-cli'
  | 'devin-cli'

export type McpConfigFormat =
  | 'json-mcp-servers'
  | 'json-mcp-servers-stdio'
  | 'codex-toml'
  | 'opencode-json'

export interface LocalAgentSpec {
  id: LocalAgentId
  name: string
  /** Display name used in AI Assistant CLI pickers (defaults to `name`). */
  cliLabel?: string
  /** Present when this agent can also act as an AI Assistant local CLI backend. */
  cliBackend?: AICliBackend
  /** Whether the CLI backend supports reasoning effort levels. */
  supportsEffort?: boolean
  /** Curated model presets for the CLI backend; '' keeps the CLI default. */
  cliModelPresets?: string[]
  mcpFormat: McpConfigFormat
}

export const LOCAL_AGENTS: readonly LocalAgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    cliBackend: 'claude-code',
    supportsEffort: true,
    cliModelPresets: ['', 'sonnet', 'opus', 'haiku', 'fable', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    mcpFormat: 'json-mcp-servers-stdio',
  },
  {
    id: 'codex-cli',
    name: 'Codex',
    cliLabel: 'Codex CLI',
    cliBackend: 'codex-cli',
    supportsEffort: true,
    cliModelPresets: ['', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.5'],
    mcpFormat: 'codex-toml',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    mcpFormat: 'json-mcp-servers',
  },
  {
    id: 'cursor-cli',
    name: 'Cursor',
    cliLabel: 'Cursor Agent',
    cliBackend: 'cursor-cli',
    cliModelPresets: ['', 'auto', 'sonnet-4.5', 'opus-4.5', 'gpt-5', 'gemini-2.5-pro'],
    mcpFormat: 'json-mcp-servers',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    cliBackend: 'gemini-cli',
    cliModelPresets: ['', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    mcpFormat: 'json-mcp-servers',
  },
  {
    id: 'opencode-cli',
    name: 'OpenCode',
    cliBackend: 'opencode-cli',
    supportsEffort: true,
    cliModelPresets: [''],
    mcpFormat: 'opencode-json',
  },
  {
    id: 'devin-cli',
    name: 'Devin CLI',
    cliBackend: 'devin-cli',
    cliModelPresets: ['', 'adaptive', 'swe-2-high', 'swe-2-medium', 'swe-2-flash-medium', 'swe-2-flash-high', 'claude-fable-5-2-medium', 'claude-fable-5-2-high'],
    mcpFormat: 'json-mcp-servers',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    mcpFormat: 'json-mcp-servers',
  },
] as const

export const AI_CLI_AGENTS = LOCAL_AGENTS.filter(
  (agent): agent is LocalAgentSpec & { cliBackend: AICliBackend } => Boolean(agent.cliBackend),
)

export const AI_CLI_BACKENDS: readonly AICliBackend[] = AI_CLI_AGENTS.map((agent) => agent.cliBackend)

export const CLI_BACKEND_LABELS: Record<AICliBackend, string> = Object.fromEntries(
  AI_CLI_AGENTS.map((agent) => [agent.cliBackend, agent.cliLabel ?? agent.name]),
) as Record<AICliBackend, string>

export const CLI_MODEL_PRESETS: Record<AICliBackend, string[]> = Object.fromEntries(
  AI_CLI_AGENTS.map((agent) => [agent.cliBackend, agent.cliModelPresets ?? ['']]),
) as Record<AICliBackend, string[]>

export function findLocalAgent(id: string | undefined | null): LocalAgentSpec | undefined {
  if (!id) return undefined
  return LOCAL_AGENTS.find((agent) => agent.id === id)
}
